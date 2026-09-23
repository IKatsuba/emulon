import { z } from 'zod';
import type { Transaction } from '../state/store.ts';

export interface DeliveryFaults {
  delayMs: number;
  loseResponse: boolean;
}

export const deliveryFaultsSchema: z.ZodType<DeliveryFaults, DeliveryFaults> = z
  .strictObject({
    delayMs: z.number().int().min(0).max(86400000),
    loseResponse: z.boolean(),
  });

export async function readDeliveryFaults(
  tx: Transaction,
): Promise<DeliveryFaults> {
  return deliveryFaultsSchema.parse(
    await tx.get('emulon.faults', 'delivery') ??
      { delayMs: 0, loseResponse: false },
  );
}

export function faultSchedule(faults: DeliveryFaults, now: number): string {
  return new Date(now + faults.delayMs).toISOString();
}
