import { environmentRegistry } from '../commands/registry.ts';
import { runCommand } from './commands.ts';
import { configURL, createConfig } from '../runtime/project.ts';

export const initialConfig = `import { defineConfig } from "emulon";

export default defineConfig({
  services: {},
});
`;

const version = '0.1.2';
const help =
  'Usage: emulon [--json] [--environment <name>] <command>\n\nCommands:\n  init       Create emulon.config.ts\n  add <name>... Install and configure plugins\n  up         Start a foreground environment\n  status     Show running service addresses\n  down       Stop the selected environment\n  events     List events (--type <type>, --follow)\n  reset      Restore fixtures and invalidate generated credentials\n\nOptions:\n  --help     Show help\n  --version  Show version\n  --json     Print structured output';

export function parseArguments(args: readonly string[]): {
  command: 'help' | 'version' | 'init' | 'invalid';
  json: boolean;
} {
  const rest = args.filter((arg) => arg !== '--json');
  const command = rest.length === 0
    ? 'help'
    : rest.length !== 1
    ? 'invalid'
    : rest[0] === '--help'
    ? 'help'
    : rest[0] === '--version'
    ? 'version'
    : rest[0] === 'init'
    ? 'init'
    : 'invalid';

  return { command, json: args.includes('--json') };
}

export async function runCLI(
  args: readonly string[],
  directory?: string,
  environment?: object,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (environment && args.some((arg) => !arg.startsWith('--'))) {
    return await runCommand(args, environmentRegistry(environment));
  }

  const { command, json } = parseArguments(args);
  const failure = (code: string, message: string) => ({
    code: 1,
    stdout: '',
    stderr: json
      ? JSON.stringify({ error: { code, message } })
      : `${code}: ${message}`,
  });

  if (command === 'invalid') {
    return failure(
      'CLI_INVALID_ARGUMENTS',
      'Unknown command or arguments. Use --help.',
    );
  }

  if (command === 'help') {
    return {
      code: 0,
      stdout: json
        ? JSON.stringify({
          commands: ['init', 'add', 'up', 'status', 'down', 'reset', 'events'],
          options: ['--help', '--version', '--json', '--environment'],
        })
        : help,
      stderr: '',
    };
  }

  if (command === 'version') {
    return {
      code: 0,
      stdout: json ? JSON.stringify({ version }) : version,
      stderr: '',
    };
  }

  try {
    await createConfig(configURL(directory), initialConfig);

    return {
      code: 0,
      stdout: json
        ? JSON.stringify({ created: 'emulon.config.ts' })
        : 'Created emulon.config.ts',
      stderr: '',
    };
  } catch (error) {
    return (error as { code?: string }).code === 'EEXIST'
      ? failure('CONFIG_EXISTS', 'emulon.config.ts already exists.')
      : failure('CONFIG_WRITE_FAILED', 'Cannot create emulon.config.ts.');
  }
}
