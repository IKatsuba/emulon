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

/** Dahlia nests the discount: `promotion: { type: 'coupon', coupon }`. */
const { project } = projector(
  (r) => ({
    ...promotionCodeFields(r),
    promotion: { type: 'coupon', coupon: r.coupon },
  }),
  (_owner, property) =>
    Object.hasOwn(references, property) ? references[property] : undefined,
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
    readSession(fields, { managedPayments: true }),
});

/** Stripe API version 2026-04-22.dahlia, verified with stripe@22.1.1. */
export const dahlia: StripeVersionModule = {
  id,
  parse,
  project,
  projectEvent: (type, fact) => projectEvent(id, type, fact),
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
