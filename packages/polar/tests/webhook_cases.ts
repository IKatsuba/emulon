import { validateEvent } from '@polar-sh/sdk/webhooks.js';
import polar from '@emulon/polar';
import {
  destinationFixture,
  Emulon,
  inspectDelivery,
  redeliverWebhook,
  sendWebhook,
  setDestination,
} from 'emulon';
import {
  memoryAdapter,
  type StateAdapter,
  type StateHandle,
} from '../../emulon/src/state/store.ts';
import { startWithAdapter } from '../../emulon/src/sdk/start.ts';
import { dispatchingStore } from '../../emulon/src/deliveries/queue.ts';
import {
  type DeliveryScheduler,
  deliveryWorker,
  recoverAttempts,
} from '../../emulon/src/deliveries/worker.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import {
  apiVersion,
  createCustomer,
  fixtures,
  makeCustomer,
} from '../src/model/customers.ts';
import {
  type CustomerCreatedPayload,
  payloadSchema,
  retryDelayMs,
  subscriptionPolicy,
  transport,
} from '../src/webhooks/mod.ts';
import { organizationId } from './customers_cases.ts';
import { assert, equal, rejects } from './assert.ts';

export const { cases, register } = caseRegistry(
  'packages/polar/tests/webhook_cases.ts',
);

/** A caller secret in the legacy mode: multi-byte and never base64 decodable. */
const secret = 'whsec_литерал_£_🐻';
const name = 'Ада 🐻 £';
const synthetic: CustomerCreatedPayload = payloadSchema.parse({
  type: 'customer.created',
  timestamp: '2026-09-22T00:00:00.000Z',
  api_version: apiVersion,
  data: makeCustomer(
    { email: 'synthetic@example.test', name: 'Synthetic 🐻' },
    '11111111-2222-4333-8444-555555555555',
    organizationId,
    '2026-09-22T00:00:00.000Z',
  ),
});

function destination(url: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'receiver',
    url,
    secret,
    types: ['customer.created'],
    enabled: true,
    ...overrides,
  };
}

/**
 * Verification written against the Standard Webhooks framing directly, so a
 * mistake shared with the transport cannot pass unnoticed.
 */
async function verify(
  body: Uint8Array,
  headers: Headers,
  key: string,
): Promise<CustomerCreatedPayload> {
  const encoder = new TextEncoder();
  const id = headers.get('webhook-id')!;
  const timestamp = headers.get('webhook-timestamp')!;
  const signed = encoder.encode(`${id}.${timestamp}.`);
  const content = new Uint8Array(signed.length + body.length);

  content.set(signed);
  content.set(body, signed.length);

  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const provided = headers.get('webhook-signature')!;
  const digest = Uint8Array.from(
    atob(provided.replace(/^v1,/, '')),
    (character) => character.charCodeAt(0),
  );

  if (
    !provided.startsWith('v1,') ||
    !await crypto.subtle.verify('HMAC', imported, digest, content)
  ) {
    throw new Error('Signature mismatch');
  }

  return payloadSchema.parse(JSON.parse(new TextDecoder().decode(body)));
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
  let hang: PromiseWithResolvers<void> | undefined;
  let currentSecret = secret;
  const received: {
    bytes: Uint8Array;
    id: string;
    timestamp: string;
    signature: string;
    apiVersion: string | null;
    payload: CustomerCreatedPayload;
  }[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const payload = await verify(bytes, request.headers, currentSecret);

      received.push({
        bytes,
        id: request.headers.get('webhook-id')!,
        timestamp: request.headers.get('webhook-timestamp')!,
        signature: request.headers.get('webhook-signature')!,
        apiVersion: request.headers.get('webhook-api-version'),
        payload,
      });

      if (hang) {
        await hang.promise;
      }

      return status === 302
        ? new Response(null, { status, headers: { location: '/moved' } })
        : new Response('receiver body secret', { status });
    },
  );
  const target = destination(`http://127.0.0.1:${receiver.addr.port}`);
  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'billing',
    version: { pluginVersion: '0.1.0', schemaVersion: 1 },
    fixtures: [
      ...fixtures({ organizationId }),
      destinationFixture(target, subscriptionPolicy),
    ],
  });
  const store = dispatchingStore(handle.store, subscriptionPolicy);
  const worker = deliveryWorker(store, transport, timer);
  const only = async () => {
    const list = await store.transaction((tx) => tx.list('emulon.deliveries'));

    equal(list.length, 1);

    return (list[0]!.value as { id: string }).id;
  };

  try {
    // Creating a customer is what queues the signed delivery.
    const customer = await createCustomer(
      store,
      { email: 'ada@example.test', name, externalId: 'usr_£' },
      timer.now,
    );
    const id = await only();

    // Dispatch schedules against the host clock; let the fake scheduler reach it.
    timer.advance(1000);
    await worker.flush();
    equal(received.length, 1);
    equal(received[0]!.payload.data.id, customer.id);
    equal(received[0]!.payload.data.name, name);
    equal(received[0]!.apiVersion, apiVersion);
    // The receiver read the real multi-byte name, not an escaped copy.
    assert(
      new TextDecoder().decode(received[0]!.bytes).includes(name),
      'Unicode name did not survive the wire',
    );
    assert(
      received[0]!.bytes.includes(0xd0) && received[0]!.bytes.includes(0xf0),
      'Body bytes are not UTF-8 encoded',
    );

    // A queued automatic retry blocks manual redelivery.
    await rejects(() => redeliverWebhook(store, id));

    for (let attempt = 1; attempt < 10; attempt++) {
      const delay = retryDelayMs(attempt)!;
      const queued = await inspectDelivery(store, id);

      equal(queued.delivery.status, 'queued');
      equal(Date.parse(queued.delivery.nextAttemptAt!), timer.now() + delay);
      timer.advance(delay - 1);
      await worker.flush();
      equal(received.length, attempt);

      if (attempt === 3) {
        currentSecret = 'whsec_rotated_🔑';

        await setDestination(
          store,
          destination(target.url, { secret: currentSecret }),
          subscriptionPolicy,
        );
      }

      timer.advance(1);
      await worker.flush();
      equal(received.length, attempt + 1);
    }

    const terminal = await inspectDelivery(store, id);

    equal(received.length, 10);
    equal(terminal.delivery.status, 'failed');
    equal(terminal.attempts.length, 10);
    equal(terminal.delivery.nextAttemptAt, undefined);
    equal(timer.jobs.size, 0);

    // The body bytes and the delivery-scoped ID are reused; each attempt is
    // signed again, so timestamps and signatures differ.
    const first = received[0]!;

    for (const attempt of received) {
      equal([...attempt.bytes], [...first.bytes]);
      equal(attempt.id, first.id);
    }

    equal(new Set(received.map((attempt) => attempt.signature)).size, 10);
    equal(new Set(received.map((attempt) => attempt.timestamp)).size, 10);

    for (const attempt of terminal.attempts) {
      equal([...attempt.requestBytes], [...first.bytes]);
      equal(Object.keys(attempt.headers).sort(), [
        'content-type',
        'webhook-api-version',
        'webhook-id',
        'webhook-timestamp',
      ]);
      equal(attempt.responseStatus, 500);
      equal(attempt.errorCode, 'HTTP_STATUS');
    }

    const redacted = JSON.stringify(terminal);

    assert(!redacted.includes(secret), 'Inspection exposed the secret');
    assert(!redacted.includes('rotated'), 'Inspection exposed the new secret');
    assert(
      !redacted.includes('receiver body secret'),
      'Inspection exposed the response body',
    );

    // Manual redelivery after exhaustion reuses the same bytes and ID.
    status = 200;

    await redeliverWebhook(store, id);
    await worker.flush();
    equal((await inspectDelivery(store, id)).delivery.status, 'succeeded');
    equal(received.length, 11);
    equal([...received[10]!.bytes], [...first.bytes]);
    equal(received[10]!.id, first.id);
    equal(timer.jobs.size, 0);

    // A failure followed by success stops the schedule at two attempts.
    status = 500;

    const recovering = await sendWebhook(store, {
      type: 'customer.created',
      data: synthetic,
      destination: target.id,
    });

    await worker.flush();

    status = 200;

    equal(
      Date.parse(
        (await inspectDelivery(store, recovering.id)).delivery.nextAttemptAt!,
      ),
      timer.now() + 2000,
    );
    timer.advance(2000);
    await worker.flush();

    const succeeded = await inspectDelivery(store, recovering.id);

    equal(succeeded.delivery.status, 'succeeded');
    equal(succeeded.attempts.length, 2);
    equal(timer.jobs.size, 0);

    // A redirect is not followed and is not a success.
    status = 302;

    const redirected = await sendWebhook(store, {
      type: 'customer.created',
      data: synthetic,
      destination: target.id,
    });

    await worker.flush();

    const moved = await inspectDelivery(store, redirected.id);

    equal(moved.delivery.status, 'queued');
    equal(moved.attempts.length, 1);
    equal(moved.attempts[0]!.responseStatus, 302);
    equal(moved.attempts[0]!.errorCode, 'HTTP_STATUS');

    // Disabling the destination cancels its queued retry and clears the timer.
    await setDestination(
      store,
      destination(target.url, { enabled: false, secret: currentSecret }),
      subscriptionPolicy,
    );
    await worker.flush();
    equal(
      (await inspectDelivery(store, redirected.id)).delivery.status,
      'cancelled',
    );
    equal(timer.jobs.size, 0);

    currentSecret = secret;

    await setDestination(store, destination(target.url), subscriptionPolicy);

    // A request that outlives the transport timeout has an unknown outcome.
    status = 200;
    hang = Promise.withResolvers<void>();

    const stalled = await sendWebhook(store, {
      type: 'customer.created',
      data: synthetic,
      destination: target.id,
    });
    const flushing = worker.flush();

    // The only pending job is the transport timeout of the stalled attempt.
    while (timer.jobs.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    equal(timer.jobs.size, 1);

    timer.advance(transport.timeoutMs);
    hang.resolve();

    hang = undefined;

    await flushing;

    const timedOut = await inspectDelivery(store, stalled.id);

    equal(timedOut.attempts[0]!.errorCode, 'TIMEOUT');
    equal(timedOut.attempts[0]!.outcome, 'unknown');
    equal(timedOut.attempts[0]!.responseStatus, undefined);

    // Neither synthetic publication nor a direct send creates a customer.
    equal((await store.transaction((tx) => tx.list('customers'))).length, 1);

    // Reset drops a pending delivery and its schedule.
    status = 500;

    const pending = await sendWebhook(store, {
      type: 'customer.created',
      data: synthetic,
      destination: target.id,
    });

    await worker.flush();
    equal(timer.jobs.size, 1);
    await worker.pause();
    equal(timer.jobs.size, 0);
    await handle.reset();
    timer.advance(512000);
    worker.resume();
    await worker.flush();
    await rejects(() => inspectDelivery(store, pending.id));

    // An interrupted send stays unknown and waits for a manual redelivery.
    const interrupted = await sendWebhook(store, {
      type: 'customer.created',
      data: synthetic,
      destination: target.id,
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
          requestBytes: [...transport.serialize({
            id: 'evt',
            instanceId: 'billing',
            type: 'customer.created',
            occurredAt: synthetic.timestamp,
            origin: 'direct',
            payload: synthetic,
          })],
          headers: {},
        },
      })
    );
    await recoverAttempts(store);

    const recovered = await inspectDelivery(store, interrupted.id);

    equal(recovered.delivery.status, 'failed');
    equal(recovered.attempts[0]!.outcome, 'unknown');
    equal(recovered.attempts[0]!.errorCode, 'INTERRUPTED');

    status = 200;

    await redeliverWebhook(store, interrupted.id);
    await worker.flush();
    equal(
      (await inspectDelivery(store, interrupted.id)).delivery.status,
      'succeeded',
    );
  } finally {
    hang?.resolve();
    await worker.pause();
    handle.close();
    await receiver.shutdown();
  }
}

async function commandContract() {
  const received: { body: string; headers: Headers }[] = [];
  const refused: string[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.text();
      const headers = Object.fromEntries(request.headers);

      // The pinned official verifier reads the captured body itself.
      try {
        validateEvent(body, headers, secret);
      } catch (error) {
        refused.push(String(error));

        return new Response(null, { status: 400 });
      }

      received.push({ body, headers: request.headers });

      return new Response('receiver body secret', { status: 200 });
    },
  );
  const directory = await Deno.makeTempDir();
  const target = destination(`http://127.0.0.1:${receiver.addr.port}`);
  const config = {
    services: {
      billing: polar({ organizationId, destinations: [target] }),
    },
  };
  const host = await serveEnvironment(config, { directory });

  try {
    await using env = await Emulon.connect({ config, directory });
    const service = env.services.billing;
    const cli = async (args: string[]) => {
      const result = await runProjectCLI(
        ['billing', ...args, '--json'],
        undefined,
        directory,
      );

      assert(result.code === 0, result.stderr);

      return JSON.parse(result.stdout);
    };

    const settled = async (id: string) => {
      await service.webhooks.wait({ id, status: 'succeeded', timeout: '10s' });

      return await service.webhooks.inspect({ id });
    };

    equal(await service.webhooks.destinations({}), [{
      id: target.id,
      url: target.url,
      types: target.types,
      enabled: true,
    }]);

    // Creating a customer delivers a signed event the official verifier accepts.
    const customer = await service.customers.create({
      email: 'ada@example.test',
      name,
      externalId: 'usr_£',
    });
    const queued = await service.webhooks.list({});

    equal(queued.length, 1);

    const delivered = await settled(queued[0]!.id);
    const event = validateEvent(
      received[0]!.body,
      Object.fromEntries(received[0]!.headers),
      secret,
    );

    assert(event.type === 'customer.created', 'Unexpected event type');
    equal(event.data.id, customer.id);
    equal(event.data.name, name);
    equal(received[0]!.headers.get('webhook-api-version'), apiVersion);
    equal(
      [...new TextEncoder().encode(received[0]!.body)],
      delivered.attempts[0]!.requestBytes,
    );
    assert(received[0]!.body.includes(name), 'Unicode name was escaped away');
    assert(
      !JSON.stringify(delivered).includes(secret) &&
        !JSON.stringify(delivered).includes('receiver body secret'),
      'Inspection exposed a secret or a response body',
    );

    // Synthetic publication reaches the same destination and creates nobody.
    const path = directory + '/event.json';

    await Deno.writeTextFile(path, JSON.stringify(synthetic));

    const published = await cli([
      'events',
      'publish',
      'customer.created',
      '--data',
      path,
    ]);

    equal(published.origin, 'published');
    await rejects(() => service.customers.get({ id: synthetic.data.id }));

    const publishedDelivery = (await cli(['webhooks', 'list'])).find(
      (record: { eventId: string }) => record.eventId === published.id,
    );

    await cli([
      'webhooks',
      'wait',
      publishedDelivery.id,
      '--status',
      'succeeded',
      '--timeout',
      '10s',
    ]);

    // A direct send selects no subscription and creates nobody either.
    const direct = await cli([
      'webhooks',
      'send',
      'customer.created',
      '--data',
      path,
      '--destination',
      target.id,
    ]);

    await cli([
      'webhooks',
      'wait',
      direct.id,
      '--status',
      'succeeded',
      '--timeout',
      '10s',
    ]);

    const inspected = await cli(['webhooks', 'inspect', direct.id]);

    equal(inspected.attempts.length, 1);
    assert(
      !JSON.stringify(inspected).includes(secret),
      'CLI inspection exposed the secret',
    );
    await cli(['webhooks', 'redeliver', direct.id]);
    equal((await settled(direct.id)).attempts.length, 2);
    await rejects(() => service.customers.get({ id: synthetic.data.id }));

    // The envelope is validated whole before anything is written: a foreign
    // version, a foreign type and a date the pinned verifier rejects are all
    // refused by both command paths, and neither records nor queues anything.
    const settledCount = (await service.webhooks.list({})).length;

    for (
      const invalid of [
        { ...synthetic, api_version: '2025-04' },
        { ...synthetic, type: 'customer.updated' },
        { ...synthetic, data: { ...synthetic.data, type: 'team' } },
        { ...synthetic, extra: true },
        { ...synthetic, timestamp: 'not-a-date' },
        { ...synthetic, timestamp: '2026-09-22T00:00:00.000' },
        { ...synthetic, data: { ...synthetic.data, created_at: 'not-a-date' } },
      ]
    ) {
      await rejects(() =>
        service.events.publish({
          type: 'customer.created',
          data: invalid as never,
        })
      );
      await rejects(() =>
        service.webhooks.send({
          type: 'customer.created',
          data: invalid as never,
          destination: target.id,
        })
      );
    }

    equal((await service.webhooks.list({})).length, settledCount);

    // Rotating the secret through the command changes what the receiver needs.
    const rotated = await service.webhooks.configure(
      destination(target.url, { secret: 'whsec_rotated_🔑' }),
    );

    assert(
      !JSON.stringify(rotated).includes('rotated'),
      'Destination view exposed the secret',
    );

    const before = received.length;
    const stale = await service.webhooks.send({
      type: 'customer.created',
      data: synthetic,
      destination: target.id,
    });

    await rejects(() =>
      service.webhooks.wait({
        id: stale.id,
        status: 'succeeded',
        timeout: '3s',
      })
    );
    assert(refused.length > 0, 'A stale secret still verified');
    equal(received.length, before);

    // Restoring it lets the same pending delivery through: the worker reads
    // the current secret when it claims an attempt.
    await service.webhooks.configure(destination(target.url));
    await service.webhooks.wait({
      id: stale.id,
      status: 'succeeded',
      timeout: '10s',
    });
    assert(received.length > before, 'The restored secret delivered nothing');

    // An unknown destination and an unknown delivery are refused.
    await rejects(() =>
      service.webhooks.send({
        type: 'customer.created',
        data: synthetic,
        destination: 'absent',
      })
    );
    await rejects(() => service.webhooks.inspect({ id: 'absent' }));
    await rejects(() => service.webhooks.redeliver({ id: 'absent' }));
    equal((await service.customers.get({ id: customer.id })).name, name);
    await env.reset();
    equal(await service.webhooks.list({}), []);
    equal((await service.webhooks.destinations({})).length, 1);
  } finally {
    await host[Symbol.asyncDispose]();
    await receiver.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

/**
 * A restart over retained state: the queued Polar retry must reopen with its
 * frozen bytes and delivery-scoped ID, and an interrupted in-flight attempt
 * must surface as an unknown outcome that only a manual redelivery clears.
 */
async function restartContract() {
  let status = 500;
  const received: { body: string; headers: Headers }[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const body = await request.text();

      // The pinned official verifier reads every resumed attempt too.
      validateEvent(body, Object.fromEntries(request.headers), secret);
      received.push({ body, headers: request.headers });

      return new Response('receiver body secret', { status });
    },
  );
  const target = destination(`http://127.0.0.1:${receiver.addr.port}`);
  const config = {
    services: { billing: polar({ organizationId, destinations: [target] }) },
  };
  // One retained memory handle stands in for durable state across restarts.
  let retained: StateHandle | undefined;
  const adapter: StateAdapter = {
    async open(input) {
      retained ??= await memoryAdapter().open(input);

      return { ...retained, close() {} };
    },
  };
  const interruptedId = 'interrupted';

  try {
    const first = await startWithAdapter(config, adapter, 'polar-restart');
    const customer = await first.services.billing.customers.create({
      email: 'ada@example.test',
      name,
      externalId: 'usr_£',
    });
    const [queued] = await first.services.billing.webhooks.list({});
    const attempted = await first.services.billing.webhooks.inspect({
      id: queued!.id,
    });

    equal(attempted.delivery.status, 'queued');
    equal(attempted.attempts.length, 1);
    equal(received.length, 1);

    const frozen = attempted.attempts[0]!.requestBytes;

    await first.dispose();

    const store = retained!.store;

    await store.transaction(async (tx) => {
      // Make the pending retry due, and plant an attempt the host never
      // finished writing an outcome for.
      await tx.put({
        collection: 'emulon.deliveries',
        id: queued!.id,
        value: { ...queued, nextAttemptAt: '2000-01-01T00:00:00.000Z' },
      });
      await tx.put({
        collection: 'emulon.deliveries',
        id: interruptedId,
        value: { ...queued, id: interruptedId, status: 'in-flight' },
      });
      await tx.put({
        collection: 'emulon.attempts',
        id: 'interrupted-attempt',
        value: {
          id: 'interrupted-attempt',
          deliveryId: interruptedId,
          startedAt: '2000-01-01T00:00:00.000Z',
          providerDeliveryId: interruptedId,
          requestBytes: frozen,
          headers: {},
        },
      });
    });

    status = 200;

    const second = await startWithAdapter(config, adapter, 'polar-restart');

    try {
      const service = second.services.billing;

      // The queued retry resumed on its own, with the retained body and ID.
      const resumed = await service.webhooks.wait({
        id: queued!.id,
        status: 'succeeded',
        timeout: '10s',
      });

      equal(resumed.status, 'succeeded');

      const reopened = await service.webhooks.inspect({ id: queued!.id });

      equal(reopened.attempts.length, 2);
      equal(reopened.attempts[1]!.requestBytes, frozen);
      equal(
        [...new TextEncoder().encode(received[1]!.body)],
        frozen,
      );
      equal(
        received[1]!.headers.get('webhook-id'),
        received[0]!.headers.get('webhook-id'),
      );
      equal(received[1]!.headers.get('webhook-api-version'), apiVersion);
      assert(
        received[1]!.body.includes(name),
        'The resumed attempt lost the Unicode name',
      );
      // Nothing was replayed twice and nobody was created again.
      equal((await service.customers.get({ id: customer.id })).name, name);

      // The interrupted attempt is not replayed: it ends unknown and waits.
      const recovered = await service.webhooks.inspect({ id: interruptedId });

      equal(recovered.delivery.status, 'failed');
      equal(recovered.attempts[0]!.outcome, 'unknown');
      equal(recovered.attempts[0]!.errorCode, 'INTERRUPTED');
      assert(
        !JSON.stringify(recovered).includes(secret),
        'Recovery inspection exposed the secret',
      );

      const before = received.length;

      await service.webhooks.redeliver({ id: interruptedId });
      await service.webhooks.wait({
        id: interruptedId,
        status: 'succeeded',
        timeout: '10s',
      });
      equal(received.length, before + 1);
      equal(
        [...new TextEncoder().encode(received[before]!.body)],
        frozen,
      );
    } finally {
      await second.dispose();
    }
  } finally {
    retained?.close();
    await receiver.shutdown();
  }
}

register(
  'polar.webhooks.1',
  ['customers.create'],
  ['customer.created'],
  true,
  'signed loopback delivery, the whole retry schedule, exhaustion, timeout, rotation, reset and recovery',
  retryContract,
);
register(
  'polar.webhooks.2',
  ['customers.create', 'customers.get'],
  ['customer.created'],
  true,
  'official verifier, CLI and SDK publication, send, inspect, wait, redeliver and configure',
  commandContract,
);
register(
  'polar.webhooks.3',
  ['customers.create', 'customers.get'],
  ['customer.created'],
  true,
  'restart over retained state resumes a queued retry and recovers an interrupted attempt',
  restartContract,
);
