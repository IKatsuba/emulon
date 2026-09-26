import { readRegistration } from '../plugins/define.ts';
import { isRecord } from '../plugins/validation.ts';
import { readInstances, type ServiceEntry } from './instances.ts';

// Keep this list aligned with the root commands described in docs/design.md.
const reservedNames = new Set([
  'init',
  'add',
  'up',
  'events',
  'clock',
  'reset',
  'exec',
]);

export function defineConfig<
  const Config extends { services: Record<string, ServiceEntry> },
>(
  config: Config,
): Config {
  if (!isRecord(config) || !isRecord(config.services)) {
    throw new TypeError('Configuration.services must be an object.');
  }

  for (const name of Object.keys(config.services)) {
    if (reservedNames.has(name)) {
      throw new TypeError(
        `Service instance name "${name}" is reserved for a core command.`,
      );
    }
  }

  for (const [, instance] of readInstances(config.services)) {
    readRegistration(instance.registration);
  }

  return config;
}
