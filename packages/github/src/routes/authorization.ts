import { exchangeCode } from '../auth/user.ts';
import { AuthError } from '../auth/errors.ts';
import type { Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { z } from 'zod';
import {
  approveAuthorization,
  authorizationApps,
  AuthorizationInputError,
  authorizationLifetime,
  authorizeInput,
  denial,
  newSecret,
  resolveAuthorization,
  secretHash,
} from '../auth/authorization.ts';
import { repositorySchema, userSchema } from '../model/schema.ts';

const sessionSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  state: z.string().optional(),
  expiresAt: z.number(),
  used: z.boolean(),
});

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll(
    '>',
    '&gt;',
  ).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local GitHub consent</title></head><body><main>${body}</main></body></html>`;
}

export function authorizationRoutes(web: Hono, ctx: PluginContext): void {
  web.use('/login/oauth/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'same-origin');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    await next();
  });

  web.onError((error) =>
    new Response(
      error instanceof AuthError || error instanceof AuthorizationInputError
        ? 'Invalid consent selection'
        : 'Local authorization failed',
      {
        status: error instanceof AuthError ||
            error instanceof AuthorizationInputError
          ? 400
          : 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  );
  web.post('/login/oauth/access_token', async (c) => {
    let input: Record<string, string>;

    try {
      const raw = c.req.header('Content-Type')?.includes('application/json')
        ? await c.req.json()
        : Object.fromEntries(new URLSearchParams(await c.req.text()));

      input = z.record(z.string(), z.string()).parse(raw);
    } catch {
      return c.json({
        error: 'invalid_request',
        error_description: 'Invalid token request.',
      }, 400);
    }

    const result = await ctx.store.transaction((tx) =>
      exchangeCode(tx, input, ctx.clock.now())
    );
    const status = 'error' in result && result.error === 'invalid_request'
      ? 400
      : 200;

    if (c.req.header('Accept')?.includes('json')) {
      return c.json(result, status);
    }

    return c.body(
      new URLSearchParams(result as Record<string, string>).toString(),
      status,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
  });

  web.get('/login/oauth/authorize', (c) =>
    ctx.store.transaction(async (tx) => {
      const query = new URL(c.req.url).searchParams;

      for (const name of ['client_id', 'redirect_uri', 'state']) {
        if (query.getAll(name).length > 1) {
          return c.html(
            page('<h1>Duplicate authorization parameter</h1>'),
            400,
          );
        }
      }

      if (
        query.has('code_challenge') || query.has('code_challenge_method') ||
        query.has('scope')
      ) {
        return c.html(
          page(
            '<h1>Unsupported authorization parameters</h1><p>PKCE and OAuth scopes are not implemented.</p>',
          ),
          400,
        );
      }

      const request = {
        clientId: query.get('client_id') ?? '',
        redirectUri: query.get('redirect_uri') ?? undefined,
        state: query.get('state') ?? undefined,
      };
      const resolved = resolveAuthorization(
        await authorizationApps(tx),
        request,
      );

      if (resolved.kind === 'page') {
        return c.html(page(`<h1>${resolved.message}</h1>`), resolved.status);
      }

      if (resolved.kind === 'redirect') {
        return c.redirect(resolved.url, 302);
      }

      // Chromium checks the final form redirect against the page's form-action.
      c.header(
        'Content-Security-Policy',
        `default-src 'none'; form-action 'self' ${
          new URL(resolved.callback).origin
        }; frame-ancestors 'none'; base-uri 'none'`,
      );

      const secret = newSecret();

      await tx.put({
        collection: 'authorizationSessions',
        id: await secretHash(secret),
        value: {
          clientId: request.clientId,
          redirectUri: resolved.callback,
          ...(request.state !== undefined ? { state: request.state } : {}),
          expiresAt: ctx.clock.now() + authorizationLifetime,
          used: false,
        },
      });

      const users = (await tx.list('users')).map((row) =>
        userSchema.parse(row.value)
      );
      const repositories = (await tx.list('repositories')).map((row) =>
        repositorySchema.parse(row.value)
      );
      const options = users.map((user) =>
        `<option value="${escapeHtml(user.login)}"${
          query.get('login')?.toLowerCase() === user.login ? ' selected' : ''
        }>${escapeHtml(user.login)}</option>`
      ).join('');
      const repos = repositories.map((repo) =>
        `<label><input type="checkbox" name="repositories" value="${
          escapeHtml(repo.fullName)
        }">${escapeHtml(repo.fullName)}</label><br>`
      ).join('');
      const permissions = Object.entries(resolved.app.permissions).map((
        [name, level],
      ) =>
        `<label>${escapeHtml(name)} <select name="permission:${
          escapeHtml(name)
        }"><option value="">None</option><option value="read">Read</option>${
          level === 'write' ? '<option value="write">Write</option>' : ''
        }</select></label><br>`
      ).join('');

      return c.html(
        page(
          `<h1>Authorize ${
            escapeHtml(resolved.app.slug)
          }</h1><p>Local Emulon consent. Choose fixture access for this user; no GitHub account is contacted.</p><p>Callback: ${
            escapeHtml(resolved.callback)
          }</p><form method="post" action="/login/oauth/consent"><input type="hidden" name="session" value="${secret}"><label>Fixture user <select name="login" required>${options}</select></label><fieldset><legend>Local repository grant</legend>${repos}</fieldset><fieldset><legend>Local permissions</legend>${permissions}</fieldset><button name="decision" value="approve"${
            users.length ? '' : ' disabled'
          }>Authorize</button> <button name="decision" value="deny" formnovalidate>Deny</button></form>`,
        ),
      );
    }));

  web.post('/login/oauth/consent', async (c) => {
    const store = ctx.store.scope();
    const origin = c.req.header('Origin');

    if (origin && origin !== new URL(c.req.url).origin) {
      return c.html(page('<h1>Invalid consent origin</h1>'), 403);
    }

    if (
      !c.req.header('Content-Type')?.startsWith(
        'application/x-www-form-urlencoded',
      )
    ) {
      return c.html(page('<h1>Invalid consent form</h1>'), 400);
    }

    const form = new URLSearchParams(await c.req.text());

    if (
      ['session', 'login', 'decision'].some((key) =>
        form.getAll(key).length > 1
      )
    ) {
      return c.html(page('<h1>Invalid consent form</h1>'), 400);
    }

    return store.transaction(async (tx) => {
      const id = await secretHash(form.get('session') ?? '');
      const parsed = sessionSchema.safeParse(
        await tx.get('authorizationSessions', id),
      );

      if (
        !parsed.success || parsed.data.used ||
        parsed.data.expiresAt <= ctx.clock.now()
      ) {
        return c.html(
          page('<h1>Consent expired or already submitted</h1>'),
          400,
        );
      }

      const session = parsed.data;
      const resolved = resolveAuthorization(
        await authorizationApps(tx),
        session,
      );

      if (resolved.kind !== 'consent') {
        return c.html(
          page('<h1>Authorization is no longer available</h1>'),
          400,
        );
      }

      let redirectUrl: string;

      if (form.get('decision') === 'deny') {
        redirectUrl = denial(
          session.redirectUri,
          session.state,
          'access_denied',
        );
      } else {
        if (form.get('decision') !== 'approve') {
          return c.html(page('<h1>Invalid consent decision</h1>'), 400);
        }

        const permissions: Record<string, string> = Object.create(null);

        for (const [key, value] of form) {
          if (!key.startsWith('permission:')) {
            continue;
          }

          if (form.getAll(key).length !== 1) {
            return c.html(page('<h1>Invalid permission selection</h1>'), 400);
          }

          if (value) {
            permissions[key.slice(11)] = value;
          }
        }

        const input = authorizeInput.safeParse({
          clientId: session.clientId,
          redirectUri: session.redirectUri,
          ...(session.state !== undefined ? { state: session.state } : {}),
          login: form.get('login'),
          repositories: form.getAll('repositories'),
          permissions,
        });

        if (!input.success) {
          return c.html(page('<h1>Invalid consent selection</h1>'), 400);
        }

        redirectUrl =
          (await approveAuthorization(tx, input.data, ctx.clock.now()))
            .redirectUrl;
      }

      await tx.put({
        collection: 'authorizationSessions',
        id,
        value: { ...session, used: true },
      });

      return c.redirect(redirectUrl, 302);
    });
  });
}
