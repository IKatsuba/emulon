import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { PluginContext } from 'emulon';
import { PolarError, PolarValidationError } from '../model/errors.ts';
import { apiVersion } from '../model/customers.ts';
import {
  activateLicenseKey,
  releaseActivation,
  validateLicenseKey,
} from '../model/license_keys.ts';
import {
  parseActivate,
  type Parsed,
  parseDeactivate,
  parseJson,
  parseValidate,
} from '../model/portal.ts';

export const versionHeader = 'polar-version';

const prefix = '/v1/customer-portal/license-keys';
export const portalPaths: readonly string[] = [
  `${prefix}/activate`,
  `${prefix}/validate`,
  `${prefix}/deactivate`,
];

/** The key is the credential on these routes: no Bearer token is read. */
export function isPublic(method: string, path: string): boolean {
  return method === 'POST' && portalPaths.includes(path);
}

/**
 * The runtime handler adds `error` to FastAPI's `detail` list. Nothing here
 * echoes the body: a failure carries a fixed text or field locations only.
 */
function failure(error: unknown): Response {
  if (error instanceof PolarValidationError) {
    return Response.json(
      { error: 'RequestValidationError', detail: error.issues },
      { status: error.status },
    );
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

async function read<T>(
  c: Context,
  parse: (body: Record<string, unknown>) => Parsed<T>,
): Promise<T> {
  const json = parseJson(await c.req.raw.text());
  const parsed = json.ok ? parse(json.value) : json;

  if (!parsed.ok) {
    throw new PolarValidationError(parsed.issues);
  }

  return parsed.value;
}

export function portalRoutes(ctx: PluginContext, api: Hono) {
  // The pinned version applies without authentication, before any mutation.
  const versioned: MiddlewareHandler = async (c, next) => {
    const version = c.req.header(versionHeader);

    if (version !== undefined && version !== apiVersion) {
      return failure(
        new PolarError(
          404,
          'UnsupportedOperation',
          `Only Polar-Version ${apiVersion} is emulated.`,
        ),
      );
    }

    await next();
    c.res.headers.set(versionHeader, apiVersion);
  };

  const handle = (run: (c: Context) => Promise<Response>) => (c: Context) =>
    run(c).catch(failure);

  for (const path of portalPaths) {
    api.post(path, versioned);
  }

  api.post(
    `${prefix}/activate`,
    handle(async (c) => {
      const body = await read(c, parseActivate);

      return c.json(
        await activateLicenseKey(ctx.store, {
          key: body.key,
          organizationId: body.organization_id,
          label: body.label,
          conditions: body.conditions,
          meta: body.meta,
        }, ctx.clock.now),
      );
    }),
  );

  api.post(
    `${prefix}/validate`,
    handle(async (c) => {
      const body = await read(c, parseValidate);

      return c.json(
        await validateLicenseKey(ctx.store, {
          key: body.key,
          organizationId: body.organization_id,
          activationId: body.activation_id,
          benefitId: body.benefit_id,
          customerId: body.customer_id,
          incrementUsage: body.increment_usage,
          conditions: body.conditions,
        }, ctx.clock.now),
      );
    }),
  );

  api.post(
    `${prefix}/deactivate`,
    handle(async (c) => {
      const body = await read(c, parseDeactivate);

      await releaseActivation(ctx.store, {
        key: body.key,
        organizationId: body.organization_id,
        activationId: body.activation_id,
      }, ctx.clock.now);

      return c.body(null, 204);
    }),
  );
}
