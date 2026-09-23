import type { Hono, MiddlewareHandler } from 'hono';
import type { PluginContext } from 'emulon';
import { authorized } from '../auth/keys.ts';
import { getEmail, sendEmail, sendInput } from '../model/emails.ts';

function failure(statusCode: number, name: string, message: string) {
  return Response.json({ statusCode, name, message }, { status: statusCode });
}

export function routes(ctx: PluginContext, api: Hono) {
  const authenticate: MiddlewareHandler = async (c, next) => {
    const request = c.req.raw;
    const store = ctx.store.scope();
    const header = request.headers.get('authorization');

    if (!header) {
      return failure(
        401,
        'missing_api_key',
        'Missing API key in the authorization header.',
      );
    }

    if (!await authorized(store, header)) {
      return failure(403, 'validation_error', 'API key is invalid');
    }

    if (
      request.headers.has('resend-version') ||
      request.headers.has('x-api-version')
    ) {
      return failure(
        501,
        'unsupported_operation',
        'Explicit API versions are not supported.',
      );
    }

    await next();
  };

  api.get('/emails/:id', authenticate, async (c) => {
    const email = await getEmail(ctx.store.scope(), c.req.param('id'));

    return email
      ? Response.json(email)
      : failure(404, 'not_found', 'Email not found.');
  });

  api.post('/emails', authenticate, async (c) => {
    const request = c.req.raw;
    const store = ctx.store.scope();

    if (request.headers.has('idempotency-key')) {
      return failure(
        501,
        'unsupported_operation',
        'Idempotency keys are not supported.',
      );
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return failure(400, 'validation_error', 'Invalid JSON body.');
    }

    const parsed = sendInput.safeParse(body);

    if (!parsed.success) {
      if (
        parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys')
      ) {
        return failure(
          501,
          'unsupported_operation',
          'Unsupported email field.',
        );
      }

      return failure(
        422,
        'validation_error',
        'Invalid email fields; from, to, subject and html or text are required.',
      );
    }

    const email = await sendEmail(store, parsed.data);

    return Response.json({ id: email.id });
  });

  api.get('/health', (c) => c.json({ status: 'ok' }));
}
