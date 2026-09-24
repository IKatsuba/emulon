// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import type { Metadata } from '../model/core.ts';
import type {
  ClosedStatus,
  DisputeReason,
  RefundReason,
} from '../model/payments.ts';

/**
 * The objects control commands return, as the SDK types them. Every shipped
 * version shows these the same way.
 */

export interface Customer {
  id: string;
  object: 'customer';
  address: null;
  balance: number;
  created: number;
  currency: string | null;
  default_source: null;
  delinquent: boolean;
  description: string | null;
  discount: null;
  email: string | null;
  invoice_prefix: string;
  invoice_settings: {
    custom_fields: null;
    default_payment_method: null;
    footer: null;
    rendering_options: null;
  };
  livemode: false;
  metadata: Metadata;
  name: string | null;
  next_invoice_sequence: number;
  phone: string | null;
  preferred_locales: string[];
  shipping: null;
  tax_exempt: 'none';
  test_clock: null;
}

export interface CheckoutSession {
  id: string;
  object: 'checkout.session';
  allow_promotion_codes: boolean | null;
  amount_subtotal: number;
  amount_total: number;
  cancel_url: string | null;
  client_reference_id: string | null;
  created: number;
  currency: string;
  customer: string | null;
  customer_creation: 'always' | 'if_required';
  customer_details: {
    address: null;
    email: string | null;
    name: string | null;
    phone: null;
    tax_exempt: 'none';
    tax_ids: [];
  } | null;
  customer_email: string | null;
  discounts: { coupon: string | null; promotion_code: string | null }[];
  expires_at: number;
  livemode: false;
  locale: string | null;
  metadata: Metadata;
  mode: 'payment';
  payment_intent: string | null;
  payment_method_types: string[];
  payment_status: 'no_payment_required' | 'paid' | 'unpaid';
  status: 'complete' | 'expired' | 'open';
  success_url: string;
  total_details: {
    amount_discount: number;
    amount_shipping: 0;
    amount_tax: 0;
  };
  ui_mode: 'hosted';
  url: string | null;
}

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
