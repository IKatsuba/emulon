import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { sign } from './helpers/jwt.ts';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import github from '../src/mod.ts';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { authenticateInstallation } from '../src/auth/operations.ts';
import { AuthError, authResponse, type Failure } from '../src/auth/errors.ts';
import {
  narrowPermissions,
  narrowRepositories,
  tokenExpiry,
} from '../src/auth/tokens.ts';
import { validateTimes } from '../src/auth/jwt.ts';
import { parity } from '../../resend/tests/helpers/parity.ts';

export const { cases, register } = caseRegistry(
  'packages/github/tests/auth_cases.ts',
);

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function equals(actual: unknown, expected: unknown) {
  parity('auth', 'result', actual, expected);
}

function fails(work: () => unknown, reason: Failure) {
  try {
    work();
  } catch (error) {
    assert(
      error instanceof AuthError && error.reason === reason,
      `Expected ${reason}`,
    );

    return;
  }

  throw new Error(`Accepted ${reason}`);
}

register(
  'github.auth.1',
  ['app.get', 'installation-token.create'],
  [],
  false,
  'pure auth rules enforce exact time boundaries and non-expanding grants',
  () => {
    const now = 1_800_000_000_000;
    const seconds = now / 1000;

    validateTimes({ iat: seconds - 60, exp: seconds + 600 }, now);
    fails(() => validateTimes({ iat: seconds, exp: seconds }, now), 'expired');
    fails(
      () => validateTimes({ iat: seconds, exp: seconds + 601 }, now),
      'future',
    );
    fails(
      () => validateTimes({ iat: seconds + 1, exp: seconds + 60 }, now),
      'issuedAt',
    );

    for (const value of [undefined, '1', null, 1.5, Infinity]) {
      fails(
        () => validateTimes({ iat: value, exp: seconds + 60 }, now),
        'issuedAt',
      );
      fails(() => validateTimes({ iat: seconds, exp: value }, now), 'expired');
    }

    equals(tokenExpiry(now), now + 3600_000);
    equals(
      narrowPermissions({ issues: 'write', metadata: 'read' }, {
        issues: 'read',
      }),
      { issues: 'read' },
    );
    equals(narrowPermissions({ issues: 'write' }, {}), {});
    fails(
      () => narrowPermissions({ issues: 'read' }, { issues: 'write' }),
      'permissions',
    );
    fails(
      () => narrowPermissions({}, { toString: 'read' as const }),
      'permissions',
    );
    fails(() => narrowRepositories(['a/b'], ['c/d']), 'repositories');
    equals(narrowRepositories(['a/b'], []), []);
  },
);
register(
  'github.auth.2',
  ['app.get', 'installation-token.create'],
  [],
  false,
  'app credentials drive local JWT issuance, failures, narrowing and token isolation',
  async () => {
    let now = 1_800_000_000_000;
    const contexts: PluginContext[] = [];
    const { definition } = readRegistration(github());
    const observed = definePlugin({
      ...definition,
      setup(ctx, options) {
        const context = { ...ctx, clock: { now: () => now } };

        contexts.push(context);

        return definition.setup(context, options);
      },
    });
    const options = {
      fixtures: {
        users: [{ login: 'igor' }, { login: 'other' }],
        repositories: [{ owner: 'igor', name: 'one' }, {
          owner: 'igor',
          name: 'two',
        }, { owner: 'other', name: 'one' }],
      },
    };
    await using env = await Emulon.start({
      services: { github: observed(options), other: observed(options) },
    });
    await using foreign = await Emulon.start({
      services: { github: observed(options) },
    });
    const gh = env.services.github;
    const app = await gh.apps.create({
      slug: 'bot',
      permissions: { issues: 'write', metadata: 'read' },
      webhook: { url: 'http://127.0.0.1:1', secret: 'webhook-secret' },
    });
    const otherApp = await gh.apps.create({ slug: 'other' });
    const installation = await gh.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/one', 'igor/two'],
    });
    const otherInstallation = await gh.installations.create({
      appId: otherApp.id,
      account: 'other',
      repositories: ['other/one'],
    });
    const claims = { iss: app.id, iat: now / 1000 - 60, exp: now / 1000 + 600 };
    const jwt = await sign(app.privateKey, claims);
    const api = env.endpoints.github.api!;
    const tokenPath = `/app/installations/${installation.id}/access_tokens`;

    async function request(
      path: string,
      token = jwt,
      input?: unknown,
      endpoint = api,
    ) {
      const response = await fetch(endpoint + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}` },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });

      return { status: response.status, body: await response.json() };
    }

    async function failure(
      path: string,
      token: string,
      input: unknown | undefined,
      status: number,
      message: string,
    ) {
      equals(await request(path, token, input), {
        status,
        body: {
          message,
          documentation_url: 'https://docs.github.com/rest',
          status: String(status),
        },
      });
    }

    const view = await request('/app');

    equals(view.status, 200);
    equals(view.body.id, Number(app.id));
    assert(
      !JSON.stringify(view).includes('PRIVATE KEY') &&
        !JSON.stringify(view).includes('webhook-secret'),
      'App route leaked secrets',
    );
    equals(
      (await request(
        '/app',
        await sign(app.privateKey, { ...claims, iss: app.clientId }),
      )).status,
      200,
    );

    const list = await request('/app/installations');

    equals(list.body.map((v: { id: number }) => v.id), [
      Number(installation.id),
    ]);
    equals((await request('/app/installations?page=2&per_page=1')).body, []);

    for (
      const [changes, alg, message] of [
        [
          { exp: now / 1000 },
          'RS256',
          "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires",
        ],
        [
          { exp: now / 1000 + 601 },
          'RS256',
          "'Expiration time' claim ('exp') must not be more than 10 minutes in the future",
        ],
        [
          { iat: now / 1000 + 1 },
          'RS256',
          "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued",
        ],
        [{}, 'HS256', 'Invalid JWT algorithm. Expected RS256.'],
        [{ iss: 'unknown' }, 'RS256', 'Invalid issuer'],
      ] as const
    ) {
      await failure(
        '/app',
        await sign(app.privateKey, { ...claims, ...changes }, alg),
        undefined,
        401,
        message,
      );
    }

    await failure(
      '/app',
      await sign(otherApp.privateKey, claims),
      undefined,
      401,
      'A JSON web token could not be decoded',
    );
    await failure(
      '/app',
      jwt.slice(0, -8) + 'AAAAAAAA',
      undefined,
      401,
      'A JSON web token could not be decoded',
    );

    for (const malformed of ['', 'x.y.z', 'e30=.e30.AA', 'bnVsbA.e30.AA']) {
      await failure(
        '/app',
        malformed,
        undefined,
        401,
        'A JSON web token could not be decoded',
      );
    }

    await failure(
      `/app/installations/${otherInstallation.id}/access_tokens`,
      jwt,
      {},
      404,
      'Not Found',
    );
    await failure(
      tokenPath,
      jwt,
      { permissions: { contents: 'write' } },
      422,
      'The permissions requested are not granted to this installation.',
    );
    await failure(
      tokenPath,
      jwt,
      { permissions: { metadata: 'write' } },
      422,
      'The permissions requested are not granted to this installation.',
    );
    await failure(
      tokenPath,
      jwt,
      { repositories: ['missing'] },
      422,
      'The repositories requested are not available to this installation.',
    );
    await failure(
      tokenPath,
      jwt,
      { repository_ids: [1] },
      422,
      'The repositories requested are not available to this installation.',
    );
    await failure(
      tokenPath,
      jwt,
      { repositories: [], repository_ids: [] },
      422,
      'Invalid request',
    );
    await gh.installations.suspend({ id: installation.id });
    await failure(
      tokenPath,
      jwt,
      {},
      403,
      'This installation has been suspended',
    );
    await gh.installations.unsuspend({ id: installation.id });
    equals(
      await contexts[0]!.store.transaction(async (tx) =>
        (await tx.list('tokens')).length
      ),
      0,
    );

    const unsupportedVersion = await fetch(api + '/app', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2099-01-01',
      },
    });

    equals(unsupportedVersion.status, 400);
    equals(await unsupportedVersion.json(), {
      message: 'Not a supported version',
      documentation_url: 'https://docs.github.com/rest',
      status: '400',
    });

    const defaultResponse = await fetch(api + tokenPath, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });

    equals(defaultResponse.status, 201);

    const defaultToken = await defaultResponse.json();

    equals(defaultToken.permissions, { issues: 'write', metadata: 'read' });
    equals(defaultToken.repositories.length, 2);

    const emptyScope = await request(tokenPath, jwt, {
      repositories: [],
      permissions: {},
    });

    equals(emptyScope.body.repositories, []);
    equals(emptyScope.body.permissions, {});

    const issued = await request(tokenPath, jwt, {
      repositories: ['one'],
      permissions: { issues: 'read' },
    });

    equals(issued.status, 201);
    equals(issued.body.expires_at, new Date(now + 3600_000).toISOString());
    equals(issued.body.permissions, { issues: 'read' });
    equals(issued.body.repository_selection, 'selected');
    equals(
      issued.body.repositories.map((r: { full_name: string }) => r.full_name),
      ['igor/one'],
    );
    assert(/^ghs_[a-f0-9]{64}$/.test(issued.body.token), 'Token is not opaque');

    const byId = await request(tokenPath, jwt, {
      repository_ids: [issued.body.repositories[0].id],
    });

    equals(byId.status, 201);
    assert(byId.body.token !== issued.body.token, 'Token reused');

    const context = contexts[0]!;
    const check = (ctx = context, id = installation.id) =>
      ctx.store.transaction((tx) =>
        authenticateInstallation(tx, `Bearer ${issued.body.token}`, id, now)
      );

    equals((await check()).repositories, ['igor/one']);

    async function denied(
      work: () => Promise<unknown>,
      status: number,
      message: string,
    ) {
      try {
        await work();
      } catch (error) {
        assert(error instanceof AuthError, 'Unexpected error type');

        const response = authResponse(error.reason);

        equals(response.status, status);
        equals(await response.json(), {
          message,
          documentation_url: 'https://docs.github.com/rest',
          status: String(status),
        });

        return;
      }

      throw new Error('Token was accepted');
    }

    await denied(() => check(context, otherInstallation.id), 404, 'Not Found');

    for (const ctx of contexts.slice(1)) {
      await denied(() => check(ctx), 401, 'Bad credentials');
    }

    await gh.installations.suspend({ id: installation.id });
    await denied(() => check(), 403, 'This installation has been suspended');
    await gh.installations.unsuspend({ id: installation.id });
    await context.store.transaction(async (tx) => {
      const grant = await tx.get('grants', installation.id) as Record<
        string,
        unknown
      >;

      await tx.put({
        collection: 'grants',
        id: installation.id,
        value: { ...grant, repositoryIds: [], permissions: {} },
      });
    });

    equals((await check()).repositories, []);
    equals((await check()).permissions, {});

    now += 3600_000 - 1;

    await check();
    now++;
    await denied(() => check(), 401, 'Bad credentials');

    now -= 3600_000;

    await env.reset();
    await denied(() => check(), 401, 'Bad credentials');
    equals(
      (await request('/app', jwt, undefined, foreign.endpoints.github.api!))
        .status,
      401,
    );
  },
);
