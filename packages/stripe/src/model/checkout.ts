// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { invalidRequest } from '../errors.ts';
import type { Fields } from '../http/fields.ts';
import {
  all,
  emit,
  find,
  load,
  type Metadata,
  paginate,
  randomId,
  save,
  seconds,
  type Transaction,
} from './core.ts';
import type { Price, Product } from './catalog.ts';
import { type Customer, insertCustomer } from './customers.ts';
import { type Coupon, couponValid, redeem, redeemable } from './discounts.ts';
import { capturePayment, type Charge } from './payments.ts';

export interface LineItem {
  id: string;
  object: 'item';
  amount_discount: number;
  amount_subtotal: number;
  amount_tax: 0;
  amount_total: number;
  currency: string;
  description: string;
  price: Price;
  quantity: number;
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

const lineCollection = 'checkout_line_items';

/**
 * Amounts for a set of line items and an optional coupon. A coupon limited to
 * products discounts only those items; a fixed amount never exceeds what it
 * applies to and must share the session currency.
 */
export function totals(
  items: { product: string; amount: number }[],
  currency: string,
  coupon?: Pick<
    Coupon,
    'percent_off' | 'amount_off' | 'currency' | 'applies_to'
  >,
): { subtotal: number; discount: number; total: number; perItem: number[] } {
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const eligible = items.map((item) =>
    coupon !== undefined &&
    (coupon.applies_to === undefined ||
      coupon.applies_to.products.includes(item.product))
  );
  const base = items.reduce(
    (sum, item, index) => sum + (eligible[index] ? item.amount : 0),
    0,
  );

  if (coupon === undefined) {
    return {
      subtotal,
      discount: 0,
      total: subtotal,
      perItem: items.map(() => 0),
    };
  }

  if (base === 0) {
    throw invalidRequest(
      'This promotion code cannot be redeemed because the associated coupon is not valid for any of the items.',
      'discounts',
    );
  }

  if (coupon.amount_off !== null && coupon.currency !== currency) {
    throw invalidRequest(
      'This coupon is in a different currency than the Checkout Session.',
      'discounts',
    );
  }

  const discount = coupon.percent_off !== null
    ? Math.round(base * coupon.percent_off / 100)
    : Math.min(coupon.amount_off ?? 0, base);
  // Spread the discount over eligible items in proportion, rounding down and
  // giving the remainder to the last one so the parts add up exactly.
  const perItem = items.map((item, index) =>
    eligible[index] ? Math.floor(discount * item.amount / base) : 0
  );
  const lastEligible = eligible.lastIndexOf(true);

  perItem[lastEligible]! += discount -
    perItem.reduce((sum, value) => sum + value, 0);

  return { subtotal, discount, total: subtotal - discount, perItem };
}

function checkUrl(value: string, param: string): string {
  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw invalidRequest(`Not a valid URL: ${param}.`, param, 'url_invalid');
  }

  return value;
}

async function discountFor(
  tx: Transaction,
  entries: Fields[] | undefined,
  now: number,
) {
  if (entries === undefined || entries.length === 0) {
    return undefined;
  }

  if (entries.length > 1) {
    throw invalidRequest(
      'You may only apply one discount to a Checkout Session.',
      'discounts',
    );
  }

  const entry = entries[0]!;
  const promotionCode = entry.string('promotion_code');
  const couponId = entry.string('coupon');

  entry.done();

  if ((promotionCode === undefined) === (couponId === undefined)) {
    throw invalidRequest(
      'You must pass exactly one of coupon or promotion_code.',
      'discounts[0]',
    );
  }

  if (promotionCode !== undefined) {
    const { promotion, coupon } = await redeemable(
      tx,
      { id: promotionCode },
      now,
      'discounts[0][promotion_code]',
    );

    return { promotion, coupon };
  }

  const coupon = await load<Coupon>(
    tx,
    'coupon',
    couponId!,
    'discounts[0][coupon]',
  );

  if (!couponValid(coupon, now)) {
    throw invalidRequest(
      'This coupon is no longer valid.',
      'discounts[0][coupon]',
    );
  }

  return { promotion: undefined, coupon };
}

export async function createSession(
  tx: Transaction,
  fields: Fields,
  now: number,
  hostedUrl: (id: string) => string,
): Promise<CheckoutSession> {
  const mode = fields.oneOf('mode', ['payment', 'setup', 'subscription']);
  const lines = fields.list('line_items');
  const customer = fields.string('customer');
  const customerEmail = fields.string('customer_email', { max: 512 });
  const clientReference = fields.string('client_reference_id', { max: 200 });
  const allowPromotion = fields.bool('allow_promotion_codes');
  const discounts = fields.list('discounts');
  const successUrl = fields.string('success_url', { max: 5000 });
  const cancelUrl = fields.string('cancel_url', { max: 5000 });
  const expiresAt = fields.int('expires_at');
  const creation = fields.oneOf('customer_creation', ['always', 'if_required']);
  const locale = fields.string('locale');
  const methods = fields.strings('payment_method_types');
  const uiMode = fields.oneOf('ui_mode', ['hosted', 'embedded', 'custom']);
  const managed = fields.object('managed_payments');
  const metadata = fields.metadata() ?? {};

  managed?.bool('enabled');
  managed?.done();
  fields.done();

  if (mode === undefined) {
    throw invalidRequest(
      'Missing required param: mode.',
      'mode',
      'parameter_missing',
    );
  }

  if (mode !== 'payment') {
    throw invalidRequest(
      'The local Stripe emulator supports only payment mode.',
      'mode',
    );
  }

  if (uiMode !== undefined && uiMode !== 'hosted') {
    throw invalidRequest(
      'The local Stripe emulator supports only hosted Checkout.',
      'ui_mode',
    );
  }

  if (lines === undefined || lines.length === 0) {
    throw invalidRequest(
      'Missing required param: line_items.',
      'line_items',
      'parameter_missing',
    );
  }

  if (successUrl === undefined) {
    throw invalidRequest(
      'Missing required param: success_url.',
      'success_url',
      'parameter_missing',
    );
  }

  if (customer !== undefined && customerEmail !== undefined) {
    throw invalidRequest(
      'You may only specify one of these parameters: customer, customer_email.',
      'customer_email',
    );
  }

  if (allowPromotion !== undefined && discounts !== undefined) {
    throw invalidRequest(
      'You may only specify one of these parameters: allow_promotion_codes, discounts.',
      'allow_promotion_codes',
    );
  }

  const created = seconds(now);

  if (
    expiresAt !== undefined &&
    (expiresAt < created + 1800 || expiresAt > created + 86400)
  ) {
    throw invalidRequest(
      'expires_at must be between 30 minutes and 24 hours from now.',
      'expires_at',
    );
  }

  const items: { price: Price; quantity: number }[] = [];

  for (const [index, line] of lines.entries()) {
    const priceId = line.string('price');
    const quantity = line.int('quantity', { min: 1, max: 999999 });

    if (line.has('price_data')) {
      throw invalidRequest(
        'Inline price_data is not supported by the local Stripe emulator; create a price first.',
        `line_items[${index}][price_data]`,
      );
    }

    line.done();

    if (priceId === undefined) {
      throw invalidRequest(
        `Missing required param: line_items[${index}][price].`,
        `line_items[${index}][price]`,
        'parameter_missing',
      );
    }

    if (quantity === undefined) {
      throw invalidRequest(
        `Missing required param: line_items[${index}][quantity].`,
        `line_items[${index}][quantity]`,
        'parameter_missing',
      );
    }

    const price = await load<Price>(
      tx,
      'price',
      priceId,
      `line_items[${index}][price]`,
    );
    const product = await load<Product>(tx, 'product', price.product);

    if (!price.active || !product.active) {
      throw invalidRequest(
        `The price specified is inactive. This field only accepts active prices.`,
        `line_items[${index}][price]`,
      );
    }

    items.push({ price, quantity });
  }

  const currency = items[0]!.price.currency;

  if (items.some((item) => item.price.currency !== currency)) {
    throw invalidRequest(
      'All line items must use the same currency.',
      'line_items',
    );
  }

  if (customer !== undefined) {
    await load<Customer>(tx, 'customer', customer, 'customer');
  }

  const discount = await discountFor(tx, discounts, now);
  const amounts = totals(
    items.map((item) => ({
      product: item.price.product,
      amount: item.price.unit_amount * item.quantity,
    })),
    currency,
    discount?.coupon,
  );
  const id = randomId('cs_test_', 58);
  const session: CheckoutSession = {
    id,
    object: 'checkout.session',
    allow_promotion_codes: allowPromotion ?? null,
    amount_subtotal: amounts.subtotal,
    amount_total: amounts.total,
    cancel_url: cancelUrl === undefined
      ? null
      : checkUrl(cancelUrl, 'cancel_url'),
    client_reference_id: clientReference ?? null,
    created,
    currency,
    customer: customer ?? null,
    customer_creation: creation ?? 'if_required',
    customer_details: null,
    customer_email: customerEmail ?? null,
    discounts: discount
      ? [{
        coupon: discount.promotion ? null : discount.coupon.id,
        promotion_code: discount.promotion?.id ?? null,
      }]
      : [],
    expires_at: expiresAt ?? created + 86400,
    livemode: false,
    locale: locale ?? null,
    metadata,
    mode: 'payment',
    payment_intent: null,
    payment_method_types: methods ?? ['card'],
    payment_status: 'unpaid',
    status: 'open',
    success_url: checkUrl(successUrl, 'success_url'),
    total_details: {
      amount_discount: amounts.discount,
      amount_shipping: 0,
      amount_tax: 0,
    },
    ui_mode: 'hosted',
    url: hostedUrl(id),
  };

  await save(tx, session);
  await tx.put({
    collection: lineCollection,
    id,
    value: items.map((item, index) => lineItem(item, index, amounts)),
  });

  return session;
}

function lineItem(
  item: { price: Price; quantity: number },
  index: number,
  amounts: ReturnType<typeof totals>,
): LineItem {
  const subtotal = item.price.unit_amount * item.quantity;

  return {
    id: randomId('li_'),
    object: 'item',
    amount_discount: amounts.perItem[index]!,
    amount_subtotal: subtotal,
    amount_tax: 0,
    amount_total: subtotal - amounts.perItem[index]!,
    currency: item.price.currency,
    description: item.price.nickname ?? '',
    price: item.price,
    quantity: item.quantity,
  };
}

/** Expire an open session whose `expires_at` has passed, as Stripe does. */
async function settle(
  tx: Transaction,
  session: CheckoutSession,
  now: number,
): Promise<CheckoutSession> {
  if (session.status !== 'open' || seconds(now) < session.expires_at) {
    return session;
  }

  const expired: CheckoutSession = { ...session, status: 'expired', url: null };

  await save(tx, expired);
  await emit(tx, 'checkout.session.expired', expired, now);

  return expired;
}

export async function getSession(
  tx: Transaction,
  id: string,
  now: number,
): Promise<CheckoutSession> {
  return await settle(
    tx,
    await load<CheckoutSession>(tx, 'checkout.session', id, 'session'),
    now,
  );
}

export async function listSessions(
  tx: Transaction,
  fields: Fields,
  now: number,
) {
  const paymentIntent = fields.string('payment_intent');
  const customer = fields.string('customer');
  const status = fields.oneOf('status', ['complete', 'expired', 'open']);
  const sessions: CheckoutSession[] = [];

  for (const stored of await all<CheckoutSession>(tx, 'checkout.session')) {
    const session = await settle(tx, stored, now);

    if (
      (paymentIntent === undefined ||
        session.payment_intent === paymentIntent) &&
      (customer === undefined || session.customer === customer) &&
      (status === undefined || session.status === status)
    ) {
      sessions.push(session);
    }
  }

  const list = paginate(sessions, fields, '/v1/checkout/sessions');

  fields.done();

  return list;
}

export async function listLineItems(
  tx: Transaction,
  id: string,
  fields: Fields,
) {
  await load<CheckoutSession>(tx, 'checkout.session', id, 'session');

  const items = (await tx.get(lineCollection, id) ?? []) as LineItem[];
  const limit = fields.int('limit', { min: 1, max: 100 }) ?? 10;

  fields.done();

  return {
    object: 'list' as const,
    data: items.slice(0, limit),
    has_more: items.length > limit,
    url: `/v1/checkout/sessions/${id}/line_items`,
  };
}

export async function expireSession(
  tx: Transaction,
  id: string,
  now: number,
): Promise<CheckoutSession> {
  const session = await getSession(tx, id, now);

  if (session.status !== 'open') {
    throw invalidRequest(
      `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".`,
      'session',
    );
  }

  const expired: CheckoutSession = { ...session, status: 'expired', url: null };

  await save(tx, expired);
  await emit(tx, 'checkout.session.expired', expired, now);

  return expired;
}

export interface CompleteInput {
  id: string;
  email?: string | undefined;
  name?: string | undefined;
  promotionCode?: string | undefined;
}

/**
 * What happens when the buyer pays on the hosted page: the discount is
 * redeemed, a payment intent and charge succeed (none for a free total), the
 * session completes and `checkout.session.completed` is recorded.
 */
export async function completeSession(
  tx: Transaction,
  input: CompleteInput,
  now: number,
): Promise<CheckoutSession> {
  let session = await getSession(tx, input.id, now);

  if (session.status !== 'open') {
    throw invalidRequest(
      `This Checkout Session is ${session.status} and can no longer be paid.`,
      'session',
    );
  }

  const customer = session.customer === null
    ? undefined
    : await find<Customer>(tx, 'customer', session.customer);
  const email = session.customer_email ?? customer?.email ?? input.email ??
    null;

  if (email === null) {
    throw invalidRequest(
      'The buyer must provide an email address to complete this Checkout Session.',
      'email',
    );
  }

  const items = (await tx.get(lineCollection, session.id) ?? []) as LineItem[];
  let discount: Awaited<ReturnType<typeof redeemable>> | undefined;

  if (input.promotionCode !== undefined) {
    if (!session.allow_promotion_codes) {
      throw invalidRequest(
        'This Checkout Session does not accept promotion codes.',
        'promotion_code',
      );
    }

    discount = await redeemable(
      tx,
      { code: input.promotionCode },
      now,
      'promotion_code',
    );
  } else if (session.discounts[0]?.promotion_code) {
    // The code may have been deactivated or used up since the session opened.
    discount = await redeemable(
      tx,
      { id: session.discounts[0].promotion_code },
      now,
      'discounts',
    );
  }

  const coupon = discount?.coupon ??
    (session.discounts[0]?.coupon
      ? await load<Coupon>(tx, 'coupon', session.discounts[0].coupon)
      : undefined);
  const amounts = totals(
    items.map((item) => ({
      product: item.price.product,
      amount: item.amount_subtotal,
    })),
    session.currency,
    coupon,
  );
  const minimum = discount?.promotion.restrictions;

  if (
    minimum !== undefined && minimum.minimum_amount !== null &&
    (minimum.minimum_amount_currency !== session.currency ||
      amounts.subtotal < minimum.minimum_amount)
  ) {
    throw invalidRequest(
      'This promotion code requires a higher order amount.',
      'promotion_code',
    );
  }

  if (minimum?.first_time_transaction && customer !== undefined) {
    const paid = (await all<Charge>(tx, 'charge')).some((charge) =>
      charge.customer === customer.id
    );

    if (paid) {
      throw invalidRequest(
        'This promotion code is only valid for first-time customers.',
        'promotion_code',
      );
    }
  }

  if (discount !== undefined) {
    await redeem(tx, discount.promotion, discount.coupon);
  } else if (coupon !== undefined) {
    if (!couponValid(coupon, now)) {
      throw invalidRequest('This coupon is no longer valid.', 'discounts');
    }

    await save(tx, { ...coupon, times_redeemed: coupon.times_redeemed + 1 });
  }

  let customerId = session.customer;

  if (customerId === null && session.customer_creation === 'always') {
    customerId =
      (await insertCustomer(tx, { email, name: input.name }, now)).id;
  }

  const intent = amounts.total > 0
    ? await capturePayment(tx, {
      amount: amounts.total,
      currency: session.currency,
      customer: customerId,
      email,
      name: input.name ?? customer?.name ?? null,
    }, now)
    : undefined;

  session = {
    ...session,
    amount_subtotal: amounts.subtotal,
    amount_total: amounts.total,
    customer: customerId,
    customer_details: {
      address: null,
      email,
      name: input.name ?? customer?.name ?? null,
      phone: null,
      tax_exempt: 'none',
      tax_ids: [],
    },
    discounts: discount
      ? [{ coupon: null, promotion_code: discount.promotion.id }]
      : session.discounts,
    payment_intent: intent?.id ?? null,
    payment_status: intent ? 'paid' : 'no_payment_required',
    status: 'complete',
    total_details: {
      amount_discount: amounts.discount,
      amount_shipping: 0,
      amount_tax: 0,
    },
    url: null,
  };

  await save(tx, session);
  await tx.put({
    collection: lineCollection,
    id: session.id,
    value: items.map((item, index) => ({
      ...item,
      amount_discount: amounts.perItem[index]!,
      amount_total: item.amount_subtotal - amounts.perItem[index]!,
    })),
  });
  await emit(tx, 'checkout.session.completed', session, now);

  return session;
}
