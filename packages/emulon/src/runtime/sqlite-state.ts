import type { DatabaseSync as Database } from 'node:sqlite';
import process from 'node:process';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { codecVersion, decodeGraph, encodeGraph } from '../state/codec.ts';
import { cloneState } from '../state/clone.ts';
import { validateCoreFormat } from '../state/core-format.ts';
import {
  checkVersion,
  type Entity,
  type ManagedState,
  type Snapshot,
  type StateAdapter,
  stateHandle,
  type StateVersion,
} from '../state/store.ts';

function loadSQLite(): { DatabaseSync: typeof Database } {
  const emitWarning = process.emitWarning;

  // Suppress only our driver's import notice, during synchronous builtin loading.
  process.emitWarning = (warning, ...args) => {
    if (
      warning ===
        'SQLite is an experimental feature and might change at any time' &&
      args[0] === 'ExperimentalWarning'
    ) {
      return;
    }

    Reflect.apply(emitWarning, process, [warning, ...args]);
  };

  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

const { DatabaseSync } = loadSQLite();

export interface Registration {
  instanceId: string;
  plugin: string;
  version: StateVersion;
}
interface Stored extends Registration {
  generation: number;
  revision: number;
  snapshot: Snapshot;
}
export interface Coordinator extends StateAdapter {
  readonly environmentId: string;
  readonly restoredInstances: readonly string[];
  prepare(registrations: readonly Registration[]): void;
  resetAll(): Promise<void>;
  close(): void;
}

const invalid = () => new Error('Invalid or unsupported state database.');

function safeInteger(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

function snapshot(value: unknown, instanceId: string): Snapshot {
  if (!value || typeof value !== 'object') {
    throw invalid();
  }

  const s = value as Snapshot;

  if (
    !(s.rows instanceof Map) || !Array.isArray(s.events) ||
    Object.keys(s).sort().join() !== 'events,rows'
  ) {
    throw invalid();
  }

  for (const [name, rows] of s.rows) {
    if (typeof name !== 'string' || !(rows instanceof Map)) {
      throw invalid();
    }

    for (const id of rows.keys()) {
      if (typeof id !== 'string') {
        throw invalid();
      }
    }
  }

  const ids = new Set<string>();

  for (const e of s.events) {
    if (
      !e || typeof e !== 'object' || typeof e.id !== 'string' ||
      ids.has(e.id) || e.instanceId !== instanceId ||
      typeof e.type !== 'string' || typeof e.occurredAt !== 'string' ||
      !['service', 'published', 'direct'].includes(e.origin) ||
      !Object.hasOwn(e, 'payload')
    ) {
      throw invalid();
    }

    ids.add(e.id);
  }

  return s;
}

function seed(fixtures: readonly Entity[]): Snapshot {
  const rows = new Map<string, Map<string, unknown>>();

  for (const entity of cloneState(fixtures)) {
    if (
      typeof entity.collection !== 'string' || typeof entity.id !== 'string'
    ) {
      throw invalid();
    }

    let collection = rows.get(entity.collection);

    if (!collection) {
      rows.set(entity.collection, collection = new Map());
    }

    collection.set(entity.id, cloneState(entity.value));
  }

  return { rows, events: [] };
}

function protect(file: string): boolean {
  const directory = dirname(file);
  // The caller chooses the storage root; every existing path component must be real.
  let part = directory;

  while (true) {
    try {
      if (lstatSync(part).isSymbolicLink()) {
        throw invalid();
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') {
        throw e;
      }
    }

    const parent = dirname(part);

    if (parent === part) {
      break;
    }

    part = parent;
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const dir = lstatSync(directory);

  if (!dir.isDirectory() || (dir.mode & 0o077)) {
    throw invalid();
  }

  for (const path of [file, file + '-wal', file + '-shm', file + '-journal']) {
    try {
      const stat = lstatSync(path);

      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
        throw invalid();
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') {
        throw e;
      }
    }
  }

  try {
    closeSync(openSync(file, 'wx', 0o600));

    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') {
      throw e;
    }

    return false;
  }
}

/** Internal host seam; one connection owns the database until coordinator close. */
export function sqliteCoordinator(path: string): Coordinator {
  const file = resolve(path);
  let db: Database | undefined;
  let closed = false;
  let revoked = false;
  const handles = new Map<
    string,
    { handle: ManagedState; initial: Snapshot }
  >();
  const restoredInstances: string[] = [];
  const stored = new Map<string, Stored>();
  const prepared = new Map<string, Registration>();
  const revoke = () => {
    revoked = true;

    for (const { handle } of handles.values()) {
      handle.close();
    }
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;

    revoke();

    try {
      db?.close();
    } catch {
      throw new Error('State database close failed.');
    }
  };

  function guard() {
    if (closed || revoked) {
      throw new Error('State database is closed.');
    }
  }

  function sql<T>(work: () => T): T {
    guard();

    try {
      db!.exec('BEGIN IMMEDIATE');

      const result = work();

      db!.exec('COMMIT');

      return result;
    } catch {
      try {
        db!.exec('ROLLBACK');
      } catch { /* Outcome may be unknown; revoke every cache. */ }

      revoke();

      throw new Error('State commit failed; reopen the environment.');
    }
  }

  let environmentId: string;

  try {
    const created = protect(file);

    db = new DatabaseSync(file);

    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;');
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
    );

    for (
      const [key, value] of [
        ['locking_mode', 'exclusive'],
        ['journal_mode', 'wal'],
        ['synchronous', 2],
        ['foreign_keys', 1],
      ] as const
    ) {
      if (db.prepare(`PRAGMA ${key}`).get()?.[key] !== value) {
        throw invalid();
      }
    }

    // A completed write transaction acquires the connection-held exclusive WAL lock.
    db.exec('BEGIN IMMEDIATE; COMMIT;');

    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
      throw invalid();
    }

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all();

    if (tables.length === 0) {
      if (!created) {
        throw invalid();
      }

      environmentId = crypto.randomUUID();

      sql(() => {
        db!.exec(
          'CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), uuid TEXT NOT NULL, sql_format INTEGER NOT NULL, codec_format INTEGER NOT NULL, core_format INTEGER NOT NULL); CREATE TABLE instances (id TEXT PRIMARY KEY, plugin TEXT NOT NULL, plugin_version TEXT NOT NULL, schema_version INTEGER NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot BLOB NOT NULL);',
        );
        db!.prepare('INSERT INTO metadata VALUES (1, ?, 1, ?, 1)').run(
          environmentId,
          codecVersion,
        );
      });
    } else {
      if (tables.map((t) => t.name).sort().join() !== 'instances,metadata') {
        throw invalid();
      }

      const meta = db.prepare('SELECT * FROM metadata').all();
      const m = meta[0];

      if (
        meta.length !== 1 || !m || m.singleton !== 1 || m.sql_format !== 1 ||
        m.codec_format !== codecVersion || m.core_format !== 1 ||
        typeof m.uuid !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          .test(m.uuid)
      ) {
        throw invalid();
      }

      environmentId = m.uuid;
    }

    for (const row of db.prepare('SELECT * FROM instances').all()) {
      if (
        typeof row.id !== 'string' || stored.has(row.id) ||
        typeof row.plugin !== 'string' ||
        typeof row.plugin_version !== 'string' ||
        !safeInteger(row.schema_version) || row.schema_version < 1 ||
        !safeInteger(row.generation) || !safeInteger(row.revision) ||
        !(row.snapshot instanceof Uint8Array)
      ) {
        throw invalid();
      }

      stored.set(row.id, {
        instanceId: row.id,
        plugin: row.plugin,
        version: {
          pluginVersion: row.plugin_version,
          schemaVersion: row.schema_version,
        },
        generation: row.generation,
        revision: row.revision,
        snapshot: snapshot(decodeGraph(row.snapshot), row.id),
      });
    }
  } catch (e) {
    try {
      close();
    } catch { /* Startup must release ownership even on invalid data. */ }

    if (
      (e as { errcode?: number }).errcode === 5 ||
      /locked|busy/i.test((e as Error).message)
    ) {
      throw new Error('STATE_IN_USE: State database is already owned.');
    }

    throw invalid();
  }

  function replace(old: Stored, next: Stored, bytes: Uint8Array) {
    const result = db!.prepare(
      'UPDATE instances SET generation=?, revision=?, snapshot=? WHERE id=? AND generation=? AND revision=?',
    ).run(
      next.generation,
      next.revision,
      bytes,
      old.instanceId,
      old.generation,
      old.revision,
    );

    if (Number(result.changes) !== 1) {
      throw new Error('State revision conflict.');
    }
  }

  function reset(ids: string[]): Promise<void> {
    try {
      guard();

      const changes = ids.map((id) => {
        const old = stored.get(id)!;
        const next = {
          ...old,
          generation: old.generation + 1,
          revision: old.revision + 1,
          snapshot: cloneState(handles.get(id)!.initial),
        };

        if (!safeInteger(next.generation) || !safeInteger(next.revision)) {
          throw invalid();
        }

        return { old, next, bytes: encodeGraph(next.snapshot) };
      });

      sql(() => {
        for (const c of changes) {
          replace(c.old, c.next, c.bytes);
        }
      });

      for (const { next } of changes) {
        stored.set(next.instanceId, next);
        handles.get(next.instanceId)!.handle.replace(
          next.snapshot,
          next.generation,
          next.revision,
        );
      }

      for (const { next } of changes) {
        handles.get(next.instanceId)!.handle.notify();
      }

      return Promise.resolve();
    } catch (e) {
      revoke();

      return Promise.reject(e);
    }
  }

  return {
    environmentId,
    get restoredInstances() {
      return [...restoredInstances];
    },
    prepare(registrations) {
      guard();

      const next = new Map<string, Registration>();

      for (const r of registrations) {
        if (
          next.has(r.instanceId) || !r.plugin ||
          !safeInteger(r.version.schemaVersion) ||
          r.version.schemaVersion < 1 ||
          typeof r.version.pluginVersion !== 'string'
        ) {
          throw invalid();
        }

        const old = stored.get(r.instanceId);

        if (old) {
          validateCoreFormat(old.snapshot);

          if (old.plugin !== r.plugin) {
            throw new Error(
              `State plugin identity mismatch for instance ${r.instanceId}.`,
            );
          }

          try {
            checkVersion(r.version, old.version);
          } catch (e) {
            throw new Error(
              `Instance ${r.instanceId}: ${(e as Error).message}`,
            );
          }
        }

        next.set(r.instanceId, cloneState(r));
      }

      prepared.clear();

      for (const [id, r] of next) {
        prepared.set(id, r);
      }
    },
    open(input) {
      try {
        guard();

        const registration = prepared.get(input.instanceId);

        if (
          !registration || input.environmentId !== environmentId ||
          handles.has(input.instanceId)
        ) {
          throw new Error(
            'State instance was not prepared or is already open.',
          );
        }

        checkVersion(input.version, registration.version);

        const initial = seed(input.fixtures);
        let row = stored.get(input.instanceId);

        if (row) {
          restoredInstances.push(input.instanceId);
        }

        if (!row) {
          row = {
            ...registration,
            generation: 0,
            revision: 0,
            snapshot: cloneState(initial),
          };

          const bytes = encodeGraph(row.snapshot);

          sql(() =>
            db!.prepare('INSERT INTO instances VALUES (?, ?, ?, ?, 0, 0, ?)')
              .run(
                input.instanceId,
                registration.plugin,
                input.version.pluginVersion,
                input.version.schemaVersion,
                bytes,
              )
          );
          stored.set(input.instanceId, row);
        }

        const handle = stateHandle(input, {
          snapshot: cloneState(row.snapshot),
          generation: row.generation,
          revision: row.revision,
          commit(value, generation, revision) {
            guard();

            const old = stored.get(input.instanceId)!;

            if (
              old.generation !== generation || old.revision !== revision ||
              !safeInteger(revision + 1)
            ) {
              throw new Error('Stale state revision.');
            }

            const detached = snapshot(cloneState(value), input.instanceId);
            const bytes = encodeGraph(detached);
            const next = { ...old, snapshot: detached, revision: revision + 1 };

            sql(() => replace(old, next, bytes));
            stored.set(input.instanceId, next);
          },
          reset: () => reset([input.instanceId]),
        });

        handles.set(input.instanceId, { handle, initial });

        return Promise.resolve(handle);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    resetAll: () => reset([...handles.keys()]),
    close,
  };
}
