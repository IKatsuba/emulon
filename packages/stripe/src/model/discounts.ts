// Stripe's domain terms are snake_case; records keep them as field names.
// deno-lint-ignore-file camelcase
import { invalidRequest, StripeError } from '../errors.ts';
import { mergeMetadata } from '../http/fields.ts';
import {
  all,
  find,
  load,
  type Metadata,
  type Page,
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
  max_redemptions: number | null;
  metadata: Metadata;
  name: string | null;
  percent_off: number | null;
  redeem_by: number | null;
  times_redeemed: number;
}

/** A coupon as read: whether it can still be redeemed depends on the clock. */
export type CouponView = Coupon & { valid: boolean };

/**
 * A promotion code for one coupon. `enabled` is the merchant's switch;
 * whether the code is active is derived on read.
 */
export interface PromotionCode {
  id: string;
  object: 'promotion_code';
  code: string;
  coupon: string;
  created: number;
  customer: string | null;
  enabled: boolean;
  expires_at: number | null;
  max_redemptions: number | null;
  metadata: Metadata;
  restrictions: {
    first_time_transaction: boolean;
    minimum_amount: number | null;
    minimum_amount_currency: string | null;
  };
  times_redeemed: number;
}

/**
 * A promotion code as read, with the current view of its coupon for versions
 * that embed it; `null` once the coupon is deleted.
 */
export type PromotionCodeView = PromotionCode & {
  active: boolean;
  coupon_view: CouponView | null;
};

export interface CouponInput {
  id?: string | undefined;
  percentOff?: number | undefined;
  amountOff?: number | undefined;
  currency?: string | undefined;
  duration: Coupon['duration'];
  durationInMonths?: number | undefined;
  products?: string[] | undefined;
  redeemBy?: number | undefined;
  maxRedemptions?: number | undefined;
  metadata?: Metadata | undefined;
  name?: string | undefined;
}

export interface PromotionCodeInput {
  coupon: string;
  code?: string | undefined;
  active?: boolean | undefined;
  customer?: string | undefined;
  expiresAt?: number | undefined;
  maxRedemptions?: number | undefined;
  metadata?: Metadata | undefined;
  firstTimeTransaction?: boolean | undefined;
  minimumAmount?: number | undefined;
  minimumAmountCurrency?: string | undefined;
}

export interface PromotionCodeUpdate {
  active?: boolean | undefined;
  metadata?: Metadata | undefined;
}

export interface PromotionCodeFilter {
  active?: boolean | undefined;
  code?: string | undefined;
  coupon?: string | undefined;
  customer?: string | undefined;
  page: Page;
}

/** The parameter that names a promotion code's coupon, before projection. */
export const couponParam = 'coupon';

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function couponValid(
  coupon: Pick<Coupon, 'redeem_by' | 'max_redemptions' | 'times_redeemed'>,
  now: number,
): boolean {
  return (coupon.redeem_by === null || coupon.redeem_by > seconds(now)) &&
    (coupon.max_redemptions === null ||
      coupon.times_redeemed < coupon.max_redemptions);
}

/**
 * Whether a promotion code can be redeemed right now: switched on, unexpired,
 * with redemptions left and an existing, valid coupon behind it.
 */
export function promotionActive(
  code: Pick<
    PromotionCode,
    'enabled' | 'expires_at' | 'max_redemptions' | 'times_redeemed'
  >,
  coupon:
    | Pick<Coupon, 'redeem_by' | 'max_redemptions' | 'times_redeemed'>
    | undefined,
  now: number,
): boolean {
  return code.enabled &&
    (code.expires_at === null || code.expires_at > seconds(now)) &&
    (code.max_redemptions === null ||
      code.times_redeemed < code.max_redemptions) &&
    coupon !== undefined && couponValid(coupon, now);
}

export function viewCoupon(coupon: Coupon, now: number): CouponView {
  return { ...coupon, valid: couponValid(coupon, now) };
}

export async function viewPromotionCode(
  tx: Transaction,
  code: PromotionCode,
  now: number,
): Promise<PromotionCodeView> {
  const coupon = await find<Coupon>(tx, 'coupon', code.coupon);

  return {
    ...code,
    active: promotionActive(code, coupon, now),
    coupon_view: coupon ? viewCoupon(coupon, now) : null,
  };
}

export async function createCoupon(
  tx: Transaction,
  input: CouponInput,
  now: number,
): Promise<CouponView> {
  const coupon: Coupon = {
    id: input.id ?? randomId('', 8).toUpperCase(),
    object: 'coupon',
    amount_off: input.amountOff ?? null,
    created: seconds(now),
    currency: input.currency ?? null,
    duration: input.duration,
    duration_in_months: input.durationInMonths ?? null,
    max_redemptions: input.maxRedemptions ?? null,
    metadata: input.metadata ?? {},
    name: input.name ?? null,
    percent_off: input.percentOff ?? null,
    redeem_by: input.redeemBy ?? null,
    times_redeemed: 0,
  };

  if (input.redeemBy !== undefined && input.redeemBy <= seconds(now)) {
    throw invalidRequest('redeem_by must be in the future.', 'redeem_by');
  }

  if (input.products !== undefined) {
    for (const [index, product] of input.products.entries()) {
      await load<Product>(
        tx,
        'product',
        product,
        `applies_to[products][${index}]`,
      );
    }

    coupon.applies_to = { products: input.products };
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

  return viewCoupon(coupon, now);
}

export async function deleteCoupon(tx: Transaction, id: string) {
  await load<Coupon>(tx, 'coupon', id);
  await tx.delete('coupons', id);

  return { id, object: 'coupon' as const, deleted: true as const };
}

export async function getCoupon(tx: Transaction, id: string, now: number) {
  return viewCoupon(await load<Coupon>(tx, 'coupon', id), now);
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
  for (const other of await all<PromotionCode>(tx, 'promotion_code')) {
    if (
      other.id !== except && other.code.toLowerCase() === code.toLowerCase() &&
      promotionActive(
        other,
        await find<Coupon>(tx, 'coupon', other.coupon),
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
  input: PromotionCodeInput,
  now: number,
): Promise<PromotionCodeView> {
  const stored: PromotionCode = {
    id: randomId('promo_'),
    object: 'promotion_code',
    code: input.code ?? generateCode(),
    coupon: input.coupon,
    created: seconds(now),
    customer: input.customer ?? null,
    enabled: input.active ?? true,
    expires_at: input.expiresAt ?? null,
    max_redemptions: input.maxRedemptions ?? null,
    metadata: input.metadata ?? {},
    restrictions: {
      first_time_transaction: input.firstTimeTransaction ?? false,
      minimum_amount: input.minimumAmount ?? null,
      minimum_amount_currency: input.minimumAmountCurrency ?? null,
    },
    times_redeemed: 0,
  };
  const coupon = await load<Coupon>(tx, 'coupon', input.coupon, couponParam);

  if (!couponValid(coupon, now)) {
    throw invalidRequest('This coupon is no longer valid.', couponParam);
  }

  if (input.expiresAt !== undefined && input.expiresAt <= seconds(now)) {
    throw invalidRequest('expires_at must be in the future.', 'expires_at');
  }

  if (
    input.expiresAt !== undefined && coupon.redeem_by !== null &&
    input.expiresAt > coupon.redeem_by
  ) {
    throw invalidRequest(
      "The promotion code's expires_at must not be after the coupon's redeem_by.",
      'expires_at',
    );
  }

  if (input.customer !== undefined) {
    await load(tx, 'customer', input.customer, 'customer');
  }

  if (stored.enabled && await activeCodeExists(tx, stored.code, now)) {
    throw invalidRequest(
      'An active promotion code with this code already exists.',
      'code',
    );
  }

  await save(tx, stored);

  return await viewPromotionCode(tx, stored, now);
}

export async function updatePromotionCode(
  tx: Transaction,
  id: string,
  input: PromotionCodeUpdate,
  now: number,
): Promise<PromotionCodeView> {
  const stored = await load<PromotionCode>(tx, 'promotion_code', id);
  const next: PromotionCode = {
    ...stored,
    metadata: mergeMetadata(stored.metadata, input.metadata),
  };

  if (input.active !== undefined) {
    if (
      input.active && !stored.enabled &&
      await activeCodeExists(tx, stored.code, now, stored.id)
    ) {
      throw invalidRequest(
        'An active promotion code with this code already exists.',
        'active',
      );
    }

    next.enabled = input.active;
  }

  await save(tx, next);

  return await viewPromotionCode(tx, next, now);
}

export async function getPromotionCode(
  tx: Transaction,
  id: string,
  now: number,
): Promise<PromotionCodeView> {
  return await viewPromotionCode(
    tx,
    await load<PromotionCode>(tx, 'promotion_code', id),
    now,
  );
}

export async function listPromotionCodes(
  tx: Transaction,
  filter: PromotionCodeFilter,
  now: number,
) {
  const codes: PromotionCodeView[] = [];

  for (const stored of await all<PromotionCode>(tx, 'promotion_code')) {
    const visible = await viewPromotionCode(tx, stored, now);

    if (
      (filter.active === undefined || visible.active === filter.active) &&
      (filter.code === undefined ||
        visible.code.toLowerCase() === filter.code.toLowerCase()) &&
      (filter.coupon === undefined || visible.coupon === filter.coupon) &&
      (filter.customer === undefined || visible.customer === filter.customer)
    ) {
      codes.push(visible);
    }
  }

  return paginate(codes, filter.page, '/v1/promotion_codes');
}

/** Resolve a code a buyer typed into a redeemable promotion code and coupon. */
export async function redeemable(
  tx: Transaction,
  reference: { id?: string; code?: string },
  now: number,
  param: string,
): Promise<{ promotion: PromotionCode; coupon: Coupon }> {
  let promotion: PromotionCode | undefined;

  if (reference.id !== undefined) {
    promotion = await load<PromotionCode>(
      tx,
      'promotion_code',
      reference.id,
      param,
    );
  } else {
    for (const candidate of await all<PromotionCode>(tx, 'promotion_code')) {
      if (
        candidate.code.toLowerCase() === reference.code?.toLowerCase() &&
        promotionActive(
          candidate,
          await find<Coupon>(tx, 'coupon', candidate.coupon),
          now,
        )
      ) {
        promotion = candidate;
      }
    }
  }

  const coupon = promotion &&
    await find<Coupon>(tx, 'coupon', promotion.coupon);

  if (!promotion || !promotionActive(promotion, coupon, now) || !coupon) {
    throw invalidRequest('This promotion code is not active.', param);
  }

  return { promotion, coupon };
}

/** Count a redemption on both the code and its coupon. */
export async function redeem(
  tx: Transaction,
  promotion: PromotionCode,
  coupon: Coupon,
) {
  await save(tx, {
    ...promotion,
    times_redeemed: promotion.times_redeemed + 1,
  });
  await save(tx, { ...coupon, times_redeemed: coupon.times_redeemed + 1 });
}
