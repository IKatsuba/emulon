import {
  bindRegistry,
  commandEntries,
  CommandError,
  jsonValue,
  Registry,
  type Services,
} from '../commands/registry.ts';
import { readRegistration } from '../plugins/define.ts';
import { remoteEvents } from '../events/client.ts';
import { discover, request } from '../control/client.ts';
import type { Target } from '../control/protocol.ts';
import { type Configuration, loadConfig, validateConfig } from './load.ts';
import type { Environment } from './start.ts';

export function connect<const Config extends Configuration>(
  options: Target & { config: Config },
): Promise<Environment<Config>>;
export function connect(options?: Target): Promise<Environment<Configuration>>;

export async function connect(
  options: Target & { config?: Configuration } = {},
): Promise<Environment<Configuration>> {
  const config = options.config
    ? validateConfig(options.config)
    : await loadConfig(options.directory);
  const { record, identity } = await discover(options);
  const registry = new Registry();
  let closed = false;
  const controller = new AbortController();
  const call = (path: string, input: unknown) => {
    if (closed) {
      throw new CommandError('ENVIRONMENT_CLOSED', 'Client is disconnected.');
    }

    return request(record, path, input, controller.signal);
  };

  registry.invoke = async (input) => {
    let encoded;

    try {
      encoded = jsonValue(input);
    } catch {
      throw new CommandError('VALIDATION_ERROR', 'Command validation failed.', [
        { path: [], code: 'invalid_json' },
      ]);
    }

    return await call('/command', encoded);
  };

  const services = Object.create(null);

  for (const [name, registration] of Object.entries(config.services)) {
    registry.instances.set(name, {
      commands: commandEntries(
        readRegistration(registration).definition.commands,
      ),
    });

    services[name] = registry.client(name);
  }

  const dispose = () => {
    closed = true;

    controller.abort();

    return Promise.resolve();
  };

  const environment: Environment<Configuration> = Object.freeze({
    events: remoteEvents(record, controller.signal),
    services: Object.freeze(services) as Services<Configuration>,
    endpoints: Object.freeze(identity.endpoints) as Environment<
      Configuration
    >['endpoints'],
    async reset() {
      await call('/reset', {});
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  });

  bindRegistry(environment, registry);

  return environment;
}
