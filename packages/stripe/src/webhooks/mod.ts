import { z } from 'zod';
import type { DeliveryTransport, SubscriptionPolicy } from 'emulon';
import { type Customer, customerSchema, version } from '../model/customers.ts';

export interface StripeEvent {
  id: string;
  object: 'event';
  // deno-lint-ignore camelcase
  api_version: '2025-03-31.basil';
  created: number;
  type: 'customer.created';
  livemode: false;
  data: { object: Customer };
}

export const eventSchema: z.ZodType<StripeEvent, StripeEvent> = z.strictObject({
  id: z.string().regex(/^evt_[a-zA-Z0-9]+$/),
  object: z.literal('event'),
  api_version: z.literal(version),
  created: z.number().int().nonnegative(),
  type: z.literal('customer.created'),
  livemode: z.literal(false),
  data: z.strictObject({ object: customerSchema }),
});
export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: ['customer.created'],
};

export function retryDelayMs(attempt: number): number | undefined {
  return [60000, 3600000, 7200000][attempt - 1];
}

export const transport: DeliveryTransport = {
  timeoutMs: 5000,
  serialize: (event) =>
    new TextEncoder().encode(JSON.stringify(eventSchema.parse(event.payload))),
  async headers({ body, timestamp, secret }) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const prefix = encoder.encode(`${timestamp}.`);
    const content = new Uint8Array(prefix.length + body.length);

    content.set(prefix);
    content.set(body, prefix.length);

    const digest = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, content),
    );
    const signature = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');

    return {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    };
  },
  succeeds: (status) => status >= 200 && status < 300,
  retryDelayMs,
};
