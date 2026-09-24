import type { Context, Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { authorized } from '../auth/keys.ts';
import { invalidRequest, StripeError } from '../errors.ts';
import { type Params, parseParams } from '../http/form.ts';
import { endpoints, type OperationId, perform } from '../operations.ts';
import { selectVersion, type VersionConfig } from '../versions/select.ts';
import type { StripeVersionModule } from '../versions/types.ts';

function failure(error: StripeError, version: string) {
  return Response.json(error.toJSON(), {
    status: error.status,
    headers: { 'stripe-version': version },
  });
}

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

/**
 * The Stripe API. Every request authenticates, then selects its version
 * module before anything reads parameters, so a rejected version changes
 * nothing and consumes no idempotency key.
 */
export function routes(
  ctx: PluginContext,
  api: Hono,
  hostedUrl: (id: string) => string,
  config: VersionConfig,
  installed: ReadonlyMap<string, StripeVersionModule>,
) {
  const select = (c: Context) =>
    selectVersion(c.req.header('stripe-version'), config, installed);

  api.use('*', async (c, next) => {
    c.header('stripe-version', config.defaultVersion);

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

      c.header('stripe-version', select(c).id);

      await next();
    } catch (error) {
      if (error instanceof StripeError) {
        return failure(error, config.defaultVersion);
      }

      return failure(
        new StripeError(500, 'api_error', 'Request failed.'),
        config.defaultVersion,
      );
    }
  });

  for (const operation of Object.keys(endpoints) as OperationId[]) {
    const { method, path } = endpoints[operation];

    api[method](path, async (c) => {
      // The middleware already validated this selection.
      const module = select(c);

      try {
        const parsed = module.parse(operation, await readParams(c));

        return c.json(
          await perform(
            ctx.store.scope(),
            module,
            {
              operation,
              path: new URL(c.req.url).pathname,
              id: c.req.param('id'),
              parsed,
              idempotencyKey: c.req.header('idempotency-key'),
            },
            ctx.clock.now(),
            hostedUrl,
          ),
        );
      } catch (error) {
        if (error instanceof StripeError) {
          return failure(error, module.id);
        }

        throw error;
      }
    });
  }

  api.notFound((c) =>
    failure(
      new StripeError(
        404,
        'invalid_request_error',
        'Unrecognized request URL. The local Stripe emulator does not implement this operation.',
      ),
      select(c).id,
    )
  );
  api.onError(() =>
    failure(
      new StripeError(500, 'api_error', 'Request failed.'),
      config.defaultVersion,
    )
  );
}
