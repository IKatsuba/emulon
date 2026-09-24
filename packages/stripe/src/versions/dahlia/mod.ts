import { invalidRequest, StripeError } from '../../errors.ts';
import { couponParam } from '../../model/discounts.ts';
import type { StripeVersionModule } from '../types.ts';
import { parseEvent, projectEvent } from '../shared/events.ts';
import { parser, readPromotionCode, readSession } from '../shared/parse.ts';
import {
  projector,
  promotionCodeFields,
  references,
} from '../shared/project.ts';

const id = '2026-04-22.dahlia';

// Dahlia renames the modes; its default, and the only one emulated, is the
// hosted page.
const uiModes = {
  values: ['hosted_page', 'embedded_page', 'elements', 'form'],
  hosted: 'hosted_page',
};

/**
 * Dahlia nests the discount: `promotion: { type: 'coupon', coupon }`. It also
 * names the Account representing a customer and a buyer's business and
 * individual names; the emulator has no Accounts and collects neither name, so
 * they are null.
 */
const { project, projectRecord } = projector(
  (r) => ({
    ...promotionCodeFields(r),
    customer_account: null,
    promotion: { type: 'coupon', coupon: r.coupon },
  }),
  (_owner, property) =>
    Object.hasOwn(references, property) ? references[property] : undefined,
  {
    customer: (wire) => ({ ...wire, customer_account: null }),
    'checkout.session': (wire) => ({
      ...wire,
      customer_account: null,
      customer_details: wire.customer_details && {
        ...wire.customer_details as Record<string, unknown>,
        business_name: null,
        individual_name: null,
      },
      ui_mode: uiModes.hosted,
    }),
    payment_intent: (wire) => ({ ...wire, customer_account: null }),
  },
);

// Dahlia's reference adds dashes to letters and digits.
const codeFormat = {
  pattern: /^[a-zA-Z0-9-]{1,500}$/,
  message: 'Promotion codes may contain only letters, digits and -.',
};

const parse = parser({
  'promotion_codes.create': (fields) => {
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

    const coupon = promotion.required('coupon');

    promotion.done();

    return readPromotionCode(fields, coupon, codeFormat);
  },
  'checkout.sessions.create': (fields) =>
    readSession(fields, { managedPayments: true, uiModes }),
});

/** Stripe API version 2026-04-22.dahlia, verified with stripe@22.1.1. */
export const dahlia: StripeVersionModule = {
  id,
  parse,
  project,
  projectEvent: (type, fact) => projectEvent(id, projectRecord, type, fact),
  parseEvent: (type, input) => parseEvent(id, type, input),
  error(operation, error) {
    // Dahlia names a promotion code's coupon inside `promotion`.
    if (
      operation === 'promotion_codes.create' && error.param === couponParam
    ) {
      return new StripeError(error.status, error.type, error.message, {
        ...(error.stripeCode ? { code: error.stripeCode } : {}),
        param: 'promotion[coupon]',
      });
    }

    return error;
  },
};
