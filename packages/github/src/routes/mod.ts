import {
  createIssue,
  installationPrincipal,
  providerIssueInput,
} from '../model/issues.ts';
import { authenticateAccess, userPrincipal } from '../auth/user.ts';
import type { Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { AuthError, authResponse } from '../auth/errors.ts';
import { authenticateApp, issueToken } from '../auth/operations.ts';
import { accountSchema, installationSchema } from '../model/schema.ts';

export function routes(app: Hono, ctx?: PluginContext): void {
  app.notFound((c) => c.json({ message: 'Not Found' }, 404));

  if (!ctx) {
    return;
  }

  app.use(async (c, next) => {
    const version = c.req.header('X-GitHub-Api-Version');

    if (version && version !== '2022-11-28') {
      return c.json({
        message: 'Not a supported version',
        documentation_url: 'https://docs.github.com/rest',
        status: '400',
      }, 400);
    }

    await next();
  });

  app.onError((error) =>
    error instanceof AuthError
      ? authResponse(error.reason)
      : new Response('Internal server error', { status: 500 })
  );
  app.get('/user', (c) =>
    ctx.store.transaction(async (tx) => {
      const token = await authenticateAccess(
        tx,
        c.req.header('Authorization') ?? null,
        ctx.clock.now(),
      );

      return c.json(
        token.kind === 'user'
          ? await userPrincipal(tx, token.userId)
          : await installationPrincipal(tx, token.installationId),
      );
    }));

  app.post('/repos/:owner/:repo/issues', async (c) => {
    const store = ctx.store.scope();
    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return c.json({
        message: 'Problems parsing JSON',
        documentation_url: 'https://docs.github.com/rest',
        status: '400',
      }, 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({
        message: 'Body should be a JSON object',
        documentation_url: 'https://docs.github.com/rest',
        status: '400',
      }, 400);
    }

    const parsed = providerIssueInput.safeParse(body);

    if (!parsed.success) {
      throw new AuthError('invalid');
    }

    return c.json(
      await createIssue({ ...ctx, store }, {
        ...parsed.data,
        repository: `${c.req.param('owner')}/${c.req.param('repo')}`,
      }, c.req.header('Authorization') ?? null),
      201,
    );
  });

  app.get('/app', (c) =>
    ctx.store.transaction(async (tx) => {
      const app = await authenticateApp(
        tx,
        c.req.header('Authorization') ?? null,
        ctx.clock.now(),
      );

      return c.json({
        id: Number(app.id),
        slug: app.slug,
        client_id: app.clientId,
        permissions: app.permissions,
        events: app.events,
      });
    }));

  app.get('/app/installations', (c) =>
    ctx.store.transaction(async (tx) => {
      const app = await authenticateApp(
        tx,
        c.req.header('Authorization') ?? null,
        ctx.clock.now(),
      );
      const installations = (await tx.list('installations')).map((row) =>
        installationSchema.parse(row.value)
      ).filter((item) => item.appId === app.id);
      const page = Number(c.req.query('page') ?? 1);
      const size = Number(c.req.query('per_page') ?? 30);

      if (
        !Number.isSafeInteger(page) || page < 1 ||
        !Number.isSafeInteger(size) || size < 1 || size > 100
      ) {
        throw new AuthError('invalid');
      }

      return c.json(
        await Promise.all(
          installations.slice((page - 1) * size, page * size).map(
            async (item) => {
              const account = accountSchema.parse(
                await tx.get('accounts', item.account),
              );

              return {
                id: Number(item.id),
                app_id: Number(item.appId),
                app_slug: app.slug,
                account: { ...account, id: Number(account.id) },
                permissions: item.permissions,
                events: app.events,
                repository_selection: 'selected',
                suspended_at: item.suspended ? '1970-01-01T00:00:00Z' : null,
              };
            },
          ),
        ),
      );
    }));

  app.post('/app/installations/:installationId/access_tokens', async (c) => {
    const store = ctx.store.scope();
    const raw = await c.req.text();

    return store.transaction(async (tx) => {
      const now = ctx.clock.now();
      const app = await authenticateApp(
        tx,
        c.req.header('Authorization') ?? null,
        now,
      );
      let input: unknown;

      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        return c.json({
          message: 'Problems parsing JSON',
          documentation_url: 'https://docs.github.com/rest',
          status: '400',
        }, 400);
      }

      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return c.json({
          message: 'Body should be a JSON object',
          documentation_url: 'https://docs.github.com/rest',
          status: '400',
        }, 400);
      }

      return c.json(
        await issueToken(tx, app.id, c.req.param('installationId'), input, now),
        201,
      );
    });
  });
}
