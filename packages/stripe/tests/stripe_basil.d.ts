import type Stripe from 'stripe';

/**
 * stripe@18.0.0. Its own declarations augment the global `stripe` module and
 * would replace stripe@22.1.1's in the same program, so the basil suite sees
 * the surface both clients share through these, and types the shapes where
 * basil differs itself.
 */
declare const StripeBasil: typeof Stripe;

export default StripeBasil;
