import type { Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { authorized } from '../auth/keys.ts';
import {
  createCustomer,
  createInput,
  getCustomer,
  StripeError,
  version,
} from '../model/customers.ts';

function failure(error: StripeError) {
  return Response.json({
    error: {
      type: error.type,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    },
  }, { status: error.status, headers: { 'stripe-version': version } });
}

export function parseForm(body: string) {
  const values: Record<string, string> = {};

  for (const [key, value] of new URLSearchParams(body)) {
    if (
      !['name', 'email', 'description'].includes(key) ||
      Object.hasOwn(values, key)
    ) {
      throw new StripeError(
        400,
        'invalid_request_error',
        'Unsupported or duplicate customer field.',
      );
    }

    values[key] = value;
  }

  return values;
}

export function routes(ctx: PluginContext, api: Hono) {
  api.use('*', async (c, next) => {
    c.header('stripe-version', version);

    try {
      if (
        !await authorized(
          ctx.store.scope(),
          c.req.header('authorization') ?? null,
        )
      ) {
        throw new StripeError(401, 'authentication_error', 'Invalid API key.');
      }

      if ((c.req.header('stripe-version') ?? version) !== version) {
        throw new StripeError(
          400,
          'invalid_request_error',
          'Unsupported API version.',
        );
      }

      if (new URL(c.req.url).search) {
        throw new StripeError(
          400,
          'invalid_request_error',
          'Query parameters are unsupported.',
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

  api.post('/v1/customers', async (c) => {
    const store = ctx.store.scope();

    if (
      c.req.header('content-type')?.split(';')[0]?.trim() !==
        'application/x-www-form-urlencoded'
    ) {
      return failure(
        new StripeError(
          400,
          'invalid_request_error',
          'Expected form-urlencoded input.',
        ),
      );
    }

    try {
      const fields = parseForm(await c.req.text());
      const key = c.req.header('idempotency-key');
      const parsed = createInput.safeParse({
        ...fields,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });

      if (!parsed.success) {
        return failure(
          new StripeError(
            400,
            'invalid_request_error',
            'Invalid customer input.',
          ),
        );
      }

      return c.json(await createCustomer(store, parsed.data, ctx.clock.now));
    } catch (error) {
      if (error instanceof StripeError) {
        return failure(error);
      }

      throw error;
    }
  });

  api.get('/v1/customers/:id', async (c) => {
    try {
      return c.json(await getCustomer(ctx.store.scope(), c.req.param('id')));
    } catch (error) {
      if (error instanceof StripeError) {
        return failure(error);
      }

      throw error;
    }
  });

  api.notFound(() =>
    failure(
      new StripeError(404, 'invalid_request_error', 'Unsupported operation.'),
    )
  );
  api.onError(() =>
    failure(new StripeError(500, 'api_error', 'Request failed.'))
  );
}
