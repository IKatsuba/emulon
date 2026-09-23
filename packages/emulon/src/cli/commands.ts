import { flagEncoding, metadata } from '../commands/define.ts';
import { CommandError, type Registry } from '../commands/registry.ts';

export function selectCommand(args: readonly string[], registry: Registry) {
  const rest = args.filter((arg) => arg !== '--json');
  const instance = rest.shift()!;
  const entry = registry.instance(instance);
  const flagIndex = rest.findIndex((arg) => arg.startsWith('--'));
  const path = rest.slice(0, flagIndex === -1 ? rest.length : flagIndex);
  const flags = rest.slice(path.length);
  const found = [...entry.commands].find(([, command]) =>
    command.cli.path.join(' ') ===
      path.slice(0, command.cli.path.length).join(' ') &&
    (path.length ===
        command.cli.path.length + (command.cli.positional ? 1 : 0) ||
      (flags.includes('--help') && path.length === command.cli.path.length))
  );
  const help = flags.length === 1 && flags[0] === '--help';

  if (!found && !(help && !path.length)) {
    throw new CommandError(
      'UNKNOWN_COMMAND',
      'Unknown command.',
      [],
      [...entry.commands.keys()].sort(),
    );
  }

  return { instance, entry, path, flags, found, help };
}

export async function runCommand(args: readonly string[], registry: Registry) {
  const json = args.includes('--json');

  try {
    const { instance, entry, path, flags, found, help } = selectCommand(
      args,
      registry,
    );

    if (help) {
      const commands = [...entry.commands].filter(([name]) =>
        !found || name === found[0]
      ).map(([name, command]) => ({
        name,
        description: command.description,
        path: command.cli.path,
        flags: command.cli.flags,
        positional: command.cli.positional,
        input: metadata(command),
      }));

      return {
        code: 0,
        stdout: json
          ? JSON.stringify({ instance, commands })
          : commands.map((c) =>
            `emulon ${instance} ${c.path.join(' ')}${
              c.positional ? ' <' + c.positional + '>' : ''
            } — ${c.description}\n${
              Object.entries(c.flags).map(([flag, field]) =>
                `  --${flag} <${field}>`
              ).join('\n')
            }`
          ).join('\n') +
            '\n  --help  Show help\n  --json  Print structured output',
        stderr: '',
      };
    }

    if (!found) {
      throw new CommandError(
        'UNKNOWN_COMMAND',
        'Unknown command.',
        [],
        [...entry.commands.keys()].sort(),
      );
    }

    const [name, command] = found;
    const schema = metadata(command);
    const input: Record<string, unknown> = Object.create(null);

    if (command.cli.positional) {
      input[command.cli.positional] = path.at(-1);
    }

    for (let index = 0; index < flags.length; index++) {
      const token = flags[index]!;
      const equal = token.indexOf('=');
      const flag = token.slice(2, equal === -1 ? undefined : equal);
      const field = Object.hasOwn(command.cli.flags, flag)
        ? command.cli.flags[flag]
        : undefined;

      if (!token.startsWith('--') || !field || Object.hasOwn(input, field)) {
        throw new CommandError(
          'CLI_INVALID_ARGUMENTS',
          'Unknown or repeated flag.',
        );
      }

      const encoding = flagEncoding(schema.properties![field]!);
      let value = equal === -1 ? undefined : token.slice(equal + 1);

      if (
        value === undefined && flags[index + 1] !== undefined &&
        !flags[index + 1]!.startsWith('--')
      ) {
        value = flags[++index];
      }

      if (value === undefined && encoding === 'boolean') {
        input[field] = true;

        continue;
      }

      if (value === undefined) {
        throw new CommandError(
          'CLI_INVALID_ARGUMENTS',
          'Flag requires a value.',
        );
      }

      // Strings stay strings; other JSON types use their explicit wire form.
      if (encoding === 'string') {
        input[field] = value;
      } else {
        try {
          input[field] = JSON.parse(value);
        } catch {
          input[field] = value;
        }
      }
    }

    const result = await registry.invoke({ instance, command: name, input });

    return {
      code: 0,
      stdout: JSON.stringify(result, null, json ? undefined : 2),
      stderr: '',
    };
  } catch (error) {
    const failure = error instanceof CommandError
      ? error
      : new CommandError('COMMAND_FAILED', 'Command execution failed.');

    return {
      code: 1,
      stdout: '',
      stderr: json
        ? JSON.stringify({ error: failure.toJSON() })
        : `${failure.code}: ${failure.message}${
          failure.available.length
            ? ` Available: ${failure.available.join(', ')}`
            : ''
        }${
          failure.fields.length
            ? ` Fields: ${JSON.stringify(failure.fields)}`
            : ''
        }`,
    };
  }
}
