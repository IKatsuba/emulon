// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import type { DeliveryTransport, SubscriptionPolicy } from 'emulon';
import { version } from '../model/core.ts';

export const eventTypes = [
  'customer.created',
  'checkout.session.completed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;

export type EventType = (typeof eventTypes)[number];

/** The object each event type carries in `data.object`. */
const objects: Record<EventType, string> = {
  'customer.created': 'customer',
  'checkout.session.completed': 'checkout.session',
  'checkout.session.expired': 'checkout.session',
  'charge.refunded': 'charge',
  'charge.dispute.created': 'dispute',
  'charge.dispute.closed': 'dispute',
};

export interface StripeEvent {
  id: string;
  object: 'event';
  api_version: typeof version;
  created: number;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
  livemode: false;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: EventType;
}

export const eventSchema: z.ZodType<StripeEvent, StripeEvent> = z.strictObject({
  id: z.string().regex(/^evt_[a-zA-Z0-9]+$/),
  object: z.literal('event'),
  api_version: z.literal(version),
  created: z.number().int().nonnegative(),
  data: z.strictObject({
    object: z.looseObject({ id: z.string(), object: z.string() }),
    previous_attributes: z.record(z.string(), z.unknown()).optional(),
  }),
  livemode: z.literal(false),
  pending_webhooks: z.number().int().nonnegative(),
  request: z.strictObject({
    id: z.string().nullable(),
    idempotency_key: z.string().nullable(),
  }),
  type: z.enum(eventTypes),
}).refine((event) => event.data.object.object === objects[event.type], {
  message: 'Event object does not match its type.',
}) as unknown as z.ZodType<StripeEvent, StripeEvent>;

export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: [...eventTypes],
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
