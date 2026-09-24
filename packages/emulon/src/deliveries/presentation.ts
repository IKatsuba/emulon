import { z } from 'zod';
import { cloneState } from '../state/clone.ts';
import type { EventRecord, Store, Transaction } from '../state/store.ts';
import type { PluginPresentation } from '../plugins/types.ts';
import { deliverySchema, storedDestinationSchema } from './queue.ts';

export const snapshots = 'emulon.delivery-snapshots';
export const snapshotSchema: z.ZodType<{ id: string; bytes: number[] }> = z
  .strictObject({
    id: z.string(),
    bytes: z.array(z.number().int().min(0).max(255)),
  });

function frozen<T>(value: T): T {
  const copy = cloneState(value);
  const freeze = (item: unknown) => {
    // Non-empty typed arrays cannot be frozen; the clone already isolates them.
    if (
      typeof item === 'object' && item !== null && !Object.isFrozen(item) &&
      !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)
    ) {
      Object.freeze(item);
      Object.values(item).forEach(freeze);
    }
  };

  freeze(copy);

  return copy;
}

/** Validate the plugin factory result before it can observe any state. */
export function readPresentation(value: unknown): PluginPresentation {
  if (
    typeof value !== 'object' || value === null ||
    ['eventView', 'deliverySnapshot'].some((key) =>
      (value as Record<string, unknown>)[key] !== undefined &&
      typeof (value as Record<string, unknown>)[key] !== 'function'
    )
  ) {
    throw new TypeError('Plugin presentation hooks must be functions.');
  }

  return value as PluginPresentation;
}

export function viewEvent(
  event: EventRecord,
  presentation: PluginPresentation | undefined,
): EventRecord {
  return presentation?.eventView
    ? { ...event, payload: presentation.eventView(frozen(event)) }
    : event;
}

export async function readSnapshot(
  tx: Transaction,
  deliveryId: string,
): Promise<number[] | undefined> {
  const raw = await tx.get(snapshots, deliveryId);

  return raw === undefined ? undefined : snapshotSchema.parse(raw).bytes;
}

async function capture(
  tx: Transaction,
  id: string,
  snapshot: NonNullable<PluginPresentation['deliverySnapshot']>,
) {
  const raw = await tx.get('emulon.deliveries', id);

  if (raw === undefined || await tx.get(snapshots, id) !== undefined) {
    return;
  }

  const delivery = deliverySchema.parse(raw);
  const destination = await tx.get(
    'emulon.destinations',
    delivery.destinationId,
  );
  const event = (await tx.outbox()).find((item) =>
    item.id === delivery.eventId
  );

  // The worker cancels deliveries whose destination or event is gone.
  if (destination === undefined || !event) {
    return;
  }

  const bytes = snapshot(
    frozen(event),
    frozen(storedDestinationSchema.parse(destination)),
  );

  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Delivery snapshot must be a Uint8Array.');
  }

  await tx.put({
    collection: snapshots,
    id,
    value: { id, bytes: Array.from(bytes) },
  });
}

/**
 * Capture the exact body of every delivery enqueued through this store in the
 * same transaction, so retries, redelivery and reopening send the same bytes.
 */
export function snapshottingStore(
  store: Store,
  snapshot: NonNullable<PluginPresentation['deliverySnapshot']>,
): Store {
  return {
    get generation() {
      return store.generation;
    },
    scope: () => snapshottingStore(store.scope(), snapshot),
    subscribe: (listener) => store.subscribe(listener),
    transaction: (work) =>
      store.transaction(async (tx) => {
        const enqueued = new Set<string>();
        const result = await work({
          ...tx,
          async put(entity) {
            if (entity.collection === 'emulon.deliveries') {
              enqueued.add(entity.id);
            }

            await tx.put(entity);
          },
        });

        for (const id of enqueued) {
          await capture(tx, id, snapshot);
        }

        return result;
      }),
  };
}
