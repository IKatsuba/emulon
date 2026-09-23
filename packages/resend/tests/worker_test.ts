import { definePlugin, inspectAttempts } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import resend from '../src/mod.ts';
import { startWithAdapter } from '../../emulon/src/sdk/start.ts';
import {
  memoryAdapter,
  type StateHandle,
} from '../../emulon/src/state/store.ts';
import { listen } from '../../emulon/src/runtime/http.ts';
import {
  completeDelivery,
  deliveryWorker,
  retryAt,
  safeHeaders,
} from '../../emulon/src/deliveries/worker.ts';
import { transport } from '../src/webhooks.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const secret = `whsec_${btoa('local-signing-secret')}`;

Deno.test('worker claims once, exposes in-flight, retries only by policy and keeps body and provider ID', async () => {
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const receiver = await listen(async (request) => {
    await request.text();
    calls++;
    entered.resolve();
    await release.promise;

    return new Response('no', { status: 503 });
  });

  const state = await memoryAdapter().open({
    environmentId: 'test',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [],
  });

  await state.store.transaction(async (tx) => {
    const event = await tx.record({
      type: 'email.sent',
      occurredAt: new Date().toISOString(),
      origin: 'service',
      payload: { message: 'test' },
    });

    await tx.put({
      collection: 'emulon.destinations',
      id: 'one',
      value: {
        id: 'one',
        url: receiver.url,
        secret,
        types: ['email.sent'],
        enabled: true,
      },
    });
    await tx.put({
      collection: 'emulon.deliveries',
      id: 'delivery',
      value: {
        id: 'delivery',
        eventId: event.id,
        destinationId: 'one',
        status: 'queued',
      },
    });
  });

  const worker = deliveryWorker(state.store, {
    ...transport,
    retryDelayMs: (count) => count === 1 ? 0 : undefined,
  });

  try {
    const running = worker.flush();

    await entered.promise;
    equal(
      (await state.store.transaction((tx) =>
        tx.get('emulon.deliveries', 'delivery')
      ) as { status: string }).status,
      'in-flight',
    );

    const again = worker.flush();

    release.resolve();
    await Promise.all([running, again]);
    equal(calls, 2);

    const attempts = await inspectAttempts(state.store, 'delivery');

    equal(attempts.length, 2);
    equal(attempts[0]!.providerDeliveryId, attempts[1]!.providerDeliveryId);
    equal(attempts[0]!.requestBytes, attempts[1]!.requestBytes);
    equal(retryAt(transport, 1, 0), undefined);
    equal(
      retryAt({ ...transport, retryDelayMs: () => 1000 }, 1, 0),
      '1970-01-01T00:00:01.000Z',
    );
    equal(
      safeHeaders({
        Authorization: 'secret',
        'X-API-Key': 'secret',
        Cookie: 'secret',
        'content-type': 'application/json',
      }),
      { 'content-type': 'application/json' },
    );
  } finally {
    release.resolve();
    await worker.pause();
    state.close();
    await receiver.stop();
  }
});

Deno.test('worker timeout and shutdown abort the receiver request and finish the attempt', async () => {
  for (const stop of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const receiver = await listen(async (request) => {
      await request.text();
      entered.resolve();
      await release.promise;

      return new Response('late');
    });

    const state = await memoryAdapter().open({
      environmentId: 'test',
      instanceId: 'mail',
      version: { pluginVersion: '1', schemaVersion: 1 },
      fixtures: [],
    });

    await state.store.transaction(async (tx) => {
      const event = await tx.record({
        type: 'email.sent',
        occurredAt: new Date().toISOString(),
        origin: 'service',
        payload: {},
      });

      await tx.put({
        collection: 'emulon.destinations',
        id: 'one',
        value: {
          id: 'one',
          url: receiver.url,
          secret,
          types: ['email.sent'],
          enabled: true,
        },
      });
      await tx.put({
        collection: 'emulon.deliveries',
        id: 'delivery',
        value: {
          id: 'delivery',
          eventId: event.id,
          destinationId: 'one',
          status: 'queued',
        },
      });
    });

    const worker = deliveryWorker(state.store, {
      ...transport,
      timeoutMs: stop ? 5000 : 100,
    });

    try {
      const running = worker.flush();

      await entered.promise;

      if (stop) {
        await worker.pause();
      }

      await running;

      const [attempt] = await inspectAttempts(state.store, 'delivery');

      equal(attempt!.errorCode, stop ? 'ABORTED' : 'TIMEOUT');
      equal(Boolean(attempt!.completedAt), true);
    } finally {
      release.resolve();
      await worker.pause();
      state.close();
      await receiver.stop();
    }
  }
});

Deno.test('environment reset drains a pending delivery and removes attempts before accepting new work', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const receiver = await listen(async (request) => {
    await request.text();
    entered.resolve();
    await release.promise;

    return new Response('late');
  });

  const { definition } = readRegistration(resend());
  const shortResend = definePlugin({
    ...definition,
    transport: { ...transport, timeoutMs: 100 },
  });
  let state: StateHandle;
  const env = await startWithAdapter({
    services: {
      mail: shortResend({
        destinations: [{
          id: 'one',
          url: receiver.url,
          secret,
          types: ['email.sent'],
          enabled: true,
        }],
      }),
    },
  }, {
    async open(input) {
      return state = await memoryAdapter().open(input);
    },
  });

  try {
    const publish = env.services.mail.events.publish({
      type: 'email.sent',
      data: {
        email_id: crypto.randomUUID(),
        from: 'a@b.test',
        to: ['c@d.test'],
        subject: 'reset',
      },
    });

    await entered.promise;
    await env.reset();
    await publish;
    equal(await env.services.mail.webhooks.list(), []);
    equal(
      await state!.store.transaction((tx) => tx.list('emulon.attempts')),
      [],
    );
    equal(await env.services.mail.emails.list(), []);
  } finally {
    release.resolve();
    await env.dispose();
    await receiver.stop();
  }
});

Deno.test('completion rules remove stale schedules and retry only failed deliveries', () => {
  const delivery = {
    id: 'one',
    eventId: 'event',
    destinationId: 'target',
    status: 'in-flight' as const,
    nextAttemptAt: 'old',
  };

  equal(completeDelivery(delivery, true, 'later'), {
    id: 'one',
    eventId: 'event',
    destinationId: 'target',
    status: 'succeeded',
  });
  equal(completeDelivery(delivery, false).status, 'failed');
  equal(completeDelivery(delivery, false).nextAttemptAt, undefined);
  equal(completeDelivery(delivery, false, 'later').status, 'queued');
  equal(completeDelivery(delivery, false, 'later').nextAttemptAt, 'later');
  equal(delivery.nextAttemptAt, 'old');
});

for (const scenario of ['response-body-timeout', 'retry-overflow']) {
  Deno.test(`worker completes failed attempts with response metadata: ${scenario}`, async () => {
    const receiver = await listen(async (request) => {
      await request.arrayBuffer();

      return new Response(
        scenario === 'response-body-timeout'
          ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial response'));
            },
          })
          : 'rejected',
        { status: 503 },
      );
    });

    const state = await memoryAdapter().open({
      environmentId: 'review',
      instanceId: 'mail',
      version: { pluginVersion: '1', schemaVersion: 1 },
      fixtures: [],
    });

    await state.store.transaction(async (tx) => {
      const event = await tx.record({
        type: 'email.sent',
        occurredAt: new Date().toISOString(),
        origin: 'service',
        payload: {},
      });

      await tx.put({
        collection: 'emulon.destinations',
        id: 'target',
        value: {
          id: 'target',
          url: receiver.url,
          secret: `whsec_${btoa('review-key')}`,
          types: ['email.sent'],
          enabled: true,
        },
      });
      await tx.put({
        collection: 'emulon.deliveries',
        id: 'delivery',
        value: {
          id: 'delivery',
          eventId: event.id,
          destinationId: 'target',
          status: 'queued',
        },
      });
    });

    const worker = deliveryWorker(state.store, {
      ...transport,
      timeoutMs: 500,
      retryDelayMs: () =>
        scenario === 'retry-overflow' ? Number.MAX_VALUE : undefined,
    });

    try {
      await worker.flush();

      const [attempt] = await inspectAttempts(state.store, 'delivery');
      const delivery = await state.store.transaction((tx) =>
        tx.get('emulon.deliveries', 'delivery')
      ) as { status: string };

      equal(delivery.status, 'failed');
      equal(attempt?.responseStatus, 503);
      equal(Boolean(attempt?.completedAt), true);
      equal(
        attempt?.errorCode,
        scenario === 'response-body-timeout' ? 'TIMEOUT' : 'HTTP_STATUS',
      );
      equal('nextAttemptAt' in delivery, false);

      const stored = await state.store.transaction((tx) =>
        tx.get('emulon.attempts', attempt!.id)
      ) as { responseBytes: number[] };

      equal(
        new TextDecoder().decode(new Uint8Array(stored.responseBytes)),
        scenario === 'response-body-timeout' ? 'partial response' : 'rejected',
      );
      equal('responseBytes' in attempt!, false);
      await worker.flush();
      equal((await inspectAttempts(state.store, 'delivery')).length, 1);
    } finally {
      await worker.pause();
      state.close();
      await receiver.stop();
    }
  });
}

Deno.test('retry schedules reject invalid delays and dates beyond the representable range', () => {
  const maximum = 8_640_000_000_000_000;

  for (const delay of [-1, NaN, Infinity, Number.MAX_VALUE, maximum]) {
    equal(
      retryAt({ ...transport, retryDelayMs: () => delay }, 1, 1),
      undefined,
    );
  }

  equal(
    retryAt({ ...transport, retryDelayMs: () => 1 }, 1, maximum - 1),
    new Date(maximum).toISOString(),
  );
  equal(retryAt({ ...transport, retryDelayMs: () => 0 }, 1, NaN), undefined);
});
