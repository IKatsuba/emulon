import { StripeError } from '../../errors.ts';
import { couponParam } from '../../model/discounts.ts';
import type { StripeVersionModule } from '../types.ts';
import { parseEvent, projectEvent } from './events.ts';
import { parse } from './parse.ts';
import { project } from './project.ts';

const id = '2026-04-22.dahlia';

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
