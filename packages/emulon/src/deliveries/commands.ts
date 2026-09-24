import { faultSchedule, readDeliveryFaults } from './faults.ts';
import { z } from 'zod';
import { DeliveryError } from './errors.ts';
import type { Store, Transaction } from '../state/store.ts';
import {
  type DeliveryRecord,
  deliverySchema,
  storedDestinationSchema,
} from './queue.ts';
import { type DeliveryAttempt, inspectAttempt } from './worker.ts';

export interface DeliveryInspection {
  delivery: DeliveryRecord;
  attempts: {
    id: string;
    deliveryId: string;
    startedAt: string;
    completedAt?: string | undefined;
    responseStatus?: number | undefined;
    errorCode?: string | undefined;
    outcome?: 'unknown' | undefined;
    providerDeliveryId: string;
    requestBytes: number[];
    headers: Record<string, string>;
    responseTruncated?: boolean | undefined;
  }[];
}

export const deliveryInspectionSchema: z.ZodType<DeliveryInspection> = z.object(
  {
    delivery: deliverySchema,
    attempts: z.array(z.object({
      id: z.string(),
      deliveryId: z.string(),
      startedAt: z.string(),
      completedAt: z.string().optional(),
      responseStatus: z.number().optional(),
      errorCode: z.string().optional(),
      outcome: z.literal('unknown').optional(),
      providerDeliveryId: z.string(),
      requestBytes: z.array(z.number()),
      headers: z.record(z.string(), z.string()),
      responseTruncated: z.boolean().optional(),
    })),
  },
);
export const waitTimeoutSchema: z.ZodType<string, string> = z.string().regex(
  /^\d+(ms|s|m)$/,
).refine(
  (value) =>
    timeoutMilliseconds(value) > 0 && timeoutMilliseconds(value) <= 2147483647,
  'Timeout must be positive and no greater than 2147483647ms',
);

export function timeoutMilliseconds(value: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);

  return match
    ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60000 }[match[2]!] ?? NaN)
    : NaN;
}

async function requireDelivery(tx: Transaction, id: string) {
  const raw = await tx.get('emulon.deliveries', id);

  if (!raw) {
    throw new DeliveryError('DELIVERY_NOT_FOUND');
  }

  return deliverySchema.parse(raw);
}

async function requireDestination(tx: Transaction, id: string) {
  const raw = await tx.get('emulon.destinations', id);

  if (!raw || !storedDestinationSchema.parse(raw).enabled) {
    throw new DeliveryError('DESTINATION_UNAVAILABLE');
  }
}

export function sendWebhook(
  store: Store,
  input: { type: string; data: unknown; destination: string },
): Promise<DeliveryRecord> {
  return store.transaction(async (tx) => {
    await requireDestination(tx, input.destination);

    const event = await tx.record({
      type: input.type,
      payload: input.data,
      origin: 'direct',
      occurredAt: new Date().toISOString(),
    });
    const faults = await readDeliveryFaults(tx);
    const delivery = {
      id: crypto.randomUUID(),
      eventId: event.id,
      destinationId: input.destination,
      status: 'queued' as const,
      ...(faults.delayMs
        ? { nextAttemptAt: faultSchedule(faults, Date.now()) }
        : {}),
      ...(faults.loseResponse ? { loseResponse: true } : {}),
    };

    await tx.put({
      collection: 'emulon.deliveries',
      id: delivery.id,
      value: delivery,
    });

    return delivery;
  });
}

export async function inspectDelivery(
  store: Store,
  id: string,
): Promise<DeliveryInspection> {
  return await store.transaction(async (tx) =>
    deliveryInspectionSchema.parse({
      delivery: await requireDelivery(tx, id),
      attempts: (await tx.list('emulon.attempts')).map((row) =>
        inspectAttempt(row.value as DeliveryAttempt)
      ).filter((attempt) => attempt.deliveryId === id),
    })
  );
}

export function redeliverWebhook(
  store: Store,
  id: string,
): Promise<DeliveryRecord> {
  return store.transaction(async (tx) => {
    const delivery = await requireDelivery(tx, id);

    if (delivery.status === 'queued' || delivery.status === 'in-flight') {
      throw new DeliveryError('DELIVERY_ACTIVE');
    }

    await requireDestination(tx, delivery.destinationId);

    const next = { ...delivery, status: 'queued' as const };

    delete next.nextAttemptAt;
    delete next.loseResponse;
    await tx.put({ collection: 'emulon.deliveries', id, value: next });

    return next;
  });
}

export function waitForDelivery(
  store: Store,
  input: {
    id: string;
    status: z.output<typeof deliverySchema>['status'];
    timeout: string;
  },
): Promise<DeliveryRecord> {
  const timeout = timeoutMilliseconds(waitTimeoutSchema.parse(input.timeout));
  const scoped = store.scope();

  return new Promise<z.output<typeof deliverySchema>>((resolve, reject) => {
    let done = false;
    let current: z.output<typeof deliverySchema>['status'] | undefined;
    let reading = false;
    let dirty = false;
    const finish = (
      error?: unknown,
      value?: z.output<typeof deliverySchema>,
    ) => {
      if (done) {
        return;
      }

      done = true;

      clearTimeout(timer);
      unsubscribe();

      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    };

    const check = async () => {
      dirty = true;

      if (reading || done) {
        return;
      }

      reading = true;

      try {
        do {
          dirty = false;

          const value = await scoped.transaction((tx) =>
            requireDelivery(tx, input.id)
          );

          current = value.status;

          if (current === input.status) {
            finish(undefined, value);
          }
        } while (dirty && !done);
      } catch (error) {
        finish(
          error instanceof DeliveryError
            ? error
            : new DeliveryError('WAIT_CANCELLED'),
        );
      } finally {
        reading = false;
      }
    };

    const unsubscribe = scoped.subscribe(() => {
      void check();
    });

    const timer = setTimeout(
      () =>
        finish(
          new DeliveryError('WAIT_TIMEOUT', current),
        ),
      timeout,
    );

    void check();
  });
}
