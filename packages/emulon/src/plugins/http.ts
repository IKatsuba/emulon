import { Hono } from 'hono';
import { bodyLimit } from './http-rules.ts';
import { boundedBody, requestLifecycle } from './http-middleware.ts';
import { listen, type Listener } from '../runtime/http.ts';
import { PortInUseError } from '../runtime/port-in-use.ts';
import type { PluginContext } from './types.ts';

/** A bind failure the host reports under its own code after rollback. */
export interface ListenFailure {
  code: 'PORT_IN_USE';
  surface: string;
  port: number;
}

export function httpContext(
  ports: ReadonlyMap<string, number> = new Map(),
) {
  const listeners = new Map<string, Promise<Listener>>();
  let failure: ListenFailure | undefined;
  const surfaces = new Map<string, Hono>();
  const lifecycle = requestLifecycle();

  return {
    context: {
      http: {
        surface(name, options = {}) {
          if (lifecycle.closed) {
            throw new Error('HTTP context is closed');
          }

          if (!name || surfaces.has(name)) {
            throw new Error('HTTP surface name must be unique and nonempty');
          }

          const limit = bodyLimit(options.maxBodyBytes);
          const app = new Hono();

          app.onError(() =>
            new Response('Internal server error', { status: 500 })
          );
          app.notFound((c) => c.text('Unsupported route', 404));
          app.use(lifecycle.middleware);
          app.use(boundedBody(limit));
          surfaces.set(name, app);

          return app;
        },
        async listen(name) {
          if (lifecycle.closed) {
            throw new Error('HTTP context is closed');
          }

          const app = surfaces.get(name);

          if (!app || listeners.has(name)) {
            throw new Error('HTTP surface must exist and listen only once');
          }

          const pending = listen(app.fetch, ports.get(name) ?? 0);

          listeners.set(name, pending);

          try {
            return (await pending).url;
          } catch (error) {
            // The plugin may wrap or swallow this; the host keeps the cause.
            if (error instanceof PortInUseError) {
              failure ??= {
                code: 'PORT_IN_USE',
                surface: name,
                port: error.port,
              };
            }

            throw error;
          }
        },
      },
    } satisfies Pick<PluginContext, 'http'>,
    /** Surfaces that were asked to listen, whether or not binding succeeded. */
    listened(): ReadonlySet<string> {
      return new Set(listeners.keys());
    },
    failure(): ListenFailure | undefined {
      return failure;
    },
    pause: lifecycle.pause,
    resume: lifecycle.resume,
    async stop() {
      const drained = lifecycle.close();
      const results = await Promise.allSettled(
        [
          drained,
          ...[...listeners.values()].map(async (pending) => {
            const listener = await pending.catch(() => undefined);

            await listener?.stop();
          }),
        ],
      );

      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('HTTP shutdown failed');
      }
    },
  };
}
