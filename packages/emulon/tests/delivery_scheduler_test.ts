import { memoryAdapter } from '../src/state/store.ts';
import {
  type DeliveryScheduler,
  type DeliveryTransport,
  deliveryWorker,
} from '../src/deliveries/worker.ts';

Deno.test('worker pause cancels only owned timers and resume uses injected time', async () => {
  let now = 1000;
  const jobs = new Set<() => void>();
  const scheduler: DeliveryScheduler = {
    now: () => now,
    schedule(callback, delay) {
      if (delay !== 1000) {
        throw new Error('Incorrect due time');
      }

      jobs.add(callback);

      return () => {
        jobs.delete(callback);
      };
    },
  };
  const transport: DeliveryTransport = {
    timeoutMs: 5000,
    serialize: () => {
      throw new Error('Cancelled destination must not send');
    },
    headers: () => Promise.resolve({}),
    succeeds: () => true,
    retryDelayMs: () => undefined,
  };
  const adapter = memoryAdapter();
  const open = (instanceId: string) =>
    adapter.open({
      environmentId: 'env',
      instanceId,
      version: { pluginVersion: '1', schemaVersion: 1 },
      fixtures: [{
        collection: 'emulon.deliveries',
        id: 'delivery',
        value: {
          id: 'delivery',
          eventId: 'event',
          destinationId: 'missing',
          status: 'queued',
          nextAttemptAt: new Date(2000).toISOString(),
        },
      }],
    });
  const first = await open('first');
  const second = await open('second');
  const a = deliveryWorker(first.store, transport, scheduler);
  const b = deliveryWorker(second.store, transport, scheduler);
  const size = () => jobs.size;

  try {
    const racing = a.flush();

    await a.pause();
    await racing;

    if (size() !== 0) {
      throw new Error('Pause raced with timer creation');
    }

    a.resume();
    await a.flush();
    await b.flush();

    if (size() !== 2) {
      throw new Error('Missing timers');
    }

    await a.pause();

    if (size() !== 1) {
      throw new Error('Pause affected another worker');
    }

    await first.reset();

    now = 2000;

    for (const callback of [...jobs]) {
      callback();
    }

    await b.flush();
    a.resume();
    await a.flush();

    if (size() !== 0) {
      throw new Error('Timer leaked');
    }
  } finally {
    await a.pause();
    await b.pause();
    first.close();
    second.close();
  }
});
