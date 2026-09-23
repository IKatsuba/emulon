import { z } from 'zod';
import { defineCommand, definePlugin, Emulon } from 'emulon';
import { memoryAdapter, type Transaction } from '../src/state/store.ts';
import { startWithAdapter } from '../src/sdk/start.ts';

function assert(value: unknown): asserts value {
  if (!value) {
    throw new Error('Assertion failed');
  }
}

async function rejects(action: () => Promise<unknown>, text: string) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(text));

    return;
  }

  throw new Error('Expected rejection');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);

  return { promise, resolve };
}

const plugin = definePlugin({
  name: 'state-test',
  apiVersion: 1,
  capabilities: ['reset', 'events'],
  state: {
    pluginVersion: '1.0.0',
    schemaVersion: 2,
    fixtures:
      () => [{ collection: 'items', id: 'fixture', value: { count: 1 } }],
  },
  commands: {
    mutate: defineCommand({
      description: 'Write an entity and event',
      input: z.object({ fail: z.boolean() }),
      output: z.string(),
      cli: { path: ['mutate'], flags: { fail: 'fail' } },
      execute: (ctx, input) =>
        ctx.store.transaction(async (tx) => {
          await tx.put({ collection: 'items', id: 'new', value: { count: 2 } });

          const event = await tx.record({
            type: 'created',
            occurredAt: '2026-01-01T00:00:00Z',
            origin: 'service',
            payload: { id: 'new' },
          });

          if (input.fail) {
            throw new Error('Injected failure');
          }

          return event.id;
        }),
    }),
    inspect: defineCommand({
      description: 'Read state',
      input: z.object({}),
      output: z.object({
        items: z.array(z.unknown()),
        events: z.array(z.unknown()),
        generation: z.number(),
      }),
      cli: { path: ['inspect'], flags: {} },
      execute: (ctx) =>
        ctx.store.transaction(async (tx) => ({
          items: await tx.list('items'),
          events: await tx.outbox(),
          generation: ctx.store.generation,
        })),
    }),
  },
  setup: () =>
    Promise.resolve({
      endpoints: {},
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    }),
});

Deno.test('SDK operations atomically commit or roll back state and outbox; reset restores isolated fixtures', async () => {
  const config = { services: { mail: plugin(), other: plugin() } };
  await using first = await Emulon.start(config);
  await using second = await Emulon.start(config);

  await rejects(
    () => first.services.mail.mutate({ fail: true }),
    'Command execution failed',
  );

  let view = await first.services.mail.inspect({});

  assert(view.items.length === 1 && view.events.length === 0);

  const id = await first.services.mail.mutate({ fail: false });

  view = await first.services.mail.inspect({});

  assert(view.items.length === 2 && view.events.length === 1);
  assert((view.events[0] as { id: string }).id === id);
  assert((await first.services.other.inspect({})).items.length === 1);
  assert((await second.services.mail.inspect({})).events.length === 0);
  await first.reset();

  view = await first.services.mail.inspect({});

  assert(
    view.items.length === 1 && view.events.length === 0 &&
      view.generation === 1,
  );
  console.log(JSON.stringify(view));
});

Deno.test('startup rejects incompatible stored versions before plugin setup', async () => {
  for (
    const version of [{ pluginVersion: '1.0.0', schemaVersion: 9 }, {
      pluginVersion: '9.0.0',
      schemaVersion: 2,
    }]
  ) {
    let closed = false;

    await rejects(
      () =>
        startWithAdapter({ services: { mail: plugin() } }, {
          async open(input) {
            const handle = await memoryAdapter().open(input);

            return {
              ...handle,
              version,
              close() {
                closed = true;

                handle.close();
              },
            };
          },
        }),
      `required plugin 1.0.0, schema 2; actual plugin ${version.pluginVersion}, schema ${version.schemaVersion}`,
    );
    assert(closed);
  }
});

Deno.test('transactions serialize, detach values and revoke escaped handles', async () => {
  const state = await memoryAdapter().open({
    environmentId: 'one',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [],
  });
  let escaped!: Transaction;

  await state.store.transaction(async (tx) => {
    escaped = tx;

    const value = { count: 0 };

    await tx.put({ collection: 'c', id: 'i', value });

    value.count = 99;
  });

  await rejects(() => escaped.delete('c', 'i'), 'finished');
  await Promise.all(
    Array.from({ length: 20 }, () =>
      state.store.transaction(async (tx) => {
        const value = await tx.get('c', 'i') as { count: number };

        await Promise.resolve();
        value.count++;
        await tx.put({ collection: 'c', id: 'i', value });
      })),
  );

  const value = await state.store.transaction((tx) => tx.get('c', 'i')) as {
    count: number;
  };

  assert(value.count === 20);

  value.count = 77;

  assert(
    (await state.store.transaction((tx) => tx.get('c', 'i')) as {
      count: number;
    }).count === 20,
  );
});

Deno.test('reset fences running and queued transactions while new work proceeds', async () => {
  const state = await memoryAdapter().open({
    environmentId: 'one',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [],
  });
  const entered = deferred();
  const release = deferred();
  const oldScope = state.store.scope();
  const running = state.store.transaction(async (tx) => {
    await tx.put({ collection: 'c', id: 'old', value: true });
    await tx.record({
      type: 'old',
      origin: 'service',
      occurredAt: 'now',
      payload: null,
    });
    entered.resolve();
    await release.promise;
  });

  await entered.promise;

  const queued = state.store.transaction(async () => {});

  const failures = [
    rejects(() => running, 'Stale'),
    rejects(() => queued, 'Stale'),
  ];

  await state.reset();
  await state.store.transaction((tx) =>
    tx.put({ collection: 'c', id: 'new', value: true })
  );
  await rejects(() => oldScope.transaction(async () => {}), 'Stale');
  release.resolve();
  await Promise.all(failures);
  await state.store.transaction(async (tx) => {
    assert((await tx.list('c')).length === 1);
    assert((await tx.outbox()).length === 0);
  });

  state.close();
  await rejects(() => state.store.transaction(async () => {}), 'closed');
});

Deno.test('SDK reset drains admitted commands and HTTP handlers and fences pending validation', async () => {
  const commandEntered = deferred();
  const commandRelease = deferred();
  const httpEntered = deferred();
  const httpRelease = deferred();
  const validationEntered = deferred();
  const validationRelease = deferred();
  let validatedExecuted = false;
  const draining = definePlugin({
    name: 'draining',
    apiVersion: 1,
    capabilities: ['http', 'reset'],
    commands: {
      slow: defineCommand({
        description: 'Delayed mutation',
        input: z.object({}),
        output: z.boolean(),
        cli: { path: ['slow'], flags: {} },
        async execute(ctx) {
          commandEntered.resolve();
          await commandRelease.promise;
          await ctx.store.transaction((tx) =>
            tx.put({ collection: 'c', id: 'command', value: true })
          );

          return true;
        },
      }),
      validating: defineCommand({
        description: 'Delayed validation',
        input: z.object({
          value: z.string().refine(async () => {
            validationEntered.resolve();
            await validationRelease.promise;

            return true;
          }),
        }),
        output: z.boolean(),
        cli: { path: ['validating'], flags: { value: 'value' } },
        execute() {
          validatedExecuted = true;

          return true;
        },
      }),
      count: defineCommand({
        description: 'Count entities',
        input: z.object({}),
        output: z.number(),
        cli: { path: ['count'], flags: {} },
        execute: (ctx) =>
          ctx.store.transaction(async (tx) => (await tx.list('c')).length),
      }),
    },
    async setup(ctx) {
      ctx.http.surface('api').get('/', async () => {
        httpEntered.resolve();
        await httpRelease.promise;
        await ctx.store.transaction((tx) =>
          tx.put({ collection: 'c', id: 'http', value: true })
        );

        return new Response('done');
      });

      const api = await ctx.http.listen('api');

      return {
        endpoints: { api },
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      };
    },
  });
  await using env = await Emulon.start({ services: { service: draining() } });
  const validating = env.services.service.validating({ value: 'valid' });

  await validationEntered.promise;

  const command = env.services.service.slow({});
  const response = fetch(env.endpoints.service.api!);

  await Promise.all([commandEntered.promise, httpEntered.promise]);

  let resetDone = false;
  const reset = env.reset().then(() => {
    resetDone = true;
  });

  await rejects(() => env.services.service.count({}), 'reset is in progress');

  const paused = await fetch(env.endpoints.service.api!);

  assert(paused.status === 503);
  await paused.text();
  assert(!resetDone);
  commandRelease.resolve();
  await command;
  assert(!resetDone);
  httpRelease.resolve();
  assert(await (await response).text() === 'done');
  await reset;
  validationRelease.resolve();
  await rejects(() => validating, 'generation changed');
  assert(!validatedExecuted);
  assert(await env.services.service.count({}) === 0);
});

Deno.test('shared memory is rejected at fixture, entity and outbox boundaries', async () => {
  const buffer = new SharedArrayBuffer(8);
  const cycle: Record<string, unknown> = { buffer };

  cycle.self = cycle;

  const values = [
    buffer,
    new Uint8Array(buffer),
    { nested: [new DataView(buffer)] },
    new Map([[buffer, 'key']]),
    new Map([['value', new Set([new Uint16Array(buffer)])]]),
    new Error('nested', { cause: cycle }),
    {
      get bytes() {
        return new Uint8Array(buffer);
      },
    },
  ];
  const input = {
    environmentId: 'one',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [],
  };

  for (const value of values) {
    await rejects(
      async () => {
        await memoryAdapter().open({
          ...input,
          fixtures: [{ collection: 'c', id: 'i', value }],
        });
      },
      'shared memory',
    );

    const state = await memoryAdapter().open(input);

    for (const boundary of ['entity', 'outbox']) {
      await rejects(
        () =>
          state.store.transaction(async (tx) => {
            await tx.put({ collection: 'c', id: 'valid', value: true });
            await tx.record({
              type: 'valid',
              origin: 'service',
              occurredAt: 'now',
              payload: null,
            });

            if (boundary === 'entity') {
              await tx.put({ collection: 'c', id: 'invalid', value });
            } else {
              await tx.record({
                type: 'invalid',
                origin: 'service',
                occurredAt: 'now',
                payload: value,
              });
            }
          }),
        'shared memory',
      );
      await state.store.transaction(async (tx) => {
        assert((await tx.list('c')).length === 0);
        assert((await tx.outbox()).length === 0);
      });
    }

    state.close();
  }
});

Deno.test('SDK binary state preserves rollback, environment isolation and reset', async () => {
  const fixture = new Uint8Array([0]);
  const binary = definePlugin({
    name: 'binary-state',
    apiVersion: 1,
    capabilities: ['reset', 'events'],
    state: {
      pluginVersion: '1',
      schemaVersion: 1,
      fixtures: () => [{ collection: 'c', id: 'i', value: fixture }],
    },
    commands: {
      mutate: defineCommand({
        description: 'Mutate binary state and record an event',
        input: z.object({ fail: z.boolean() }),
        output: z.boolean(),
        cli: { path: ['mutate'], flags: { fail: 'fail' } },
        execute: (ctx, input) =>
          ctx.store.transaction(async (tx) => {
            const bytes = await tx.get('c', 'i') as Uint8Array;

            bytes[0] = 42;

            await tx.put({ collection: 'c', id: 'i', value: bytes });

            const event = await tx.record({
              type: 'changed',
              origin: 'service',
              occurredAt: 'now',
              payload: bytes,
            });

            bytes[0] = 99;
            (event.payload as Uint8Array)[0] = 99;

            if (input.fail) {
              throw new Error('Injected failure');
            }

            return true;
          }),
      }),
      inspect: defineCommand({
        description: 'Inspect binary state and events',
        input: z.object({}),
        output: z.object({ byte: z.number(), events: z.array(z.number()) }),
        cli: { path: ['inspect'], flags: {} },
        execute: (ctx) =>
          ctx.store.transaction(async (tx) => {
            const rows = await tx.list('c');
            const events = await tx.outbox();
            const byte = (rows[0]!.value as Uint8Array)[0]!;
            const result = {
              byte,
              events: events.map((e) => (e.payload as Uint8Array)[0]!),
            };

            (rows[0]!.value as Uint8Array)[0] = 77;

            for (const event of events) {
              (event.payload as Uint8Array)[0] = 77;
            }

            return result;
          }),
      }),
    },
    setup: () =>
      Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
  });
  const config = { services: { mail: binary() } };
  await using first = await Emulon.start(config);
  await using second = await Emulon.start(config);

  fixture[0] = 88;

  await rejects(
    () => first.services.mail.mutate({ fail: true }),
    'Command execution failed',
  );
  assert(
    JSON.stringify(await first.services.mail.inspect({})) ===
      '{"byte":0,"events":[]}',
  );
  await first.services.mail.mutate({ fail: false });

  for (let i = 0; i < 2; i++) {
    assert(
      JSON.stringify(await first.services.mail.inspect({})) ===
        '{"byte":42,"events":[42]}',
    );
    assert(
      JSON.stringify(await second.services.mail.inspect({})) ===
        '{"byte":0,"events":[]}',
    );
  }

  await first.reset();
  assert(
    JSON.stringify(await first.services.mail.inspect({})) ===
      '{"byte":0,"events":[]}',
  );
});
