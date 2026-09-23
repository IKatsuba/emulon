/// <reference lib="esnext.disposable" preserve="true" />

import { deliveryWorker, recoverAttempts } from '../deliveries/worker.ts';
import { cloneState } from '../state/clone.ts';
import type { Coordinator } from '../runtime/sqlite-state.ts';
import type { Store } from '../state/store.ts';
import { dispatchingStore } from '../deliveries/queue.ts';
import {
  checkVersion,
  memoryAdapter,
  type StateAdapter,
  type StateHandle,
} from '../state/store.ts';

import { eventFilter, eventHub, type Events } from '../events/stream.ts';
import { readRegistration } from '../plugins/define.ts';
import { httpContext } from '../plugins/http.ts';
import type { PluginInstance } from '../plugins/types.ts';
import { type Configuration, validateConfig } from './load.ts';

import {
  bindRegistry,
  commandEntries,
  CommandError,
  Registry,
  type Services,
} from '../commands/registry.ts';

export interface Environment<Config extends Configuration> {
  readonly events: Events;
  readonly services: Services<Config>;
  readonly endpoints: {
    readonly [Name in keyof Config['services']]: Readonly<
      Record<string, string>
    >;
  };
  reset(): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function start<const Config extends Configuration>(
  config: Config,
): Promise<Environment<Config>> {
  return startWithAdapter(config, memoryAdapter());
}

export async function startWithAdapter<const Config extends Configuration>(
  config: Config,
  adapter: StateAdapter,
  environmentId: string = crypto.randomUUID(),
  coordinator?: Coordinator,
): Promise<Environment<Config>> {
  validateConfig(config);

  const hub = eventHub();
  const owned: {
    host: ReturnType<typeof httpContext>;
    instance?: PluginInstance;
    state?: StateHandle;
    worker?: ReturnType<typeof deliveryWorker>;
  }[] = [];
  const endpoints = Object.create(null) as {
    readonly [Name in keyof Config['services']]: Readonly<
      Record<string, string>
    >;
  };
  const services = Object.create(null) as Services<Config>;
  const registry = new Registry();
  // Validate every declaration before any plugin can allocate resources.
  const declarations = new Map(
    Object.entries(config.services).map(([name, registration]) =>
      [
        name,
        commandEntries(readRegistration(registration).definition.commands),
      ] as const
    ),
  );

  try {
    coordinator?.prepare(
      Object.entries(config.services).map(([instanceId, registration]) => {
        const { definition } = readRegistration(registration);

        return {
          instanceId,
          plugin: definition.name,
          version: {
            pluginVersion: definition.state?.pluginVersion ?? '0',
            schemaVersion: definition.state?.schemaVersion ?? 1,
          },
        };
      }),
    );
  } catch (error) {
    throw new CommandError('STATE_INCOMPATIBLE', (error as Error).message);
  }

  const fixtures = new Map(
    Object.entries(config.services).map(([name, registration]) => {
      const { definition, options } = readRegistration(registration);

      try {
        return [
          name,
          cloneState(definition.state?.fixtures?.(options) ?? []),
        ] as const;
      } catch {
        throw new CommandError(
          'ENVIRONMENT_FAILED',
          `Service instance "${name}" fixtures failed.`,
        );
      }
    }),
  );
  let stopping: Promise<void> | undefined;

  function dispose() {
    return stopping ??= (async () => {
      const drained = registry.close();
      const providersStopped = Promise.allSettled(
        [...owned].reverse().map((entry) => entry.host.stop()),
      );

      hub.close();

      const errors: Error[] = [];

      for (const entry of owned) {
        try {
          await entry.worker?.pause();
        } catch {
          errors.push(new Error('Delivery worker shutdown failed'));
        }
      }

      for (const entry of owned) {
        entry.state?.close();
      }

      await drained;

      for (const result of await providersStopped) {
        if (result.status === 'rejected') {
          errors.push(new Error('Listener shutdown failed'));
        }
      }

      for (const entry of [...owned].reverse()) {
        try {
          await entry.instance?.stop();
        } catch {
          errors.push(new Error('Plugin shutdown failed'));
        }
      }

      if (errors.length) {
        throw new AggregateError(errors, 'Environment shutdown failed');
      }
    })();
  }

  for (const [name, registration] of Object.entries(config.services)) {
    const entry: typeof owned[number] = { host: httpContext() };

    owned.push(entry);

    let versionError: Error | undefined;

    try {
      const { definition, options } = readRegistration(registration);
      const version = {
        pluginVersion: definition.state?.pluginVersion ?? '0',
        schemaVersion: definition.state?.schemaVersion ?? 1,
      };

      entry.state = await adapter.open({
        environmentId,
        onEvent: hub.publish,
        instanceId: name,
        version,
        fixtures: fixtures.get(name)!,
      });

      try {
        checkVersion(version, entry.state.version);
      } catch (error) {
        versionError = error as Error;

        throw error;
      }

      let store = definition.subscriptions
        ? dispatchingStore(entry.state.store, definition.subscriptions)
        : entry.state.store;

      await store.transaction(() => Promise.resolve());

      if (definition.transport) {
        await recoverAttempts(entry.state.store);

        const base = store;
        const worker = entry.worker = deliveryWorker(
          entry.state.store,
          definition.transport,
        );
        const wrap = (source: Store): Store => ({
          get generation() {
            return source.generation;
          },
          scope: () => wrap(source.scope()),
          subscribe: (listener) => source.subscribe(listener),
          async transaction(work) {
            let changed = false;
            const result = await source.transaction((tx) =>
              work({
                ...tx,
                async put(entity) {
                  changed = true;

                  await tx.put(entity);
                },
                async delete(collection, id) {
                  changed = true;

                  await tx.delete(collection, id);
                },
                async record(event) {
                  changed = true;

                  return await tx.record(event);
                },
              })
            );

            // Observation must not wait behind an unrelated receiver's I/O.
            if (changed) {
              await worker.flush();
            }

            return result;
          },
        });

        store = wrap(base);

        await worker.flush();
      }

      const context = Object.freeze({
        ...entry.host.context,
        clock: Object.freeze({ now: () => Date.now() }),
        store,
      });

      entry.instance = await definition.setup(context, options);

      await entry.instance.ready();
      Object.defineProperty(endpoints, name, {
        value: Object.freeze({ ...entry.instance.endpoints }),
        enumerable: true,
      });
      registry.instances.set(name, {
        commands: declarations.get(name)!,
        context,
      });
      Object.defineProperty(services, name, {
        value: registry.client(name),
        enumerable: true,
      });
    } catch {
      // Plugin errors can contain credentials, so do not expose their text/cause.
      let rollbackFailed = false;

      try {
        await dispose();
      } catch {
        rollbackFailed = true;
      }

      if (versionError) {
        throw versionError;
      }

      throw new CommandError(
        'ENVIRONMENT_FAILED',
        `Service instance "${name}" failed to start.${
          rollbackFailed ? ' Rollback failed.' : ''
        }`,
      );
    }
  }

  function checkEvents(generation = registry.generation) {
    if (stopping) {
      throw new CommandError('ENVIRONMENT_CLOSED', 'Environment is disposed.');
    }

    if (registry.paused || generation !== registry.generation) {
      throw new CommandError(
        'ENVIRONMENT_RESETTING',
        'Environment reset interrupted event observation.',
      );
    }
  }

  const environment = Object.freeze({
    events: {
      async list(input = {}) {
        const filter = eventFilter.parse(input);
        const generation = registry.generation;

        checkEvents(generation);

        const records = (await Promise.all(owned.map((entry) =>
          entry.state!.store.transaction((tx) =>
            tx.outbox()
          )
        )).catch((error) => {
          checkEvents(generation);

          throw error;
        })).flat();

        checkEvents(generation);

        return records.filter((event) =>
          !filter.type || event.type === filter.type
        );
      },
      async follow(input = {}) {
        checkEvents();

        return await hub.follow(input);
      },
    } satisfies Events,
    services: Object.freeze(services),
    endpoints: Object.freeze(endpoints),
    async reset() {
      if (stopping) {
        throw new Error('Environment is disposed.');
      }

      if (registry.paused) {
        throw new Error('Environment reset is in progress.');
      }

      registry.paused = true;

      registry.generation++;
      hub.interrupt(
        new CommandError(
          'ENVIRONMENT_RESETTING',
          'Environment reset interrupted event observation.',
        ),
      );

      try {
        await Promise.all([
          registry.drain(),
          ...owned.map((entry) =>
            entry.host.pause()
          ),
        ]);
        await Promise.all(owned.map((entry) => entry.worker?.pause()));

        if (stopping) {
          throw new Error('Environment is disposed.');
        }

        if (coordinator) {
          await coordinator.resetAll();
        } else {
          await Promise.all(owned.map((entry) => entry.state!.reset()));
        }
      } catch (error) {
        if (coordinator) {
          await dispose();
        }

        throw error;
      } finally {
        if (!stopping) {
          for (const entry of owned) {
            entry.worker?.resume();
            entry.host.resume();
          }

          registry.paused = false;
        }
      }
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  });

  bindRegistry(environment, registry);

  return environment;
}
