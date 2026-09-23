import { definePlugin, Emulon, type PluginContext } from 'emulon';
import github from '@emulon/github';
import resend from '@emulon/resend';
import { readRegistration } from '../src/plugins/define.ts';
import { serveEnvironment } from '../src/control/server.ts';
import { readDiscovery } from '../src/runtime/discovery.ts';
import { request } from '../src/control/client.ts';
import { startWithAdapter } from '../src/sdk/start.ts';
import { memoryAdapter, type Store } from '../src/state/store.ts';
import { CommandError } from '../src/commands/registry.ts';
import { runProjectCLI } from '../src/cli/project.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);

  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Lifecycle barrier timed out')),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resetting(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof CommandError && error.code === 'ENVIRONMENT_RESETTING',
      String(error),
    );

    return;
  }

  throw new Error('Expected reset rejection');
}

const mailData = {
  // deno-lint-ignore camelcase
  email_id: '00000000-0000-4000-8000-000000000001',
  from: 'a@example.test',
  to: ['b@example.test'],
  subject: 'Before reset',
};

Deno.test('event snapshots crossing reset reject, including reads delayed until the new generation', async () => {
  const base = memoryAdapter();
  const entered = gate();
  const release = gate();
  let hold = false;
  await using env = await startWithAdapter({
    services: {
      github: github({
        fixtures: {
          users: [{ login: 'igor' }],
          repositories: [{ owner: 'igor', name: 'demo', private: true }],
        },
      }),
      mail: resend(),
    },
  }, {
    async open(input) {
      const handle = await base.open(input);
      const source = handle.store;

      return {
        ...handle,
        store: {
          ...source,
          async transaction(work) {
            if (hold && input.instanceId === 'mail') {
              entered.resolve();
              await release.promise;
            }

            return await source.transaction(work);
          },
        },
      };
    },
  });

  await env.services.github.issues.create({
    repository: 'igor/demo',
    title: 'Old generation',
  });

  const buffered = (await env.events.follow()).getReader();

  await env.services.mail.events.publish({
    type: 'email.sent',
    data: mailData,
  });
  assert((await env.events.list()).length === 2);

  const stream = (await env.events.follow()).getReader();
  const interrupted = resetting(stream.read());

  hold = true;

  const pending = resetting(env.events.list());

  try {
    await bounded(entered.promise);
    await env.reset();

    hold = false;

    release.resolve();
    await pending;
    await interrupted;
    await resetting(buffered.read());
    await buffered.cancel().catch(() => {});

    assert((await env.events.list()).length === 0);

    const next = (await env.events.follow()).getReader();

    await env.services.mail.events.publish({
      type: 'email.sent',
      data: mailData,
    });
    assert((await next.read()).value?.type === 'email.sent');
    await next.cancel();
  } finally {
    hold = false;

    release.resolve();
    await stream.cancel().catch(() => {});
  }
});

Deno.test('project reset drains GitHub and Resend requests and deliveries, rejects observers, and revokes old credentials', async () => {
  const directory = await Deno.makeTempDir();
  const entered = gate();
  const release = gate();
  const received = gate();
  const delivered = gate();
  const stores: Store[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (req) => {
      await req.text();
      received.resolve();
      await delivered.promise;

      return new Response('ok');
    },
  );
  const gh = readRegistration(github()).definition;
  const mail = readRegistration(resend()).definition;

  function observe(ctx: PluginContext): PluginContext {
    stores.push(ctx.store);

    return {
      ...ctx,
      http: {
        ...ctx.http,
        surface(name, options) {
          const app = ctx.http.surface(name, options);

          app.use(async (c, next) => {
            if (c.req.header('x-test-hold')) {
              entered.resolve();
              await release.promise;
            }

            await next();
          });

          return app;
        },
      },
    };
  }

  const config = {
    services: {
      github: definePlugin({
        ...gh,
        setup: (ctx, options) => gh.setup(observe(ctx), options),
      })({
        fixtures: {
          users: [{ login: 'igor' }],
          repositories: [{ owner: 'igor', name: 'demo', private: true }],
        },
      }),
      mail: definePlugin({
        ...mail,
        setup: (ctx, options) => mail.setup(observe(ctx), options),
      })(),
    },
  };
  const host = await serveEnvironment(config, { directory });
  const env = await Emulon.connect({ config, directory });
  let pending: Promise<unknown> | undefined;
  let sending: Promise<unknown> | undefined;
  let reset: Promise<void> | undefined;

  try {
    const app = await env.services.github.apps.create({
      slug: 'reset-app',
      callbackUrls: ['http://127.0.0.1/callback'],
      permissions: { issues: 'write' },
    });

    await env.services.github.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/demo'],
    });

    const code = await env.services.github.authorization.approve({
      clientId: app.clientId,
      login: 'igor',
      repositories: ['igor/demo'],
      permissions: { issues: 'write' },
    });
    const tokenResponse = await fetch(
      env.endpoints.github.web + '/login/oauth/access_token',
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code: code.code,
        }),
      },
    );
    const { access_token: token } = await tokenResponse.json();

    assert(token);

    const key = await env.services.mail.keys.create();

    await env.services.mail.webhooks.configure({
      id: 'receiver',
      url: `http://127.0.0.1:${receiver.addr.port}`,
      secret: 'whsec_' + btoa('local-secret'),
      types: ['email.sent'],
      enabled: true,
    });

    pending = fetch(env.endpoints.github.api + '/repos/igor/demo/issues', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'x-test-hold': 'true',
      },
      body: JSON.stringify({ title: 'Admitted before reset' }),
    }).then(async (r) => {
      const body = await r.json();

      assert(
        r.status === 201 && body.title === 'Admitted before reset',
        JSON.stringify(body),
      );
    });

    await bounded(entered.promise);

    sending = fetch(env.endpoints.mail.api + '/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: mailData.from,
        to: mailData.to,
        subject: mailData.subject,
        text: 'Hello',
      }),
    }).then(async (r) => {
      const body = await r.json();

      assert(r.status === 200 && body.id, JSON.stringify(body));
    });

    await bounded(received.promise);
    assert(
      (await env.services.mail.webhooks.list()).some((d) =>
        d.status === 'in-flight'
      ),
    );
    assert((await env.events.list()).length === 1);

    reset = env.reset();

    let paused = false;

    for (let i = 0; i < 100; i++) {
      const probe = await fetch(env.endpoints.mail.api + '/health');

      await probe.text();

      if (probe.status === 503) {
        paused = true;

        break;
      }
    }

    assert(paused);
    await resetting(env.events.list());
    await resetting(env.events.follow());
    await resetting(env.services.mail.emails.list());

    const record = await readDiscovery({ directory });
    const head = await fetch(record.url + '/events?follow=true', {
      method: 'HEAD',
      headers: {
        authorization: 'Bearer ' + record.token,
        'x-emulon-environment': record.id,
      },
    });

    assert(head.status === 400);
    await head.body?.cancel();
    release.resolve();
    delivered.resolve();
    await bounded(Promise.all([pending, sending, reset]));
    assert((await env.events.list()).length === 0);
    assert((await env.services.mail.emails.list()).length === 0);
    assert((await env.services.mail.webhooks.list()).length === 0);

    for (const store of stores) {
      await store.transaction(async (tx) => {
        for (
          const name of [
            'emulon.deliveries',
            'emulon.attempts',
            'tokens',
            'authorizationCodes',
            'authorizationSessions',
            'userGrants',
            'keys',
            'issues',
            'apps',
          ]
        ) {
          assert((await tx.list(name)).length === 0, name + ' survived reset');
        }
      });
    }

    for (
      const [url, credential, status] of [[
        env.endpoints.github.api + '/user',
        token,
        401,
      ], [
        env.endpoints.mail.api + '/emails/' + mailData.email_id,
        key.apiKey,
        403,
      ]] as const
    ) {
      const denied = await fetch(url!, {
        headers: { Authorization: 'Bearer ' + credential },
      });

      assert(denied.status === status, 'Old credential survived reset');
      await denied.text();
    }

    await env.services.mail.events.publish({
      type: 'email.sent',
      data: mailData,
    });
    assert((await env.events.list()).length === 1);
  } finally {
    release.resolve();
    delivered.resolve();
    await Promise.allSettled([pending, sending, reset]);
    await env.dispose();
    await host.dispose();
    await receiver.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});

async function free(url: string) {
  const socket = Deno.listen({
    hostname: '127.0.0.1',
    port: Number(new URL(url).port),
  });

  socket.close();
  await Promise.resolve();
}

for (const failure of ['port', 'setup', 'ready'] as const) {
  Deno.test(`partial ${failure} failure rolls back real plugin listeners and preserves committed state and foreign ownership`, async () => {
    const directory = await Deno.makeTempDir();
    const config = { services: { github: github(), mail: resend() } };
    const originalServe = Deno.serve;
    const occupied = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const urls: string[] = [];
    let host = await serveEnvironment(config, { directory });
    const env = await Emulon.connect({ config, directory });
    const key = await env.services.mail.keys.create();

    await env.services.mail.events.publish({
      type: 'email.sent',
      data: mailData,
    });

    const before = await env.events.list();

    await env.dispose();
    await host.dispose();
    await Deno.writeTextFile(directory + '/keep.txt', 'foreign');
    await Deno.writeTextFile(directory + '/.emulon/foreign.json', 'foreign');

    try {
      let listens = 0;
      let collision = false;

      Deno.serve =
        ((options: Deno.ServeTcpOptions, handler: Deno.ServeHandler) => {
          listens++;

          let server;

          try {
            server = originalServe({
              ...options,
              ...(failure === 'port' && listens === 3
                ? { port: occupied.addr.port }
                : {}),
            }, handler);
          } catch (error) {
            collision = error instanceof Deno.errors.AddrInUse;

            throw error;
          }

          urls.push(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);

          return server;
        }) as typeof Deno.serve;

      const { definition } = readRegistration(resend());
      const broken = definePlugin({
        ...definition,
        async setup(ctx, options) {
          const instance = await definition.setup(ctx, options);

          if (failure === 'setup') {
            throw new Error('private-startup-secret');
          }

          if (failure === 'port') {
            return instance;
          }

          return {
            ...instance,
            ready() {
              throw new Error('private-startup-secret');
            },
          };
        },
      });
      const failed = await runProjectCLI(['up', '--json'], {
        services: { github: github(), mail: broken() },
      }, directory);

      assert(failed.code === 1 && failed.stdout === '');

      const error = JSON.parse(failed.stderr).error;

      assert(error.code === 'ENVIRONMENT_FAILED');

      const message = error.message;

      assert(
        message.includes('Service instance "mail" failed to start.') &&
          !message.includes('private-startup-secret'),
        message,
      );

      Deno.serve = originalServe;

      assert(
        collision === (failure === 'port'),
        'Expected actual occupied-port failure',
      );
      assert(urls.length >= 2);

      for (const url of urls) {
        await free(url);
      }

      const entries = Array.from(
        Deno.readDirSync(directory + '/.emulon'),
        (entry) => entry.name,
      ).sort();

      assert(
        JSON.stringify(entries) === JSON.stringify(['foreign.json', 'state']),
        JSON.stringify(entries),
      );
      assert(await Deno.readTextFile(directory + '/keep.txt') === 'foreign');
      assert(
        await Deno.readTextFile(directory + '/.emulon/foreign.json') ===
          'foreign',
      );

      let stillOwned = false;

      try {
        const unexpected = Deno.listen({
          hostname: '127.0.0.1',
          port: occupied.addr.port,
        });

        unexpected.close();
      } catch (error) {
        stillOwned = error instanceof Deno.errors.AddrInUse;
      }

      assert(stillOwned, 'Foreign listener was closed');

      host = await serveEnvironment(config, { directory });

      await using connected = await Emulon.connect({ config, directory });

      assert(
        JSON.stringify(await connected.events.list()) ===
          JSON.stringify(before),
      );

      const response = await fetch(
        connected.endpoints.mail.api + '/emails/' + mailData.email_id,
        { headers: { Authorization: 'Bearer ' + key.apiKey } },
      );

      assert(response.status === 404, 'Committed credential lost');
      await response.text();

      const record = await readDiscovery({ directory });

      await request(record, '/down', {});
      await host.finished;

      for (const endpoints of Object.values(host.identity.endpoints)) {
        for (const url of Object.values(endpoints)) {
          await free(url);
        }
      }

      await free(record.url);
    } finally {
      Deno.serve = originalServe;

      occupied.close();
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  });
}
