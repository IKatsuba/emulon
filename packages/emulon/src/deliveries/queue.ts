import { faultSchedule, readDeliveryFaults } from './faults.ts';
import { z } from 'zod';
import type { EventRecord, Store, Transaction } from '../state/store.ts';

export interface Destination {
  id: string;
  url: string;
  secret: string;
  types: string[];
  enabled: boolean;
}
export interface DeliveryRecord {
  id: string;
  eventId: string;
  destinationId: string;
  status: 'queued' | 'in-flight' | 'succeeded' | 'failed' | 'cancelled';
  nextAttemptAt?: string | undefined;
  loseResponse?: boolean | undefined;
}

const destinationObject = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  url: z.url().refine((value) => {
    const url = new URL(value);

    return ['http:', 'https:'].includes(url.protocol) && !url.username &&
      !url.password && !url.hash;
  }),
  secret: z.string(),
  types: z.array(z.string().min(1)).min(1),
  enabled: z.boolean(),
});
export const destinationSchema: z.ZodType<Destination, Destination> =
  destinationObject;
export const destinationViewSchema: z.ZodType<Omit<Destination, 'secret'>> =
  destinationObject.omit({ secret: true })
    .strip();
export const deliverySchema: z.ZodType<DeliveryRecord> = z.object({
  id: z.string(),
  eventId: z.string(),
  destinationId: z.string(),
  status: z.enum(['queued', 'in-flight', 'succeeded', 'failed', 'cancelled']),
  nextAttemptAt: z.string().optional(),
  loseResponse: z.boolean().optional(),
});

export interface SubscriptionPolicy {
  selection: 'processing-time';
  allowUnsigned?: boolean;
  eventTypes: readonly string[];
}

const destinations = 'emulon.destinations';
const deliveries = 'emulon.deliveries';
const processed = 'emulon.dispatched';

export function eligible(
  event: EventRecord,
  destination: Destination,
  policy: SubscriptionPolicy,
): boolean {
  return event.origin !== 'direct' && destination.enabled &&
    policy.eventTypes.includes(event.type) &&
    destination.types.includes(event.type);
}

export function destinationFixture(
  input: Destination,
  policy: SubscriptionPolicy,
): { collection: string; id: string; value: Destination } {
  const value = destinationSchema.parse(input);

  if (!value.secret && !policy.allowUnsigned) {
    throw new Error('Signing secret is required.');
  }

  if (value.types.some((type) => !policy.eventTypes.includes(type))) {
    throw new Error('Unsupported subscription event type.');
  }

  return { collection: destinations, id: value.id, value };
}

export async function setDestination(
  store: Store,
  input: Destination,
  policy: SubscriptionPolicy,
): Promise<Omit<Destination, 'secret'>> {
  const row = destinationFixture(input, policy);

  return await store.transaction(async (tx) => {
    await tx.put(row);

    if (!row.value.enabled) {
      for (const delivery of await tx.list(deliveries)) {
        const value = deliverySchema.parse(delivery.value);

        if (value.destinationId === row.id && value.status === 'queued') {
          delete value.nextAttemptAt;
          await tx.put({
            ...delivery,
            value: { ...value, status: 'cancelled' },
          });
        }
      }
    }

    return destinationViewSchema.parse(row.value);
  });
}

export function listDestinations(
  store: Store,
): Promise<Omit<Destination, 'secret'>[]> {
  return store.transaction(async (tx) =>
    (await tx.list(destinations)).map((row) =>
      destinationViewSchema.parse(row.value)
    )
  );
}

export function listDeliveries(store: Store): Promise<DeliveryRecord[]> {
  return store.transaction(async (tx) =>
    (await tx.list(deliveries)).map((row) => deliverySchema.parse(row.value))
  );
}

export async function dispatch(
  tx: Transaction,
  policy: SubscriptionPolicy,
): Promise<void> {
  const faults = await readDeliveryFaults(tx);
  const subscriptions = (await tx.list(destinations)).map((row) =>
    destinationSchema.parse(row.value)
  );

  for (const event of await tx.outbox()) {
    if (await tx.get(processed, event.id)) {
      continue;
    }

    for (const subscription of subscriptions) {
      if (!eligible(event, subscription, policy)) {
        continue;
      }

      const id = JSON.stringify([event.id, subscription.id]);

      if (await tx.get(deliveries, id)) {
        continue;
      }

      await tx.put({
        collection: deliveries,
        id,
        value: {
          id,
          eventId: event.id,
          destinationId: subscription.id,
          status: 'queued',
          nextAttemptAt: faultSchedule(faults, Date.now()),
          ...(faults.loseResponse ? { loseResponse: true } : {}),
        } satisfies DeliveryRecord,
      });
    }

    await tx.put({ collection: processed, id: event.id, value: true });
  }
}

export function dispatchingStore(
  store: Store,
  policy: SubscriptionPolicy,
): Store {
  return {
    get generation() {
      return store.generation;
    },
    scope: () => dispatchingStore(store.scope(), policy),
    subscribe: (listener) => store.subscribe(listener),
    transaction: (work) =>
      store.transaction(async (tx) => {
        await dispatch(tx, policy);

        const result = await work(tx);

        await dispatch(tx, policy);

        return result;
      }),
  };
}
