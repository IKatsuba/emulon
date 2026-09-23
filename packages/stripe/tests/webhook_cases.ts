import Stripe from 'stripe';
import stripe from '@emulon/stripe';
import {
  destinationFixture,
  Emulon,
  inspectDelivery,
  redeliverWebhook,
  sendWebhook,
  setDestination,
} from 'emulon';
import { memoryAdapter } from '../../emulon/src/state/store.ts';
import {
  type DeliveryScheduler,
  deliveryWorker,
  recoverAttempts,
} from '../../emulon/src/deliveries/worker.ts';
import {
  eventSchema,
  subscriptionPolicy,
  transport,
} from '../src/webhooks/mod.ts';
import {
  createCustomer,
  makeCustomer,
  version,
} from '../src/model/customers.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function rejects(action: () => unknown) {
  try {
    await action();
  } catch {
    return;
  }

  throw new Error('Expected rejection');
}

const secret = 'whsec_literal_utf8_£';
const event = eventSchema.parse({
  id: 'evt_synthetic',
  object: 'event',
  api_version: version,
  created: 1700000000,
  type: 'customer.created',
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  data: { object: makeCustomer({}, 'cus_synthetic', 1700000000000) },
});

function destination(url: string) {
  return {
    id: 'receiver',
    url,
    secret,
    types: ['customer.created'],
    enabled: true,
  };
}

class FakeScheduler implements DeliveryScheduler {
  time = Date.now();
  jobs = new Map<number, { due: number; callback: () => void }>();
  serial = 0;
  now = () => this.time;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.serial;

    this.jobs.set(id, { due: this.time + delay, callback });

    return () => {
      this.jobs.delete(id);
    };
  };
  advance(ms: number) {
    this.time += ms;

    for (const [id, job] of [...this.jobs]) {
      if (job.due <= this.time) {
        this.jobs.delete(id);
        job.callback();
      }
    }
  }
}

async function retryContract() {
  const timer = new FakeScheduler();
  let status = 500;
  let currentSecret = secret;
  const received: { body: string; signature: string }[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.text();
      const signature = request.headers.get('stripe-signature')!;
      const parsed = await Stripe.webhooks.constructEventAsync(
        body,
        signature,
        currentSecret,
        300,
        Stripe.createSubtleCryptoProvider(),
        timer.now(),
      );

      assert(parsed.id.startsWith('evt_'));
      received.push({ body, signature });

      return new Response('receiver secret', { status });
    },
  );
  const dest = destination(`http://127.0.0.1:${receiver.addr.port}`);
  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'stripe',
    version: { pluginVersion: '0.1.0', schemaVersion: 1 },
    fixtures: [destinationFixture(dest, subscriptionPolicy)],
  });
  const store = handle.store;
  const worker = deliveryWorker(store, transport, timer);

  try {
    await createCustomer(store, { name: 'One' });

    const original = (await store.transaction((tx) => tx.outbox()))[0]!;
    const delivery = await sendWebhook(store, {
      type: original.type,
      data: original.payload,
      destination: dest.id,
    });

    await worker.flush();
    assert(received.length === 1);
    await rejects(() => redeliverWebhook(store, delivery.id));

    for (const [index, delay] of [60000, 3600000, 7200000].entries()) {
      const inspection = await inspectDelivery(store, delivery.id);

      assert(
        Date.parse(inspection.delivery.nextAttemptAt!) === timer.now() + delay,
      );
      timer.advance(delay - 1);
      await worker.flush();
      assert(received.length === index + 1);

      if (index === 0) {
        currentSecret = 'whsec_rotated';

        await setDestination(
          store,
          { ...dest, secret: currentSecret },
          subscriptionPolicy,
        );
      }

      timer.advance(1);
      await worker.flush();
      assert(received.length === index + 2);
    }

    const terminal = await inspectDelivery(store, delivery.id);

    assert(
      terminal.delivery.status === 'failed' && terminal.attempts.length === 4,
    );
    assert(timer.jobs.size === 0);
    assert(received.every((r) => r.body === received[0]!.body));
    assert(new Set(received.map((r) => r.signature)).size === 4);
    assert(
      terminal.attempts.every((a) =>
        !Object.keys(a.headers).includes('stripe-signature')
      ),
    );
    assert(
      !JSON.stringify(terminal).includes(secret) &&
        !JSON.stringify(terminal).includes('receiver secret'),
    );
    await redeliverWebhook(store, delivery.id);

    status = 200;

    await worker.flush();
    assert(
      (await inspectDelivery(store, delivery.id)).delivery.status ===
        'succeeded',
    );
    assert(received[4]!.body === received[0]!.body && timer.jobs.size === 0);
    assert(
      (await store.transaction((tx) => tx.list('customers'))).length === 1,
    );

    const retrySuccess = await sendWebhook(store, {
      type: event.type,
      data: event,
      destination: dest.id,
    });

    status = 500;

    await worker.flush();

    status = 200;

    timer.advance(60000);
    await worker.flush();
    assert(
      (await inspectDelivery(store, retrySuccess.id)).attempts.length === 2,
    );
    assert(
      (await inspectDelivery(store, retrySuccess.id)).delivery.status ===
        'succeeded',
    );
    assert(timer.jobs.size === 0);

    const lost = await sendWebhook(store, {
      type: event.type,
      data: event,
      destination: dest.id,
    });

    await store.transaction((tx) =>
      tx.put({
        collection: 'emulon.deliveries',
        id: lost.id,
        value: { ...lost, loseResponse: true },
      })
    );
    await worker.flush();
    assert(
      (await inspectDelivery(store, lost.id)).attempts[0]!.outcome ===
        'unknown',
    );
    await setDestination(
      store,
      { ...dest, enabled: false },
      subscriptionPolicy,
    );
    await worker.flush();
    assert(
      (await inspectDelivery(store, lost.id)).delivery.status === 'cancelled',
    );
    assert(timer.jobs.size === 0);
    await setDestination(store, dest, subscriptionPolicy);

    currentSecret = secret;
    status = 500;

    const pending = await sendWebhook(store, {
      type: event.type,
      data: event,
      destination: dest.id,
    });

    await worker.flush();
    assert(Number(timer.jobs.size) === 1);
    await worker.pause();
    assert(timer.jobs.size === 0);
    await handle.reset();
    timer.advance(7200000);
    worker.resume();
    await worker.flush();
    await rejects(() => inspectDelivery(store, pending.id));

    const interrupted = await sendWebhook(store, {
      type: event.type,
      data: event,
      destination: dest.id,
    });

    await store.transaction((tx) =>
      tx.put({
        collection: 'emulon.deliveries',
        id: interrupted.id,
        value: { ...interrupted, status: 'in-flight' },
      })
    );
    await store.transaction((tx) =>
      tx.put({
        collection: 'emulon.attempts',
        id: 'interrupted',
        value: {
          id: 'interrupted',
          deliveryId: interrupted.id,
          startedAt: new Date(timer.now()).toISOString(),
          providerDeliveryId: 'interrupted',
          requestBytes: Array.from(
            new TextEncoder().encode(JSON.stringify(event)),
          ),
          headers: {},
        },
      })
    );
    await recoverAttempts(store);
    assert(
      (await inspectDelivery(store, interrupted.id)).delivery.status ===
        'failed',
    );

    const recovered = await inspectDelivery(store, interrupted.id);

    assert(
      recovered.attempts[0]!.outcome === 'unknown' &&
        recovered.attempts[0]!.errorCode === 'INTERRUPTED',
    );
  } finally {
    await worker.pause();
    handle.close();
    await receiver.shutdown();
  }
}

async function commandContract() {
  const received: string[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.text();

      await Stripe.webhooks.constructEventAsync(
        body,
        request.headers.get('stripe-signature')!,
        secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
      received.push(body);

      return new Response(null, { status: 204 });
    },
  );
  const directory = await Deno.makeTempDir();
  const config = {
    services: {
      stripe: stripe({
        destinations: [destination(`http://127.0.0.1:${receiver.addr.port}`)],
      }),
    },
  };
  const host = await serveEnvironment(config, { directory });

  try {
    await using env = await Emulon.connect({ config, directory });
    const service = env.services.stripe;
    const cli = async (args: string[]) => {
      const result = await runProjectCLI(
        ['stripe', ...args, '--json'],
        undefined,
        directory,
      );

      assert(result.code === 0, result.stderr);

      return JSON.parse(result.stdout);
    };

    const path = directory + '/event.json';

    await Deno.writeTextFile(path, JSON.stringify(event));

    const published = await cli([
      'events',
      'publish',
      event.type,
      '--data',
      path,
    ]);

    assert(published.origin === 'published');

    const list = await service.webhooks.list({});

    assert(list.length === 1);
    await service.webhooks.wait({
      id: list[0]!.id,
      status: 'succeeded',
      timeout: '5s',
    });

    const direct = await cli([
      'webhooks',
      'send',
      event.type,
      '--data',
      path,
      '--destination',
      'receiver',
    ]);

    await cli([
      'webhooks',
      'wait',
      direct.id,
      '--status',
      'succeeded',
      '--timeout',
      '5s',
    ]);

    const inspected = await cli(['webhooks', 'inspect', direct.id]);

    assert(
      inspected.attempts.length === 1 &&
        !JSON.stringify(inspected).includes(secret),
    );
    await cli(['webhooks', 'redeliver', direct.id]);
    await service.webhooks.wait({
      id: direct.id,
      status: 'succeeded',
      timeout: '5s',
    });
    assert(
      (await service.webhooks.inspect({ id: direct.id })).attempts.length === 2,
    );
    assert((await cli(['webhooks', 'list'])).length === 2);
    await service.events.publish({ type: event.type, data: event });

    const sent = await service.webhooks.send({
      type: event.type,
      data: event,
      destination: 'receiver',
    });

    await service.webhooks.wait({
      id: sent.id,
      status: 'succeeded',
      timeout: '5s',
    });
    await service.webhooks.redeliver({ id: sent.id });
    await service.webhooks.wait({
      id: sent.id,
      status: 'succeeded',
      timeout: '5s',
    });
    await rejects(() => service.customers.get({ id: 'cus_synthetic' }));
    await rejects(() =>
      service.events.publish({
        type: event.type,
        data: { ...event, livemode: true } as never,
      })
    );
    assert(received.every((body) => JSON.parse(body).id === event.id));
    await env.reset();
    assert((await service.webhooks.list({})).length === 0);
  } finally {
    await host[Symbol.asyncDispose]();
    await receiver.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

export const { cases, register } = caseRegistry(
  'packages/stripe/tests/webhook_cases.ts',
);

register(
  'stripe.webhooks.1',
  [],
  [],
  true,
  'signed loopback retries, terminal failure, redelivery and timer cancellation',
  retryContract,
);
register(
  'stripe.webhooks.2',
  [],
  [],
  true,
  'CLI and SDK publication, send, inspect, wait and redeliver',
  commandContract,
);
