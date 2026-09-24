import { defineCommand } from 'emulon';
import { z } from 'zod';
import { createKey } from '../auth/keys.ts';
import { StripeError } from '../errors.ts';
import type { Store, Transaction } from '../model/core.ts';
import {
  type CustomerCommandInput,
  customerCommandInput,
} from '../model/customers.ts';
import { type CompleteInput, completeSession } from '../model/checkout.ts';
import {
  closeDispute,
  type ClosedStatus,
  closedStatuses,
  createDispute,
  type DisputeReason,
  disputeReasons,
  type RefundReason,
} from '../model/payments.ts';
import {
  type Inputs,
  type OperationId,
  perform,
  resolver,
} from '../operations.ts';
import { readConfig, selectVersion } from '../versions/select.ts';
import type { StripeVersionModule } from '../versions/types.ts';
import {
  type Commands as WebhookCommands,
  commands as webhookCommands,
} from './webhooks.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;

/** A Stripe object as the version a command selected shows it. */
export type WireObject<Name extends string> =
  & { id: string; object: Name }
  // deno-lint-ignore no-explicit-any
  & Record<string, any>;

/** Wire objects are validated by their identity; the module owns their shape. */
function wire<Name extends string>(
  object: Name,
): z.ZodType<WireObject<Name>, WireObject<Name>> {
  return z.looseObject({
    id: z.string(),
    object: z.literal(object),
  }) as unknown as z.ZodType<WireObject<Name>, WireObject<Name>>;
}

const id = z.string().min(1);

/** Commands that show provider objects accept the version to show them in. */
const apiVersion = z.string().min(1).optional();
const versionFlag = { 'api-version': 'apiVersion' } as const;

type Versioned<T> = T & { apiVersion?: string | undefined };

interface RefundInput {
  charge?: string | undefined;
  paymentIntent?: string | undefined;
  amount?: number | undefined;
  reason?: RefundReason | undefined;
}

export type Commands = WebhookCommands & {
  'customers.create': Operation<CustomerCommandInput, WireObject<'customer'>>;
  'customers.get': Operation<Versioned<{ id: string }>, WireObject<'customer'>>;
  'keys.create': Operation<Record<string, never>, { apiKey: string }>;
  'checkout.sessions.get': Operation<
    Versioned<{ id: string }>,
    WireObject<'checkout.session'>
  >;
  'checkout.sessions.complete': Operation<
    Versioned<CompleteInput>,
    WireObject<'checkout.session'>
  >;
  'checkout.sessions.expire': Operation<
    Versioned<{ id: string }>,
    WireObject<'checkout.session'>
  >;
  'charges.get': Operation<Versioned<{ id: string }>, WireObject<'charge'>>;
  'refunds.create': Operation<Versioned<RefundInput>, WireObject<'refund'>>;
  'disputes.create': Operation<
    Versioned<{ charge: string; reason?: DisputeReason | undefined }>,
    WireObject<'dispute'>
  >;
  'disputes.close': Operation<
    Versioned<{ id: string; status: ClosedStatus }>,
    WireObject<'dispute'>
  >;
};

/**
 * The module a control command shows objects with, the requested version if
 * this instance enables it or the account default, and that default: events
 * caused by control actions are viewed in it.
 */
export async function moduleFor(
  store: Store,
  installed: ReadonlyMap<string, StripeVersionModule>,
  requested: string | undefined,
): Promise<{ module: StripeVersionModule; defaultVersion: string }> {
  const config = await store.transaction(readConfig);

  return {
    module: selectVersion(requested, config, installed),
    defaultVersion: config.defaultVersion,
  };
}

export function commands(
  installed: ReadonlyMap<string, StripeVersionModule>,
): Commands {
  /** An API operation on behalf of the account, without an HTTP request. */
  async function call<Op extends OperationId>(
    ctx: { store: Store; clock: { now(): number } },
    requested: string | undefined,
    operation: Op,
    request: {
      path: string;
      id?: string;
      input: Inputs[Op];
      idempotencyKey?: string | undefined;
    },
    // The command's output schema checks what the module projected.
    // deno-lint-ignore no-explicit-any
  ): Promise<any> {
    const { module, defaultVersion } = await moduleFor(
      ctx.store,
      installed,
      requested,
    );

    return await perform(ctx.store, module, {
      operation,
      path: request.path,
      id: request.id,
      parsed: { input: request.input, expand: [] },
      idempotencyKey: request.idempotencyKey,
      eventVersion: defaultVersion,
    }, ctx.clock.now());
  }

  /** A control action outside the API, shown in the selected version. */
  async function act(
    ctx: { store: Store; clock: { now(): number } },
    requested: string | undefined,
    work: (tx: Transaction, now: number, version: string) => Promise<unknown>,
    // deno-lint-ignore no-explicit-any
  ): Promise<any> {
    const { module, defaultVersion } = await moduleFor(
      ctx.store,
      installed,
      requested,
    );
    const now = ctx.clock.now();

    try {
      return await ctx.store.transaction(async (tx) =>
        await module.project(
          await work(tx, now, defaultVersion),
          [],
          resolver(tx, now),
        )
      );
    } catch (error) {
      throw error instanceof StripeError
        ? module.error(undefined, error)
        : error;
    }
  }

  return {
    ...webhookCommands(installed),
    'customers.create': defineCommand({
      description: 'Create a customer and record customer.created',
      input: customerCommandInput,
      output: wire('customer'),
      cli: {
        path: ['customers', 'create'],
        flags: {
          name: 'name',
          email: 'email',
          description: 'description',
          phone: 'phone',
          metadata: 'metadata',
          'idempotency-key': 'idempotencyKey',
          ...versionFlag,
        },
      },
      execute: (ctx, { idempotencyKey, apiVersion, ...input }) =>
        call(ctx, apiVersion, 'customers.create', {
          path: '/v1/customers',
          input,
          idempotencyKey,
        }),
    }),
    'customers.get': defineCommand({
      description: 'Read a customer',
      input: z.strictObject({ id, apiVersion }),
      output: wire('customer'),
      cli: {
        path: ['customers', 'get'],
        flags: { id: 'id', ...versionFlag },
      },
      execute: (ctx, { id, apiVersion }) =>
        call(ctx, apiVersion, 'customers.get', {
          path: `/v1/customers/${id}`,
          id,
          input: {},
        }),
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
      input: z.strictObject({ id, apiVersion }),
      output: wire('checkout.session'),
      cli: {
        path: ['checkout', 'sessions', 'get'],
        positional: 'id',
        flags: versionFlag,
      },
      execute: (ctx, { id, apiVersion }) =>
        call(ctx, apiVersion, 'checkout.sessions.get', {
          path: `/v1/checkout/sessions/${id}`,
          id,
          input: {},
        }),
    }),
    'checkout.sessions.complete': defineCommand({
      description:
        'Pay an open Checkout Session as the buyer would on the hosted page',
      input: z.strictObject({
        id,
        email: z.string().min(1).max(512).optional(),
        name: z.string().min(1).max(256).optional(),
        promotionCode: z.string().min(1).max(500).optional(),
        apiVersion,
      }),
      output: wire('checkout.session'),
      cli: {
        path: ['checkout', 'sessions', 'complete'],
        positional: 'id',
        flags: {
          email: 'email',
          name: 'name',
          'promotion-code': 'promotionCode',
          ...versionFlag,
        },
      },
      execute: (ctx, { apiVersion, ...input }) =>
        act(
          ctx,
          apiVersion,
          (tx, now, version) => completeSession(tx, input, now, version),
        ),
    }),
    'checkout.sessions.expire': defineCommand({
      description: 'Expire an open Checkout Session',
      input: z.strictObject({ id, apiVersion }),
      output: wire('checkout.session'),
      cli: {
        path: ['checkout', 'sessions', 'expire'],
        positional: 'id',
        flags: versionFlag,
      },
      execute: (ctx, { id, apiVersion }) =>
        call(ctx, apiVersion, 'checkout.sessions.expire', {
          path: `/v1/checkout/sessions/${id}/expire`,
          id,
          input: {},
        }),
    }),
    'charges.get': defineCommand({
      description: 'Read a charge',
      input: z.strictObject({ id, apiVersion }),
      output: wire('charge'),
      cli: {
        path: ['charges', 'get'],
        positional: 'id',
        flags: versionFlag,
      },
      execute: (ctx, { id, apiVersion }) =>
        call(ctx, apiVersion, 'charges.get', {
          path: `/v1/charges/${id}`,
          id,
          input: {},
        }),
    }),
    'refunds.create': defineCommand({
      description: 'Refund all or part of a charge and record charge.refunded',
      input: z.strictObject({
        charge: id.optional(),
        paymentIntent: id.optional(),
        amount: z.number().int().positive().optional(),
        reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer'])
          .optional(),
        apiVersion,
      }),
      output: wire('refund'),
      cli: {
        path: ['refunds', 'create'],
        flags: {
          charge: 'charge',
          'payment-intent': 'paymentIntent',
          amount: 'amount',
          reason: 'reason',
          ...versionFlag,
        },
      },
      execute: (ctx, { apiVersion, ...input }) =>
        call(ctx, apiVersion, 'refunds.create', {
          path: '/v1/refunds',
          input,
        }),
    }),
    'disputes.create': defineCommand({
      description:
        "Open a dispute on a charge as the cardholder's bank would, recording charge.dispute.created",
      input: z.strictObject({
        charge: id,
        reason: z.enum(disputeReasons).optional(),
        apiVersion,
      }),
      output: wire('dispute'),
      cli: {
        path: ['disputes', 'create'],
        flags: { charge: 'charge', reason: 'reason', ...versionFlag },
      },
      execute: (ctx, { apiVersion, ...input }) =>
        act(
          ctx,
          apiVersion,
          (tx, now, version) => createDispute(tx, input, now, version),
        ),
    }),
    'disputes.close': defineCommand({
      description:
        'Close a dispute as won, lost or warning_closed, recording charge.dispute.closed',
      input: z.strictObject({ id, status: z.enum(closedStatuses), apiVersion }),
      output: wire('dispute'),
      cli: {
        path: ['disputes', 'close'],
        positional: 'id',
        flags: { status: 'status', ...versionFlag },
      },
      execute: (ctx, { apiVersion, ...input }) =>
        act(
          ctx,
          apiVersion,
          (tx, now, version) => closeDispute(tx, input, now, version),
        ),
    }),
  };
}
