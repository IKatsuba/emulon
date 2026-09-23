import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import github from '../src/mod.ts';
import resend from '@emulon/resend';
import { providerEvent, signature, transport } from '../src/webhooks/mod.ts';
import { listen } from '../../emulon/src/runtime/http.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { parity } from '../../resend/tests/helpers/parity.ts';

export const { cases, register } = caseRegistry(
  'packages/github/tests/webhooks_cases.ts',
);
const equal = (actual: unknown, expected: unknown) =>
  parity('GitHub webhooks', 'value', actual, expected);
const data = {
  issue: { id: 123, number: 99, title: 'Synthetic 🌍' },
  repository: {
    id: 456,
    name: 'absent',
    full_name: 'nobody/absent',
    private: true,
  },
  sender: { id: 789, login: 'nobody', type: 'User' as const },
};

register(
  'github.webhooks.1',
  [],
  ['issues.opened'],
  true,
  'GitHub mapping is pure, validates projections and matches the documented HMAC vector',
  async () => {
    const before = structuredClone(data);

    equal(providerEvent('issues.opened', data), {
      name: 'issues',
      payload: { ...data, action: 'opened' },
    });
    equal(data, before);

    for (
      const [type, payload] of [
        ['issues.closed', data],
        ['issues.opened', {}],
        [
          'issues.opened',
          { ...data, action: 'closed' },
        ],
      ] as const
    ) {
      let rejected = false;

      try {
        providerEvent(type, payload);
      } catch {
        rejected = true;
      }

      equal(rejected, true);
    }

    equal(
      await signature(
        new TextEncoder().encode('Hello, World!'),
        "It's a Secret to Everybody",
      ),
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    );

    for (const attempt of [1, 2, 100]) {
      equal(transport.retryDelayMs(attempt), undefined);
    }
  },
);
register(
  'github.webhooks.2',
  [],
  ['issues.opened'],
  true,
  'GitHub loopback delivery: signed issue, failed attempt, CLI redelivery and mutation-free publish/send',
  async () => {
    const directory = await Deno.makeTempDir();
    const secret = 'local-secret-🌍';
    let status = 503;
    const requests: { body: Uint8Array<ArrayBuffer>; headers: Headers }[] = [];
    const receiver = await listen(async (request) => {
      requests.push({
        body: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
      });

      return new Response(secret, { status });
    });

    let ctx!: PluginContext;
    const { definition } = readRegistration(github());
    const observed = definePlugin({
      ...definition,
      setup(context, options) {
        ctx = context;

        return definition.setup(context, options);
      },
    });
    const config = {
      services: {
        github: observed({
          webhooks: { url: receiver.url, secret },
          fixtures: {
            users: [{ login: 'igor' }],
            repositories: [{ owner: 'igor', name: 'demo' }],
          },
        }),
      },
    };

    try {
      await Deno.writeTextFile(`${directory}/event.json`, JSON.stringify(data));

      await using _host = await serveEnvironment(config, { directory });
      await using env = await Emulon.connect({ config, directory });
      const gh = env.services.github;
      const cli = async (args: string[]) => {
        const result = await runProjectCLI(
          ['github', ...args, '--json'],
          undefined,
          directory,
        );

        equal(result.stderr, '');
        equal(result.code, 0);

        return JSON.parse(result.stdout);
      };

      const issue = await gh.issues.create({
        repository: 'igor/demo',
        title: 'Bug 🌍',
        body: 'line\nnext',
      });
      const deliveries = await cli(['webhooks', 'list']);

      equal(deliveries.length, 1);

      const id = deliveries[0].id;

      equal(
        (await gh.webhooks.wait({ id, status: 'failed', timeout: '1s' }))
          .status,
        'failed',
      );

      const failed = await gh.webhooks.inspect({ id });

      equal(failed.attempts.length, 1);
      equal(failed.delivery.nextAttemptAt, undefined);
      equal(failed.attempts[0]!.responseStatus, 503);
      equal(requests.length, 1);
      equal(
        JSON.parse(new TextDecoder().decode(requests[0]!.body)).issue,
        issue,
      );
      equal(
        JSON.parse(new TextDecoder().decode(requests[0]!.body)).action,
        'opened',
      );

      // Repeated command-triggered worker passes must not retry a failed delivery.
      for (let i = 0; i < 3; i++) {
        await gh.webhooks.list();
      }

      equal(requests.length, 1);

      status = 200;

      await cli(['webhooks', 'redeliver', id]);
      equal(
        (await cli([
          'webhooks',
          'wait',
          id,
          '--status',
          'succeeded',
          '--timeout',
          '1s',
        ])).status,
        'succeeded',
      );

      const inspected = await cli(['webhooks', 'inspect', id]);

      equal(inspected.attempts.length, 2);
      equal(requests.length, 2);
      equal(Array.from(requests[0]!.body), Array.from(requests[1]!.body));
      equal(
        requests[0]!.headers.get('x-github-delivery') ===
          requests[1]!.headers.get('x-github-delivery'),
        false,
      );

      for (const request of requests) {
        equal(request.headers.get('x-github-event'), 'issues');

        const signature = request.headers.get('x-hub-signature-256')!;

        equal(signature.startsWith('sha256='), true);

        const digest = Uint8Array.from(
          signature.slice(7).match(/../g)!,
          (byte) => parseInt(byte, 16),
        );
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify'],
        );

        equal(
          await crypto.subtle.verify('HMAC', key, digest, request.body),
          true,
        );
        equal(
          await crypto.subtle.verify(
            'HMAC',
            key,
            digest,
            new TextEncoder().encode('changed'),
          ),
          false,
        );
      }

      for (
        const forbidden of [secret, 'x-hub-signature-256', 'responseBytes']
      ) {
        equal(JSON.stringify(inspected).includes(forbidden), false);
      }

      const snapshot = () =>
        ctx.store.transaction(async (tx) =>
          Object.fromEntries(
            await Promise.all(
              [
                'issues',
                'issue-counters',
                'users',
                'accounts',
                'repositories',
                'apps',
                'installations',
              ].map(async (
                collection,
              ) => [collection, await tx.list(collection)]),
            ),
          )
        );
      const before = await snapshot();
      const published = await cli([
        'events',
        'publish',
        'issues.opened',
        '--data',
        'event.json',
      ]);

      equal(published.origin, 'published');
      equal(requests.length, 3);
      equal(JSON.parse(new TextDecoder().decode(requests[2]!.body)), {
        ...data,
        action: 'opened',
      });

      const direct = await cli([
        'webhooks',
        'send',
        'issues.opened',
        '--data',
        'event.json',
        '--destination',
        'github',
      ]);

      equal(
        (await gh.webhooks.wait({
          id: direct.id,
          status: 'succeeded',
          timeout: '1s',
        })).status,
        'succeeded',
      );
      equal(requests.length, 4);
      equal(await snapshot(), before);
      equal((await env.events.list()).map((event) => event.origin), [
        'service',
        'published',
        'direct',
      ]);

      const invalid = await runProjectCLI(
        [
          'github',
          'events',
          'publish',
          'issues.closed',
          '--data',
          'event.json',
          '--json',
        ],
        undefined,
        directory,
      );

      equal(invalid.code, 1);
      equal((await env.events.list()).length, 3);
      await env.reset();
      equal(await gh.webhooks.list(), []);
      await gh.events.publish({ type: 'issues.opened', data });
      equal(requests.length, 5);
    } finally {
      await receiver.stop();
      await Deno.remove(directory, { recursive: true });
    }
  },
);
register(
  'github.webhooks.3',
  [],
  ['issues.opened'],
  true,
  'GitHub configuration accepts unsigned delivery and rejects unsafe destinations',
  async () => {
    let signature: string | null = 'not received';
    const receiver = await listen(async (request) => {
      signature = request.headers.get('x-hub-signature-256');

      await request.arrayBuffer();

      return new Response(null, { status: 204 });
    });

    try {
      await using env = await Emulon.start({
        services: { github: github({ webhooks: { url: receiver.url } }) },
      });

      await env.services.github.events.publish({ type: 'issues.opened', data });
      equal(signature, null);
      equal(
        (await env.services.github.webhooks.list())[0]!.status,
        'succeeded',
      );

      for (
        const url of [
          'file:///tmp/receiver',
          'https://user:password@example.test',
          'https://example.test/#fragment',
        ]
      ) {
        let rejected = false;

        try {
          github({ webhooks: { url } });
        } catch {
          rejected = true;
        }

        equal(rejected, true);
      }
    } finally {
      await receiver.stop();
    }
  },
);

register(
  'github.webhooks.4',
  [],
  ['issues.opened'],
  true,
  'Resend still rejects empty signing secrets at fixture and command boundaries',
  async () => {
    const destination = {
      id: 'receiver',
      url: 'http://127.0.0.1:1/',
      secret: '',
      types: ['email.sent'],
      enabled: true,
    };
    let rejected = false;

    try {
      await using _env = await Emulon.start({
        services: { mail: resend({ destinations: [destination] }) },
      });
    } catch {
      rejected = true;
    }

    equal(rejected, true);

    await using env = await Emulon.start({ services: { mail: resend() } });

    rejected = false;

    try {
      await env.services.mail.webhooks.configure(destination);
    } catch {
      rejected = true;
    }

    equal(rejected, true);
    equal(await env.services.mail.webhooks.destinations(), []);
  },
);
