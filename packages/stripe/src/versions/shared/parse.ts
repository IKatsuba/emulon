import { invalidRequest } from '../../errors.ts';
import { Fields } from '../../http/fields.ts';
import type { Params } from '../../http/form.ts';
import type { CustomerInput } from '../../model/customers.ts';
import type { SessionInput } from '../../model/checkout.ts';
import type { Inputs, OperationId } from '../../operations.ts';
import type { Parsed } from '../types.ts';
import { readExpand, readPage } from '../common.ts';

const productId = /^[a-zA-Z0-9_-]{1,255}$/;
const couponId = /^[a-zA-Z0-9_-]{1,255}$/;
const codeFormat = /^[a-zA-Z0-9_-]{1,500}$/;
const taxCode = /^txcd_\d{8}$/;

function currency(fields: Fields, required: boolean): string | undefined {
  const value = required
    ? fields.required('currency')
    : fields.string('currency');

  if (value !== undefined && !/^[a-zA-Z]{3}$/.test(value)) {
    throw invalidRequest('Invalid currency.', 'currency');
  }

  return value?.toLowerCase();
}

/** An empty `tax_code` clears it. */
function readTaxCode(fields: Fields): string | null | undefined {
  const value = fields.string('tax_code', { empty: true });

  if (value === '') {
    return null;
  }

  if (value !== undefined && !taxCode.test(value)) {
    throw invalidRequest('Invalid tax_code.', 'tax_code');
  }

  return value;
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

function none(fields: Fields): Record<string, never> {
  fields.done();

  return {};
}

export function readCustomer(fields: Fields): CustomerInput {
  const input: CustomerInput = {
    name: fields.string('name', { max: 256 }),
    email: fields.string('email', { max: 512 }),
    description: fields.string('description', { max: 350 }),
    phone: fields.string('phone', { max: 20 }),
    metadata: fields.metadata(),
  };

  fields.done();

  return input;
}

/**
 * `managed_payments` exists only in versions that know Stripe-managed
 * payments; elsewhere it is an unknown parameter.
 */
export function readSession(
  fields: Fields,
  { managedPayments }: { managedPayments: boolean },
): SessionInput {
  const mode = fields.oneOf('mode', ['payment', 'setup', 'subscription']);
  const lines = fields.list('line_items');
  const customer = fields.string('customer');
  const customerEmail = fields.string('customer_email', { max: 512 });
  const clientReferenceId = fields.string('client_reference_id', { max: 200 });
  const allowPromotionCodes = fields.bool('allow_promotion_codes');
  const discounts = fields.list('discounts');
  const successUrl = fields.string('success_url', { max: 5000 });
  const cancelUrl = fields.string('cancel_url', { max: 5000 });
  const expiresAt = fields.int('expires_at');
  const customerCreation = fields.oneOf('customer_creation', [
    'always',
    'if_required',
  ]);
  const locale = fields.string('locale');
  const paymentMethodTypes = fields.strings('payment_method_types');
  const uiMode = fields.oneOf('ui_mode', ['hosted', 'embedded', 'custom']);
  const managed = managedPayments
    ? fields.object('managed_payments')
    : undefined;
  const metadata = fields.metadata() ?? {};

  // Accepted for Stripe-managed payments integrations and otherwise ignored.
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

  if (allowPromotionCodes !== undefined && discounts !== undefined) {
    throw invalidRequest(
      'You may only specify one of these parameters: allow_promotion_codes, discounts.',
      'allow_promotion_codes',
    );
  }

  const items = lines.map((line, index) => {
    const price = line.string('price');
    const quantity = line.int('quantity', { min: 1, max: 999999 });

    if (line.has('price_data')) {
      throw invalidRequest(
        'Inline price_data is not supported by the local Stripe emulator; create a price first.',
        `line_items[${index}][price_data]`,
      );
    }

    line.done();

    if (price === undefined) {
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

    return { price, quantity };
  });

  return {
    lines: items,
    successUrl: checkUrl(successUrl, 'success_url'),
    cancelUrl: cancelUrl === undefined
      ? undefined
      : checkUrl(cancelUrl, 'cancel_url'),
    customer,
    customerEmail,
    clientReferenceId,
    allowPromotionCodes,
    discount: readDiscount(discounts),
    expiresAt,
    customerCreation,
    locale,
    paymentMethodTypes,
    metadata,
  };
}

function readDiscount(
  entries: Fields[] | undefined,
): SessionInput['discount'] {
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
  const coupon = entry.string('coupon');

  entry.done();

  if ((promotionCode === undefined) === (coupon === undefined)) {
    throw invalidRequest(
      'You must pass exactly one of coupon or promotion_code.',
      'discounts[0]',
    );
  }

  return promotionCode !== undefined ? { promotionCode } : { coupon: coupon! };
}

type Parser<Op extends OperationId> = (fields: Fields) => Inputs[Op];

/** Operations whose parameters differ between shipped versions. */
type Versioned = 'promotion_codes.create' | 'checkout.sessions.create';

/** Parsers of operations every shipped version accepts the same way. */
const shared: { [Op in Exclude<OperationId, Versioned>]: Parser<Op> } = {
  'customers.create': readCustomer,
  'customers.get': none,
  'products.create': (fields) => {
    const id = fields.string('id', { max: 255 });

    if (id !== undefined && !productId.test(id)) {
      throw invalidRequest('Invalid product id.', 'id');
    }

    const input = {
      id,
      active: fields.bool('active'),
      description: fields.string('description', { max: 40000 }),
      metadata: fields.metadata(),
      name: fields.required('name', { max: 250 }),
      statementDescriptor: fields.string('statement_descriptor', { max: 22 }),
      taxCode: readTaxCode(fields),
      unitLabel: fields.string('unit_label', { max: 12 }),
      url: fields.string('url', { max: 5000 }),
    };

    fields.done();

    return input;
  },
  'products.get': none,
  'products.update': (fields) => {
    const name = fields.string('name', { max: 250 });
    const active = fields.bool('active');
    const description = fields.string('description', {
      max: 40000,
      empty: true,
    });
    const taxCode = readTaxCode(fields);
    const defaultPrice = fields.string('default_price');
    const metadata = fields.metadata();

    fields.done();

    return {
      name,
      active,
      description: description === undefined ? undefined : description || null,
      taxCode,
      defaultPrice,
      metadata,
    };
  },
  'products.list': (fields) => {
    const input = {
      active: fields.bool('active'),
      ids: fields.strings('ids'),
      page: readPage(fields),
    };

    fields.done();

    return input;
  },
  'prices.create': (fields) => {
    if (fields.has('recurring')) {
      throw invalidRequest(
        'Recurring prices are not supported by the local Stripe emulator.',
        'recurring',
      );
    }

    const product = fields.required('product');
    const unitAmount = fields.int('unit_amount', { min: 0, max: 99999999 });
    const lookupKey = fields.string('lookup_key', { max: 200 });
    const transferLookupKey = fields.bool('transfer_lookup_key') ?? false;

    if (unitAmount === undefined) {
      throw invalidRequest(
        'Missing required param: unit_amount.',
        'unit_amount',
        'parameter_missing',
      );
    }

    const input = {
      product,
      unitAmount,
      lookupKey,
      transferLookupKey,
      active: fields.bool('active'),
      currency: currency(fields, true)!,
      metadata: fields.metadata(),
      nickname: fields.string('nickname', { max: 5000 }),
      taxBehavior: fields.oneOf('tax_behavior', [
        'exclusive',
        'inclusive',
        'unspecified',
      ]),
    };

    fields.done();

    return input;
  },
  'prices.get': none,
  'prices.update': (fields) => {
    const active = fields.bool('active');
    const nickname = fields.string('nickname', { max: 5000, empty: true });
    const lookupKey = fields.string('lookup_key', { max: 200, empty: true });
    const transferLookupKey = fields.bool('transfer_lookup_key') ?? false;
    const taxBehavior = fields.oneOf('tax_behavior', [
      'exclusive',
      'inclusive',
      'unspecified',
    ]);
    const metadata = fields.metadata();

    fields.done();

    return {
      active,
      nickname: nickname === undefined ? undefined : nickname || null,
      lookupKey: lookupKey === undefined ? undefined : lookupKey || null,
      transferLookupKey,
      taxBehavior,
      metadata,
    };
  },
  'prices.list': (fields) => {
    const active = fields.bool('active');
    const product = fields.string('product');
    const currencyFilter = currency(fields, false);
    const type = fields.oneOf('type', ['one_time', 'recurring']);
    const lookupKeys = fields.strings('lookup_keys');

    if (lookupKeys !== undefined && lookupKeys.length > 10) {
      throw invalidRequest(
        'You may pass at most 10 lookup keys.',
        'lookup_keys',
      );
    }

    const page = readPage(fields);

    fields.done();

    return {
      active,
      product,
      currency: currencyFilter,
      type,
      lookupKeys,
      page,
    };
  },
  'coupons.create': (fields) => {
    const id = fields.string('id', { max: 255 });
    const percentOff = fields.decimal('percent_off', { min: 0, max: 100 });
    const amountOff = fields.int('amount_off', { min: 1 });
    const currency = fields.string('currency');
    const duration =
      fields.oneOf('duration', ['forever', 'once', 'repeating']) ?? 'once';
    const durationInMonths = fields.int('duration_in_months', {
      min: 1,
      max: 12,
    });
    const appliesTo = fields.object('applies_to');
    const products = appliesTo?.strings('products');
    const redeemBy = fields.int('redeem_by', { min: 0 });
    const maxRedemptions = fields.int('max_redemptions', { min: 1 });
    const metadata = fields.metadata();
    const name = fields.string('name', { max: 40 });

    appliesTo?.done();
    fields.done();

    if (id !== undefined && !couponId.test(id)) {
      throw invalidRequest('Invalid coupon id.', 'id');
    }

    if ((percentOff === undefined) === (amountOff === undefined)) {
      throw invalidRequest(
        'You must pass exactly one of percent_off or amount_off.',
        percentOff === undefined ? 'percent_off' : 'amount_off',
      );
    }

    if (percentOff !== undefined && percentOff <= 0) {
      throw invalidRequest(
        'percent_off must be greater than 0.',
        'percent_off',
      );
    }

    if (amountOff !== undefined && currency === undefined) {
      throw invalidRequest(
        'You must pass currency when passing amount_off.',
        'currency',
      );
    }

    if (percentOff !== undefined && currency !== undefined) {
      throw invalidRequest(
        'currency is only used with amount_off.',
        'currency',
      );
    }

    if ((duration === 'repeating') !== (durationInMonths !== undefined)) {
      throw invalidRequest(
        'duration_in_months is required for, and only valid with, a repeating duration.',
        'duration_in_months',
      );
    }

    return {
      id,
      percentOff,
      amountOff,
      currency: currency?.toLowerCase(),
      duration,
      durationInMonths,
      products,
      redeemBy,
      maxRedemptions,
      metadata,
      name,
    };
  },
  'coupons.get': none,
  'coupons.delete': none,
  'promotion_codes.get': none,
  'promotion_codes.update': (fields) => {
    const input = {
      active: fields.bool('active'),
      metadata: fields.metadata(),
    };

    fields.done();

    return input;
  },
  'promotion_codes.list': (fields) => {
    const input = {
      active: fields.bool('active'),
      code: fields.string('code'),
      coupon: fields.string('coupon'),
      customer: fields.string('customer'),
      page: readPage(fields),
    };

    fields.done();

    return input;
  },
  'checkout.sessions.get': none,
  'checkout.sessions.list': (fields) => {
    const input = {
      paymentIntent: fields.string('payment_intent'),
      customer: fields.string('customer'),
      status: fields.oneOf('status', ['complete', 'expired', 'open']),
      page: readPage(fields),
    };

    fields.done();

    return input;
  },
  'checkout.sessions.line_items': (fields) => {
    const limit = fields.int('limit', { min: 1, max: 100 }) ?? 10;

    fields.done();

    return { limit };
  },
  'checkout.sessions.expire': none,
  'payment_intents.get': none,
  'charges.get': none,
  'refunds.create': (fields) => {
    const input = {
      charge: fields.string('charge'),
      paymentIntent: fields.string('payment_intent'),
      amount: fields.int('amount', { min: 1 }),
      reason: fields.oneOf('reason', [
        'duplicate',
        'fraudulent',
        'requested_by_customer',
      ]),
      metadata: fields.metadata(),
    };

    fields.done();

    return input;
  },
  'refunds.get': none,
  'disputes.get': none,
};

/**
 * The rest of a promotion code once a version has read which coupon it
 * discounts with, in whatever shape that version names it.
 */
export function readPromotionCode(
  fields: Fields,
  coupon: string,
): Inputs['promotion_codes.create'] {
  const code = fields.string('code', { max: 500 });
  const expiresAt = fields.int('expires_at', { min: 0 });
  const customer = fields.string('customer');
  const restrictions = fields.object('restrictions');
  const minimumAmount = restrictions?.int('minimum_amount', { min: 1 });
  const minimumAmountCurrency = restrictions?.string(
    'minimum_amount_currency',
  );
  const active = fields.bool('active');
  const maxRedemptions = fields.int('max_redemptions', { min: 1 });
  const metadata = fields.metadata();
  const firstTimeTransaction = restrictions?.bool('first_time_transaction');

  restrictions?.done();
  fields.done();

  if (code !== undefined && !codeFormat.test(code)) {
    throw invalidRequest(
      'Promotion codes may contain only letters, digits, - and _.',
      'code',
    );
  }

  if (
    (minimumAmount === undefined) !== (minimumAmountCurrency === undefined)
  ) {
    throw invalidRequest(
      'minimum_amount and minimum_amount_currency must be passed together.',
      'restrictions',
    );
  }

  return {
    coupon,
    code,
    active,
    customer,
    expiresAt,
    maxRedemptions,
    metadata,
    firstTimeTransaction,
    minimumAmount,
    minimumAmountCurrency: minimumAmountCurrency?.toLowerCase(),
  };
}

/** A version's parser: the shared operations plus its own. */
export function parser(
  own: { [Op in Versioned]: Parser<Op> },
): <Op extends OperationId>(
  operation: Op,
  params: Params,
) => Parsed<Inputs[Op]> {
  const parsers = { ...shared, ...own } as {
    [Op in OperationId]: Parser<Op>;
  };

  return (operation, params) => {
    const fields = new Fields(params);
    const expand = readExpand(fields);

    return { input: parsers[operation](fields), expand };
  };
}
