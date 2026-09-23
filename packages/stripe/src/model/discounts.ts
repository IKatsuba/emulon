// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { invalidRequest, StripeError } from '../errors.ts';
import { type Fields, mergeMetadata } from '../http/fields.ts';
import {
  all,
  find,
  load,
  type Metadata,
  paginate,
  randomId,
  save,
  seconds,
  type Transaction,
} from './core.ts';
import type { Product } from './catalog.ts';

export interface Coupon {
  id: string;
  object: 'coupon';
  amount_off: number | null;
  applies_to?: { products: string[] };
  created: number;
  currency: string | null;
  duration: 'forever' | 'once' | 'repeating';
  duration_in_months: number | null;
  livemode: false;
  max_redemptions: number | null;
  metadata: Metadata;
  name: string | null;
  percent_off: number | null;
  redeem_by: number | null;
  times_redeemed: number;
  valid: boolean;
}

export interface PromotionCode {
  id: string;
  object: 'promotion_code';
  active: boolean;
  code: string;
  created: number;
  customer: string | null;
  expires_at: number | null;
  livemode: false;
  max_redemptions: number | null;
  metadata: Metadata;
  promotion: { type: 'coupon'; coupon: string | Coupon };
  restrictions: {
    first_time_transaction: boolean;
    minimum_amount: number | null;
    minimum_amount_currency: string | null;
  };
  times_redeemed: number;
}

/** Stored codes keep the merchant's switch; `active` is derived on read. */
type StoredPromotionCode = PromotionCode & { enabled: boolean };

const couponId = /^[a-zA-Z0-9_-]{1,255}$/;
const codeFormat = /^[a-zA-Z0-9_-]{1,500}$/;
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function couponValid(coupon: Coupon, now: number): boolean {
  return (coupon.redeem_by === null || coupon.redeem_by > seconds(now)) &&
    (coupon.max_redemptions === null ||
      coupon.times_redeemed < coupon.max_redemptions);
}

/**
 * Whether a promotion code can be redeemed right now: switched on, unexpired,
 * with redemptions left and an existing, valid coupon behind it.
 */
export function promotionActive(
  code: StoredPromotionCode,
  coupon: Coupon | undefined,
  now: number,
): boolean {
  return code.enabled &&
    (code.expires_at === null || code.expires_at > seconds(now)) &&
    (code.max_redemptions === null ||
      code.times_redeemed < code.max_redemptions) &&
    coupon !== undefined && couponValid(coupon, now);
}

async function present(
  tx: Transaction,
  code: StoredPromotionCode,
  now: number,
): Promise<PromotionCode> {
  const { enabled: _, ...visible } = code;
  const coupon = await find<Coupon>(
    tx,
    'coupon',
    code.promotion.coupon as string,
  );

  return { ...visible, active: promotionActive(code, coupon, now) };
}

export async function createCoupon(
  tx: Transaction,
  fields: Fields,
  now: number,
): Promise<Coupon> {
  const id = fields.string('id', { max: 255 });
  const percentOff = fields.decimal('percent_off', { min: 0, max: 100 });
  const amountOff = fields.int('amount_off', { min: 1 });
  const currency = fields.string('currency');
  const duration = fields.oneOf('duration', ['forever', 'once', 'repeating']) ??
    'once';
  const months = fields.int('duration_in_months', { min: 1, max: 12 });
  const appliesTo = fields.object('applies_to');
  const products = appliesTo?.strings('products');
  const redeemBy = fields.int('redeem_by', { min: 0 });
  const coupon: Coupon = {
    id: id ?? randomId('', 8).toUpperCase(),
    object: 'coupon',
    amount_off: amountOff ?? null,
    created: seconds(now),
    currency: currency?.toLowerCase() ?? null,
    duration,
    duration_in_months: months ?? null,
    livemode: false,
    max_redemptions: fields.int('max_redemptions', { min: 1 }) ?? null,
    metadata: fields.metadata() ?? {},
    name: fields.string('name', { max: 40 }) ?? null,
    percent_off: percentOff ?? null,
    redeem_by: redeemBy ?? null,
    times_redeemed: 0,
    valid: true,
  };

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

  if ((duration === 'repeating') !== (months !== undefined)) {
    throw invalidRequest(
      'duration_in_months is required for, and only valid with, a repeating duration.',
      'duration_in_months',
    );
  }

  if (redeemBy !== undefined && redeemBy <= seconds(now)) {
    throw invalidRequest('redeem_by must be in the future.', 'redeem_by');
  }

  if (products !== undefined) {
    for (const [index, product] of products.entries()) {
      await load<Product>(
        tx,
        'product',
        product,
        `applies_to[products][${index}]`,
      );
    }

    coupon.applies_to = { products };
  }

  if (await find(tx, 'coupon', coupon.id)) {
    throw new StripeError(
      400,
      'invalid_request_error',
      'Coupon already exists.',
      { code: 'resource_already_exists', param: 'id' },
    );
  }

  await save(tx, coupon);

  return coupon;
}

export async function deleteCoupon(tx: Transaction, id: string) {
  await load<Coupon>(tx, 'coupon', id);
  await tx.delete('coupons', id);

  return { id, object: 'coupon' as const, deleted: true as const };
}

export async function getCoupon(tx: Transaction, id: string, now: number) {
  const coupon = await load<Coupon>(tx, 'coupon', id);

  return { ...coupon, valid: couponValid(coupon, now) };
}

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));

  return Array.from(bytes, (byte) => codeAlphabet[byte % 32]).join('');
}

async function activeCodeExists(
  tx: Transaction,
  code: string,
  now: number,
  except?: string,
) {
  for (const other of await all<StoredPromotionCode>(tx, 'promotion_code')) {
    if (
      other.id !== except && other.code.toLowerCase() === code.toLowerCase() &&
      promotionActive(
        other,
        await find<Coupon>(tx, 'coupon', other.promotion.coupon as string),
        now,
      )
    ) {
      return true;
    }
  }

  return false;
}

export async function createPromotionCode(
  tx: Transaction,
  fields: Fields,
  now: number,
): Promise<PromotionCode> {
  const promotion = fields.object('promotion');

  if (promotion === undefined) {
    throw invalidRequest(
      'Missing required param: promotion.',
      'promotion',
      'parameter_missing',
    );
  }

  if (promotion.oneOf('type', ['coupon']) === undefined) {
    throw invalidRequest(
      'Missing required param: promotion[type].',
      'promotion[type]',
      'parameter_missing',
    );
  }

  const couponRef = promotion.required('coupon');
  const code = fields.string('code', { max: 500 });
  const expiresAt = fields.int('expires_at', { min: 0 });
  const customer = fields.string('customer');
  const restrictions = fields.object('restrictions');
  const minimum = restrictions?.int('minimum_amount', { min: 1 });
  const minimumCurrency = restrictions?.string('minimum_amount_currency');
  const stored: StoredPromotionCode = {
    id: randomId('promo_'),
    object: 'promotion_code',
    active: true,
    enabled: fields.bool('active') ?? true,
    code: code ?? generateCode(),
    created: seconds(now),
    customer: customer ?? null,
    expires_at: expiresAt ?? null,
    livemode: false,
    max_redemptions: fields.int('max_redemptions', { min: 1 }) ?? null,
    metadata: fields.metadata() ?? {},
    promotion: { type: 'coupon', coupon: couponRef },
    restrictions: {
      first_time_transaction: restrictions?.bool('first_time_transaction') ??
        false,
      minimum_amount: minimum ?? null,
      minimum_amount_currency: minimumCurrency?.toLowerCase() ?? null,
    },
    times_redeemed: 0,
  };

  promotion.done();
  restrictions?.done();
  fields.done();

  if (code !== undefined && !codeFormat.test(code)) {
    throw invalidRequest(
      'Promotion codes may contain only letters, digits, - and _.',
      'code',
    );
  }

  const coupon = await load<Coupon>(
    tx,
    'coupon',
    couponRef,
    'promotion[coupon]',
  );

  if (!couponValid(coupon, now)) {
    throw invalidRequest(
      'This coupon is no longer valid.',
      'promotion[coupon]',
    );
  }

  if (expiresAt !== undefined && expiresAt <= seconds(now)) {
    throw invalidRequest('expires_at must be in the future.', 'expires_at');
  }

  if (
    expiresAt !== undefined && coupon.redeem_by !== null &&
    expiresAt > coupon.redeem_by
  ) {
    throw invalidRequest(
      "The promotion code's expires_at must not be after the coupon's redeem_by.",
      'expires_at',
    );
  }

  if ((minimum === undefined) !== (minimumCurrency === undefined)) {
    throw invalidRequest(
      'minimum_amount and minimum_amount_currency must be passed together.',
      'restrictions',
    );
  }

  if (customer !== undefined) {
    await load(tx, 'customer', customer, 'customer');
  }

  if (
    stored.enabled && await activeCodeExists(tx, stored.code, now)
  ) {
    throw invalidRequest(
      'An active promotion code with this code already exists.',
      'code',
    );
  }

  await save(tx, stored);

  return await present(tx, stored, now);
}

export async function updatePromotionCode(
  tx: Transaction,
  id: string,
  fields: Fields,
  now: number,
): Promise<PromotionCode> {
  const stored = await load<StoredPromotionCode>(tx, 'promotion_code', id);
  const active = fields.bool('active');
  const next = {
    ...stored,
    metadata: mergeMetadata(stored.metadata, fields.metadata()),
  };

  fields.done();

  if (active !== undefined) {
    if (
      active && !stored.enabled &&
      await activeCodeExists(tx, stored.code, now, stored.id)
    ) {
      throw invalidRequest(
        'An active promotion code with this code already exists.',
        'active',
      );
    }

    next.enabled = active;
  }

  await save(tx, next);

  return await present(tx, next, now);
}

export async function getPromotionCode(
  tx: Transaction,
  id: string,
  now: number,
): Promise<PromotionCode> {
  return await present(
    tx,
    await load<StoredPromotionCode>(tx, 'promotion_code', id),
    now,
  );
}

export async function listPromotionCodes(
  tx: Transaction,
  fields: Fields,
  now: number,
) {
  const active = fields.bool('active');
  const code = fields.string('code');
  const coupon = fields.string('coupon');
  const customer = fields.string('customer');
  const codes: PromotionCode[] = [];

  for (const stored of await all<StoredPromotionCode>(tx, 'promotion_code')) {
    const visible = await present(tx, stored, now);

    if (
      (active === undefined || visible.active === active) &&
      (code === undefined ||
        visible.code.toLowerCase() === code.toLowerCase()) &&
      (coupon === undefined || visible.promotion.coupon === coupon) &&
      (customer === undefined || visible.customer === customer)
    ) {
      codes.push(visible);
    }
  }

  const list = paginate(codes, fields, '/v1/promotion_codes');

  fields.done();

  return list;
}

/** Resolve a code a buyer typed into a redeemable promotion code and coupon. */
export async function redeemable(
  tx: Transaction,
  reference: { id?: string; code?: string },
  now: number,
  param: string,
): Promise<{ promotion: StoredPromotionCode; coupon: Coupon }> {
  let promotion: StoredPromotionCode | undefined;

  if (reference.id !== undefined) {
    promotion = await load<StoredPromotionCode>(
      tx,
      'promotion_code',
      reference.id,
      param,
    );
  } else {
    for (
      const candidate of await all<StoredPromotionCode>(tx, 'promotion_code')
    ) {
      if (
        candidate.code.toLowerCase() === reference.code?.toLowerCase() &&
        promotionActive(
          candidate,
          await find<Coupon>(
            tx,
            'coupon',
            candidate.promotion.coupon as string,
          ),
          now,
        )
      ) {
        promotion = candidate;
      }
    }
  }

  const coupon = promotion &&
    await find<Coupon>(tx, 'coupon', promotion.promotion.coupon as string);

  if (!promotion || !promotionActive(promotion, coupon, now) || !coupon) {
    throw invalidRequest('This promotion code is not active.', param);
  }

  return { promotion, coupon };
}

/** Count a redemption on both the code and its coupon. */
export async function redeem(
  tx: Transaction,
  promotion: StoredPromotionCode,
  coupon: Coupon,
) {
  await save(tx, {
    ...promotion,
    times_redeemed: promotion.times_redeemed + 1,
  });
  await save(tx, { ...coupon, times_redeemed: coupon.times_redeemed + 1 });
}
