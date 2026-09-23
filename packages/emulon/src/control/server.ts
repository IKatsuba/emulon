import { Hono } from 'hono';
import { eventResponse } from './events.ts';
import { CommandError, environmentRegistry } from '../commands/registry.ts';
import { runCommand } from '../cli/commands.ts';
import { listen, type Listener } from '../runtime/http.ts';
import {
  projectTarget,
  publishDiscovery,
  removeDiscovery,
  requireVacantDiscovery,
  statePath,
} from '../runtime/discovery.ts';
import type { Configuration } from '../sdk/load.ts';
import { startWithAdapter } from '../sdk/start.ts';
import { sqliteCoordinator } from '../runtime/sqlite-state.ts';
import {
  addresses,
  authorized,
  commandRequest,
  type Connection,
  environmentName,
  type Target,
} from './protocol.ts';

export async function serveEnvironment(
  config: Configuration,
  target: Target = {},
) {
  environmentName(target.environment);

  target = await projectTarget(target);

  await requireVacantDiscovery(target);

  let coordinator: ReturnType<typeof sqliteCoordinator>;

  try {
    coordinator = sqliteCoordinator(await statePath(target));
  } catch (error) {
    const busy = (error as Error).message.startsWith('STATE_IN_USE:');

    throw new CommandError(
      busy ? 'STATE_IN_USE' : 'STATE_INVALID',
      busy
        ? 'STATE_IN_USE: State database is already owned.'
        : 'Invalid or unsupported state database.',
    );
  }

  let environment: Awaited<ReturnType<typeof startWithAdapter>>;

  try {
    // Recheck under ownership before any trusted plugin callback.
    await requireVacantDiscovery(target);

    environment = await startWithAdapter(
      config,
      coordinator,
      coordinator.environmentId,
      coordinator,
    );
  } catch (error) {
    coordinator.close();

    throw error;
  }

  const registry = environmentRegistry(environment);
  let listener: Listener | undefined;
  let published = false;
  let stopping: Promise<void> | undefined;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  // A startup rollback can finish before a foreground caller begins waiting.
  finished.catch(() => {});

  const record: Connection = {
    version: 1,
    id: crypto.randomUUID(),
    token: Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join(''),
    url: '',
  };

  function dispose(): Promise<void> {
    return stopping ??= (async () => {
      try {
        await environment.dispose();
      } finally {
        try {
          if (published) {
            await removeDiscovery(target, record.id);
          }
        } finally {
          try {
            await listener?.stop();
          } finally {
            coordinator.close();
          }
        }
      }
    })().then(finish, (error) => {
      fail(error);

      throw error;
    });
  }

  const identity = () => ({
    id: record.id,
    endpoints: addresses(environment.endpoints),
  });

  try {
    const app = new Hono();

    app.use(async (c, next) => {
      const req = c.req.raw;

      if (!authorized(req, record)) {
        return Response.json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Control authentication required.',
          },
        }, { status: 401 });
      }

      await next();
    });

    app.onError((error) => {
      const failure = error instanceof CommandError
        ? error
        : new CommandError('INVALID_REQUEST', 'Control request failed.');

      return Response.json({ error: failure.toJSON() }, { status: 400 });
    });

    app.notFound((c) => c.text('Unsupported route', 404));
    app.get('/identity', () => {
      return Response.json({
        id: record.id,
        endpoints: environment.endpoints,
      });
    });

    app.get('/events', (c) => eventResponse(c.req.raw, environment.events));
    app.post('/command', async (c) => {
      const body = await c.req.json();

      return Response.json(await registry.invoke(commandRequest(body)));
    });

    app.post('/cli', async (c) => {
      const body = await c.req.json();

      if (
        !Array.isArray(body) ||
        !body.every((arg) => typeof arg === 'string')
      ) {
        throw new CommandError(
          'INVALID_REQUEST',
          'Expected command arguments.',
        );
      }

      return Response.json(await runCommand(body, registry));
    });

    app.post('/reset', async (c) => {
      await c.req.json();

      try {
        await environment.reset();
      } catch (error) {
        if (registry.closed) {
          setTimeout(() => {
            dispose().catch(() => {});
          }, 0);
        }

        throw error;
      }

      return Response.json({});
    });

    app.post('/down', async (c) => {
      await c.req.json();

      try {
        await environment.dispose();
      } finally {
        try {
          await removeDiscovery(target, record.id);
        } finally {
          // Let the response leave the handler before closing its listener.
          setTimeout(() => {
            dispose().catch(() => {});
          }, 0);
        }
      }

      return Response.json({ stopping: true });
    });

    listener = await listen(app.fetch);
    record.url = listener.url;

    await publishDiscovery(target, record);

    published = true;

    return {
      identity: identity(),
      restoredInstances: coordinator.restoredInstances,
      dispose,
      finished,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();

    throw error;
  }
}
