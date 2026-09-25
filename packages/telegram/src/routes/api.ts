import type { Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { parseToken } from '../auth/tokens.ts';
import { authenticate, type Bot, botUser } from '../model/bots.ts';
import { SendError, sendMessage, sendRequest } from '../model/messages.ts';
import { type KnownMethod, knownMethod } from './methods.ts';

/**
 * A Bot API failure. Descriptions are fixed strings: the request path carries
 * the bot token, so no failure may echo the path, the token or caller input.
 */
export class BotApiError extends Error {
  constructor(readonly status: number, readonly description: string) {
    super(description);
  }
}

export const notFound = (): BotApiError => new BotApiError(404, 'Not Found');
export const unauthorized = (): BotApiError =>
  new BotApiError(401, 'Unauthorized');
export const unsupportedMethod = (): BotApiError =>
  new BotApiError(501, 'Not Implemented: method is not emulated');
export const unsupportedTransport = (): BotApiError =>
  new BotApiError(
    501,
    'Not Implemented: only POST requests with a JSON body are emulated',
  );
export const unsupportedParameter = (): BotApiError =>
  new BotApiError(501, 'Not Implemented: parameter is not emulated');
export const invalidBody = (): BotApiError =>
  new BotApiError(400, 'Bad Request: request body must be a JSON object');

export function success(result: unknown): Response {
  return Response.json({ ok: true, result });
}

export function failure(error: unknown): Response {
  const known = error instanceof BotApiError || error instanceof SendError
    ? error
    : new BotApiError(500, 'Internal Server Error');

  return Response.json({
    ok: false,
    error_code: known.status,
    description: known.description,
  }, { status: known.status });
}

/** Exactly one `bot<token>/<method>` pair; anything else is not a Bot API path. */
export function parseRoute(
  pathname: string,
): { token: string; method: string } | null {
  const match = /^\/bot([^/]+)\/([^/]+)$/.exec(pathname);

  return match ? { token: match[1]!, method: match[2]! } : null;
}

/** grammY sends `application/json`, optionally with a charset parameter. */
export function isJson(contentType: string | null): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() ===
    'application/json';
}

type Handler = (
  params: Record<string, unknown>,
  bot: Bot,
  request: { store: PluginContext['store']; now: number },
) => unknown;

const handlers: Partial<Record<KnownMethod, Handler>> = {
  getMe(params, bot) {
    if (Object.keys(params).length > 0) {
      throw unsupportedParameter();
    }

    return botUser(bot);
  },
  sendMessage(params, bot, { store, now }) {
    return sendMessage(store, bot, sendRequest(params), now);
  },
};

async function params(request: Request): Promise<Record<string, unknown>> {
  if (
    request.method !== 'POST' || !isJson(request.headers.get('content-type'))
  ) {
    throw unsupportedTransport();
  }

  let body: unknown;

  try {
    body = JSON.parse(await request.text());
  } catch {
    throw invalidBody();
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidBody();
  }

  return body as Record<string, unknown>;
}

/**
 * The token is checked before the method is resolved, so an unknown or
 * unsupported method reveals nothing to a caller without a valid token.
 */
export function routes(ctx: PluginContext, api: Hono) {
  api.all('*', async (c) => {
    const store = ctx.store.scope();

    try {
      const route = parseRoute(new URL(c.req.url).pathname);
      const token = route && parseToken(route.token);

      if (!route || !token) {
        throw notFound();
      }

      const bot = await authenticate(store, token);

      if (!bot) {
        throw unauthorized();
      }

      const method = knownMethod(route.method);

      if (!method) {
        throw notFound();
      }

      const handler = handlers[method];

      if (!handler) {
        throw unsupportedMethod();
      }

      return success(
        await handler(await params(c.req.raw), bot, {
          store,
          now: ctx.clock.now(),
        }),
      );
    } catch (error) {
      return failure(error);
    }
  });

  api.onError(() => failure(undefined));
}
