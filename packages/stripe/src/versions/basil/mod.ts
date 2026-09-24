import type { StripeVersionModule } from '../types.ts';
import { parseEvent, projectEvent } from '../shared/events.ts';
import { parser, readPromotionCode, readSession } from '../shared/parse.ts';
import {
  coupon,
  projector,
  promotionCodeFields,
  references,
} from '../shared/project.ts';

const id = '2025-03-31.basil';

/**
 * Basil embeds the whole coupon at the top level of a promotion code. It is
 * always an object there, so it does not expand; elsewhere a coupon is still a
 * reference.
 */
const { project } = projector(
  (r) => ({
    ...promotionCodeFields(r),
    coupon: r.coupon_view === null
      ? { id: r.coupon, object: 'coupon', deleted: true }
      : coupon(r.coupon_view),
  }),
  (owner, property) =>
    owner === 'promotion_code' && property === 'coupon'
      ? undefined
      : Object.hasOwn(references, property)
      ? references[property]
      : undefined,
);

// Basil's reference allows only letters and digits in a code.
const codeFormat = {
  pattern: /^[a-zA-Z0-9]{1,500}$/,
  message: 'Promotion codes may contain only letters and digits.',
};

const parse = parser({
  'promotion_codes.create': (fields) =>
    readPromotionCode(fields, fields.required('coupon'), codeFormat),
  // Basil predates Stripe-managed payments.
  'checkout.sessions.create': (fields) =>
    readSession(fields, { managedPayments: false }),
});

/** Stripe API version 2025-03-31.basil, verified with stripe@18.0.0. */
export const basil: StripeVersionModule = {
  id,
  parse,
  project,
  projectEvent: (type, fact) => projectEvent(id, type, fact),
  parseEvent: (type, input) => parseEvent(id, type, input),
  // Shared rules name parameters as basil does.
  error: (_operation, error) => error,
};
