import { memoryAdapter, type Store } from '../src/state/store.ts';
import {
  redeliverWebhook,
  sendWebhook,
  waitForDelivery,
  waitTimeoutSchema,
} from '../src/deliveries/commands.ts';
import { DeliveryError } from '../src/deliveries/errors.ts';
import { requestTimeout } from '../src/control/timeout.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejects(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    if (error instanceof DeliveryError) {
      equal(error.code, code);

      return;
    }

    throw error;
  }

  throw new Error('Expected rejection');
}

async function fixture() {
  return await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [
      {
        collection: 'emulon.deliveries',
        id: 'delivery',
        value: {
          id: 'delivery',
          eventId: 'event',
          destinationId: 'app',
          status: 'failed',
        },
      },
    ],
  });
}

Deno.test('wait subscribes before reading, wakes on commit, unsubscribes and never polls idle state', async () => {
  const state = await fixture();
  let reads = 0;
  let listeners = 0;
  let observed!: () => void;
  let initialRead = new Promise<void>((resolve) => observed = resolve);
  const store: Store = {
    generation: 0,
    scope: () => store,
    subscribe(listener) {
      listeners++;

      const unsubscribe = state.store.subscribe(listener);

      return () => {
        listeners--;
        unsubscribe();
      };
    },
    async transaction(work) {
      reads++;

      const result = await state.store.transaction(work);

      observed();

      return result;
    },
  };

  try {
    await rejects(
      waitForDelivery(store, {
        id: 'delivery',
        status: 'succeeded',
        timeout: '20ms',
      }),
      'WAIT_TIMEOUT',
    );
    equal(reads, 1);
    equal(listeners, 0);

    initialRead = new Promise<void>((resolve) => observed = resolve);

    const waiting = waitForDelivery(store, {
      id: 'delivery',
      status: 'succeeded',
      timeout: '10s',
    });

    await initialRead;
    await state.store.transaction((tx) =>
      tx.put({
        collection: 'emulon.deliveries',
        id: 'delivery',
        value: {
          id: 'delivery',
          eventId: 'event',
          destinationId: 'app',
          status: 'succeeded',
        },
      })
    );
    equal((await waiting).status, 'succeeded');
    equal(listeners, 0);

    const closing = waitForDelivery(store, {
      id: 'delivery',
      status: 'failed',
      timeout: '10s',
    });

    state.close();
    await rejects(closing, 'WAIT_CANCELLED');
    equal(listeners, 0);
  } finally {
    state.close();
  }
});

Deno.test('webhook validation rejects unavailable destinations and active redelivery without mutation', async () => {
  const state = await fixture();

  try {
    await rejects(
      sendWebhook(state.store, {
        type: 'email.sent',
        data: {},
        destination: 'missing',
      }),
      'DESTINATION_UNAVAILABLE',
    );
    equal(await state.store.transaction((tx) => tx.outbox()), []);
    await rejects(
      redeliverWebhook(state.store, 'missing'),
      'DELIVERY_NOT_FOUND',
    );
    await state.store.transaction((tx) =>
      tx.put({
        collection: 'emulon.deliveries',
        id: 'active',
        value: {
          id: 'active',
          eventId: 'event',
          destinationId: 'app',
          status: 'in-flight',
        },
      })
    );
    await rejects(redeliverWebhook(state.store, 'active'), 'DELIVERY_ACTIVE');
  } finally {
    state.close();
  }
});

Deno.test('wait durations are bounded and control deadlines honor both command encodings', () => {
  for (const value of ['0s', '-1s', 'forever', '2147483648ms']) {
    equal(waitTimeoutSchema.safeParse(value).success, false);
  }

  for (const value of ['10s', '1ms', '1m']) {
    equal(waitTimeoutSchema.safeParse(value).success, true);
  }

  equal(
    requestTimeout('/command', {
      command: 'webhooks.wait',
      input: { timeout: '1m' },
    }),
    63000,
  );
  equal(
    requestTimeout('/cli', [
      'mail',
      'webhooks',
      'wait',
      'id',
      '--timeout',
      '1m',
    ]),
    63000,
  );
  equal(
    requestTimeout('/cli', ['mail', 'webhooks', 'wait', 'id', '--timeout=1m']),
    63000,
  );
});

Deno.test('store observers see only commits and lifecycle changes, including through scopes', async () => {
  const state = await fixture();
  let changes = 0;
  const unsubscribe = state.store.scope().subscribe(() => changes++);
  const removeThrowing = state.store.subscribe(() => {
    throw new Error('Observer failure');
  });

  try {
    await state.store.transaction((tx) => tx.list('emulon.deliveries'));
    equal(changes, 0);

    try {
      await state.store.transaction(async (tx) => {
        await tx.delete('emulon.deliveries', 'delivery');

        throw new Error('Rollback');
      });
    } catch { /* Deliberate rollback must not notify. */ }

    equal(changes, 0);
    await state.store.transaction((tx) =>
      tx.delete('emulon.deliveries', 'delivery')
    );
    equal(changes, 1);
    equal(
      await state.store.transaction((tx) => tx.list('emulon.deliveries')),
      [],
    );

    const wait = waitForDelivery(state.store, {
      id: 'delivery',
      status: 'succeeded',
      timeout: '10s',
    });

    await state.reset();
    await rejects(wait, 'WAIT_CANCELLED');
    equal(changes, 2);
    state.close();
    equal(changes, 3);
  } finally {
    unsubscribe();
    removeThrowing();
    state.close();
  }
});
