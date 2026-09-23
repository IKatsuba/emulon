import { memoryAdapter, type Transaction } from '../src/state/store.ts';
import { sqliteCoordinator } from '../src/runtime/sqlite-state.ts';

function assert(v: unknown): asserts v {
  if (!v) {
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);

  return { resolve, promise };
}

const version = { pluginVersion: '1', schemaVersion: 1 };

for (const kind of ['memory', 'sqlite']) {
  Deno.test(`${kind}: detached cyclic values, serial callbacks, rollback, observers and lifecycle fencing`, async () => {
    const directory = await Deno.realPath(await Deno.makeTempDir());
    const coordinator = kind === 'sqlite'
      ? sqliteCoordinator(directory + '/state.sqlite')
      : undefined;

    coordinator?.prepare([{ instanceId: 'mail', plugin: 'test', version }]);

    const adapter = coordinator ?? memoryAdapter();
    const fixture = {
      collection: 'c',
      id: 'fixture',
      value: new Uint8Array([7]),
    };
    let escaped!: Transaction;
    const observerFailures: Promise<void>[] = [];
    const state = await adapter.open({
      environmentId: coordinator?.environmentId ?? 'private',
      instanceId: 'mail',
      version,
      fixtures: [fixture],
      onEvent() {
        observerFailures.push(
          rejects(
            () => escaped.put({ collection: 'c', id: 'observer', value: true }),
            'finished',
          ),
        );

        throw new Error('Observer failure');
      },
    });

    try {
      fixture.value[0] = 99;

      const buffer = new ArrayBuffer(16);
      const value = {
        count: 0,
        bytes: new Uint8Array(buffer, 2, 4),
        view: new DataView(buffer, 1, 8),
        cycle: new Map<unknown, unknown>(),
      };

      value.bytes[0] = 42;

      value.cycle.set(value, value);
      await state.store.transaction(async (tx) => {
        escaped = tx;

        await tx.put({ collection: 'c', id: 'value', value });
      });

      value.bytes[0] = 99;

      await rejects(() => escaped.get('c', 'value'), 'finished');
      await Promise.all(
        Array.from({ length: 10 }, () =>
          state.store.transaction(async (tx) => {
            const copy = await tx.get('c', 'value') as typeof value;

            assert(
              copy.bytes[0] === 42 && copy.bytes.buffer === copy.view.buffer &&
                copy.cycle.get(copy) === copy,
            );
            await Promise.resolve();
            copy.count++;
            await tx.put({ collection: 'c', id: 'value', value: copy });
          })),
      );
      await state.store.transaction(async (tx) => {
        assert((await tx.get('c', 'value') as typeof value).count === 10);
      });

      await rejects(() =>
        state.store.transaction(async (tx) => {
          await tx.delete('c', 'value');
          await tx.record({
            type: 'failed',
            origin: 'service',
            occurredAt: 'now',
            payload: value,
          });

          throw new Error('Rollback');
        }), 'Rollback');

      let notifications = 0;

      state.store.subscribe(() => {
        notifications++;

        throw new Error('Observer failure');
      });

      await state.store.transaction(async (tx) => {
        assert(
          (await tx.list('c')).map((x) => x.id).join() === 'fixture,value',
        );
        assert((await tx.outbox()).length === 0);

        escaped = tx;

        await tx.record({
          type: 'committed',
          origin: 'service',
          occurredAt: 'now',
          payload: value,
        });
      });

      assert(notifications === 1);
      await Promise.all(observerFailures);

      for (
        const value of [new SharedArrayBuffer(8), {
          bytes: new Uint8Array(new SharedArrayBuffer(8)),
        }, () => {}]
      ) {
        await rejects(
          () =>
            state.store.transaction((tx) =>
              tx.put({ collection: 'c', id: 'unsupported', value })
            ),
          '',
        );
      }

      for (const close of [false, true]) {
        const entered = deferred();
        const release = deferred();
        const scope = state.store.scope();
        const pending = state.store.transaction(async (tx) => {
          await tx.delete('c', 'fixture');
          entered.resolve();
          await release.promise;
        });

        await entered.promise;

        const queued = state.store.transaction(async () => {});

        const text = close ? 'closed' : 'Stale';
        const failures = [
          rejects(() => pending, text),
          rejects(() => queued, text),
        ];

        if (close) {
          state.close();
        } else {
          await state.reset();
        }

        failures.push(rejects(() => scope.transaction(async () => {}), text));

        if (!close) {
          await state.store.transaction(async (tx) => {
            assert(
              (await tx.list('c')).length === 1 &&
                (await tx.get('c', 'fixture') as Uint8Array)[0] === 7 &&
                (await tx.outbox()).length === 0,
            );
          });
        }

        release.resolve();
        await Promise.all(failures);
      }

      await rejects(() => state.reset(), 'closed');
    } finally {
      state.close();
      coordinator?.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
}
