import { DatabaseSync } from 'node:sqlite';
import { definePlugin, Emulon } from 'emulon';
import type { Store } from '../src/state/store.ts';
import { serveEnvironment } from '../src/control/server.ts';
import { request } from '../src/control/client.ts';
import { publishDiscovery, readDiscovery } from '../src/runtime/discovery.ts';
import { sqliteCoordinator } from '../src/runtime/sqlite-state.ts';

function assert(value: unknown): asserts value {
  if (!value) {
    throw new Error('Assertion failed');
  }
}

async function rejects(work: () => unknown, message: string) {
  try {
    await work();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(message));

    return;
  }

  throw new Error('Expected failure: ' + message);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);

  return { promise, resolve };
}

function fixture() {
  const stores: Store[] = [];
  const calls = { fixtures: 0, setup: 0, stop: 0 };
  let stop = () => Promise.resolve();
  const plugin = (version = '1', name = 'durable-fixture', fail = false) =>
    definePlugin({
      name,
      apiVersion: 1,
      capabilities: [],
      commands: {},
      state: {
        pluginVersion: version,
        schemaVersion: 1,
        fixtures(options: { seed: string }) {
          calls.fixtures++;

          return [{ collection: 'resources', id: 'seed', value: options.seed }];
        },
      },
      setup(ctx) {
        calls.setup++;
        stores.push(ctx.store);

        if (fail) {
          throw new Error('private-startup-secret');
        }

        return Promise.resolve({
          endpoints: {},
          ready: () => Promise.resolve(),
          async stop() {
            calls.stop++;
            await stop();
          },
        });
      },
    });

  return { stores, calls, plugin, setStop: (fn: typeof stop) => stop = fn };
}

const path = (directory: string, slot = 'default') =>
  directory + '/.emulon/state/' + slot + '/state.sqlite';

async function put(store: Store, id: string, value: unknown) {
  await store.transaction((tx) =>
    tx.put({ collection: 'resources', id, value })
  );
}

async function get(store: Store, id: string) {
  return await store.transaction((tx) => tx.get('resources', id));
}

Deno.test('project restart retains UUID, credentials, resources and outbox; reset uses current fixtures and preserves dormant rows', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const f = fixture();
  const config = {
    services: {
      a: f.plugin()({ seed: 'first' }),
      b: f.plugin()({ seed: 'b' }),
    },
  };
  let host = await serveEnvironment(config, { directory });

  try {
    assert(host.restoredInstances.length === 0);

    const first = await readDiscovery({ directory });
    const credential = crypto.randomUUID();

    await put(f.stores[0]!, 'token', credential);
    await put(f.stores[1]!, 'retained', 'dormant');
    await f.stores[0]!.transaction((tx) =>
      tx.record({
        type: 'saved',
        origin: 'service',
        occurredAt: '2026-01-01',
        payload: { bytes: new Uint8Array([0, 255]), credential },
      })
    );

    const events = await f.stores[0]!.transaction((tx) => tx.outbox());

    await request(first, '/down', {});
    await host.finished;

    const c = sqliteCoordinator(path(directory));
    const uuid = c.environmentId;

    c.close();

    host = await serveEnvironment({
      services: {
        a: f.plugin()({ seed: 'current' }),
        renamed: f.plugin()({ seed: 'new' }),
      },
    }, { directory });

    assert(JSON.stringify(host.restoredInstances) === JSON.stringify(['a']));

    const second = await readDiscovery({ directory });

    assert(first.id !== second.id && first.token !== second.token);
    assert(await get(f.stores[2]!, 'seed') === 'first');
    assert(await get(f.stores[2]!, 'token') === credential);
    assert(await get(f.stores[3]!, 'token') === undefined);
    assert(
      JSON.stringify(await f.stores[2]!.transaction((tx) => tx.outbox())) ===
        JSON.stringify(events),
    );

    await using _privateEnv = await Emulon.start(config);

    assert(await get(f.stores[4]!, 'token') === undefined);

    const oldScope = f.stores[2]!.scope();
    const entered = gate();
    const release = gate();
    const pending = f.stores[2]!.transaction(async (tx) => {
      await tx.put({ collection: 'resources', id: 'abandoned', value: true });
      entered.resolve();
      await release.promise;
    });

    const failed = rejects(() => pending, 'Stale');

    await entered.promise;
    await request(second, '/reset', {});
    release.resolve();
    await failed;
    await rejects(() => get(oldScope, 'token'), 'Stale');
    assert(await get(f.stores[2]!, 'seed') === 'current');
    assert(await get(f.stores[2]!, 'token') === undefined);
    assert((await readDiscovery({ directory })).id === second.id);
    await host.dispose();

    const reopened = sqliteCoordinator(path(directory));

    assert(reopened.environmentId === uuid);
    reopened.close();

    host = await serveEnvironment(config, { directory });

    assert(await get(f.stores[7]!, 'retained') === 'dormant');
    assert(await get(f.stores[6]!, 'seed') === 'current');

    await using other = await serveEnvironment(config, {
      directory,
      environment: 'other',
    });

    assert(await get(f.stores[8]!, 'token') === undefined);
    await other.dispose();

    const otherState = sqliteCoordinator(path(directory, 'other'));

    assert(otherState.environmentId !== uuid);
    otherState.close();
  } finally {
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('project preflight rejects last-instance versions, plugin identity and corrupt formats before callbacks', async () => {
  for (const mutation of ['version', 'plugin', 'codec', 'snapshot']) {
    const directory = await Deno.realPath(await Deno.makeTempDir());
    const f = fixture();
    const initial = {
      services: { a: f.plugin()({ seed: 'a' }), z: f.plugin()({ seed: 'z' }) },
    };

    try {
      const host = await serveEnvironment(initial, { directory });

      await host.dispose();

      if (mutation === 'codec' || mutation === 'snapshot') {
        const db = new DatabaseSync(path(directory));

        db.exec(
          mutation === 'codec'
            ? 'UPDATE metadata SET codec_format=2'
            : "UPDATE instances SET snapshot=x'ff' WHERE id='z'",
        );
        db.close();
      }

      const before = JSON.stringify(f.calls);

      await rejects(
        () =>
          serveEnvironment({
            services: {
              a: f.plugin()({ seed: 'changed' }),
              z: f.plugin(
                mutation === 'version' ? '2' : '1',
                mutation === 'plugin' ? 'other' : 'durable-fixture',
              )({ seed: 'changed' }),
            },
          }, { directory }),
        mutation === 'version' || mutation === 'plugin'
          ? 'mismatch'
          : 'Invalid',
      );
      assert(JSON.stringify(f.calls) === before);

      const db = new DatabaseSync(path(directory));

      assert(db.prepare('SELECT count(*) AS n FROM instances').get()!.n === 2);
      db.close();
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test('live ownership and stale discovery reject startup before fixtures; failed startup releases ownership and retains commits', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const f = fixture();
  const config = { services: { a: f.plugin()({ seed: 'a' }) } };
  let host = await serveEnvironment(config, { directory });

  try {
    const record = await readDiscovery({ directory });

    await put(f.stores[0]!, 'saved', 'committed');

    const before = JSON.stringify(f.calls);

    await rejects(
      () => serveEnvironment(config, { directory }),
      'already exists',
    );
    await Deno.remove(directory + '/.emulon/default.json');
    await rejects(
      () => serveEnvironment(config, { directory }),
      'STATE_IN_USE',
    );
    assert(JSON.stringify(f.calls) === before);
    await host.dispose();

    const afterStop = JSON.stringify(f.calls);

    await publishDiscovery({ directory }, record);
    await rejects(
      () => serveEnvironment(config, { directory }),
      'already exists',
    );
    assert(JSON.stringify(f.calls) === afterStop);
    await Deno.remove(directory + '/.emulon/default.json');
    await rejects(() =>
      serveEnvironment({
        services: {
          a: f.plugin()({ seed: 'changed' }),
          z: f.plugin('1', 'durable-fixture', true)({ seed: 'z' }),
        },
      }, { directory }), 'Service instance "z" failed');
    await rejects(() => get(f.stores[1]!, 'saved'), 'closed');
    await rejects(() => readDiscovery({ directory }), 'No environment record');

    host = await serveEnvironment(config, { directory });

    assert(await get(f.stores[3]!, 'saved') === 'committed');
  } finally {
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('failed durable reset is atomic, fences stores and holds ownership through plugin shutdown', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const f = fixture();
  const config = {
    services: { a: f.plugin()({ seed: 'a' }), b: f.plugin()({ seed: 'b' }) },
  };
  let host = await serveEnvironment(config, { directory });
  const entered = gate();
  const release = gate();

  try {
    await put(f.stores[0]!, 'saved', 'a');
    await put(f.stores[1]!, 'saved', 'b');
    await host.dispose();

    const db = new DatabaseSync(path(directory));

    db.exec(
      "CREATE TRIGGER fail_reset BEFORE UPDATE ON instances WHEN OLD.id='b' AND NEW.generation>OLD.generation BEGIN SELECT RAISE(ABORT, 'private-secret'); END;",
    );
    db.close();

    host = await serveEnvironment(config, { directory });

    f.setStop(async () => {
      entered.resolve();
      await release.promise;
    });

    const record = await readDiscovery({ directory });
    const reset = rejects(
      () => request(record, '/reset', {}),
      'Control request failed',
    );

    await entered.promise;
    await rejects(() => get(f.stores[2]!, 'saved'), 'closed');
    await rejects(() => sqliteCoordinator(path(directory)), 'STATE_IN_USE');
    assert((await readDiscovery({ directory })).id === record.id);
    release.resolve();
    await reset;
    await host.finished;
    await rejects(() => readDiscovery({ directory }), 'No environment record');

    host = await serveEnvironment(config, { directory });

    assert(await get(f.stores[4]!, 'saved') === 'a');
    assert(await get(f.stores[5]!, 'saved') === 'b');
  } finally {
    release.resolve();
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('host close fences abandoned callbacks and retains lock until plugin stop and discovery cleanup', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const f = fixture();
  const config = { services: { a: f.plugin()({ seed: 'a' }) } };
  let host = await serveEnvironment(config, { directory });
  const entered = gate();
  const release = gate();
  const stopped = gate();
  const stopRelease = gate();

  try {
    const pending = f.stores[0]!.transaction(async (tx) => {
      await tx.put({ collection: 'resources', id: 'abandoned', value: true });
      entered.resolve();
      await release.promise;
    });

    const failed = rejects(() => pending, 'closed');

    await entered.promise;
    f.setStop(async () => {
      stopped.resolve();
      await stopRelease.promise;
    });

    const closing = host.dispose();

    await stopped.promise;
    await rejects(() => sqliteCoordinator(path(directory)), 'STATE_IN_USE');
    await readDiscovery({ directory });
    stopRelease.resolve();
    await closing;

    host = await serveEnvironment(config, { directory });

    release.resolve();
    await failed;
    assert(await get(f.stores[1]!, 'abandoned') === undefined);
  } finally {
    release.resolve();
    stopRelease.resolve();
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('whole-environment mismatch prevents pending event selection and transport callbacks', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const f = fixture();
  let selected = 0;
  let transported = 0;

  try {
    const host = await serveEnvironment({
      services: {
        a: f.plugin()({ seed: 'a' }),
        z: f.plugin()({ seed: 'z' }),
      },
    }, { directory });

    await f.stores[0]!.transaction(async (tx) => {
      await tx.put({
        collection: 'emulon.destinations',
        id: 'receiver',
        value: {
          id: 'receiver',
          url: 'http://127.0.0.1:1',
          secret: 'local-secret',
          types: ['saved'],
          enabled: true,
        },
      });
      await tx.record({
        type: 'saved',
        origin: 'service',
        occurredAt: 'now',
        payload: {},
      });
    });

    await host.dispose();

    const eventTypes = ['saved'];

    eventTypes.includes = (value) => {
      selected++;

      return value === 'saved';
    };

    const active = definePlugin({
      name: 'durable-fixture',
      apiVersion: 1,
      capabilities: ['webhooks'],
      commands: {},
      state: { pluginVersion: '1', schemaVersion: 1 },
      subscriptions: {
        selection: 'processing-time',
        eventTypes,
      },
      transport: {
        timeoutMs: 100,
        serialize() {
          transported++;

          throw new Error('Transport must not run');
        },
        headers: () => Promise.resolve({}),
        succeeds: () => true,
        retryDelayMs: () => undefined,
      },
      setup: () => {
        throw new Error('Setup must not run');
      },
    });
    const before = selected;

    await rejects(() =>
      serveEnvironment({
        services: {
          a: active(),
          z: f.plugin('2')({ seed: 'z' }),
        },
      }, { directory }), 'mismatch');
    assert(selected === before && transported === 0);

    const c = sqliteCoordinator(path(directory));

    c.prepare([{
      instanceId: 'a',
      plugin: 'durable-fixture',
      version: { pluginVersion: '1', schemaVersion: 1 },
    }]);

    const h = await c.open({
      environmentId: c.environmentId,
      instanceId: 'a',
      version: { pluginVersion: '1', schemaVersion: 1 },
      fixtures: [],
    });

    await h.store.transaction(async (tx) => {
      assert((await tx.outbox()).length === 1);
      assert((await tx.list('emulon.deliveries')).length === 0);
      assert((await tx.list('emulon.dispatched')).length === 0);
    });

    c.close();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('host reopening dispatches pending outbox once and retains completed delivery bytes and attempts', async () => {
  const { listen } = await import('../src/runtime/http.ts');
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const f = fixture();
  let received = 0;
  const receiver = await listen(async (request) => {
    assert(await request.text() === '{"saved":true}');
    received++;

    return new Response('ok');
  });

  let host = await serveEnvironment({
    services: { a: f.plugin()({ seed: 'a' }) },
  }, { directory });
  let store!: Store;
  const worker = definePlugin({
    name: 'durable-fixture',
    apiVersion: 1,
    capabilities: ['webhooks'],
    commands: {},
    state: { pluginVersion: '1', schemaVersion: 1 },
    subscriptions: { selection: 'processing-time', eventTypes: ['saved'] },
    transport: {
      timeoutMs: 1000,
      serialize: (event) =>
        new TextEncoder().encode(JSON.stringify(event.payload)),
      headers: () => Promise.resolve({ 'content-type': 'application/json' }),
      succeeds: (status) => status === 200,
      retryDelayMs: () => undefined,
    },
    setup(ctx) {
      store = ctx.store;

      return Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      });
    },
  });

  try {
    await f.stores[0]!.transaction(async (tx) => {
      await tx.put({
        collection: 'emulon.destinations',
        id: 'receiver',
        value: {
          id: 'receiver',
          url: receiver.url,
          secret: 'local-secret',
          types: ['saved'],
          enabled: true,
        },
      });
      await tx.record({
        type: 'saved',
        origin: 'service',
        occurredAt: 'now',
        payload: { saved: true },
      });
    });

    await host.dispose();

    const config = { services: { a: worker() } };

    host = await serveEnvironment(config, { directory });

    assert(received === 1);

    const saved = await store.transaction(async (tx) => ({
      deliveries: await tx.list('emulon.deliveries'),
      attempts: await tx.list('emulon.attempts'),
      events: await tx.outbox(),
      destinations: await tx.list('emulon.destinations'),
    }));

    assert(saved.deliveries.length === 1 && saved.attempts.length === 1);
    assert(
      (saved.deliveries[0]!.value as { status: string }).status === 'succeeded',
    );
    await host.dispose();

    host = await serveEnvironment(config, { directory });

    assert(received === 1);

    const reopened = await store.transaction(async (tx) => ({
      deliveries: await tx.list('emulon.deliveries'),
      attempts: await tx.list('emulon.attempts'),
      events: await tx.outbox(),
      destinations: await tx.list('emulon.destinations'),
    }));

    assert(JSON.stringify(saved) === JSON.stringify(reopened));
  } finally {
    await host.dispose();
    await receiver.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('concurrent reset rejection does not terminate a host while admitted HTTP work drains', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const entered = gate();
  const release = gate();
  const plugin = definePlugin({
    name: 'reset-drain',
    apiVersion: 1,
    capabilities: ['http'],
    commands: {},
    async setup(ctx) {
      const api = ctx.http.surface('api');

      api.get('/slow', async (c) => {
        entered.resolve();
        await release.promise;

        return c.text('done');
      });

      api.get('/probe', (c) => c.text('ready'));

      return {
        endpoints: { api: await ctx.http.listen('api') },
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      };
    },
  });
  const host = await serveEnvironment({ services: { a: plugin() } }, {
    directory,
  });

  try {
    const url = host.identity.endpoints.a!.api!;
    const pending = fetch(url + '/slow').then((r) => r.text());

    await entered.promise;

    const record = await readDiscovery({ directory });
    const reset = request(record, '/reset', {});
    let paused = false;

    for (let i = 0; i < 50; i++) {
      const probe = await fetch(url + '/probe');

      await probe.text();

      if (probe.status === 503) {
        paused = true;

        break;
      }
    }

    assert(paused);
    await rejects(
      () => request(record, '/reset', {}),
      'Control request failed',
    );
    release.resolve();
    assert(await pending === 'done');
    await reset;
    assert((await readDiscovery({ directory })).id === record.id);

    const probe = await fetch(url + '/probe');

    assert(await probe.text() === 'ready');
    await request(record, '/reset', {});
  } finally {
    release.resolve();
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('shutdown and startup rollback retain ownership until admitted provider handlers finish', async () => {
  for (const rollback of [false, true]) {
    const directory = await Deno.realPath(await Deno.makeTempDir());
    const entered = gate();
    const release = gate();
    const failReady = gate();
    const listening = gate();
    let url = '';
    let handlerDone = false;
    let finished = false;
    let probe!: () => Promise<Response> | Response;
    const plugin = definePlugin({
      name: 'provider-drain',
      apiVersion: 1,
      capabilities: ['http'],
      commands: {},
      async setup(ctx) {
        const api = ctx.http.surface('api');

        api.get('/slow', async (c) => {
          entered.resolve();
          await release.promise;

          handlerDone = true;

          return c.text('done');
        });

        api.get('/probe', (c) => c.text('ready'));

        probe = () => api.fetch(new Request('http://localhost/probe'));
        url = await ctx.http.listen('api');

        listening.resolve();

        return {
          endpoints: { api: url },
          async ready() {
            if (rollback) {
              await failReady.promise;

              throw new Error('Readiness failed');
            }
          },
          stop: () => Promise.resolve(),
        };
      },
    });
    const starting = serveEnvironment({ services: { a: plugin() } }, {
      directory,
    });
    const failed = rollback
      ? rejects(() => starting, 'failed to start')
      : undefined;

    await listening.promise;

    const host = rollback ? undefined : await starting;
    const pending = fetch(url + '/slow').then((r) => r.text()).catch(() => {});

    let closing: Promise<void> | undefined;

    try {
      await entered.promise;
      failReady.resolve();

      closing = (rollback ? failed! : host!.dispose()).then(() => {
        finished = true;
      });

      let fenced = false;

      for (let i = 0; i < 50; i++) {
        const response = await probe();

        await response.text();

        if (response.status === 503) {
          fenced = true;

          break;
        }
      }

      assert(fenced && !handlerDone && !finished);
      await rejects(() => sqliteCoordinator(path(directory)), 'STATE_IN_USE');

      if (!rollback) {
        await readDiscovery({ directory });
      }

      release.resolve();
      await pending;
      await closing;
      assert(handlerDone && finished);
      await rejects(
        () => readDiscovery({ directory }),
        'No environment record',
      );

      const coordinator = sqliteCoordinator(path(directory));

      coordinator.close();
    } finally {
      release.resolve();
      failReady.resolve();
      await pending;
      await closing;
      await host?.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test('last-instance malformed core records reject reopen before every callback without changing snapshots', async () => {
  const malformed = [
    { collection: 'emulon.deliveries', id: 'bad', value: { status: 'queued' } },
    {
      collection: 'emulon.attempts',
      id: 'bad',
      value: { requestBytes: [256] },
    },
    {
      collection: 'emulon.destinations',
      id: 'bad',
      value: { secret: 'private-secret' },
    },
    { collection: 'emulon.dispatched', id: 'bad', value: false },
    {
      collection: 'emulon.faults',
      id: 'delivery',
      value: { delayMs: -1, loseResponse: false },
    },
  ];

  for (const row of malformed) {
    const directory = await Deno.realPath(await Deno.makeTempDir());
    const f = fixture();
    let selected = 0;
    let transported = 0;
    let fixtures = 0;
    let setups = 0;

    try {
      const host = await serveEnvironment({
        services: {
          a: f.plugin()({ seed: 'a' }),
          z: f.plugin()({ seed: 'z' }),
        },
      }, { directory });

      await f.stores[0]!.transaction(async (tx) => {
        await tx.put({
          collection: 'emulon.destinations',
          id: 'receiver',
          value: {
            id: 'receiver',
            url: 'http://127.0.0.1:1',
            secret: 'local-secret',
            types: ['saved'],
            enabled: true,
          },
        });
        await tx.record({
          type: 'saved',
          origin: 'service',
          occurredAt: 'now',
          payload: {},
        });
      });

      await f.stores[1]!.transaction((tx) => tx.put(row));
      await host.dispose();

      const snapshots = () => {
        const db = new DatabaseSync(path(directory));

        try {
          return JSON.stringify(
            db.prepare('SELECT * FROM instances ORDER BY id').all(),
          );
        } finally {
          db.close();
        }
      };

      const before = snapshots();
      const eventTypes = ['saved'];

      eventTypes.includes = () => {
        selected++;

        return true;
      };

      const active = definePlugin({
        name: 'durable-fixture',
        apiVersion: 1,
        capabilities: ['webhooks'],
        commands: {},
        state: {
          pluginVersion: '1',
          schemaVersion: 1,
          fixtures() {
            fixtures++;

            return [];
          },
        },
        subscriptions: { selection: 'processing-time', eventTypes },
        transport: {
          timeoutMs: 100,
          serialize() {
            transported++;

            throw new Error('Transport must not run');
          },
          headers: () => Promise.resolve({}),
          succeeds: () => true,
          retryDelayMs: () => undefined,
        },
        setup() {
          setups++;

          throw new Error('Setup must not run');
        },
      });

      await rejects(
        () =>
          serveEnvironment({ services: { a: active(), z: active() } }, {
            directory,
          }),
        'Invalid core',
      );
      assert(
        fixtures === 0 && setups === 0 && selected === 0 && transported === 0,
      );
      assert(snapshots() === before);
      await rejects(
        () => readDiscovery({ directory }),
        'No environment record',
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});
