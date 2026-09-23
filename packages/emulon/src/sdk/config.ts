import {
  isRegistration,
  readRegistration,
  type Registration,
} from '../plugins/define.ts';
import { isRecord } from '../plugins/validation.ts';

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
  const Config extends { services: Record<string, Registration> },
>(
  config: Config,
): Config {
  if (!isRecord(config) || !isRecord(config.services)) {
    throw new TypeError('Configuration.services must be an object.');
  }

  for (const [name, service] of Object.entries(config.services)) {
    if (reservedNames.has(name)) {
      throw new TypeError(
        `Service instance name "${name}" is reserved for a core command.`,
      );
    }

    if (!isRegistration(service)) {
      throw new TypeError(
        'Each service must be created by a definePlugin factory.',
      );
    }

    readRegistration(service);
  }

  return config;
}
