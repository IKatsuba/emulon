import Stripe from 'stripe';
// @ts-types="./stripe_basil.d.ts"
import StripeBasil from 'stripe-basil';
import type { ApiVersion, Options } from '@emulon/stripe';

export const dahliaVersion = '2026-04-22.dahlia';
export const basilVersion = '2025-03-31.basil';

type PromotionCodeParams = Omit<Stripe.PromotionCodeCreateParams, 'promotion'>;

/**
 * One official client and the API version it pins. A suite written once runs
 * through each flavor; the flavor owns what the versions spell differently.
 */
export interface Flavor {
  version: ApiVersion;
  /** Case IDs are distinct per version: `stripe.catalog.1`, `stripe.basil.…`. */
  prefix: string;
  /** The client package; both share the surface the suites use. */
  Stripe: typeof Stripe;
  /** Plugin options that serve this version as the account default. */
  options: Options;
  /** Whether `managed_payments` exists in this version. */
  managedPayments: boolean;
  /**
   * Checkout's `ui_mode`: the emulated hosted value, the version's other
   * values, which fail explicitly, and a value only another version knows.
   */
  uiModes: { hosted: string; unsupported: string[]; foreign: string };
  /**
   * Whether objects name `customer_account` and a buyer's `business_name` and
   * `individual_name`.
   */
  accountFields: boolean;
  /** The parameter shared rules name for a promotion code's coupon. */
  couponParam: string;
  createPromotionCode(
    sdk: Stripe,
    coupon: string,
    params?: PromotionCodeParams,
  ): Promise<Stripe.PromotionCode>;
  /** The coupon of a promotion code: an ID, or an object once expanded. */
  couponOf(code: Stripe.PromotionCode): string | Stripe.Coupon;
  /** `expand[]` that shows a promotion code's coupon as an object. */
  expandCoupon: string[];
}

/** A promotion code as basil shows it: the whole coupon at the top level. */
export type BasilPromotionCode =
  & Omit<Stripe.PromotionCode, 'promotion'>
  & { coupon: Stripe.Coupon };

export const dahliaFlavor: Flavor = {
  version: dahliaVersion,
  prefix: 'stripe',
  Stripe,
  // The baseline: without options only dahlia is served.
  options: {},
  managedPayments: true,
  uiModes: {
    hosted: 'hosted_page',
    unsupported: ['embedded_page', 'elements', 'form'],
    foreign: 'hosted',
  },
  accountFields: true,
  couponParam: 'promotion[coupon]',
  createPromotionCode: (sdk, coupon, params = {}) =>
    sdk.promotionCodes.create({
      ...params,
      promotion: { type: 'coupon', coupon },
    }),
  couponOf: (code) => code.promotion.coupon!,
  expandCoupon: ['promotion.coupon'],
};

export const basilFlavor: Flavor = {
  version: basilVersion,
  prefix: 'stripe.basil',
  Stripe: StripeBasil,
  options: {
    apiVersions: [dahliaVersion, basilVersion],
    defaultApiVersion: basilVersion,
  },
  managedPayments: false,
  uiModes: {
    hosted: 'hosted',
    unsupported: ['embedded', 'custom'],
    foreign: 'hosted_page',
  },
  accountFields: false,
  couponParam: 'coupon',
  createPromotionCode: (sdk, coupon, params = {}) =>
    sdk.promotionCodes.create(
      { ...params, coupon } as unknown as Stripe.PromotionCodeCreateParams,
    ),
  couponOf: (code) => (code as unknown as BasilPromotionCode).coupon,
  // Basil always embeds the coupon.
  expandCoupon: [],
};

/** An official client of one flavor against a loopback emulator. */
export function client(flavor: Flavor, api: string, apiKey: string): Stripe {
  const url = new URL(api);

  return new flavor.Stripe(apiKey, {
    host: url.hostname,
    port: Number(url.port),
    protocol: 'http',
    apiVersion: flavor.version as typeof dahliaVersion,
    httpClient: flavor.Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    telemetry: false,
  });
}
