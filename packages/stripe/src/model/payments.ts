// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { invalidRequest } from '../errors.ts';
import {
  emit,
  load,
  type Metadata,
  randomId,
  save,
  seconds,
  type Transaction,
} from './core.ts';

export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_capturable: number;
  amount_received: number;
  capture_method: 'automatic_async';
  client_secret: string;
  confirmation_method: 'automatic';
  created: number;
  currency: string;
  customer: string | null;
  description: string | null;
  latest_charge: string;
  livemode: false;
  metadata: Metadata;
  payment_method: string;
  payment_method_types: string[];
  receipt_email: string | null;
  status: 'succeeded';
}

export interface Charge {
  id: string;
  object: 'charge';
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  balance_transaction: null;
  billing_details: {
    address: null;
    email: string | null;
    name: string | null;
    phone: null;
  };
  captured: true;
  created: number;
  currency: string;
  customer: string | null;
  description: string | null;
  disputed: boolean;
  failure_code: null;
  failure_message: null;
  livemode: false;
  metadata: Metadata;
  outcome: {
    network_status: 'approved_by_network';
    reason: null;
    risk_level: 'normal';
    seller_message: 'Payment complete.';
    type: 'authorized';
  };
  paid: true;
  payment_intent: string;
  payment_method: string;
  receipt_email: string | null;
  refunded: boolean;
  status: 'succeeded';
}

export interface Refund {
  id: string;
  object: 'refund';
  amount: number;
  charge: string;
  created: number;
  currency: string;
  metadata: Metadata;
  payment_intent: string;
  reason: RefundReason | null;
  status: 'succeeded';
}

export type RefundReason = 'duplicate' | 'fraudulent' | 'requested_by_customer';

export const disputeReasons = [
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
] as const;

export type DisputeReason = (typeof disputeReasons)[number];

export const closedStatuses = ['won', 'lost', 'warning_closed'] as const;

export type ClosedStatus = (typeof closedStatuses)[number];

export interface Dispute {
  id: string;
  object: 'dispute';
  amount: number;
  balance_transactions: [];
  charge: string;
  created: number;
  currency: string;
  evidence_details: {
    due_by: number;
    has_evidence: false;
    past_due: false;
    submission_count: 0;
  };
  is_charge_refundable: false;
  livemode: false;
  metadata: Metadata;
  payment_intent: string;
  reason: DisputeReason;
  status: 'needs_response' | ClosedStatus;
}

/** A succeeded card payment: the intent and the charge that settled it. */
export async function capturePayment(
  tx: Transaction,
  input: {
    amount: number;
    currency: string;
    customer: string | null;
    email: string | null;
    name: string | null;
  },
  now: number,
): Promise<PaymentIntent> {
  const intentId = randomId('pi_');
  const method = randomId('pm_');
  const charge: Charge = {
    id: randomId('ch_'),
    object: 'charge',
    amount: input.amount,
    amount_captured: input.amount,
    amount_refunded: 0,
    balance_transaction: null,
    billing_details: {
      address: null,
      email: input.email,
      name: input.name,
      phone: null,
    },
    captured: true,
    created: seconds(now),
    currency: input.currency,
    customer: input.customer,
    description: null,
    disputed: false,
    failure_code: null,
    failure_message: null,
    livemode: false,
    metadata: {},
    outcome: {
      network_status: 'approved_by_network',
      reason: null,
      risk_level: 'normal',
      seller_message: 'Payment complete.',
      type: 'authorized',
    },
    paid: true,
    payment_intent: intentId,
    payment_method: method,
    receipt_email: input.email,
    refunded: false,
    status: 'succeeded',
  };
  const intent: PaymentIntent = {
    id: intentId,
    object: 'payment_intent',
    amount: input.amount,
    amount_capturable: 0,
    amount_received: input.amount,
    capture_method: 'automatic_async',
    client_secret: `${intentId}_secret_${randomId('', 24)}`,
    confirmation_method: 'automatic',
    created: seconds(now),
    currency: input.currency,
    customer: input.customer,
    description: null,
    latest_charge: charge.id,
    livemode: false,
    metadata: {},
    payment_method: method,
    payment_method_types: ['card'],
    receipt_email: input.email,
    status: 'succeeded',
  };

  await save(tx, charge);
  await save(tx, intent);

  return intent;
}

async function chargeFor(
  tx: Transaction,
  input: { charge?: string | undefined; paymentIntent?: string | undefined },
): Promise<Charge> {
  if ((input.charge === undefined) === (input.paymentIntent === undefined)) {
    throw invalidRequest(
      'You must pass exactly one of charge or payment_intent.',
      'charge',
    );
  }

  if (input.charge !== undefined) {
    return await load<Charge>(tx, 'charge', input.charge, 'charge');
  }

  const intent = await load<PaymentIntent>(
    tx,
    'payment_intent',
    input.paymentIntent!,
    'payment_intent',
  );

  return await load<Charge>(tx, 'charge', intent.latest_charge, 'charge');
}

/**
 * Refund all or part of a charge. The charge carries the running total and
 * becomes `refunded` once nothing is left; each refund emits `charge.refunded`.
 */
export async function createRefund(
  tx: Transaction,
  input: {
    charge?: string | undefined;
    paymentIntent?: string | undefined;
    amount?: number | undefined;
    reason?: RefundReason | undefined;
    metadata?: Metadata | undefined;
  },
  now: number,
): Promise<Refund> {
  const charge = await chargeFor(tx, input);
  const remaining = charge.amount - charge.amount_refunded;

  if (remaining === 0) {
    throw invalidRequest(
      `Charge ${charge.id} has already been refunded.`,
      'charge',
      'charge_already_refunded',
    );
  }

  const amount = input.amount ?? remaining;

  if (amount < 1 || amount > remaining) {
    throw invalidRequest(
      `Refund amount (${amount}) is greater than unrefunded amount on charge (${remaining}).`,
      'amount',
      'amount_too_large',
    );
  }

  const refund: Refund = {
    id: randomId('re_'),
    object: 'refund',
    amount,
    charge: charge.id,
    created: seconds(now),
    currency: charge.currency,
    metadata: input.metadata ?? {},
    payment_intent: charge.payment_intent,
    reason: input.reason ?? null,
    status: 'succeeded',
  };
  const updated: Charge = {
    ...charge,
    amount_refunded: charge.amount_refunded + amount,
    refunded: charge.amount_refunded + amount === charge.amount,
  };

  await save(tx, refund);
  await save(tx, updated);
  await emit(tx, 'charge.refunded', updated, now, {
    amount_refunded: charge.amount_refunded,
    refunded: charge.refunded,
  });

  return refund;
}

/** Open a dispute on a paid charge, as a cardholder's bank would. */
export async function createDispute(
  tx: Transaction,
  input: { charge: string; reason?: DisputeReason | undefined },
  now: number,
): Promise<Dispute> {
  const charge = await load<Charge>(tx, 'charge', input.charge, 'charge');

  if (charge.disputed) {
    throw invalidRequest(
      `Charge ${charge.id} is already disputed.`,
      'charge',
    );
  }

  const dispute: Dispute = {
    id: randomId('dp_'),
    object: 'dispute',
    amount: charge.amount,
    balance_transactions: [],
    charge: charge.id,
    created: seconds(now),
    currency: charge.currency,
    evidence_details: {
      due_by: seconds(now) + 7 * 86400,
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    },
    is_charge_refundable: false,
    livemode: false,
    metadata: {},
    payment_intent: charge.payment_intent,
    reason: input.reason ?? 'fraudulent',
    status: 'needs_response',
  };

  await save(tx, dispute);
  await save(tx, { ...charge, disputed: true });
  await emit(tx, 'charge.dispute.created', dispute, now);

  return dispute;
}

/** Resolve an open dispute with the card network's final outcome. */
export async function closeDispute(
  tx: Transaction,
  input: { id: string; status: ClosedStatus },
  now: number,
): Promise<Dispute> {
  const dispute = await load<Dispute>(tx, 'dispute', input.id);

  if (dispute.status !== 'needs_response') {
    throw invalidRequest(`Dispute ${dispute.id} is already closed.`, 'id');
  }

  const closed: Dispute = { ...dispute, status: input.status };

  await save(tx, closed);
  await emit(tx, 'charge.dispute.closed', closed, now, {
    status: dispute.status,
  });

  return closed;
}
