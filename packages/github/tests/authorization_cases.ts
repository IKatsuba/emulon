import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import github from '../src/mod.ts';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import {
  authorizationCodeSchema,
  authorizationLifetime,
  consumeAuthorizationCode,
  resolveAuthorization,
  secretHash,
  validAuthorizationCode,
} from '../src/auth/authorization.ts';
import { escapeHtml } from '../src/routes/authorization.ts';

export const { cases, register } = caseRegistry(
  'packages/github/tests/authorization_cases.ts',
);

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function rejects(fn: () => Promise<unknown>) {
  let rejected = false;

  try {
    await fn();
  } catch {
    rejected = true;
  }

  assert(rejected, 'Expected rejection');
}

const fixture = {
  fixtures: {
    users: [{ login: 'igor' }, { login: 'other' }],
    repositories: [{ owner: 'igor', name: 'demo', private: true }, {
      owner: 'other',
      name: 'repo',
    }],
  },
};

register(
  'github.authorization.1',
  ['authorization.start'],
  [],
  false,
  'authorization reaches callback, protects consent, binds and consumes codes atomically',
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
    const received: URL[] = [];
    const callbackServer = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen() {},
    }, (req) => {
      received.push(new URL(req.url));

      return new Response('Callback received');
    });

    try {
      await using env = await Emulon.start({
        services: { github: observed(fixture) },
      });
      const callback =
        `http://127.0.0.1:${callbackServer.addr.port}/callback?keep=yes`;
      const app = await env.services.github.apps.create({
        slug: 'consent-app',
        permissions: { issues: 'write', metadata: 'read' },
        callbackUrls: [callback, callback + '&second=yes'],
      });
      const state = 'a +%&=/?# Привет <script>"';
      const authorize = (params: Record<string, string> = {}) =>
        env.endpoints.github.web + '/login/oauth/authorize?' +
        new URLSearchParams({
          client_id: app.clientId,
          redirect_uri: callback,
          state,
          ...params,
        });
      const open = async (url = authorize()) => {
        const response = await fetch(url, { redirect: 'manual' });
        const html = await response.text();

        assert(response.status === 200, html);
        assert(response.headers.get('cache-control') === 'no-store');
        assert(
          response.headers.get('referrer-policy') === 'same-origin',
          'A same-origin form must retain its Origin header',
        );
        assert(
          response.headers.get('content-security-policy')?.includes(
            `form-action 'self' ${new URL(callback).origin};`,
          ),
          'Browser form policy must allow the validated callback redirect',
        );
        assert(!html.includes(app.privateKey));

        const session = /name="session" value="([^"]+)"/.exec(html)?.[1];

        assert(session, html);

        return { session, html };
      };

      const submit = (
        session: string,
        decision = 'approve',
        extra: Record<string, string> = {},
      ) =>
        fetch(env.endpoints.github.web + '/login/oauth/consent', {
          method: 'POST',
          headers: { Origin: env.endpoints.github.web! },
          redirect: 'manual',
          body: new URLSearchParams({
            session,
            decision,
            login: 'igor',
            repositories: 'igor/demo',
            'permission:issues': 'read',
            ...extra,
          }),
        });
      const { session, html } = await open();

      assert(
        html.includes('other/repo') && html.includes('Local Emulon consent') &&
          html.includes('value="write"'),
      );

      const approved = await submit(session, 'approve', {
        client_id: 'foreign',
        redirect_uri: 'https://example.invalid/steal',
        state: 'replaced',
      });

      await approved.text();
      assert(approved.status === 302);

      const location = approved.headers.get('location');

      assert(location);

      const callbackResponse = await fetch(location);

      assert(await callbackResponse.text() === 'Callback received');

      const returned = received[0]!;

      assert(
        returned.searchParams.get('state') === state &&
          returned.searchParams.get('keep') === 'yes',
      );

      const code = returned.searchParams.get('code');

      assert(code);

      const record = await ctx.store.transaction(async (tx) =>
        authorizationCodeSchema.parse(
          await tx.get('authorizationCodes', await secretHash(code)),
        )
      );

      assert(
        record.clientId === app.clientId && record.redirectUri === callback &&
          record.grant.permissions.issues === 'read' &&
          record.grant.repositories.join() === 'igor/demo',
      );
      assert(
        validAuthorizationCode(
          record,
          app.clientId,
          callback,
          now + authorizationLifetime - 1,
        ),
      );
      assert(
        !validAuthorizationCode(
          record,
          app.clientId,
          callback,
          now + authorizationLifetime,
        ),
      );

      for (
        const [client, redirect] of [['other-client', callback], [
          app.clientId,
          callback + '&second=yes',
        ]]
      ) {
        await rejects(() =>
          ctx.store.transaction((tx) =>
            consumeAuthorizationCode(tx, code, client!, redirect!, now)
          )
        );
      }

      await rejects(() =>
        ctx.store.transaction(async (tx) => {
          await consumeAuthorizationCode(tx, code, app.clientId, callback, now);

          throw new Error('Simulated token issuance failure');
        })
      );

      const raced = await Promise.allSettled(
        [1, 2].map(() =>
          ctx.store.transaction((tx) =>
            consumeAuthorizationCode(tx, code, app.clientId, callback, now)
          )
        ),
      );

      assert(
        raced.filter((r) => r.status === 'fulfilled').length === 1,
        'Code was consumed twice',
      );

      const replay = await submit(session);

      assert(replay.status === 400);
      await replay.text();

      const denied = await submit((await open()).session, 'deny');

      assert(denied.status === 302);

      const deniedUrl = new URL(denied.headers.get('location')!);

      assert(
        deniedUrl.searchParams.get('error') === 'access_denied' &&
          deniedUrl.searchParams.get('state') === state &&
          !deniedUrl.searchParams.has('code'),
      );
      await denied.text();

      const unknown = await fetch(authorize({ client_id: 'unknown' }), {
        redirect: 'manual',
      });

      assert(unknown.status === 404 && !unknown.headers.has('location'));
      await unknown.text();

      const mismatch = await fetch(
        authorize({ redirect_uri: 'https://example.invalid/steal' }),
        { redirect: 'manual' },
      );

      assert(mismatch.status === 302);

      const mismatchUrl = new URL(mismatch.headers.get('location')!);

      assert(
        mismatchUrl.origin === new URL(callback).origin &&
          mismatchUrl.searchParams.get('error') === 'redirect_uri_mismatch' &&
          mismatchUrl.searchParams.get('state') === state,
      );
      await mismatch.text();

      const invalidSession = (await open()).session;

      for (
        const extra of [
          { login: 'missing' },
          { repositories: 'missing/repo' },
          {
            'permission:metadata': 'write',
          },
        ]
      ) {
        const response = await submit(invalidSession, 'approve', extra);

        assert(response.status === 400);
        await response.text();
      }

      const crossOrigin = await fetch(
        env.endpoints.github.web + '/login/oauth/consent',
        {
          method: 'POST',
          headers: { Origin: 'https://example.invalid' },
          body: new URLSearchParams({
            session: invalidSession,
            decision: 'approve',
          }),
        },
      );

      assert(crossOrigin.status === 403);
      await crossOrigin.text();

      const pkce = await fetch(authorize({ code_challenge: 'unsupported' }));

      assert(pkce.status === 400);
      await pkce.text();

      const input = {
        clientId: app.clientId,
        redirectUri: callback,
        login: 'igor',
        repositories: [],
        permissions: {},
      };
      const expiring = await env.services.github.authorization.approve(input);

      now = Date.parse(expiring.expiresAt);

      await rejects(() =>
        ctx.store.transaction((tx) =>
          consumeAuthorizationCode(
            tx,
            expiring.code,
            app.clientId,
            callback,
            now,
          )
        )
      );

      const expiredForm = await submit(invalidSession);

      assert(expiredForm.status === 400);
      await expiredForm.text();

      const current = await env.services.github.authorization.approve(input);

      await env.reset();
      await rejects(() =>
        ctx.store.transaction((tx) =>
          consumeAuthorizationCode(
            tx,
            current.code,
            app.clientId,
            callback,
            now,
          )
        )
      );

      for (
        const collection of [
          'authorizationCodes',
          'authorizationSessions',
          'userGrants',
        ]
      ) {
        assert(
          (await ctx.store.transaction((tx) => tx.list(collection))).length ===
            0,
        );
      }
    } finally {
      await callbackServer.shutdown();
    }
  },
);

register(
  'github.authorization.2',
  ['authorization.start'],
  [],
  false,
  'headless authorization shares CLI/SDK contract and survives durable restart',
  async () => {
    const directory = await Deno.makeTempDir();
    let ctx!: PluginContext;
    const { definition } = readRegistration(github());
    const observed = definePlugin({
      ...definition,
      setup(context, options) {
        ctx = context;

        return definition.setup(context, options);
      },
    });
    const config = { services: { github: observed(fixture) } };

    try {
      let code = '';
      let clientId = '';
      const callback = 'http://127.0.0.1:3000/callback';

      {
        await using host = await serveEnvironment(config, { directory });
        await using env = await Emulon.connect({ config, directory });

        assert(
          env.endpoints.github.web === host.identity.endpoints.github?.web,
        );

        const app = await env.services.github.apps.create({
          slug: 'headless',
          callbackUrls: [callback],
        });

        clientId = app.clientId;

        const cli = await runProjectCLI(
          [
            'github',
            'authorization',
            'approve',
            '--client-id',
            clientId,
            '--login',
            'igor',
            '--repositories',
            '["igor/demo"]',
            '--permissions',
            '{}',
            '--state',
            'cli state',
            '--json',
          ],
          undefined,
          directory,
        );

        assert(cli.code === 0, cli.stderr);

        const result = JSON.parse(cli.stdout);

        code = result.code;

        assert(
          new URL(result.redirectUrl).searchParams.get('state') === 'cli state',
        );

        const sdk = await env.services.github.authorization.approve({
          clientId,
          login: 'igor',
          repositories: ['igor/demo'],
          permissions: {},
        });

        assert(
          sdk.code !== code &&
            Object.keys(sdk).sort().join() ===
              Object.keys(result).sort().join(),
        );

        await using isolated = await Emulon.start({
          services: { github: github(fixture) },
        });

        await rejects(() =>
          isolated.services.github.authorization.approve({
            clientId,
            login: 'igor',
            repositories: [],
            permissions: {},
          })
        );

        const status = await runProjectCLI(
          ['status', '--json'],
          undefined,
          directory,
        );

        assert(
          !status.stdout.includes(code) && !status.stdout.includes(sdk.code),
        );
      }

      {
        await using host = await serveEnvironment(config, { directory });

        assert(host.identity.endpoints.github?.web);
        await ctx.store.transaction((tx) =>
          consumeAuthorizationCode(
            tx,
            code,
            clientId,
            callback,
            ctx.clock.now(),
          )
        );
        await rejects(() =>
          ctx.store.transaction((tx) =>
            consumeAuthorizationCode(
              tx,
              code,
              clientId,
              callback,
              ctx.clock.now(),
            )
          )
        );
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'github.authorization.3',
  ['authorization.start'],
  [],
  false,
  'authorization resolution uses exact registered callbacks and escapes markup',
  () => {
    const app = {
      id: '1',
      slug: 'app',
      clientId: 'client',
      callbackUrls: ['http://127.0.0.1/callback'],
      permissions: {},
      events: [],
    };

    assert(
      resolveAuthorization([app], { clientId: 'client' }).kind === 'consent',
    );
    assert(resolveAuthorization([app], { clientId: '1' }).kind === 'page');
    assert(
      resolveAuthorization([app], {
        clientId: 'client',
        redirectUri: 'http://127.0.0.1/callback/extra',
      }).kind === 'redirect',
    );
    assert(
      resolveAuthorization(
        [{ ...app, callbackUrls: ['javascript:alert(1)'] }],
        {
          clientId: 'client',
        },
      ).kind === 'page',
    );
    assert(escapeHtml('<script>"&\'') === '&lt;script&gt;&quot;&amp;&#39;');
  },
);
