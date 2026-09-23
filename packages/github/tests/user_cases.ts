import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import github from '../src/mod.ts';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { authenticateInstallation } from '../src/auth/operations.ts';
import { codeFailure, unsupportedTokenRequest } from '../src/auth/user.ts';
import { intersectPermissions } from '../src/auth/tokens.ts';

export const { cases, register } = caseRegistry(
  'packages/github/tests/user_cases.ts',
);

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

register(
  'github.user.1',
  ['user.get', 'user-token.create'],
  [],
  false,
  'user exchange rejects replay and intersects live app and user access over HTTP',
  async () => {
    let ctx!: PluginContext;
    let now = Date.now();
    const { definition } = readRegistration(github());
    const observed = definePlugin({
      ...definition,
      setup(context, options) {
        ctx = { ...context, clock: { now: () => now } };

        return definition.setup(ctx, options);
      },
    });
    await using env = await Emulon.start({
      services: {
        github: observed({
          fixtures: {
            users: [{ login: 'igor' }],
            repositories: ['both', 'app-only', 'user-only'].map((name) => ({
              owner: 'igor',
              name,
              private: true,
            })),
          },
        }),
      },
    });
    const gh = env.services.github;
    const callback = 'http://127.0.0.1:3000/callback';
    const app = await gh.apps.create({
      slug: 'user-app',
      callbackUrls: [callback],
      permissions: { issues: 'write' },
    });
    const installation = await gh.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/both', 'igor/app-only'],
    });
    const approve = (
      repositories = ['igor/both', 'igor/user-only'],
      permissions: Record<string, 'read' | 'write'> = { issues: 'write' },
    ) =>
      gh.authorization.approve({
        clientId: app.clientId,
        login: 'igor',
        repositories,
        permissions,
      });
    const exchange = async (
      code: string,
      extra: Record<string, string> = {},
      json = true,
      status = 200,
    ) => {
      const body = {
        // deno-lint-ignore camelcase
        client_id: app.clientId,
        // deno-lint-ignore camelcase
        client_secret: app.clientSecret,
        code,
        ...extra,
      };
      const response = await fetch(
        env.endpoints.github.web + '/login/oauth/access_token',
        {
          method: 'POST',
          headers: json
            ? { Accept: 'application/json', 'Content-Type': 'application/json' }
            : {},
          body: json ? JSON.stringify(body) : new URLSearchParams(body),
        },
      );

      assert(response.status === status, `Exchange status ${response.status}`);
      assert(response.headers.get('cache-control') === 'no-store');

      return json
        ? await response.json()
        : Object.fromEntries(new URLSearchParams(await response.text()));
    };

    const restricted = await approve(['igor/both', 'igor/app-only']);
    const repository =
      (await ctx.store.transaction((tx) => tx.list('repositories')))
        .map((row) => row.value as { id: string; fullName: string })
        .find((repo) => repo.fullName === 'igor/both')!;
    const tokensBefore = await ctx.store.transaction((tx) => tx.list('tokens'));

    for (const json of [true, false]) {
      const rejected = await exchange(
        restricted.code,
        { repository_id: String(repository.id) },
        json,
        400,
      );

      assert(rejected.error === 'invalid_request');
      assert(
        rejected.error_description ===
          'The repository_id parameter is not supported.',
      );
      assert(!('access_token' in rejected));
      assert(
        JSON.stringify(
          await ctx.store.transaction((tx) => tx.list('tokens')),
        ) ===
          JSON.stringify(tokensBefore),
        'Rejected repository restriction issued a token',
      );
    }

    assert((await exchange(restricted.code)).access_token);
    assert(
      (await exchange(restricted.code)).error === 'bad_verification_code',
    );

    const authorization = await approve();

    assert(
      (await exchange(authorization.code, { client_secret: 'foreign' }))
        .error ===
        'incorrect_client_credentials',
    );
    assert(
      (await exchange(authorization.code, {
        redirect_uri: callback + '/wrong',
      }))
        .error === 'redirect_uri_mismatch',
    );
    assert(
      (await exchange(authorization.code, {
        grant_type: 'refresh_token',
        refresh_token: 'fake',
      })).error === 'unsupported_grant_type',
    );

    const result = await exchange(
      authorization.code,
      { redirect_uri: callback },
      false,
    );

    assert(
      result.access_token.startsWith('ghu_') &&
        result.token_type === 'bearer' &&
        result.scope === '',
    );
    assert(!('refresh_token' in result) && !('expires_in' in result));
    assert(
      (await exchange(authorization.code)).error === 'bad_verification_code',
    );

    const headers = {
      Authorization: `Bearer ${result.access_token}`,
      'Content-Type': 'application/json',
    };
    const user = await fetch(env.endpoints.github.api + '/user', { headers });
    const principal = await user.json();

    assert(
      user.status === 200 && principal.login === 'igor' &&
        principal.type === 'User',
    );

    const issue = async (repo: string, status: number) => {
      const response = await fetch(
        env.endpoints.github.api + `/repos/igor/${repo}/issues`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Intersection' }),
        },
      );
      const body = await response.json();

      assert(response.status === status, JSON.stringify(body));

      return body;
    };

    assert((await issue('both', 201)).user.type === 'User');
    await issue('app-only', 404);
    await issue('user-only', 404);
    await approve(['igor/both'], { issues: 'read' });
    await issue('both', 403);
    await approve();
    await ctx.store.transaction(async (tx) => {
      const value = await tx.get('apps', app.id) as Record<string, unknown>;

      await tx.put({
        collection: 'apps',
        id: app.id,
        value: { ...value, permissions: { issues: 'read' } },
      });
    });

    await issue('both', 403);
    await gh.installations.suspend({ id: installation.id });
    await issue('both', 403);

    let rejected = false;

    try {
      await ctx.store.transaction((tx) =>
        authenticateInstallation(tx, headers.Authorization, undefined, now)
      );
    } catch {
      rejected = true;
    }

    assert(rejected, 'User token accepted as installation principal');

    const jwtRoute = await fetch(env.endpoints.github.api + '/app', {
      headers,
    });

    assert(jwtRoute.status === 401);
    await jwtRoute.text();

    const racing = await approve([], {});
    const raced = await Promise.all([
      exchange(racing.code),
      exchange(racing.code),
    ]);

    assert(
      raced.filter((r) => r.access_token).length === 1 &&
        raced.filter((r) => r.error === 'bad_verification_code').length ===
          1,
    );

    const expired = await approve([], {});

    now = Date.parse(expired.expiresAt);

    assert((await exchange(expired.code)).error === 'bad_verification_code');

    await using isolated = await Emulon.start({
      services: { github: github() },
    });
    const foreign = await fetch(isolated.endpoints.github.api + '/user', {
      headers,
    });

    assert(foreign.status === 401);
    await foreign.text();
    await env.reset();

    const reset = await fetch(env.endpoints.github.api + '/user', { headers });

    assert(reset.status === 401);
    await reset.text();
  },
);
register(
  'github.user.2',
  ['user.get', 'user-token.create'],
  [],
  false,
  'code rejection and permission intersection are pure rules',
  () => {
    assert(unsupportedTokenRequest({}) === undefined);

    // deno-lint-ignore camelcase
    for (const repository_id of ['1', '', 'unknown']) {
      assert(
        unsupportedTokenRequest({ repository_id })?.error === 'invalid_request',
      );
    }

    const record = {
      clientId: 'client',
      redirectUri: 'callback',
      grant: {
        id: '1:2',
        appId: '1',
        userId: '2',
        repositories: [],
        permissions: {},
      },
      expiresAt: 100,
      consumedAt: null,
    };

    assert(codeFailure(record, 'client', undefined, 99) === undefined);
    assert(
      codeFailure(record, 'client', undefined, 100) === 'bad_verification_code',
    );
    assert(
      codeFailure({ ...record, consumedAt: 1 }, 'client', undefined, 99) ===
        'bad_verification_code',
    );
    assert(
      codeFailure(record, 'other', undefined, 99) === 'bad_verification_code',
    );
    assert(
      codeFailure(record, 'client', 'other', 99) === 'redirect_uri_mismatch',
    );
    assert(
      intersectPermissions({ issues: 'write' }, { issues: 'read' }).issues ===
        'read',
    );
    assert(
      intersectPermissions({ issues: 'read' }, { issues: 'write' }).issues ===
        'read',
    );
  },
);

register(
  'github.user.3',
  ['user.get', 'user-token.create'],
  [],
  false,
  'user codes and tokens survive durable restart without exposing credentials in status',
  async () => {
    const directory = await Deno.makeTempDir();
    const { serveEnvironment } = await import(
      '../../emulon/src/control/server.ts'
    );
    const { runProjectCLI } = await import('../../emulon/src/cli/project.ts');
    const config = {
      services: {
        github: github({ fixtures: { users: [{ login: 'igor' }] } }),
      },
    };
    let clientId = '';
    let clientSecret = '';
    let code = '';
    let token = '';

    try {
      {
        await using host = await serveEnvironment(config, { directory });
        await using env = await Emulon.connect({ config, directory });

        assert(host.identity.endpoints.github?.web);

        const app = await env.services.github.apps.create({
          slug: 'durable',
          callbackUrls: ['http://127.0.0.1/callback'],
        });

        clientId = app.clientId;
        clientSecret = app.clientSecret;
        code = (await env.services.github.authorization.approve({
          clientId,
          login: 'igor',
          repositories: [],
          permissions: {},
        })).code;
      }

      for (let round = 0; round < 2; round++) {
        await using host = await serveEnvironment(config, { directory });
        const endpoints = host.identity.endpoints.github!;
        const response = await fetch(
          endpoints.web + '/login/oauth/access_token',
          {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
            }),
          },
        );
        const body = await response.json();

        assert(response.status === 200);

        if (round === 0) {
          token = body.access_token;

          assert(token);
        } else {
          assert(body.error === 'bad_verification_code');
        }

        const user = await fetch(endpoints.api + '/user', {
          headers: { Authorization: `token ${token}` },
        });

        assert(user.status === 200 && (await user.json()).login === 'igor');

        const status = await runProjectCLI(
          ['status', '--json'],
          undefined,
          directory,
        );

        assert(
          status.code === 0 &&
            ![clientSecret, code, token].some((secret) =>
              status.stdout.includes(secret)
            ),
        );
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);
