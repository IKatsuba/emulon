import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { Emulon } from 'emulon';
import resend from '../src/mod.ts';
import { listen } from '../../emulon/src/runtime/http.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { startWithAdapter } from '../../emulon/src/sdk/start.ts';
import {
  memoryAdapter,
  type StateAdapter,
  type StateHandle,
} from '../../emulon/src/state/store.ts';
import {
  deliveryFaultsSchema,
  faultSchedule,
} from '../../emulon/src/deliveries/faults.ts';

export const { cases, register } = caseRegistry(
  'packages/resend/tests/delivery_scenarios_cases.ts',
);

function check(condition: unknown, boundary: string): asserts condition {
  if (!condition) {
    throw new Error(`Delivery verification: ${boundary}`);
  }
}

const data = {
  // deno-lint-ignore camelcase
  email_id: '11111111-1111-4111-8111-111111111111',
  from: 'a@example.test',
  to: ['b@example.test'],
  subject: 'Exact 🌍 bytes',
};
const secret = `whsec_${btoa('scenario-secret')}`;

type Received = { body: Uint8Array<ArrayBuffer>; headers: Headers };

async function verify(request: Received) {
  const prefix = new TextEncoder().encode(
    `${request.headers.get('svix-id')}.${
      request.headers.get('svix-timestamp')
    }.`,
  );
  const content = new Uint8Array(prefix.length + request.body.length);

  content.set(prefix);
  content.set(request.body, prefix.length);

  if (Deno.args.includes('--inject-signature-mismatch')) {
    content[content.length - 1] = content[content.length - 1]! ^ 1;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('scenario-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signature = Uint8Array.from(
    atob(request.headers.get('svix-signature')!.slice(3)),
    (c) => c.charCodeAt(0),
  );

  check(
    await crypto.subtle.verify('HMAC', key, signature, content),
    'signature does not match exact received bytes',
  );
}

register(
  'resend.delivery_scenarios.1',
  [],
  [],
  true,
  'delivery scenarios through one control API',
  async (t) => {
    const directory = await Deno.makeTempDir();
    const received: Received[] = [];
    let status = 503;
    const receiver = await listen(async (request) => {
      received.push({
        body: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
      });

      return new Response('processed', { status });
    });

    const config = {
      services: {
        mail: resend({
          destinations: [{
            id: 'app',
            url: receiver.url,
            secret,
            types: ['email.sent'],
            enabled: true,
          }],
        }),
        other: resend(),
      },
    };

    try {
      await using _host = await serveEnvironment(config, { directory });
      await using env = await Emulon.connect({ config, directory });
      const mail = env.services.mail;
      const step = async (name: string, run: () => Promise<void>) => {
        check(await t.step(name, run), `scenario failed: ${name}`);
      };

      const cli = async (args: string[]) => {
        const result = await runProjectCLI(
          ['mail', ...args, '--json'],
          config,
          directory,
        );

        check(result.code === 0, `CLI failed: ${result.stderr}`);

        return JSON.parse(result.stdout);
      };

      await Deno.writeTextFile(`${directory}/event.json`, JSON.stringify(data));
      await step(
        'failed attempt, exact-byte signature and explicit redelivery',
        async () => {
          const sent = await cli([
            'webhooks',
            'send',
            'email.sent',
            '--data',
            'event.json',
            '--destination',
            'app',
          ]);
          const failed = await mail.webhooks.inspect({ id: sent.id });

          check(
            failed.delivery.status === 'failed' &&
              failed.attempts[0]?.errorCode === 'HTTP_STATUS',
            'failed attempt must be retained',
          );
          await verify(received[0]!);
          check(
            JSON.stringify(failed.attempts[0]!.requestBytes) ===
              JSON.stringify(Array.from(received[0]!.body)),
            'inspection must retain sent bytes',
          );

          let mismatch = '';

          try {
            await verify({
              ...received[0]!,
              body: new TextEncoder().encode('different body'),
            });
          } catch (error) {
            mismatch = (error as Error).message;
          }

          check(
            mismatch.includes('signature does not match exact received bytes'),
            'intentional signature mismatch must fail clearly',
          );

          status = 200;

          await mail.webhooks.redeliver({ id: sent.id });

          const retried = await mail.webhooks.inspect({ id: sent.id });

          check(
            retried.delivery.status === 'succeeded' &&
              retried.attempts.length === 2,
            'redelivery must append a successful attempt',
          );
          check(
            JSON.stringify(retried.attempts[0]!.requestBytes) ===
              JSON.stringify(retried.attempts[1]!.requestBytes),
            'redelivery preserves exact bytes',
          );
        },
      );
      await step(
        'receiver success followed by simulated response loss is unknown; redelivery can duplicate processing',
        async () => {
          await cli([
            'webhooks',
            'faults',
            '--delay-ms',
            '0',
            '--lose-response',
            'true',
          ]);

          const before = received.length;
          const sent = await mail.webhooks.send({
            type: 'email.sent',
            data,
            destination: 'app',
          });
          const lost = await mail.webhooks.inspect({ id: sent.id });

          check(
            received.length === before + 1,
            'receiver processed before response loss',
          );
          check(
            lost.delivery.status === 'failed' &&
              lost.attempts[0]?.outcome === 'unknown',
            'lost response must expose unknown receiver outcome',
          );
          check(
            lost.attempts[0]?.responseStatus === undefined,
            'lost response cannot claim acknowledged success',
          );
          await mail.webhooks.redeliver({ id: sent.id });

          const retried = await mail.webhooks.inspect({ id: sent.id });

          check(
            received.length === before + 2 && retried.attempts.length === 2,
            'duplicate processing remains visible in attempts',
          );
          check(
            retried.attempts[0]?.providerDeliveryId ===
              retried.attempts[1]?.providerDeliveryId,
            'redelivery preserves provider identity',
          );
          await mail.webhooks.faults({ delayMs: 0, loseResponse: false });
        },
      );
      await step(
        'delayed delivery allows later events first; duplicate publications remain distinct',
        async () => {
          await mail.webhooks.faults({ delayMs: 1000, loseResponse: false });

          const before = received.length;
          const delayed = await mail.webhooks.send({
            type: 'email.sent',
            data: { ...data, subject: 'delayed' },
            destination: 'app',
          });

          check(
            received.length === before,
            'delayed delivery must remain queued',
          );
          await mail.webhooks.faults({ delayMs: 0, loseResponse: false });

          const first = await cli([
            'events',
            'publish',
            'email.sent',
            '--data',
            'event.json',
          ]);
          const second = await mail.events.publish({
            type: 'email.sent',
            data,
          });

          check(
            first.id !== second.id,
            'duplicate payloads must have distinct event records',
          );
          await mail.webhooks.wait({
            id: delayed.id,
            status: 'succeeded',
            timeout: '10s',
          });

          const subjects = received.slice(before).map((r) =>
            JSON.parse(new TextDecoder().decode(r.body)).data.subject
          );

          check(
            JSON.stringify(subjects) ===
              JSON.stringify([data.subject, data.subject, 'delayed']),
            'later publications must arrive before delayed delivery',
          );

          const deliveries = await mail.webhooks.list();

          check(
            deliveries.filter((d) =>
              d.eventId === first.id || d.eventId === second.id
            ).length === 2,
            'duplicate publications retain separate deliveries',
          );
          check(
            (await mail.emails.list()).length === 0,
            'publication and direct sending must not mutate business state',
          );
          check(
            (await env.services.other.webhooks.list()).length === 0,
            'fault scenarios stay within the chosen instance',
          );

          for (const request of received) {
            await verify(request);
          }
        },
      );
      console.log(
        'Delivery report: exact bytes/signatures; mismatch detection; failed attempts; redelivery; unknown receiver outcome; duplicates; delay/order; CLI/SDK non-mutation; instance isolation.',
      );
    } finally {
      await receiver.stop();
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'resend.delivery_scenarios.2',
  [],
  [],
  true,
  'retained-state restart recovers outbox and pending deliveries without duplicates',
  async () => {
    let calls = 0;
    const receiver = await listen(async (request) => {
      await request.text();
      calls++;

      return new Response('ok');
    });

    let retained: StateHandle | undefined;
    const adapter: StateAdapter = {
      async open(input) {
        retained ??= await memoryAdapter().open(input);

        return { ...retained, close() {} };
      },
    };
    const config = {
      services: {
        mail: resend({
          destinations: [{
            id: 'app',
            url: receiver.url,
            secret,
            types: ['email.sent'],
            enabled: true,
          }],
        }),
      },
    };

    try {
      const first = await startWithAdapter(config, adapter, 'restart');

      await first.services.mail.webhooks.faults({
        delayMs: 86400000,
        loseResponse: false,
      });

      const pending = await first.services.mail.webhooks.send({
        type: 'email.sent',
        data,
        destination: 'app',
      });

      await first.dispose();

      const store = retained!.store;

      await store.transaction(async (tx) => {
        await tx.delete('emulon.faults', 'delivery');
        await tx.put({
          collection: 'emulon.deliveries',
          id: 'interrupted',
          value: { ...pending, id: 'interrupted', status: 'in-flight' },
        });
        await tx.put({
          collection: 'emulon.attempts',
          id: 'interrupted-attempt',
          value: {
            id: 'interrupted-attempt',
            deliveryId: 'interrupted',
            startedAt: new Date().toISOString(),
            providerDeliveryId: 'interrupted-provider',
            requestBytes: [123, 125],
            headers: {},
          },
        });
        await tx.put({
          collection: 'emulon.deliveries',
          id: pending.id,
          value: { ...pending, nextAttemptAt: '2000-01-01T00:00:00.000Z' },
        });
      });

      await Promise.all(
        Array.from(
          { length: 4 },
          (_, index) =>
            store.transaction(async (tx) => {
              await tx.put({
                collection: 'business',
                id: String(index),
                value: index,
              });
              await tx.record({
                type: 'email.sent',
                origin: 'service',
                occurredAt: new Date().toISOString(),
                payload: data,
              });
            }),
        ),
      );

      try {
        await store.transaction(async (tx) => {
          await tx.put({
            collection: 'business',
            id: 'rolled-back',
            value: true,
          });
          await tx.record({
            type: 'email.sent',
            origin: 'service',
            occurredAt: new Date().toISOString(),
            payload: data,
          });

          throw new Error('simulated transaction interruption');
        });
      } catch {
        /* The failed transaction must leave neither state nor event. */
      }

      const second = await startWithAdapter(config, adapter, 'restart');
      const deliveries = await second.services.mail.webhooks.list();

      check(
        deliveries.length === 6 &&
          deliveries.filter((d) => d.status === 'succeeded').length === 5,
        'restart must recover queued delivery and committed outbox',
      );
      check(
        (await second.events.list()).length === 5,
        'rolled-back event must be absent',
      );
      check(
        (await store.transaction((tx) => tx.list('business'))).length === 4,
        'concurrent state mutations must survive; rollback must be atomic',
      );

      const interrupted = await second.services.mail.webhooks.inspect({
        id: 'interrupted',
      });

      check(
        interrupted.delivery.status === 'failed' &&
          interrupted.attempts[0]?.outcome === 'unknown' &&
          interrupted.attempts[0]?.errorCode === 'INTERRUPTED',
        'interrupted attempts must recover as unknown without automatic replay',
      );
      await second.dispose();

      const third = await startWithAdapter(config, adapter, 'restart');

      try {
        check(
          JSON.stringify(await third.services.mail.webhooks.list()) ===
            JSON.stringify(deliveries),
          'repeated restart must preserve logical delivery IDs',
        );
        check(
          calls === 5,
          'repeated restart must not resend completed deliveries',
        );
      } finally {
        await third.dispose();
      }

      console.log(
        'Delivery report: retained-state worker/environment restart; concurrent atomic outbox commits; rollback; queued recovery; no duplicate logical deliveries or completed sends. This retained-memory scenario does not cover process exit; durable_process_test.ts supplies the separate crash proof.',
      );
    } finally {
      retained?.close();
      await receiver.stop();
    }
  },
);

register(
  'resend.delivery_scenarios.3',
  [],
  [],
  true,
  'fault validation and scheduling are bounded and deterministic',
  () => {
    check(
      faultSchedule({ delayMs: 100, loseResponse: false }, 0) ===
        '1970-01-01T00:00:00.100Z',
      'delay schedule',
    );

    for (const delayMs of [-1, 0.5, Infinity, 86400001]) {
      check(
        !deliveryFaultsSchema.safeParse({ delayMs, loseResponse: false })
          .success,
        'invalid delays rejected',
      );
    }

    check(
      !deliveryFaultsSchema.safeParse({ delayMs: 0, loseResponse: 'true' })
        .success,
      'invalid response-loss flag rejected',
    );
  },
);

register(
  'resend.delivery_scenarios.4',
  [],
  [],
  true,
  'receiver processing followed by a real broken HTTP response remains unknown',
  async () => {
    const { serveNode } = await import('../../emulon/src/runtime/http.ts');
    let processed = 0;
    const receiver = await serveNode(async (request) => {
      await request.arrayBuffer();
      processed++;

      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('Receiver response connection failure'));
          },
        }),
        // Force headers onto the wire before the body fails, avoiding adapter prefetch.
        { headers: { 'transfer-encoding': 'chunked' } },
      );
    });

    try {
      await using env = await Emulon.start({
        services: {
          mail: resend({
            destinations: [{
              id: 'app',
              url: receiver.url,
              secret,
              types: ['email.sent'],
              enabled: true,
            }],
          }),
        },
      });
      const delivery = await env.services.mail.webhooks.send({
        type: 'email.sent',
        data,
        destination: 'app',
      });
      const inspection = await env.services.mail.webhooks.inspect({
        id: delivery.id,
      });

      check(processed === 1, 'receiver must process before breaking response');
      check(
        inspection.delivery.status === 'failed' &&
          inspection.attempts[0]?.outcome === 'unknown' &&
          inspection.attempts[0]?.errorCode === 'TRANSPORT_ERROR',
        'real response failure must persist unknown outcome',
      );
    } finally {
      await receiver.stop();
    }
  },
);
