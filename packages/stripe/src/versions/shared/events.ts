import { z } from 'zod';
import { invalidRequest } from '../../errors.ts';
import type { EventFact, ResourceRecord } from '../../model/core.ts';
import { disputeReasons } from '../../model/payments.ts';
import { eventObjects, eventTypes } from '../../webhooks/mod.ts';
import type { StripeEvent } from '../types.ts';

const nullable = z.string().nullable();
const metadata = z.record(z.string(), z.string());
const created = z.number().int().nonnegative();

/**
 * The resources events carry, the same in every shipped version. Parsing keeps the
 * semantic fields a record holds and drops what the projection derives.
 */
const objects: Record<string, z.ZodType<ResourceRecord>> = {
  customer: z.object({
    id: z.string().min(1),
    object: z.literal('customer'),
    created,
    description: nullable,
    email: nullable,
    invoice_prefix: z.string(),
    metadata,
    name: nullable,
    phone: nullable,
  }),
  'checkout.session': z.object({
    id: z.string().min(1),
    object: z.literal('checkout.session'),
    allow_promotion_codes: z.boolean().nullable(),
    amount_subtotal: z.number().int(),
    amount_total: z.number().int(),
    cancel_url: nullable,
    client_reference_id: nullable,
    created,
    currency: z.string(),
    customer: nullable,
    customer_creation: z.enum(['always', 'if_required']),
    customer_details: z.object({ email: z.string(), name: nullable })
      .nullable(),
    customer_email: nullable,
    discounts: z.array(
      z.object({ coupon: nullable, promotion_code: nullable }),
    ),
    expires_at: created,
    locale: nullable,
    metadata,
    payment_intent: nullable,
    payment_method_types: z.array(z.string()),
    payment_status: z.enum(['no_payment_required', 'paid', 'unpaid']),
    status: z.enum(['complete', 'expired', 'open']),
    success_url: z.string(),
    total_details: z.object({ amount_discount: z.number().int() }),
    url: nullable,
  }).transform(({ total_details, ...session }) => ({
    ...session,
    amount_discount: total_details.amount_discount,
  })),
  charge: z.object({
    id: z.string().min(1),
    object: z.literal('charge'),
    amount: z.number().int(),
    amount_refunded: z.number().int(),
    billing_details: z.object({ email: nullable, name: nullable }),
    created,
    currency: z.string(),
    customer: nullable,
    disputed: z.boolean(),
    metadata,
    payment_intent: z.string(),
    payment_method: z.string(),
    receipt_email: nullable,
    refunded: z.boolean(),
  }),
  dispute: z.object({
    id: z.string().min(1),
    object: z.literal('dispute'),
    amount: z.number().int(),
    charge: z.string(),
    created,
    currency: z.string(),
    evidence_details: z.object({ due_by: created }),
    metadata,
    payment_intent: z.string(),
    reason: z.enum(disputeReasons),
    status: z.enum(['needs_response', 'won', 'lost', 'warning_closed']),
  }).transform(({ evidence_details, ...dispute }) => ({
    ...dispute,
    evidence_due_by: evidence_details.due_by,
  })),
} as Record<string, z.ZodType<ResourceRecord>>;

function envelope(version: string) {
  return z.strictObject({
    id: z.string().regex(/^evt_[a-zA-Z0-9]+$/),
    object: z.literal('event'),
    api_version: z.literal(version),
    created,
    data: z.strictObject({
      object: z.looseObject({ object: z.string() }),
      previous_attributes: z.record(z.string(), z.unknown()).optional(),
    }),
    livemode: z.literal(false),
    pending_webhooks: z.number().int().nonnegative(),
    request: z.strictObject({
      id: z.string().nullable(),
      idempotency_key: z.string().nullable(),
    }),
    type: z.enum(eventTypes),
  });
}

/** An event envelope around the object as `project` shows it in `version`. */
export function projectEvent(
  version: string,
  project: (record: ResourceRecord) => Record<string, unknown>,
  type: string,
  fact: EventFact,
): StripeEvent {
  return {
    id: fact.id,
    object: 'event',
    api_version: version,
    created: fact.created,
    data: {
      object: project(fact.object),
      ...(fact.previous
        ? { previous_attributes: structuredClone(fact.previous) }
        : {}),
    },
    livemode: false,
    pending_webhooks: fact.pendingWebhooks,
    request: {
      id: fact.request.id,
      idempotency_key: fact.request.idempotencyKey,
    },
    type,
  };
}

export function parseEvent(
  version: string,
  type: string,
  input: unknown,
): EventFact {
  const parsed = envelope(version).safeParse(input);
  const kind = parsed.success ? eventObjects[parsed.data.type] : undefined;
  const object = parsed.success && parsed.data.type === type &&
      parsed.data.data.object.object === kind
    ? objects[kind!]!.safeParse(parsed.data.data.object)
    : undefined;

  if (!parsed.success || !object?.success) {
    throw invalidRequest(
      `The event is not a valid ${type} event for API version ${version}.`,
      'data',
    );
  }

  const event = parsed.data;

  return {
    id: event.id,
    apiVersion: version,
    created: event.created,
    object: object.data,
    ...(event.data.previous_attributes
      ? { previous: event.data.previous_attributes }
      : {}),
    pendingWebhooks: event.pending_webhooks,
    request: {
      id: event.request.id,
      idempotencyKey: event.request.idempotency_key,
    },
  };
}
