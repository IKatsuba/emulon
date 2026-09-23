import { z } from 'zod';
import { deliverySchema, destinationSchema } from '../deliveries/queue.ts';
import { deliveryFaultsSchema } from '../deliveries/faults.ts';
import type { Snapshot } from './store.ts';

const bytes = z.array(z.number().int().min(0).max(255));
const attemptSchema = z.object({
  id: z.string(),
  deliveryId: z.string(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  responseStatus: z.number().int().min(100).max(599).optional(),
  errorCode: z.string().optional(),
  outcome: z.literal('unknown').optional(),
  providerDeliveryId: z.string(),
  requestBytes: bytes,
  headers: z.record(z.string(), z.string()),
  responseBytes: bytes.optional(),
  responseTruncated: z.boolean().optional(),
});

/** Validate core-owned records without running plugin policies or recovery. */
export function validateCoreFormat(snapshot: Snapshot): void {
  const invalid = () => new Error('Invalid core state record format.');

  for (
    const [collection, schema] of [
      ['emulon.destinations', destinationSchema],
      ['emulon.deliveries', deliverySchema],
      ['emulon.attempts', attemptSchema],
    ] as const
  ) {
    for (const [id, value] of snapshot.rows.get(collection) ?? []) {
      const result = schema.safeParse(value);

      // Never expose schema errors: persisted records can contain credentials.
      if (!result.success || result.data.id !== id) {
        throw invalid();
      }

      if (collection === 'emulon.deliveries') {
        const delivery = deliverySchema.parse(value);

        if (
          delivery.nextAttemptAt !== undefined &&
          !z.iso.datetime().safeParse(delivery.nextAttemptAt).success
        ) {
          throw invalid();
        }
      }
    }
  }

  for (const value of snapshot.rows.get('emulon.dispatched')?.values() ?? []) {
    if (value !== true) {
      throw invalid();
    }
  }

  for (const [id, value] of snapshot.rows.get('emulon.faults') ?? []) {
    if (id !== 'delivery' || !deliveryFaultsSchema.safeParse(value).success) {
      throw invalid();
    }
  }
}
