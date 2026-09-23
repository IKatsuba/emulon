import {
  destinationFixture,
  inspectDelivery,
  redeliverWebhook,
  sendWebhook,
} from 'emulon';
import calcom from '@emulon/calcom';
import { Emulon } from 'emulon';
import { memoryAdapter } from '../../emulon/src/state/store.ts';
import {
  deliveryWorker,
  recoverAttempts,
} from '../../emulon/src/deliveries/worker.ts';
import { subscriptionPolicy, transport } from '../src/webhooks/mod.ts';
import { destination, payload } from './webhook_cases.ts';
import { assert, equal, rejects } from './assert.ts';

Deno.test('Cal.com destination fixtures reject empty secrets, duplicate IDs and unsupported events', async () => {
  const dest = destination('http://127.0.0.1:1');

  for (
    const destinations of [[{ ...dest, secret: '' }], [dest, dest], [{
      ...dest,
      types: ['OTHER'],
    }]]
  ) {
    await rejects(async () => {
      await using _env = await Emulon.start({
        services: { cal: calcom({ destinations }) },
      });
    });
  }
});

Deno.test('Cal.com timeout and interrupted outcomes stay failed until manual redelivery', async () => {
  for (const status of [200, 201, 204, 299]) {
    assert(transport.succeeds(status));
  }

  for (const status of [199, 300, 400, 500]) {
    assert(!transport.succeeds(status));
  }

  for (const attempt of [1, 2, 3, 100]) {
    equal(transport.retryDelayMs(attempt), undefined);
  }

  let release = Promise.withResolvers<void>();
  let entered = Promise.withResolvers<void>();
  let requests = 0;
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.arrayBuffer();
      requests++;
      entered.resolve();
      await release.promise;

      return new Response(null, { status: 204 });
    },
  );
  const dest = destination(`http://127.0.0.1:${receiver.addr.port}`);
  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'cal',
    version: { pluginVersion: '0.1.0', schemaVersion: 1 },
    fixtures: [destinationFixture(dest, subscriptionPolicy)],
  });
  const jobs = new Set<() => void>();
  const worker = deliveryWorker(handle.store, transport, {
    now: () => 1700000000000,
    schedule(callback, delay) {
      equal(delay, 5000);
      jobs.add(callback);

      return () => {
        jobs.delete(callback);
      };
    },
  });

  try {
    const delivery = await sendWebhook(handle.store, {
      type: 'BOOKING_CREATED',
      data: payload,
      destination: dest.id,
    });
    const running = worker.flush();

    await entered.promise;
    equal(jobs.size, 1);

    for (const callback of [...jobs]) {
      callback();
    }

    await running;
    release.resolve();

    const timedOut = await inspectDelivery(handle.store, delivery.id);

    equal(timedOut.delivery.status, 'failed');
    equal(timedOut.attempts[0]!.errorCode, 'TIMEOUT');
    equal(timedOut.attempts[0]!.outcome, 'unknown');
    equal(jobs.size, 0);
    await worker.flush();
    equal(requests, 1);
    await redeliverWebhook(handle.store, delivery.id);
    await worker.flush();

    const succeeded = await inspectDelivery(handle.store, delivery.id);

    equal(succeeded.delivery.status, 'succeeded');
    equal(succeeded.attempts.length, 2);
    equal(
      succeeded.attempts[0]!.requestBytes,
      succeeded.attempts[1]!.requestBytes,
    );

    // Persist an interrupted claim to exercise the recovery seam without a public provider.
    const interrupted = await sendWebhook(handle.store, {
      type: 'BOOKING_CREATED',
      data: payload,
      destination: dest.id,
    });

    await handle.store.transaction(async (tx) => {
      await tx.put({
        collection: 'emulon.deliveries',
        id: interrupted.id,
        value: { ...interrupted, status: 'in-flight' },
      });
      await tx.put({
        collection: 'emulon.attempts',
        id: 'interrupted',
        value: {
          id: 'interrupted',
          deliveryId: interrupted.id,
          startedAt: '2023-11-14T22:13:20.000Z',
          providerDeliveryId: 'interrupted',
          requestBytes: succeeded.attempts[0]!.requestBytes,
          headers: {},
        },
      });
    });

    await recoverAttempts(handle.store);

    const recovered = await inspectDelivery(handle.store, interrupted.id);

    equal(recovered.delivery.status, 'failed');
    equal(recovered.attempts[0]!.errorCode, 'INTERRUPTED');
    equal(recovered.attempts[0]!.outcome, 'unknown');
    await worker.flush();
    equal(requests, 2);
    await redeliverWebhook(handle.store, interrupted.id);
    await worker.flush();
    equal(
      (await inspectDelivery(handle.store, interrupted.id)).delivery.status,
      'succeeded',
    );

    release = Promise.withResolvers<void>();
    entered = Promise.withResolvers<void>();

    const pending = await sendWebhook(handle.store, {
      type: 'BOOKING_CREATED',
      data: payload,
      destination: dest.id,
    });
    const pendingRun = worker.flush();

    await entered.promise;
    await worker.pause();
    await pendingRun;
    equal(jobs.size, 0);
    await handle.reset();
    release.resolve();
    worker.resume();
    await worker.flush();
    await rejects(() => inspectDelivery(handle.store, pending.id));
  } finally {
    release.resolve();
    await worker.pause();
    handle.close();
    await receiver.shutdown();
  }
});
