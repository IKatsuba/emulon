import resend from '@emulon/resend';
import { defineConfig, definePlugin, type PluginInstance } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import metadata from '../deno.json' with { type: 'json' };
import core from '../../emulon/deno.json' with { type: 'json' };

function assert(value: boolean, message = 'Assertion failed'): void {
  if (!value) {
    throw new Error(message);
  }
}

function rejectsVersion(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    assert(error instanceof TypeError);
    assert(
      (error as Error).message ===
        'Plugin contract mismatch: required apiVersion 1, actual 2.',
    );

    return;
  }

  throw new Error('Expected a plugin contract mismatch');
}

Deno.test('Resend imports as a separate package and preserves typed configuration', () => {
  const options = {};
  const config = defineConfig({
    services: { mail: resend(), other: resend(options) },
  });
  const first = readRegistration(config.services.mail);
  const second = readRegistration(config.services.other);
  const typedOptions: Parameters<typeof resend>[0] = first.options;

  assert(typedOptions === undefined);
  assert(second.options === options);
  assert(config.services.mail !== config.services.other);
  assert(first.definition.name === metadata.name);
  assert(first.definition.apiVersion === metadata.emulon.apiVersion);
  assert(
    JSON.stringify(first.definition.capabilities) ===
      JSON.stringify(metadata.emulon.capabilities),
  );
  assert(metadata.peerDependencies.emulon === `^${core.version}`);

  // deno-lint-ignore no-constant-condition
  if (false) {
    // @ts-expect-error Provider keys must be explicitly issued through control commands.
    resend({ apiKey: 'unsupported' });
    // @ts-expect-error Configuration retains concrete service names.
    config.services.missing;
  }
});

Deno.test('unknown plugin contracts fail before setup at definition and configuration loading', () => {
  let setups = 0;
  const definition = {
    ...readRegistration(resend()).definition,
    apiVersion: 2,
    setup(): Promise<PluginInstance> {
      setups++;

      throw new Error('Incompatible setup must never run');
    },
  };

  rejectsVersion(() => definePlugin(definition));

  definition.apiVersion = 1;

  const registration = definePlugin(definition)();

  definition.apiVersion = 2;

  rejectsVersion(() => defineConfig({ services: { mail: registration } }));
  rejectsVersion(() => readRegistration(registration));
  assert(setups === 0);
});
