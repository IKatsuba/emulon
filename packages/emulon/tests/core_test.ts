import { memoryAdapter } from '../src/state/store.ts';
import { defineConfig, definePlugin, type PluginDefinition } from 'emulon';
import { readRegistration } from '../src/plugins/define.ts';
import plugin, { setups } from './fixtures/plugin.ts';

function assert(value: boolean, message = 'Assertion failed'): void {
  if (!value) {
    throw new Error(message);
  }
}

function rejects(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    assert(error instanceof TypeError && error.message.includes(message));

    return;
  }

  throw new Error(`Expected TypeError containing: ${message}`);
}

Deno.test('configuration preserves identity and factories defer setup', async () => {
  const options = { sender: 'local@example.test' };
  const first = plugin(options);
  const second = plugin();
  const config = { services: { mail: first, other: second } };

  assert(defineConfig(config) === config);
  assert(setups.length === 0);
  assert(first !== second);

  const captured = readRegistration(first);

  assert(captured.options === options);
  assert(readRegistration(second).options === undefined);

  const sender: string | undefined = captured.options?.sender;
  const description: string = captured.definition.commands.send.description;

  assert(sender === options.sender && description === 'Send a message');

  const state = await memoryAdapter().open({
    environmentId: 'test',
    instanceId: 'mail',
    version: { pluginVersion: '0', schemaVersion: 1 },
    fixtures: [],
  });
  const instance = await captured.definition.setup({
    store: state.store,
    clock: { now: () => Date.now() },
    http: {
      surface: () => {
        throw new Error('Unexpected surface');
      },
      listen: () => Promise.reject(new Error('Unexpected listener')),
    },
  }, captured.options);

  assert(setups.length === 1 && setups[0] === options);
  await instance.ready();
  await instance.stop();
});

Deno.test('all documented core command names are reserved', () => {
  for (
    const name of ['init', 'add', 'up', 'events', 'clock', 'reset', 'exec']
  ) {
    rejects(
      () => defineConfig({ services: { [name]: plugin() } }),
      `"${name}" is reserved`,
    );
  }

  defineConfig({
    services: { mail: plugin(), github: plugin(), db: plugin() },
  });
  defineConfig({ services: {} });
  defineConfig({ services: { constructor: plugin(), toString: plugin() } });
});

Deno.test('invalid definition fields produce actionable errors without setup', () => {
  const definition = readRegistration(plugin()).definition;
  const invalid: [unknown, string][] = [
    [null, 'definition must be an object'],
    [[], 'definition must be an object'],
    [{ ...definition, name: ' ' }, 'definition.name'],
    [{ ...definition, apiVersion: 0 }, 'definition.apiVersion'],
    [{ ...definition, apiVersion: 1.5 }, 'definition.apiVersion'],
    [{ ...definition, apiVersion: '1' }, 'definition.apiVersion'],
    [{ ...definition, capabilities: ['unknown'] }, 'definition.capabilities'],
    [{ ...definition, capabilities: Array(1) }, 'definition.capabilities'],
    [{ ...definition, capabilities: null }, 'definition.capabilities'],
    [{ ...definition, commands: [] }, 'definition.commands'],
    [{ ...definition, commands: null }, 'definition.commands'],
    [{ ...definition, setup: null }, 'definition.setup'],
    ...[
      null,
      {},
      { pluginVersion: '1', schemaVersion: 0 },
      { pluginVersion: '1', schemaVersion: 1.5 },
      { pluginVersion: '', schemaVersion: 1 },
      { pluginVersion: '1', schemaVersion: 1, fixtures: [] },
    ].map((
      state,
    ): [unknown, string] => [
      { ...definition, state },
      'Plugin state requires',
    ]),
  ];

  for (const [value, message] of invalid) {
    rejects(
      () =>
        definePlugin(value as PluginDefinition<void, Record<string, never>>),
      message,
    );
  }
});

Deno.test('invalid configuration shape fails clearly', () => {
  // @ts-expect-error JavaScript callers can pass a missing services record.
  rejects(() => defineConfig({}), 'Configuration.services');
  // @ts-expect-error JavaScript callers can pass null.
  rejects(() => defineConfig(null), 'Configuration.services');
  rejects(
    // @ts-expect-error Raw objects are not plugin registrations.
    () => defineConfig({ services: { mail: {} } }),
    'definePlugin factory',
  );
});

Deno.test('option and command types survive factory and config inference', () => {
  const required = definePlugin({
    name: 'required',
    apiVersion: 1,
    capabilities: [],
    commands: readRegistration(plugin()).definition.commands,
    setup(_ctx, _options: { count: number }) {
      return Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      });
    },
  });
  const config = defineConfig({ services: { mail: required({ count: 3 }) } });
  const registration = readRegistration(config.services.mail);
  const count: number = registration.options.count;
  const command: string = registration.definition.commands.send.description;

  assert(count === 3 && command === 'Send a message');

  // Invalid calls are checked by TypeScript but must never execute.
  // deno-lint-ignore no-constant-condition
  if (false) {
    // @ts-expect-error Required options cannot be omitted.
    required();
    // @ts-expect-error Option fields preserve their types.
    required({ count: 'three' });
    // @ts-expect-error Instance names remain concrete.
    config.services.missing;
    // @ts-expect-error Definition shape is checked at compile time too.
    definePlugin({ name: 'incomplete' });
  }
});
