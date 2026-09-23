// Polar webhook envelopes keep the provider's snake_case names.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import type { DeliveryTransport, SubscriptionPolicy } from 'emulon';
import {
  apiVersion,
  type Customer,
  customerSchema,
  dateTime,
} from '../model/customers.ts';

/** The `WebhookCustomerCreatedPayload` projection of the pinned schema. */
export interface CustomerCreatedPayload {
  type: 'customer.created';
  timestamp: string;
  api_version: typeof apiVersion;
  data: Customer;
}

export const payloadSchema: z.ZodType<
  CustomerCreatedPayload,
  CustomerCreatedPayload
> = z.strictObject({
  type: z.literal('customer.created'),
  timestamp: dateTime,
  api_version: z.literal(apiVersion),
  data: customerSchema,
});
export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: ['customer.created'],
};

/** Ten total attempts; the tenth failure is terminal. See ADR 0033. */
export const maxAttempts = 10;

/**
 * A deterministic local approximation of the documented exponential retries,
 * not the hosted schedule: the server counts attempts against its configured
 * maximum and adds worker jitter, which this does not reproduce.
 */
export function retryDelayMs(attempt: number): number | undefined {
  return attempt >= 1 && attempt < maxAttempts
    ? Math.min(1000 * 2 ** attempt, 1200000)
    : undefined;
}

/**
 * Legacy/custom-secret Polar signing: the HMAC key is the entire secret as
 * UTF-8 bytes, including any `whsec_` prefix, which is never stripped and
 * never base64-decoded. Newly generated dashboard secrets, which Standard
 * Webhooks decodes instead, are not claimed by this slice.
 */
export async function signature(
  secret: string,
  id: string,
  timestamp: number,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  if (!secret) {
    throw new Error('Signing secret is required.');
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  // Standard Webhooks signs the exact bytes of `id.timestamp.body`.
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const content = new Uint8Array(prefix.length + body.length);

  content.set(prefix);
  content.set(body, prefix.length);

  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, content));

  return `v1,${btoa(String.fromCharCode(...digest))}`;
}

export const transport: DeliveryTransport = {
  timeoutMs: 10000,
  serialize: (event) =>
    new TextEncoder().encode(
      JSON.stringify(payloadSchema.parse(event.payload)),
    ),
  async headers({ body, id, timestamp, secret }) {
    return {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-api-version': apiVersion,
      'webhook-signature': await signature(secret, id, timestamp, body),
    };
  },
  succeeds: (status) => status >= 200 && status < 300,
  retryDelayMs,
};
