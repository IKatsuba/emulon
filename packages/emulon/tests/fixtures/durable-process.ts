// This fixture is also copied into an offline npm consumer by verify-dist.
import process from 'node:process';
import { readSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sqliteCoordinator } from '../../src/runtime/sqlite-state.ts';
import { serveEnvironment } from '../../src/control/server.ts';
import resend from '../../../resend/src/mod.ts';

const [mode, directory, receiver] = process.argv.slice(2);

if (!mode || !directory) {
  throw new Error('Missing fixture arguments');
}

const path = directory + '/.emulon/state/default/state.sqlite';
const secret = 'whsec_' + btoa('durable-process-private-secret');

function report(value: unknown) {
  writeSync(1, JSON.stringify(value) + '\n');
}

function barrier(label: string): never {
  report({ barrier: label });
  // A synchronous barrier can stop inside SQL without adding production hooks.
  readSync(0, new Uint8Array(1), 0, 1, null);

  throw new Error('Crash barrier must be terminated by SIGKILL');
}

if (mode === 'host') {
  const host = await serveEnvironment({ services: { mail: resend() } }, {
    directory,
  });

  report({ ready: true });
  await host.finished;
} else {
  const c = sqliteCoordinator(path);
  const version = { pluginVersion: '0.1.0', schemaVersion: 2 };

  c.prepare(
    ['mail', 'other'].map((instanceId) => ({
      instanceId,
      plugin: '@emulon/resend',
      version,
    })),
  );

  const handles = await Promise.all(
    ['mail', 'other'].map((instanceId) =>
      c.open({
        environmentId: c.environmentId,
        instanceId,
        version,
        fixtures: [],
      })
    ),
  );
  const h = handles[0]!;

  if (mode === 'inspect') {
    const values = await Promise.all(
      handles.map((h) =>
        h.store.transaction(async (tx) => ({
          rows: await tx.list('business'),
          events: await tx.outbox(),
          generation: h.store.generation,
        }))
      ),
    );

    report({ uuid: c.environmentId, values });
  } else if (mode.startsWith('reset')) {
    const prepare = DatabaseSync.prototype.prepare;

    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);

      if (mode === 'reset-mid' && sql.startsWith('UPDATE instances')) {
        const run = statement.run.bind(statement);

        statement.run = (...args) => {
          Reflect.apply(run, statement, args);

          return barrier('reset-mid');
        };
      }

      return statement;
    };

    await c.resetAll();
    barrier('reset-after');
  } else if (mode === 'seed-delivery') {
    if (!receiver) {
      throw new Error('Missing loopback receiver');
    }

    await h.store.transaction(async (tx) => {
      await tx.put({
        collection: 'emulon.destinations',
        id: 'app',
        value: {
          id: 'app',
          url: receiver,
          secret,
          types: ['email.sent'],
          enabled: true,
        },
      });

      const pending = await tx.record({
        type: 'email.sent',
        origin: 'service',
        occurredAt: '2026-09-21T00:00:00.000Z',
        payload: { email_id: 'pending', text: 'Привет 🌍' },
      });
      const queued = await tx.record({
        type: 'email.sent',
        origin: 'service',
        occurredAt: '2026-09-21T00:00:00.000Z',
        payload: { email_id: 'queued' },
      });
      const id = JSON.stringify([queued.id, 'app']);

      await tx.put({
        collection: 'emulon.deliveries',
        id,
        value: {
          id,
          eventId: queued.id,
          destinationId: 'app',
          status: 'queued',
          nextAttemptAt: '2020-01-01T00:00:00.000Z',
        },
      });
      await tx.put({
        collection: 'emulon.dispatched',
        id: queued.id,
        value: true,
      });
      report({ pending: pending.id, queued: queued.id });
    });
  } else {
    if (mode === 'before' || mode === 'after') {
      const exec = DatabaseSync.prototype.exec;

      DatabaseSync.prototype.exec = function (sql) {
        if (sql === 'COMMIT' && mode === 'before') {
          barrier('before');
        }

        const result = exec.call(this, sql);

        if (sql === 'COMMIT' && mode === 'after') {
          barrier('after');
        }

        return result;
      };
    }

    for (const handle of handles) {
      await handle.store.transaction(async (tx) => {
        await tx.put({
          collection: 'business',
          id: 'entity',
          value: 'committed',
        });
        await tx.record({
          type: 'probe',
          origin: 'service',
          occurredAt: 'now',
          payload: { entity: 'entity' },
        });
      });
    }

    report({ committed: true });
  }

  c.close();
}
