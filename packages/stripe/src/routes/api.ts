import type { Context, Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { authorized } from '../auth/keys.ts';
import { invalidRequest, StripeError } from '../errors.ts';
import { Fields } from '../http/fields.ts';
import { type Params, parseParams } from '../http/form.ts';
import {
  expand,
  idempotent,
  load,
  type Transaction,
  version,
} from '../model/core.ts';
import {
  createPrice,
  createProduct,
  listPrices,
  listProducts,
  updatePrice,
  updateProduct,
} from '../model/catalog.ts';
import {
  createCoupon,
  createPromotionCode,
  deleteCoupon,
  getCoupon,
  getPromotionCode,
  listPromotionCodes,
  updatePromotionCode,
} from '../model/discounts.ts';
import {
  fingerprint,
  insertCustomer,
  readCustomerFields,
} from '../model/customers.ts';
import {
  createSession,
  expireSession,
  getSession,
  listLineItems,
  listSessions,
} from '../model/checkout.ts';
import { createRefund, type RefundReason } from '../model/payments.ts';

function failure(error: StripeError) {
  return Response.json(error.toJSON(), {
    status: error.status,
    headers: { 'stripe-version': version },
  });
}

interface Request {
  tx: Transaction;
  fields: Fields;
  id: string;
  now: number;
}

type Handler = (request: Request) => Promise<unknown>;

async function readParams(c: Context): Promise<Params> {
  const query = new URL(c.req.url).search.slice(1);

  if (c.req.method === 'GET' || c.req.method === 'DELETE') {
    return parseParams(query);
  }

  if (query) {
    throw invalidRequest('POST parameters belong in the request body.');
  }

  const type = c.req.header('content-type')?.split(';')[0]?.trim();
  const body = await c.req.text();

  if (body && type !== 'application/x-www-form-urlencoded') {
    throw invalidRequest('Expected form-urlencoded input.');
  }

  return parseParams(body);
}

export function routes(
  ctx: PluginContext,
  api: Hono,
  hostedUrl: (id: string) => string,
) {
  api.use('*', async (c, next) => {
    c.header('stripe-version', version);

    try {
      if (
        !await authorized(
          ctx.store.scope(),
          c.req.header('authorization') ?? null,
        )
      ) {
        throw new StripeError(
          401,
          'authentication_error',
          'Invalid API Key provided.',
        );
      }

      if ((c.req.header('stripe-version') ?? version) !== version) {
        throw invalidRequest(
          `Unsupported API version. This emulator serves ${version}.`,
        );
      }

      await next();
    } catch (error) {
      if (error instanceof StripeError) {
        return failure(error);
      }

      return failure(new StripeError(500, 'api_error', 'Request failed.'));
    }
  });

  /**
   * One route: parse parameters, run the handler in a transaction (keyed by
   * `Idempotency-Key` for POST), and expand the result in that transaction.
   */
  const route = (
    method: 'get' | 'post' | 'delete',
    path: string,
    handler: Handler,
  ) => {
    api[method](path, async (c) => {
      try {
        const params = await readParams(c);
        const fields = new Fields(params);
        const paths = fields.expand();
        const now = ctx.clock.now();
        const store = ctx.store.scope();
        const work = async (tx: Transaction) =>
          await expand(
            tx,
            await handler({ tx, fields, id: c.req.param('id') ?? '', now }),
            paths,
          );
        const result = method === 'post'
          ? await idempotent(
            store,
            c.req.header('idempotency-key'),
            fingerprint('POST', new URL(c.req.url).pathname, params),
            now,
            work,
          )
          : await store.transaction(work);

        return c.json(result);
      } catch (error) {
        if (error instanceof StripeError) {
          return failure(error);
        }

        throw error;
      }
    });
  };

  const only = (fields: Fields) => {
    fields.done();
  };

  route(
    'post',
    '/v1/customers',
    ({ tx, fields, now }) =>
      insertCustomer(tx, readCustomerFields(fields), now),
  );
  route('get', '/v1/customers/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'customer', id);
  });

  route(
    'post',
    '/v1/products',
    ({ tx, fields, now }) => createProduct(tx, fields, now),
  );
  route('get', '/v1/products', ({ tx, fields }) => listProducts(tx, fields));
  route('get', '/v1/products/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'product', id);
  });

  route(
    'post',
    '/v1/products/:id',
    ({ tx, fields, id, now }) => updateProduct(tx, id, fields, now),
  );

  route(
    'post',
    '/v1/prices',
    ({ tx, fields, now }) => createPrice(tx, fields, now),
  );
  route('get', '/v1/prices', ({ tx, fields }) => listPrices(tx, fields));
  route('get', '/v1/prices/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'price', id);
  });

  route(
    'post',
    '/v1/prices/:id',
    ({ tx, fields, id }) => updatePrice(tx, id, fields),
  );

  route(
    'post',
    '/v1/coupons',
    ({ tx, fields, now }) => createCoupon(tx, fields, now),
  );
  route('get', '/v1/coupons/:id', ({ tx, fields, id, now }) => {
    only(fields);

    return getCoupon(tx, id, now);
  });

  route('delete', '/v1/coupons/:id', ({ tx, fields, id }) => {
    only(fields);

    return deleteCoupon(tx, id);
  });

  route(
    'post',
    '/v1/promotion_codes',
    ({ tx, fields, now }) => createPromotionCode(tx, fields, now),
  );
  route(
    'get',
    '/v1/promotion_codes',
    ({ tx, fields, now }) => listPromotionCodes(tx, fields, now),
  );
  route('get', '/v1/promotion_codes/:id', ({ tx, fields, id, now }) => {
    only(fields);

    return getPromotionCode(tx, id, now);
  });

  route(
    'post',
    '/v1/promotion_codes/:id',
    ({ tx, fields, id, now }) => updatePromotionCode(tx, id, fields, now),
  );

  route(
    'post',
    '/v1/checkout/sessions',
    ({ tx, fields, now }) => createSession(tx, fields, now, hostedUrl),
  );
  route(
    'get',
    '/v1/checkout/sessions',
    ({ tx, fields, now }) => listSessions(tx, fields, now),
  );
  route('get', '/v1/checkout/sessions/:id', ({ tx, fields, id, now }) => {
    only(fields);

    return getSession(tx, id, now);
  });

  route(
    'get',
    '/v1/checkout/sessions/:id/line_items',
    ({ tx, fields, id }) => listLineItems(tx, id, fields),
  );
  route(
    'post',
    '/v1/checkout/sessions/:id/expire',
    ({ tx, fields, id, now }) => {
      only(fields);

      return expireSession(tx, id, now);
    },
  );

  route('get', '/v1/payment_intents/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'payment_intent', id, 'intent');
  });

  route('get', '/v1/charges/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'charge', id, 'charge');
  });

  route('post', '/v1/refunds', ({ tx, fields, now }) => {
    const input = {
      charge: fields.string('charge'),
      paymentIntent: fields.string('payment_intent'),
      amount: fields.int('amount', { min: 1 }),
      reason: fields.oneOf<RefundReason>('reason', [
        'duplicate',
        'fraudulent',
        'requested_by_customer',
      ]),
      metadata: fields.metadata(),
    };

    fields.done();

    return createRefund(tx, input, now);
  });

  route('get', '/v1/refunds/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'refund', id, 'refund');
  });

  route('get', '/v1/disputes/:id', ({ tx, fields, id }) => {
    only(fields);

    return load(tx, 'dispute', id, 'dispute');
  });

  api.notFound(() =>
    failure(
      new StripeError(
        404,
        'invalid_request_error',
        'Unrecognized request URL. The local Stripe emulator does not implement this operation.',
      ),
    )
  );
  api.onError(() =>
    failure(new StripeError(500, 'api_error', 'Request failed.'))
  );
}
