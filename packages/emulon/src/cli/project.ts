import { remoteEvents } from '../events/client.ts';
import { readDataFile } from '../runtime/project.ts';
import { CommandError } from '../commands/registry.ts';
import { discover, request } from '../control/client.ts';
import {
  addresses,
  environmentName,
  type Target,
} from '../control/protocol.ts';
import { serveEnvironment } from '../control/server.ts';
import { onShutdown } from '../runtime/discovery.ts';
import { ConfigError, type Configuration, loadConfig } from '../sdk/load.ts';
import { runCLI } from './run.ts';

export function selectEnvironment(args: readonly string[]) {
  const rest: string[] = [];
  let environment: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--environment' || arg.startsWith('--environment=')) {
      if (environment !== undefined) {
        throw new CommandError(
          'CLI_INVALID_ARGUMENTS',
          'Repeated environment option.',
        );
      }

      const value = arg === '--environment' ? args[++i] : arg.slice(14);

      if (value === undefined) {
        throw new CommandError(
          'CLI_INVALID_ARGUMENTS',
          'Environment option requires a name.',
        );
      }

      environment = environmentName(value);
    } else {
      rest.push(arg);
    }
  }

  return { args: rest, environment: environmentName(environment) };
}

export async function runProjectCLI(
  input: readonly string[],
  config?: Configuration,
  directory?: string,
  ready: (text: string) => void = console.log,
  subscribed: () => void = () => {},
) {
  try {
    const selected = selectEnvironment(input);
    const args = selected.args;
    const target: Target = {
      environment: selected.environment,
      ...(directory === undefined ? {} : { directory }),
    };
    const first = args.find((arg) => arg !== '--json');

    if (!first || first.startsWith('--') || first === 'init') {
      return await runCLI(args, directory);
    }

    const success = (value: unknown) => ({
      code: 0,
      stdout: JSON.stringify(
        value,
        null,
        args.includes('--json') ? undefined : 2,
      ),
      stderr: '',
    });

    if (first === 'add') {
      const { addPlugins } = await import('./add.ts');
      const { addIO } = await import('../runtime/add.ts');
      const result = await addPlugins(
        args.filter((arg) => arg !== '--json').slice(1),
        addIO(directory),
      );

      if (args.includes('--json')) {
        return success(result);
      }

      return {
        code: 0,
        stderr: '',
        stdout: result.configuration === 'manual'
          ? 'Plugins installed. Add these imports and services entries to emulon.config.ts manually:\n' +
            result.additions.map((entry) => `${entry.import}\n${entry.service}`)
              .join('\n')
          : `Plugins installed; configuration ${result.configuration}.`,
      };
    }

    if (
      ['up', 'status', 'down', 'reset'].includes(first) &&
      args.filter((arg) => arg !== '--json').length !== 1
    ) {
      throw new CommandError('CLI_INVALID_ARGUMENTS', 'Unexpected arguments.');
    }

    if (first === 'up') {
      const host = await serveEnvironment(
        config ?? await loadConfig(directory),
        target,
      );
      const unsubscribe = onShutdown(() => {
        host.dispose().catch(() => {});
      });

      try {
        ready(
          success({
            environment: selected.environment,
            ...host.identity,
            ...(host.restoredInstances.length
              ? {
                notices: [{
                  code: 'STATE_RESTORED',
                  instances: host.restoredInstances,
                  message:
                    `Existing durable state restored; configuration fixtures were not reapplied. To apply this startup configuration, run emulon reset --environment ${selected.environment}. Reset replaces state for all active instances and invalidates generated credentials.`,
                }],
              }
              : {}),
          })
            .stdout,
        );
        await host.finished;
      } finally {
        unsubscribe();
        await host.dispose();
      }

      return { code: 0, stdout: '', stderr: '' };
    }

    const { record, identity } = await discover(target);

    if (first === 'reset') {
      await request(record, '/reset', {});

      return success({ reset: true });
    }

    if (first === 'status') {
      return success({
        environment: selected.environment,
        id: identity.id,
        endpoints: addresses(identity.endpoints),
      });
    }

    if (first === 'down') {
      await request(record, '/down', {});

      return success({ stopping: true });
    }

    if (first === 'events') {
      const filter: { type?: string } = {};
      let follow = false;
      const rest = args.filter((arg) => arg !== '--json').slice(1);

      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--follow' && !follow) {
          follow = true;
        } else if (
          rest[i] === '--type' && filter.type === undefined && rest[i + 1]
        ) {
          filter.type = rest[++i]!;
        } else {
          throw new CommandError(
            'CLI_INVALID_ARGUMENTS',
            'Invalid events arguments.',
          );
        }
      }

      const controller = new AbortController();
      const events = remoteEvents(record, controller.signal);

      if (!follow) {
        return success(await events.list(filter));
      }

      const unsubscribe = onShutdown(() => controller.abort());

      try {
        const stream = await events.follow(filter);

        subscribed();

        for await (const event of stream) {
          ready(JSON.stringify(event));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      } finally {
        unsubscribe();
        controller.abort();
      }

      return { code: 0, stdout: '', stderr: '' };
    }

    const commandArgs = [...args];
    const operation = args.filter((arg) => arg !== '--json').slice(1, 3).join(
      '.',
    );

    if (operation === 'events.publish' || operation === 'webhooks.send') {
      const data = commandArgs.findIndex((arg) =>
        arg === '--data' || arg.startsWith('--data=')
      );
      const inline = data !== -1 && commandArgs[data]!.startsWith('--data=');
      const value = data === -1
        ? undefined
        : inline
        ? commandArgs[data]!.slice(7)
        : commandArgs[data + 1];

      if (value && !value.trimStart().startsWith('{')) {
        try {
          const contents = await readDataFile(value, directory);

          commandArgs[inline ? data : data + 1] = inline
            ? `--data=${contents}`
            : contents;
        } catch {
          throw new CommandError(
            'CLI_INVALID_ARGUMENTS',
            'Cannot read event data file.',
          );
        }
      }
    }

    return await request(record, '/cli', commandArgs) as {
      code: number;
      stdout: string;
      stderr: string;
    };
  } catch (error) {
    const failure = error instanceof CommandError
      ? error
      : error instanceof ConfigError
      ? new CommandError(error.code, error.message)
      : new CommandError('ENVIRONMENT_FAILED', 'Cannot access environment.');

    return {
      code: 1,
      stdout: '',
      stderr: input.includes('--json')
        ? JSON.stringify({ error: failure.toJSON() })
        : `${failure.code}: ${failure.message}`,
    };
  }
}
