// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import type { Kind, Resolver, ResourceRecord } from '../../model/core.ts';
import type { Customer } from '../../model/customers.ts';
import type { Price, Product } from '../../model/catalog.ts';
import type { CouponView, PromotionCodeView } from '../../model/discounts.ts';
import type { CheckoutSession, LineItem } from '../../model/checkout.ts';
import type {
  Charge,
  Dispute,
  PaymentIntent,
  Refund,
} from '../../model/payments.ts';
import { expandPaths } from '../common.ts';

type Wire = Record<string, unknown>;

function customer(r: Customer): Wire {
  return {
    id: r.id,
    object: 'customer',
    address: null,
    balance: 0,
    created: r.created,
    currency: null,
    default_source: null,
    delinquent: false,
    description: r.description,
    discount: null,
    email: r.email,
    invoice_prefix: r.invoice_prefix,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null,
    },
    livemode: false,
    metadata: { ...r.metadata },
    name: r.name,
    next_invoice_sequence: 1,
    phone: r.phone,
    preferred_locales: [],
    shipping: null,
    tax_exempt: 'none',
    test_clock: null,
  };
}

function product(r: Product): Wire {
  return {
    id: r.id,
    object: 'product',
    active: r.active,
    created: r.created,
    default_price: r.default_price,
    description: r.description,
    images: [],
    livemode: false,
    marketing_features: [],
    metadata: { ...r.metadata },
    name: r.name,
    package_dimensions: null,
    shippable: null,
    statement_descriptor: r.statement_descriptor,
    tax_code: r.tax_code,
    type: 'service',
    unit_label: r.unit_label,
    updated: r.updated,
    url: r.url,
  };
}

function price(r: Price): Wire {
  return {
    id: r.id,
    object: 'price',
    active: r.active,
    billing_scheme: 'per_unit',
    created: r.created,
    currency: r.currency,
    custom_unit_amount: null,
    livemode: false,
    lookup_key: r.lookup_key,
    metadata: { ...r.metadata },
    nickname: r.nickname,
    product: r.product,
    recurring: null,
    tax_behavior: r.tax_behavior,
    tiers_mode: null,
    transform_quantity: null,
    type: 'one_time',
    unit_amount: r.unit_amount,
    unit_amount_decimal: String(r.unit_amount),
  };
}

function coupon(r: CouponView): Wire {
  return {
    id: r.id,
    object: 'coupon',
    amount_off: r.amount_off,
    ...(r.applies_to
      ? { applies_to: { products: [...r.applies_to.products] } }
      : {}),
    created: r.created,
    currency: r.currency,
    duration: r.duration,
    duration_in_months: r.duration_in_months,
    livemode: false,
    max_redemptions: r.max_redemptions,
    metadata: { ...r.metadata },
    name: r.name,
    percent_off: r.percent_off,
    redeem_by: r.redeem_by,
    times_redeemed: r.times_redeemed,
    valid: r.valid,
  };
}

function promotionCode(r: PromotionCodeView): Wire {
  return {
    id: r.id,
    object: 'promotion_code',
    active: r.active,
    code: r.code,
    created: r.created,
    customer: r.customer,
    expires_at: r.expires_at,
    livemode: false,
    max_redemptions: r.max_redemptions,
    metadata: { ...r.metadata },
    promotion: { type: 'coupon', coupon: r.coupon },
    restrictions: { ...r.restrictions },
    times_redeemed: r.times_redeemed,
  };
}

function session(r: CheckoutSession): Wire {
  return {
    id: r.id,
    object: 'checkout.session',
    allow_promotion_codes: r.allow_promotion_codes,
    amount_subtotal: r.amount_subtotal,
    amount_total: r.amount_total,
    cancel_url: r.cancel_url,
    client_reference_id: r.client_reference_id,
    created: r.created,
    currency: r.currency,
    customer: r.customer,
    customer_creation: r.customer_creation,
    customer_details: r.customer_details && {
      address: null,
      email: r.customer_details.email,
      name: r.customer_details.name,
      phone: null,
      tax_exempt: 'none',
      tax_ids: [],
    },
    customer_email: r.customer_email,
    discounts: r.discounts.map((discount) => ({ ...discount })),
    expires_at: r.expires_at,
    livemode: false,
    locale: r.locale,
    metadata: { ...r.metadata },
    mode: 'payment',
    payment_intent: r.payment_intent,
    payment_method_types: [...r.payment_method_types],
    payment_status: r.payment_status,
    status: r.status,
    success_url: r.success_url,
    total_details: {
      amount_discount: r.amount_discount,
      amount_shipping: 0,
      amount_tax: 0,
    },
    ui_mode: 'hosted',
    url: r.url,
  };
}

function lineItem(r: LineItem): Wire {
  return {
    id: r.id,
    object: 'item',
    amount_discount: r.amount_discount,
    amount_subtotal: r.amount_subtotal,
    amount_tax: 0,
    amount_total: r.amount_total,
    currency: r.currency,
    description: r.description,
    price: price(r.price),
    quantity: r.quantity,
  };
}

function paymentIntent(r: PaymentIntent): Wire {
  return {
    id: r.id,
    object: 'payment_intent',
    amount: r.amount,
    amount_capturable: 0,
    amount_received: r.amount,
    capture_method: 'automatic_async',
    client_secret: r.client_secret,
    confirmation_method: 'automatic',
    created: r.created,
    currency: r.currency,
    customer: r.customer,
    description: null,
    latest_charge: r.latest_charge,
    livemode: false,
    metadata: { ...r.metadata },
    payment_method: r.payment_method,
    payment_method_types: ['card'],
    receipt_email: r.receipt_email,
    status: 'succeeded',
  };
}

function charge(r: Charge): Wire {
  return {
    id: r.id,
    object: 'charge',
    amount: r.amount,
    amount_captured: r.amount,
    amount_refunded: r.amount_refunded,
    balance_transaction: null,
    billing_details: {
      address: null,
      email: r.billing_details.email,
      name: r.billing_details.name,
      phone: null,
    },
    captured: true,
    created: r.created,
    currency: r.currency,
    customer: r.customer,
    description: null,
    disputed: r.disputed,
    failure_code: null,
    failure_message: null,
    livemode: false,
    metadata: { ...r.metadata },
    outcome: {
      network_status: 'approved_by_network',
      reason: null,
      risk_level: 'normal',
      seller_message: 'Payment complete.',
      type: 'authorized',
    },
    paid: true,
    payment_intent: r.payment_intent,
    payment_method: r.payment_method,
    receipt_email: r.receipt_email,
    refunded: r.refunded,
    status: 'succeeded',
  };
}

function refund(r: Refund): Wire {
  return {
    id: r.id,
    object: 'refund',
    amount: r.amount,
    charge: r.charge,
    created: r.created,
    currency: r.currency,
    metadata: { ...r.metadata },
    payment_intent: r.payment_intent,
    reason: r.reason,
    status: 'succeeded',
  };
}

function dispute(r: Dispute): Wire {
  return {
    id: r.id,
    object: 'dispute',
    amount: r.amount,
    balance_transactions: [],
    charge: r.charge,
    created: r.created,
    currency: r.currency,
    evidence_details: {
      due_by: r.evidence_due_by,
      has_evidence: false,
      past_due: false,
      submission_count: 0,
    },
    is_charge_refundable: false,
    livemode: false,
    metadata: { ...r.metadata },
    payment_intent: r.payment_intent,
    reason: r.reason,
    status: r.status,
  };
}

// deno-lint-ignore no-explicit-any
const projections: Record<Kind | 'item', (record: any) => Wire> = {
  customer,
  product,
  price,
  coupon,
  promotion_code: promotionCode,
  'checkout.session': session,
  item: lineItem,
  payment_intent: paymentIntent,
  charge,
  refund,
  dispute,
};

/** Properties of dahlia objects that name another resource. */
const expandable: Record<string, Kind> = {
  coupon: 'coupon',
  customer: 'customer',
  product: 'product',
  price: 'price',
  promotion_code: 'promotion_code',
  payment_intent: 'payment_intent',
  latest_charge: 'charge',
  charge: 'charge',
  default_price: 'price',
};

/**
 * A stored record as a dahlia object. Coupons and promotion codes are
 * projected from their views, which carry the derived `valid` and `active`.
 */
export function projectRecord(record: ResourceRecord | LineItem): Wire {
  return projections[record.object](record);
}

export async function project(
  result: unknown,
  expand: readonly string[],
  resolve: Resolver,
): Promise<unknown> {
  const value = result as { object: string; deleted?: true };
  let wire: unknown;

  if (value.object === 'list') {
    const list = result as { data: (ResourceRecord | LineItem)[] } & Wire;

    wire = { ...list, data: list.data.map(projectRecord) };
  } else if (value.deleted) {
    wire = { ...value };
  } else {
    wire = projectRecord(result as ResourceRecord);
  }

  return await expandPaths(wire, expand, expandable, resolve, projectRecord);
}
