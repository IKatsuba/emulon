import { DatabaseSync } from 'node:sqlite';
import { sqliteCoordinator } from '../src/runtime/sqlite-state.ts';

function assert(value: unknown): asserts value {
  if (!value) {
    throw new Error('Assertion failed');
  }
}

async function rejects(work: () => unknown, text: string) {
  try {
    await work();
  } catch (e) {
    assert(e instanceof Error && e.message.includes(text));

    return;
  }

  throw new Error('Expected failure: ' + text);
}

const version = { pluginVersion: '1.0', schemaVersion: 1 };
const registrations = ['a', 'b', 'dormant'].map((instanceId) => ({
  instanceId,
  plugin: 'example',
  version,
}));
const fixture = [{ collection: 'c', id: 'i', value: 'fixture' }];

async function open(
  c: ReturnType<typeof sqliteCoordinator>,
  instanceId: string,
) {
  return await c.open({
    environmentId: c.environmentId,
    instanceId,
    version,
    fixtures: fixture,
  });
}

async function directory() {
  return await Deno.realPath(await Deno.makeTempDir());
}

Deno.test('SQLite fresh adapters retain identity, ordered state and outbox; prepare rejects mismatches; reset preserves dormant instances', async () => {
  const dir = await directory();
  const path = dir + '/state.sqlite';
  let c = sqliteCoordinator(path);
  const uuid = c.environmentId;

  try {
    c.prepare(registrations);

    for (const r of registrations) {
      const handle = await open(c, r.instanceId);

      await handle.store.transaction(async (tx) => {
        await tx.put({ collection: 'c', id: 'i', value: r.instanceId });
        await tx.put({ collection: 'c', id: 'second', value: 2n });
        await tx.record({
          type: 'event',
          origin: 'service',
          occurredAt: 'now',
          payload: new Uint8Array([42]),
        });
      });
    }

    await rejects(() => sqliteCoordinator(path), 'STATE_IN_USE');
    c.close();

    c = sqliteCoordinator(path);

    assert(c.environmentId === uuid);
    await rejects(() => sqliteCoordinator(path), 'STATE_IN_USE');

    for (
      const registration of [{ ...registrations[0]!, plugin: 'other' }, {
        ...registrations[0]!,
        version: { pluginVersion: '2', schemaVersion: 1 },
      }, {
        ...registrations[0]!,
        version: { pluginVersion: '1.0', schemaVersion: 2 },
      }]
    ) {
      await rejects(() => c.prepare([registration]), 'mismatch');
    }

    c.prepare(registrations.slice(0, 2));

    const handles = await Promise.all([open(c, 'a'), open(c, 'b')]);

    for (const h of handles) {
      await h.store.transaction(async (tx) => {
        assert((await tx.list('c')).map((e) => e.id).join() === 'i,second');
        assert(((await tx.outbox())[0]!.payload as Uint8Array)[0] === 42);
      });
    }

    await c.resetAll();

    for (const h of handles) {
      assert(h.store.generation === 1);
    }

    c.close();

    c = sqliteCoordinator(path);

    c.prepare(registrations);

    for (const r of registrations) {
      const h = await open(c, r.instanceId);

      await h.store.transaction(async (tx) => {
        assert(
          await tx.get('c', 'i') ===
            (r.instanceId === 'dormant' ? 'dormant' : 'fixture'),
        );
        assert(
          (await tx.outbox()).length === (r.instanceId === 'dormant' ? 1 : 0),
        );
      });
    }
  } finally {
    c.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('SQLite SQL failure rolls back all reset rows, revokes callbacks and redacts engine errors', async () => {
  const dir = await directory();
  const path = dir + '/state.sqlite';
  let c = sqliteCoordinator(path);

  try {
    c.prepare(registrations);

    for (const name of ['a', 'b']) {
      const h = await open(c, name);

      await h.store.transaction((tx) =>
        tx.put({ collection: 'c', id: 'i', value: 'committed' })
      );
    }

    c.close();

    const db = new DatabaseSync(path);

    db.exec(
      "CREATE TRIGGER fail_reset BEFORE UPDATE ON instances WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT, 'secret-value'); END;",
    );
    db.close();

    c = sqliteCoordinator(path);

    c.prepare(registrations);

    const a = await open(c, 'a');
    const b = await open(c, 'b');
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((r) => release = r);
    const ready = new Promise<void>((r) => entered = r);
    const pending = a.store.transaction(async (tx) => {
      await tx.put({ collection: 'c', id: 'old', value: 1 });
      entered();
      await wait;
    });

    await ready;

    const failed = rejects(() => pending, 'closed');

    await rejects(
      () => c.resetAll(),
      'State commit failed; reopen the environment.',
    );
    release();
    await failed;
    await rejects(() => b.store.transaction(async () => {}), 'closed');
    c.close();

    c = sqliteCoordinator(path);

    c.prepare(registrations);

    for (const name of ['a', 'b']) {
      const h = await open(c, name);

      assert(h.store.generation === 0);
      await h.store.transaction(async (tx) => {
        assert(await tx.get('c', 'i') === 'committed');
        assert(await tx.get('c', 'old') === undefined);
      });
    }
  } finally {
    c.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('SQLite rejects corrupt snapshots and all unknown format versions without reseeding', async () => {
  for (
    const mutation of [
      'UPDATE metadata SET sql_format=2',
      'UPDATE metadata SET codec_format=2',
      'UPDATE metadata SET core_format=2',
      'DELETE FROM metadata',
      "UPDATE instances SET snapshot=x'ff'",
      'UPDATE instances SET generation=-1',
      "UPDATE instances SET snapshot=x'5b312c5b226e756c6c225d2c5b5d5d'",
    ]
  ) {
    const dir = await directory();
    const path = dir + '/state.sqlite';

    try {
      const c = sqliteCoordinator(path);

      c.prepare(registrations);
      await open(c, 'a');
      c.close();

      const db = new DatabaseSync(path);

      db.exec(mutation);

      const before = db.prepare('SELECT * FROM instances').all();

      db.close();
      await rejects(() => sqliteCoordinator(path), 'Invalid or unsupported');

      const after = new DatabaseSync(path);

      assert(
        JSON.stringify(after.prepare('SELECT * FROM instances').all()) ===
          JSON.stringify(before),
      );
      after.close();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test('SQLite rejects symlinks and unsafe file or directory permissions', async () => {
  const dir = await directory();

  try {
    await Deno.mkdir(dir + '/unsafe', { mode: 0o755 });
    await rejects(
      () => sqliteCoordinator(dir + '/unsafe/state.sqlite'),
      'Invalid',
    );
    await Deno.mkdir(dir + '/safe', { mode: 0o700 });
    await Deno.symlink(dir + '/safe', dir + '/link');
    await rejects(
      () => sqliteCoordinator(dir + '/link/state.sqlite'),
      'Invalid',
    );
    await Deno.writeTextFile(dir + '/safe/state.sqlite', '', { mode: 0o644 });
    await rejects(
      () => sqliteCoordinator(dir + '/safe/state.sqlite'),
      'Invalid',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('SQLite failed entity/outbox commits never publish and revision conflicts revoke the coordinator', async () => {
  for (const action of ["RAISE(ABORT, 'secret')", 'RAISE(IGNORE)']) {
    const dir = await directory();
    const path = dir + '/state.sqlite';
    let c = sqliteCoordinator(path);

    try {
      c.prepare(registrations);
      await open(c, 'a');
      c.close();

      const db = new DatabaseSync(path);

      db.exec(
        `CREATE TRIGGER conflict BEFORE UPDATE ON instances BEGIN SELECT ${action}; END;`,
      );
      db.close();

      c = sqliteCoordinator(path);

      c.prepare(registrations);

      let observed = 0;
      const h = await c.open({
        environmentId: c.environmentId,
        instanceId: 'a',
        version,
        fixtures: [],
        onEvent: () => observed++,
      });

      await rejects(() =>
        h.store.transaction(async (tx) => {
          await tx.put({ collection: 'c', id: 'i', value: 'new' });
          await tx.record({
            type: 'new',
            origin: 'service',
            occurredAt: 'now',
            payload: 'secret',
          });
        }), 'State commit failed; reopen the environment.');
      assert(observed === 0);
      await rejects(() => h.store.transaction(async () => {}), 'closed');
      c.close();

      c = sqliteCoordinator(path);

      c.prepare(registrations);

      const restored = await open(c, 'a');

      await restored.store.transaction(async (tx) => {
        assert(
          await tx.get('c', 'i') === 'fixture' &&
            (await tx.outbox()).length === 0,
        );
      });
    } finally {
      c.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test('SQLite existing empty files and missing schemas fail without reseed', async () => {
  const dir = await directory();
  const path = dir + '/state.sqlite';

  try {
    await Deno.writeFile(path, new Uint8Array(), { mode: 0o600 });
    await rejects(() => sqliteCoordinator(path), 'Invalid');

    const db = new DatabaseSync(path);

    assert(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .length === 0,
    );
    db.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('SQLite callbacks hold no SQL transaction and coordinator close fences an abandoned draft after reopen', async () => {
  const dir = await directory();
  const path = dir + '/state.sqlite';
  let c = sqliteCoordinator(path);
  let release!: () => void;

  try {
    c.prepare(registrations);

    const a = await open(c, 'a');
    const b = await open(c, 'b');
    let entered!: () => void;
    const wait = new Promise<void>((r) => release = r);
    const ready = new Promise<void>((r) => entered = r);
    const pending = a.store.transaction(async (tx) => {
      await tx.put({ collection: 'c', id: 'abandoned', value: true });
      entered();
      await wait;
    });

    await ready;

    const failed = rejects(() => pending, 'closed');

    await b.store.transaction((tx) =>
      tx.put({ collection: 'c', id: 'while-a-waits', value: true })
    );
    c.close();

    c = sqliteCoordinator(path);

    c.prepare(registrations);

    const fresh = await open(c, 'a');

    await fresh.store.transaction((tx) =>
      tx.put({ collection: 'c', id: 'fresh', value: true })
    );
    release();
    await failed;
    await fresh.store.transaction(async (tx) => {
      assert(
        await tx.get('c', 'abandoned') === undefined &&
          await tx.get('c', 'fresh') === true,
      );
    });

    const retained = await open(c, 'b');

    await retained.store.transaction(async (tx) => {
      assert(await tx.get('c', 'while-a-waits') === true);
    });
  } finally {
    release?.();
    c.close();
    await Deno.remove(dir, { recursive: true });
  }
});
