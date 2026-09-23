import { defineCommand } from 'emulon';
import { z } from 'zod';
import {
  createCustomer,
  type CreateInput,
  createInput,
  type Customer,
  customerSchema,
  getCustomer,
} from '../model/customers.ts';
import { createKey } from '../auth/keys.ts';
import { load } from '../model/core.ts';
import {
  type CheckoutSession,
  type CompleteInput,
  completeSession,
  expireSession,
  getSession,
} from '../model/checkout.ts';
import {
  type Charge,
  closeDispute,
  type ClosedStatus,
  closedStatuses,
  createDispute,
  createRefund,
  type Dispute,
  type DisputeReason,
  disputeReasons,
  type Refund,
  type RefundReason,
} from '../model/payments.ts';

import {
  type Commands as WebhookCommands,
  commands as webhookCommands,
} from './webhooks.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;

/** Wire objects are validated by their identity; the model owns their shape. */
function wire<T>(object: string): z.ZodType<T, T> {
  return z.looseObject({
    id: z.string(),
    object: z.literal(object),
  }) as unknown as z.ZodType<T, T>;
}

const id = z.string().min(1);

interface RefundInput {
  charge?: string | undefined;
  paymentIntent?: string | undefined;
  amount?: number | undefined;
  reason?: RefundReason | undefined;
}

export type Commands = WebhookCommands & {
  'customers.create': Operation<CreateInput, Customer>;
  'customers.get': Operation<{ id: string }, Customer>;
  'keys.create': Operation<Record<string, never>, { apiKey: string }>;
  'checkout.sessions.get': Operation<{ id: string }, CheckoutSession>;
  'checkout.sessions.complete': Operation<CompleteInput, CheckoutSession>;
  'checkout.sessions.expire': Operation<{ id: string }, CheckoutSession>;
  'charges.get': Operation<{ id: string }, Charge>;
  'refunds.create': Operation<RefundInput, Refund>;
  'disputes.create': Operation<
    { charge: string; reason?: DisputeReason | undefined },
    Dispute
  >;
  'disputes.close': Operation<{ id: string; status: ClosedStatus }, Dispute>;
};

export const commands: Commands = {
  ...webhookCommands,
  'customers.create': defineCommand({
    description: 'Create a customer and record customer.created',
    input: createInput,
    output: customerSchema,
    cli: {
      path: ['customers', 'create'],
      flags: {
        name: 'name',
        email: 'email',
        description: 'description',
        phone: 'phone',
        metadata: 'metadata',
        'idempotency-key': 'idempotencyKey',
      },
    },
    execute: (ctx, input) => createCustomer(ctx.store, input, ctx.clock.now),
  }),
  'customers.get': defineCommand({
    description: 'Read a customer',
    input: z.strictObject({ id }),
    output: customerSchema,
    cli: { path: ['customers', 'get'], flags: { id: 'id' } },
    execute: (ctx, { id }) => getCustomer(ctx.store, id),
  }),
  'keys.create': defineCommand({
    description: 'Issue a local test API key',
    input: z.strictObject({}),
    output: z.object({ apiKey: z.string() }),
    cli: { path: ['keys', 'create'], flags: {} },
    execute: (ctx) => createKey(ctx.store),
  }),
  'checkout.sessions.get': defineCommand({
    description: 'Read a Checkout Session',
    input: z.strictObject({ id }),
    output: wire<CheckoutSession>('checkout.session'),
    cli: { path: ['checkout', 'sessions', 'get'], positional: 'id', flags: {} },
    execute: (ctx, { id }) =>
      ctx.store.transaction((tx) => getSession(tx, id, ctx.clock.now())),
  }),
  'checkout.sessions.complete': defineCommand({
    description:
      'Pay an open Checkout Session as the buyer would on the hosted page',
    input: z.strictObject({
      id,
      email: z.string().min(1).max(512).optional(),
      name: z.string().min(1).max(256).optional(),
      promotionCode: z.string().min(1).max(500).optional(),
    }),
    output: wire<CheckoutSession>('checkout.session'),
    cli: {
      path: ['checkout', 'sessions', 'complete'],
      positional: 'id',
      flags: {
        email: 'email',
        name: 'name',
        'promotion-code': 'promotionCode',
      },
    },
    execute: (ctx, input) =>
      ctx.store.transaction((tx) =>
        completeSession(tx, input, ctx.clock.now())
      ),
  }),
  'checkout.sessions.expire': defineCommand({
    description: 'Expire an open Checkout Session',
    input: z.strictObject({ id }),
    output: wire<CheckoutSession>('checkout.session'),
    cli: {
      path: ['checkout', 'sessions', 'expire'],
      positional: 'id',
      flags: {},
    },
    execute: (ctx, { id }) =>
      ctx.store.transaction((tx) => expireSession(tx, id, ctx.clock.now())),
  }),
  'charges.get': defineCommand({
    description: 'Read a charge',
    input: z.strictObject({ id }),
    output: wire<Charge>('charge'),
    cli: { path: ['charges', 'get'], positional: 'id', flags: {} },
    execute: (ctx, { id }) =>
      ctx.store.transaction((tx) => load<Charge>(tx, 'charge', id)),
  }),
  'refunds.create': defineCommand({
    description: 'Refund all or part of a charge and record charge.refunded',
    input: z.strictObject({
      charge: id.optional(),
      paymentIntent: id.optional(),
      amount: z.number().int().positive().optional(),
      reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer'])
        .optional(),
    }),
    output: wire<Refund>('refund'),
    cli: {
      path: ['refunds', 'create'],
      flags: {
        charge: 'charge',
        'payment-intent': 'paymentIntent',
        amount: 'amount',
        reason: 'reason',
      },
    },
    execute: (ctx, input) =>
      ctx.store.transaction((tx) => createRefund(tx, input, ctx.clock.now())),
  }),
  'disputes.create': defineCommand({
    description:
      "Open a dispute on a charge as the cardholder's bank would, recording charge.dispute.created",
    input: z.strictObject({
      charge: id,
      reason: z.enum(disputeReasons).optional(),
    }),
    output: wire<Dispute>('dispute'),
    cli: {
      path: ['disputes', 'create'],
      flags: { charge: 'charge', reason: 'reason' },
    },
    execute: (ctx, input) =>
      ctx.store.transaction((tx) => createDispute(tx, input, ctx.clock.now())),
  }),
  'disputes.close': defineCommand({
    description:
      'Close a dispute as won, lost or warning_closed, recording charge.dispute.closed',
    input: z.strictObject({ id, status: z.enum(closedStatuses) }),
    output: wire<Dispute>('dispute'),
    cli: {
      path: ['disputes', 'close'],
      positional: 'id',
      flags: { status: 'status' },
    },
    execute: (ctx, input) =>
      ctx.store.transaction((tx) => closeDispute(tx, input, ctx.clock.now())),
  }),
};
