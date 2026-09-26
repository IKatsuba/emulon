import { defineConfig, Emulon } from 'emulon';
import resend from '@emulon/resend';
import { runCLI } from '../src/cli/run.ts';
import { runProjectCLI } from '../src/cli/project.ts';
import { ConfigError } from '../src/sdk/load.ts';

function assert(value: unknown): asserts value {
  if (!value) {
    throw new Error('Assertion failed');
  }
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof ConfigError && error.code === code);
    assert(!error.message.includes('secret-marker'));

    return;
  }

  throw new Error(`Expected ${code}`);
}

Deno.test('CLI init loads through SDK and never replaces existing config', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'emulon space # ' });
  const path = `${directory}/emulon.config.ts`;

  try {
    await expectCode(() => Emulon.load(directory), 'CONFIG_NOT_FOUND');

    const result = await runCLI(['init', '--json'], directory);

    assert(result.code === 0);
    assert(JSON.parse(result.stdout).created === 'emulon.config.ts');

    const source = await Deno.readTextFile(path);

    assert(source.includes('import { defineConfig } from "emulon"'));
    assert(Object.keys((await Emulon.load(directory)).services).length === 0);

    const duplicate = await runCLI(['--json', 'init'], directory);

    assert(duplicate.code === 1);
    assert(JSON.parse(duplicate.stderr).error.code === 'CONFIG_EXISTS');
    assert(await Deno.readTextFile(path) === source);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('generated config with mail loads without starting the plugin', async () => {
  const directory = await Deno.makeTempDir();

  try {
    await runCLI(['init'], directory);

    const path = `${directory}/emulon.config.ts`;
    const source = await Deno.readTextFile(path);

    await Deno.writeTextFile(
      path,
      'import resend from "@emulon/resend";\n' +
        source.replace('services: {}', 'services: { mail: resend() }'),
    );
    assert('mail' in (await Emulon.load(directory)).services);

    const config = defineConfig({ services: { mail: resend() } });
    const descriptor = await Emulon.load(config);
    const mail: typeof config.services.mail = descriptor.services.mail;

    assert(mail === config.services.mail);
    // @ts-expect-error The descriptor preserves literal instance names.
    descriptor.services.missing;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('loader reports stable safe errors for import and shape failures', async () => {
  for (
    const [source, code] of [
      ['throw new Error("secret-marker")', 'CONFIG_IMPORT_FAILED'],
      [
        'throw Object.assign(new Error("secret-marker"), { code: "CONFIG_INVALID" })',
        'CONFIG_IMPORT_FAILED',
      ],
      [
        'import { DomainError } from "emulon";\n' +
        'throw new DomainError("NotPermitted", "secret-marker");',
        'CONFIG_IMPORT_FAILED',
      ],
      [
        'export default { services: { mail: "secret-marker" } }',
        'CONFIG_INVALID',
      ],
      ['export const config = {}', 'CONFIG_INVALID'],
      ['export default { services: [] }', 'CONFIG_INVALID'],
    ]
  ) {
    const directory = await Deno.makeTempDir();

    try {
      await Deno.writeTextFile(`${directory}/emulon.config.ts`, source!);
      await expectCode(() => Emulon.load(directory), code!);

      const up = await runProjectCLI(['up', '--json'], undefined, directory);
      const error = JSON.parse(up.stderr).error;

      assert(up.code === 1 && error.code === code);
      assert(!up.stderr.includes('secret-marker'));
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test('loader shows a plugin configuration verdict from any emulon copy', async () => {
  const text = 'Invalid option: expected a port.';
  // A separate copy of emulon brands its DomainError with the same registry
  // symbol but a different class.
  const foreign = 'class DomainError extends Error {\n' +
    '  constructor(code, message) {\n' +
    '    super(message);\n' +
    '    this.code = code;\n' +
    '    this[Symbol.for("emulon.DomainError")] = true;\n' +
    '  }\n' +
    '}\n';

  for (
    const source of [
      `import { DomainError } from "emulon";\n` +
      `throw new DomainError("CONFIG_INVALID", "${text}");`,
      `${foreign}throw new DomainError("CONFIG_INVALID", "${text}");`,
    ]
  ) {
    const directory = await Deno.makeTempDir();

    try {
      await Deno.writeTextFile(`${directory}/emulon.config.ts`, source);

      try {
        await Emulon.load(directory);

        throw new Error('Expected CONFIG_INVALID');
      } catch (error) {
        assert(error instanceof ConfigError);
        assert(error.code === 'CONFIG_INVALID' && error.message === text);
      }

      const up = await runProjectCLI(['up', '--json'], undefined, directory);

      assert(up.code === 1);

      const error = JSON.parse(up.stderr).error;

      assert(error.code === 'CONFIG_INVALID' && error.message === text);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test('CLI help, version and invalid arguments have structured output', async () => {
  assert((await runCLI(['--help'])).stdout.includes('init'));
  assert(
    JSON.parse((await runCLI(['--version', '--json'])).stdout).version ===
      JSON.parse(
        await Deno.readTextFile(new URL('../deno.json', import.meta.url)),
      ).version,
  );
  assert(
    JSON.parse((await runCLI(['--json', '--help'])).stdout).commands.includes(
      'init',
    ),
  );

  for (const args of [['unknown'], ['init', 'extra'], ['--version', 'init']]) {
    const result = await runCLI([...args, '--json']);

    assert(result.code !== 0);
    assert(JSON.parse(result.stderr).error.code === 'CLI_INVALID_ARGUMENTS');
  }
});
