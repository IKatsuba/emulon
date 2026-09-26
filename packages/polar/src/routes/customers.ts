import type { Hono, MiddlewareHandler } from 'hono';
import type { PluginContext } from 'emulon';
import { z } from 'zod';
import { authorized } from '../auth/keys.ts';
import {
  PolarError,
  PolarValidationError,
  type ValidationIssue,
  validationIssue,
} from '../model/errors.ts';
import {
  apiVersion,
  createBody,
  createCustomer,
  fromBody,
  getCustomer,
} from '../model/customers.ts';
import { isPublic, portalRoutes, versionHeader } from './license_keys.ts';

function failure(error: unknown): Response {
  if (error instanceof PolarValidationError) {
    return Response.json({ detail: error.issues }, { status: error.status });
  }

  if (error instanceof PolarError) {
    return Response.json({ error: error.code, detail: error.message }, {
      status: error.status,
    });
  }

  return Response.json(
    { error: 'UnsupportedOperation', detail: 'Request failed.' },
    { status: 404 },
  );
}

/** Field locations only: a rejected value may be caller data or a credential. */
export function issues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) =>
    validationIssue(
      ['body', ...issue.path.map((part) => part as string | number)],
      issue.code === 'unrecognized_keys'
        ? 'Unsupported field'
        : 'Invalid input',
      issue.code,
    )
  );
}

export function routes(ctx: PluginContext, api: Hono) {
  const authenticate: MiddlewareHandler = async (c, next) => {
    if (isPublic(c.req.method, c.req.path)) {
      return next();
    }

    if (
      !await authorized(
        ctx.store.scope(),
        c.req.header('authorization') ?? null,
      )
    ) {
      return failure(
        new PolarError(
          401,
          'Unauthorized',
          'Invalid organization access token.',
        ),
      );
    }

    const version = c.req.header(versionHeader);

    // A missing header selects this pinned slice, never a moving current version.
    if (version !== undefined && version !== apiVersion) {
      return failure(
        new PolarError(
          404,
          'UnsupportedOperation',
          `Only Polar-Version ${apiVersion} is emulated.`,
        ),
      );
    }

    // A query key is caller data and may itself be a credential: report the
    // location only, never the supplied name.
    if ([...new URL(c.req.url).searchParams.keys()].length > 0) {
      const rejected = failure(
        new PolarValidationError([
          validationIssue(['query'], 'Unsupported field', 'extra_forbidden'),
        ]),
      );

      rejected.headers.set(versionHeader, apiVersion);

      return rejected;
    }

    await next();
    // Set after the handler so the selected version reaches raw responses too.
    c.header(versionHeader, apiVersion);
  };

  const create = async (c: Parameters<MiddlewareHandler>[0]) => {
    let body: unknown;

    try {
      body = await c.req.raw.json();
    } catch {
      return failure(
        new PolarValidationError([
          validationIssue(['body'], 'Invalid JSON body', 'json_invalid'),
        ]),
      );
    }

    const parsed = createBody.safeParse(body);

    if (!parsed.success) {
      return failure(new PolarValidationError(issues(parsed.error)));
    }

    try {
      const customer = await createCustomer(
        ctx.store.scope(),
        fromBody(parsed.data),
        ctx.clock.now,
      );

      return c.json(customer, 201);
    } catch (error) {
      return failure(error);
    }
  };

  api.use('*', authenticate);
  portalRoutes(ctx, api);
  // FastAPI redirects the unslashed form upstream; both are accepted locally.
  api.post('/v1/customers', create);
  api.post('/v1/customers/', create);
  api.get('/v1/customers/:id', async (c) => {
    try {
      return c.json(await getCustomer(ctx.store.scope(), c.req.param('id')));
    } catch (error) {
      return failure(error);
    }
  });

  api.notFound(() =>
    failure(
      new PolarError(
        404,
        'UnsupportedOperation',
        'This operation is not emulated.',
      ),
    )
  );
  api.onError((error) => failure(error));
}
