import { StripeError } from './errors.ts';
import {
  find,
  fingerprint,
  idempotent,
  load,
  type Resolver,
  type Store,
  type Transaction,
} from './model/core.ts';
import { type CustomerInput, insertCustomer } from './model/customers.ts';
import {
  createPrice,
  createProduct,
  listPrices,
  listProducts,
  type PriceFilter,
  type PriceInput,
  type PriceUpdate,
  type ProductFilter,
  type ProductInput,
  type ProductUpdate,
  updatePrice,
  updateProduct,
} from './model/catalog.ts';
import {
  type Coupon,
  type CouponInput,
  createCoupon,
  createPromotionCode,
  deleteCoupon,
  getCoupon,
  getPromotionCode,
  listPromotionCodes,
  type PromotionCode,
  type PromotionCodeFilter,
  type PromotionCodeInput,
  type PromotionCodeUpdate,
  updatePromotionCode,
  viewCoupon,
  viewPromotionCode,
} from './model/discounts.ts';
import {
  createSession,
  expireSession,
  getSession,
  listLineItems,
  listSessions,
  type SessionFilter,
  type SessionInput,
} from './model/checkout.ts';
import { createRefund, type RefundInput } from './model/payments.ts';
import type { Parsed, StripeVersionModule } from './versions/types.ts';

type Empty = Record<string, never>;

/** Canonical input of every Stripe API operation, whatever its version. */
export interface Inputs {
  'customers.create': CustomerInput;
  'customers.get': Empty;
  'products.create': ProductInput;
  'products.get': Empty;
  'products.update': ProductUpdate;
  'products.list': ProductFilter;
  'prices.create': PriceInput;
  'prices.get': Empty;
  'prices.update': PriceUpdate;
  'prices.list': PriceFilter;
  'coupons.create': CouponInput;
  'coupons.get': Empty;
  'coupons.delete': Empty;
  'promotion_codes.create': PromotionCodeInput;
  'promotion_codes.get': Empty;
  'promotion_codes.update': PromotionCodeUpdate;
  'promotion_codes.list': PromotionCodeFilter;
  'checkout.sessions.create': SessionInput;
  'checkout.sessions.get': Empty;
  'checkout.sessions.list': SessionFilter;
  'checkout.sessions.line_items': { limit: number };
  'checkout.sessions.expire': Empty;
  'payment_intents.get': Empty;
  'charges.get': Empty;
  'refunds.create': RefundInput;
  'refunds.get': Empty;
  'disputes.get': Empty;
}

export type OperationId = keyof Inputs;

interface Call {
  tx: Transaction;
  /** The resource ID from the request path, when it has one. */
  id: string;
  now: number;
  /** The version that selected this call, recorded on the events it causes. */
  version: string;
  hostedUrl: (id: string) => string;
}

export const endpoints: {
  [Op in OperationId]: { method: 'get' | 'post' | 'delete'; path: string };
} = {
  'customers.create': { method: 'post', path: '/v1/customers' },
  'customers.get': { method: 'get', path: '/v1/customers/:id' },
  'products.create': { method: 'post', path: '/v1/products' },
  'products.get': { method: 'get', path: '/v1/products/:id' },
  'products.update': { method: 'post', path: '/v1/products/:id' },
  'products.list': { method: 'get', path: '/v1/products' },
  'prices.create': { method: 'post', path: '/v1/prices' },
  'prices.get': { method: 'get', path: '/v1/prices/:id' },
  'prices.update': { method: 'post', path: '/v1/prices/:id' },
  'prices.list': { method: 'get', path: '/v1/prices' },
  'coupons.create': { method: 'post', path: '/v1/coupons' },
  'coupons.get': { method: 'get', path: '/v1/coupons/:id' },
  'coupons.delete': { method: 'delete', path: '/v1/coupons/:id' },
  'promotion_codes.create': { method: 'post', path: '/v1/promotion_codes' },
  'promotion_codes.get': { method: 'get', path: '/v1/promotion_codes/:id' },
  'promotion_codes.update': {
    method: 'post',
    path: '/v1/promotion_codes/:id',
  },
  'promotion_codes.list': { method: 'get', path: '/v1/promotion_codes' },
  'checkout.sessions.create': { method: 'post', path: '/v1/checkout/sessions' },
  'checkout.sessions.get': {
    method: 'get',
    path: '/v1/checkout/sessions/:id',
  },
  'checkout.sessions.list': { method: 'get', path: '/v1/checkout/sessions' },
  'checkout.sessions.line_items': {
    method: 'get',
    path: '/v1/checkout/sessions/:id/line_items',
  },
  'checkout.sessions.expire': {
    method: 'post',
    path: '/v1/checkout/sessions/:id/expire',
  },
  'payment_intents.get': { method: 'get', path: '/v1/payment_intents/:id' },
  'charges.get': { method: 'get', path: '/v1/charges/:id' },
  'refunds.create': { method: 'post', path: '/v1/refunds' },
  'refunds.get': { method: 'get', path: '/v1/refunds/:id' },
  'disputes.get': { method: 'get', path: '/v1/disputes/:id' },
};

const executors: {
  [Op in OperationId]: (call: Call, input: Inputs[Op]) => Promise<unknown>;
} = {
  'customers.create': ({ tx, now, version }, input) =>
    insertCustomer(tx, input, now, version),
  'customers.get': ({ tx, id }) => load(tx, 'customer', id),
  'products.create': ({ tx, now }, input) => createProduct(tx, input, now),
  'products.get': ({ tx, id }) => load(tx, 'product', id),
  'products.update': ({ tx, id, now }, input) =>
    updateProduct(tx, id, input, now),
  'products.list': ({ tx }, filter) => listProducts(tx, filter),
  'prices.create': ({ tx, now }, input) => createPrice(tx, input, now),
  'prices.get': ({ tx, id }) => load(tx, 'price', id),
  'prices.update': ({ tx, id }, input) => updatePrice(tx, id, input),
  'prices.list': ({ tx }, filter) => listPrices(tx, filter),
  'coupons.create': ({ tx, now }, input) => createCoupon(tx, input, now),
  'coupons.get': ({ tx, id, now }) => getCoupon(tx, id, now),
  'coupons.delete': ({ tx, id }) => deleteCoupon(tx, id),
  'promotion_codes.create': ({ tx, now }, input) =>
    createPromotionCode(tx, input, now),
  'promotion_codes.get': ({ tx, id, now }) => getPromotionCode(tx, id, now),
  'promotion_codes.update': ({ tx, id, now }, input) =>
    updatePromotionCode(tx, id, input, now),
  'promotion_codes.list': ({ tx, now }, filter) =>
    listPromotionCodes(tx, filter, now),
  'checkout.sessions.create': ({ tx, now, hostedUrl }, input) =>
    createSession(tx, input, now, hostedUrl),
  'checkout.sessions.get': ({ tx, id, now, version }) =>
    getSession(tx, id, now, version),
  'checkout.sessions.list': ({ tx, now, version }, filter) =>
    listSessions(tx, filter, now, version),
  'checkout.sessions.line_items': ({ tx, id }, { limit }) =>
    listLineItems(tx, id, limit),
  'checkout.sessions.expire': ({ tx, id, now, version }) =>
    expireSession(tx, id, now, version),
  'payment_intents.get': ({ tx, id }) =>
    load(tx, 'payment_intent', id, 'intent'),
  'charges.get': ({ tx, id }) => load(tx, 'charge', id, 'charge'),
  'refunds.create': ({ tx, now, version }, input) =>
    createRefund(tx, input, now, version),
  'refunds.get': ({ tx, id }) => load(tx, 'refund', id, 'refund'),
  'disputes.get': ({ tx, id }) => load(tx, 'dispute', id, 'dispute'),
};

/** Current views of resources a projection expands, with derived state. */
export function resolver(tx: Transaction, now: number): Resolver {
  return async (kind, id) => {
    const record = await find(tx, kind, id);

    if (record?.object === 'coupon') {
      return viewCoupon(record as Coupon, now);
    }

    if (record?.object === 'promotion_code') {
      return await viewPromotionCode(tx, record as PromotionCode, now);
    }

    return record;
  };
}

export interface Request<Op extends OperationId> {
  operation: Op;
  /** The request path; it identifies an idempotent request with its input. */
  path: string;
  id?: string | undefined;
  parsed: Parsed<Inputs[Op]>;
  idempotencyKey?: string | undefined;
  /**
   * The version events record as their view: the request's own for the API,
   * the account default for control actions.
   */
  eventVersion?: string | undefined;
}

/**
 * Run one operation in the version that selected it: execute the shared rule
 * on canonical input, then let the module project the result. POST requests
 * are idempotent over method, path, version and canonical input.
 */
export async function perform<Op extends OperationId>(
  store: Store,
  module: StripeVersionModule,
  request: Request<Op>,
  now: number,
  hostedUrl: (id: string) => string = () => {
    throw new Error('Checkout Sessions are created only over HTTP.');
  },
): Promise<unknown> {
  const { operation, parsed } = request;
  const work = (tx: Transaction) =>
    executors[operation]({
      tx,
      id: request.id ?? '',
      now,
      version: request.eventVersion ?? module.id,
      hostedUrl,
    }, parsed.input);
  const present = (result: unknown, resolve: Resolver) =>
    module.project(result, parsed.expand, resolve);

  try {
    if (endpoints[operation].method === 'post') {
      return await idempotent(
        store,
        request.idempotencyKey,
        fingerprint('POST', request.path, {
          version: module.id,
          input: parsed.input,
          expand: parsed.expand,
        }),
        now,
        work,
        present,
        (tx) => resolver(tx, now),
      );
    }

    return await store.transaction(async (tx) =>
      await present(await work(tx), resolver(tx, now))
    );
  } catch (error) {
    if (error instanceof StripeError) {
      throw module.error(operation, error);
    }

    throw error;
  }
}
