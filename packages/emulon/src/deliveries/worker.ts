import type { EventRecord, Store } from '../state/store.ts';
import {
  type DeliveryRecord,
  deliverySchema,
  destinationSchema,
} from './queue.ts';
import { send } from '../runtime/send.ts';

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  startedAt: string;
  completedAt?: string;
  responseStatus?: number;
  errorCode?: string;
  outcome?: 'unknown';
  providerDeliveryId: string;
  requestBytes: number[];
  headers: Record<string, string>;
  responseBytes?: number[];
  responseTruncated?: boolean;
}
export interface DeliveryTransport {
  timeoutMs: number;
  providerId?: 'delivery' | 'attempt';
  serialize(event: EventRecord): Uint8Array<ArrayBuffer>;
  headers(
    input: {
      body: Uint8Array<ArrayBuffer>;
      id: string;
      timestamp: number;
      secret: string;
    },
  ): Promise<Record<string, string>>;
  succeeds(status: number): boolean;
  retryDelayMs(attempt: number): number | undefined;
}

export function safeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) =>
      [
        'content-type',
        'svix-id',
        'svix-timestamp',
        'webhook-id',
        'webhook-timestamp',
        'webhook-api-version',
        'x-github-event',
        'x-github-delivery',
      ].includes(key.toLowerCase())
    ),
  );
}

export function retryAt(
  transport: DeliveryTransport,
  count: number,
  now: number,
): string | undefined {
  const delay = transport.retryDelayMs(count);

  if (delay === undefined || !Number.isFinite(delay) || delay < 0) {
    return undefined;
  }

  const date = new Date(now + delay);

  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function completeDelivery(
  delivery: DeliveryRecord,
  success: boolean,
  nextAttemptAt?: string,
): DeliveryRecord {
  const { nextAttemptAt: _previous, ...record } = delivery;

  return {
    ...record,
    status: success ? 'succeeded' : nextAttemptAt ? 'queued' : 'failed',
    ...(!success && nextAttemptAt ? { nextAttemptAt } : {}),
  };
}

export function inspectAttempt(value: DeliveryAttempt): DeliveryAttempt {
  const { responseBytes: _response, ...attempt } = value;

  return { ...attempt, headers: safeHeaders(attempt.headers) };
}

export function inspectAttempts(
  store: Store,
  deliveryId: string,
): Promise<DeliveryAttempt[]> {
  return store.transaction(async (tx) =>
    (await tx.list('emulon.attempts')).map((row) =>
      inspectAttempt(row.value as DeliveryAttempt)
    ).filter((a) => a.deliveryId === deliveryId)
  );
}

// Internal seam: each worker owns its timers without replacing the host clock.
export interface DeliveryScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const realScheduler: DeliveryScheduler = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);

    return () => clearTimeout(timer);
  },
};

export function deliveryWorker(
  store: Store,
  transport: DeliveryTransport,
  scheduler: DeliveryScheduler = realScheduler,
) {
  let active: Promise<void> | undefined;
  let stopped = false;
  let requested = false;
  let controller: AbortController | undefined;
  let cancelTimer: (() => void) | undefined;

  async function run() {
    const scoped = store.scope();

    while (!stopped) {
      const claim = await scoped.transaction(async (tx) => {
        const now = scheduler.now();
        let earliest = Infinity;

        cancelTimer?.();

        cancelTimer = undefined;

        for (const row of await tx.list('emulon.deliveries')) {
          const delivery = deliverySchema.parse(row.value);

          if (delivery.status !== 'queued') {
            continue;
          }

          const due = Date.parse(delivery.nextAttemptAt ?? '') || 0;

          if (due > now) {
            earliest = Math.min(earliest, due);

            continue;
          }

          const raw = await tx.get(
            'emulon.destinations',
            delivery.destinationId,
          );
          const destination = raw === undefined
            ? undefined
            : destinationSchema.parse(raw);

          if (!destination || !destination.enabled) {
            delete delivery.nextAttemptAt;
            await tx.put({
              ...row,
              value: {
                ...delivery,
                status: 'cancelled',
              },
            });
            continue;
          }

          delete delivery.nextAttemptAt;

          const event = (await tx.outbox()).find((e) =>
            e.id === delivery.eventId
          )!;
          const previous = (await tx.list('emulon.attempts')).map((r) =>
            r.value as DeliveryAttempt
          ).filter((a) => a.deliveryId === delivery.id);
          const attempt: DeliveryAttempt = {
            id: crypto.randomUUID(),
            deliveryId: delivery.id,
            startedAt: new Date(scheduler.now()).toISOString(),
            providerDeliveryId: transport.providerId === 'attempt'
              ? crypto.randomUUID()
              : previous[0]?.providerDeliveryId ?? crypto.randomUUID(),
            requestBytes: previous[0]?.requestBytes ??
              Array.from(transport.serialize(event)),
            headers: {},
          };

          await tx.put({
            ...row,
            value: {
              ...delivery,
              status: 'in-flight',
            },
          });
          await tx.put({
            collection: 'emulon.attempts',
            id: attempt.id,
            value: attempt,
          });

          return { delivery, destination, attempt, count: previous.length + 1 };
        }

        if (!stopped && Number.isFinite(earliest)) {
          cancelTimer = scheduler.schedule(() => {
            void flush().catch(() => {});
          }, Math.min(earliest - now, 2147483647));
        }
      });

      if (!claim) {
        break;
      }

      const { delivery, destination, attempt, count } = claim;

      controller = new AbortController();

      if (stopped) {
        controller.abort();
      }

      let timedOut = false;
      const cancelTimeout = scheduler.schedule(() => {
        timedOut = true;

        controller?.abort();
      }, transport.timeoutMs);
      let success = false;

      try {
        const body = new Uint8Array(attempt.requestBytes);
        const headers = await transport.headers({
          body,
          id: attempt.providerDeliveryId,
          timestamp: Math.floor(scheduler.now() / 1000),
          secret: destination.secret,
        });

        attempt.headers = safeHeaders(headers);

        await scoped.transaction((tx) =>
          tx.put({
            collection: 'emulon.attempts',
            id: attempt.id,
            value: attempt,
          })
        );

        const response = await send(
          destination.url,
          body,
          headers,
          controller.signal,
        );

        if (delivery.loseResponse) {
          throw new Error('Injected response loss');
        }

        attempt.responseStatus = response.status;
        attempt.responseBytes = response.body;
        attempt.responseTruncated = response.truncated;

        if (response.bodyFailed) {
          throw new Error('Response body read failed');
        }

        success = transport.succeeds(response.status);

        if (!success) {
          attempt.errorCode = 'HTTP_STATUS';
        }
      } catch {
        attempt.outcome = 'unknown';
        attempt.errorCode = timedOut
          ? 'TIMEOUT'
          : controller.signal.aborted
          ? 'ABORTED'
          : 'TRANSPORT_ERROR';
      } finally {
        cancelTimeout();

        controller = undefined;
      }

      attempt.completedAt = new Date(scheduler.now()).toISOString();

      let nextAttemptAt = success || stopped
        ? undefined
        : retryAt(transport, count, scheduler.now());

      await scoped.transaction(async (tx) => {
        const current = await tx.get(
          'emulon.destinations',
          delivery.destinationId,
        );

        if (!current || !destinationSchema.parse(current).enabled) {
          nextAttemptAt = undefined;
        }

        await tx.put({
          collection: 'emulon.attempts',
          id: attempt.id,
          value: attempt,
        });
        await tx.put({
          collection: 'emulon.deliveries',
          id: delivery.id,
          value: completeDelivery(delivery, success, nextAttemptAt),
        });
      });
    }
  }

  function flush(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }

    requested = true;

    return active ??= (async () => {
      do {
        requested = false;

        await run();
      } while (requested && !stopped);
    })().finally(() => {
      active = undefined;
    });
  }

  return {
    flush,
    async pause() {
      stopped = true;

      cancelTimer?.();

      cancelTimer = undefined;

      controller?.abort();
      await active;
    },
    resume() {
      stopped = false;
    },
  };
}

// An interrupted request may already have been applied by its receiver.
export async function recoverAttempts(store: Store): Promise<void> {
  await store.transaction(async (tx) => {
    for (const row of await tx.list('emulon.deliveries')) {
      const delivery = deliverySchema.parse(row.value);

      if (delivery.status !== 'in-flight') {
        continue;
      }

      for (const attemptRow of await tx.list('emulon.attempts')) {
        const attempt = attemptRow.value as DeliveryAttempt;

        if (attempt.deliveryId !== delivery.id || attempt.completedAt) {
          continue;
        }

        await tx.put({
          ...attemptRow,
          value: {
            ...attempt,
            completedAt: new Date().toISOString(),
            errorCode: 'INTERRUPTED',
            outcome: 'unknown',
          },
        });
      }

      await tx.put({ ...row, value: completeDelivery(delivery, false) });
    }
  });
}
