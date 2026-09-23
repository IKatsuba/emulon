import { bookingInput, createBooking, getBooking } from '../model/bookings.ts';
import type { Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { authorized } from '../auth/keys.ts';
import {
  CalError,
  getEventType,
  idSchema,
  listSlots,
  queryInput,
} from '../model/scheduling.ts';

function failure(error: CalError) {
  return Response.json({
    status: 'error',
    error: { code: error.code, message: error.message },
  }, { status: error.status });
}

export function parseQuery(
  search: URLSearchParams,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};

  for (const [key, value] of search) {
    if (
      !['eventTypeId', 'start', 'end', 'timeZone'].includes(key) ||
      Object.hasOwn(result, key)
    ) {
      throw new CalError(
        400,
        'invalid_request',
        'Unsupported or duplicate query field.',
      );
    }

    if (key === 'eventTypeId' && !/^[1-9]\d*$/.test(value)) {
      throw new CalError(400, 'invalid_request', 'Invalid event type ID.');
    }

    result[key] = key === 'eventTypeId' ? Number(value) : value;
  }

  return result;
}

export function routes(ctx: PluginContext, api: Hono) {
  api.use('*', async (c, next) => {
    if (
      !await authorized(
        ctx.store.scope(),
        c.req.header('authorization') ?? null,
      )
    ) {
      return failure(new CalError(401, 'unauthorized', 'Invalid API key.'));
    }

    await next();
  });

  api.get('/v2/event-types/:id', async (c) => {
    if (c.req.header('cal-api-version') !== '2026-06-12') {
      throw new CalError(
        400,
        'invalid_version',
        'Expected cal-api-version: 2026-06-12.',
      );
    }

    if (new URL(c.req.url).search) {
      throw new CalError(
        400,
        'invalid_request',
        'Query fields are unsupported.',
      );
    }

    const raw = c.req.param('id');
    const id = idSchema.safeParse(/^[1-9]\d*$/.test(raw) ? Number(raw) : NaN);

    if (!id.success) {
      throw new CalError(400, 'invalid_request', 'Invalid event type ID.');
    }

    return c.json({
      status: 'success',
      data: await getEventType(ctx.store.scope(), id.data),
    });
  });

  api.get('/v2/slots', async (c) => {
    if (c.req.header('cal-api-version') !== '2024-09-04') {
      throw new CalError(
        400,
        'invalid_version',
        'Expected cal-api-version: 2024-09-04.',
      );
    }

    const input = queryInput.safeParse(
      parseQuery(new URL(c.req.url).searchParams),
    );

    if (!input.success) {
      throw new CalError(400, 'invalid_request', 'Invalid slot query.');
    }

    return c.json({
      status: 'success',
      data: await listSlots(ctx.store.scope(), input.data, ctx.clock.now),
    });
  });

  api.use('/v2/bookings', async (c, next) => {
    checkBookingRequest(c.req.header('cal-api-version'), c.req.url);
    await next();
  });

  api.use('/v2/bookings/*', async (c, next) => {
    checkBookingRequest(c.req.header('cal-api-version'), c.req.url);
    await next();
  });

  api.post('/v2/bookings', async (c) => {
    let raw: unknown;

    try {
      raw = await c.req.json();
    } catch {
      throw new CalError(
        400,
        'invalid_request',
        'Expected a JSON booking object.',
      );
    }

    const input = bookingInput.safeParse(raw);

    if (!input.success) {
      throw new CalError(400, 'invalid_request', 'Invalid booking input.');
    }

    return c.json({
      status: 'success',
      data: await createBooking(ctx.store.scope(), input.data, ctx.clock.now),
    }, 201);
  });

  api.get('/v2/bookings/:uid', async (c) =>
    c.json({
      status: 'success',
      data: await getBooking(ctx.store.scope(), c.req.param('uid')),
    }));
  api.notFound(() =>
    failure(
      new CalError(404, 'unsupported_operation', 'Unsupported operation.'),
    )
  );
  api.onError((error) =>
    failure(
      error instanceof CalError
        ? error
        : new CalError(500, 'internal_error', 'Request failed.'),
    )
  );
}

function checkBookingRequest(version: string | undefined, url: string) {
  if (version !== '2026-02-25') {
    throw new CalError(
      400,
      'invalid_version',
      'Expected cal-api-version: 2026-02-25.',
    );
  }

  if (new URL(url).search) {
    throw new CalError(400, 'invalid_request', 'Query fields are unsupported.');
  }
}
