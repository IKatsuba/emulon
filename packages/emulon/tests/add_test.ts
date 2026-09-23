// deno-lint-ignore-file require-await
import { addIO } from '../src/runtime/add.ts';
import { addPlugins } from '../src/cli/add.ts';
import {
  editConfig,
  installArguments,
  packageManager,
  validateMetadata,
} from '../src/cli/add-rules.ts';
import { initialConfig } from '../src/cli/run.ts';
import { resolvePluginName } from '../src/plugins/resolve.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function rejects(action: () => unknown) {
  try {
    action();
  } catch {
    return;
  }

  throw new Error('Expected rejection');
}

Deno.test('generated config stays formatted after initial and incremental additions', async () => {
  let source = initialConfig;

  for (
    const packages of [['@emulon/github'], [
      '@emulon/resend',
      '@team/with-dash',
    ]]
  ) {
    source = editConfig(source, packages).source;

    const child = new Deno.Command('deno', {
      args: ['fmt', '--no-config', '--ext=ts', '-'],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const writer = child.stdin.getWriter();

    await writer.write(new TextEncoder().encode(source));
    await writer.close();

    const result = await child.output();

    assert(result.success, new TextDecoder().decode(result.stderr));
    assert(new TextDecoder().decode(result.stdout) === source, source);
  }
});

Deno.test('add selects one project manager and builds literal process arguments', () => {
  for (
    const [lock, manager] of [
      ['package-lock.json', 'npm'],
      ['npm-shrinkwrap.json', 'npm'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
      ['deno.lock', 'deno'],
    ] as const
  ) {
    assert(packageManager([lock, 'package.json']) === manager);
    assert(
      installArguments(manager, ['@emulon/github@1.0.0']).at(-1) ===
        (manager === 'deno' ? 'npm:' : '') + '@emulon/github@1.0.0',
    );
  }

  assert(installArguments('pnpm', ['@emulon/github'])[1] === '--save-dev');
  assert(packageManager([]) === 'npm');
  assert(packageManager(['deno.jsonc']) === 'deno');
  assert(packageManager(['package.json', 'deno.json']) === 'npm');
  rejects(() => packageManager(['deno.lock', 'yarn.lock']));
});

Deno.test('add metadata requires the installed identity and supported contract', () => {
  validateMetadata(
    { name: '@emulon/github', emulon: { apiVersion: 1 } },
    '@emulon/github',
  );

  for (
    const value of [null, {}, { name: 'other', emulon: { apiVersion: 1 } }, {
      name: '@emulon/github',
    }, { name: '@emulon/github', emulon: { apiVersion: 2 } }]
  ) {
    rejects(() => validateMetadata(value, '@emulon/github'));
  }
});

Deno.test('add preserves aliases, options and multiple existing instances byte for byte', () => {
  const source = `import { defineConfig as config } from "emulon";
import gh from "@emulon/github";
export default config({ services: {
  // Keep the user's fixture.
  first: gh({ fixtures: { users: [{ login: "igor" }] } }),
  second: gh(),
} });\n`;
  const result = editConfig(source, ['@emulon/github', '@emulon/resend']);

  assert(result.safe && result.additions.length === 1);
  assert(result.source.includes(source.slice(source.indexOf('\n  //'))));
  assert(result.additions[0]!.instance === 'resend');

  const again = editConfig(result.source, ['@emulon/github', '@emulon/resend']);

  assert(
    again.safe && again.source === result.source && !again.additions.length,
  );

  const clean = editConfig(initialConfig, ['@emulon/github', '@emulon/resend']);

  assert(
    clean.safe &&
      clean.additions.map((item) => item.instance).join() ===
        'github,resend',
  );
});

Deno.test('add refuses executable and ambiguous configuration shapes without rewriting', () => {
  for (
    const source of [
      'export default { services: {} };',
      'import { defineConfig } from "emulon"; export default defineConfig({ services: { ...other } });',
      'import { defineConfig } from "emulon"; const services = {}; export default defineConfig({ services });',
      'import { defineConfig } from "emulon"; export default defineConfig({ services: {}, ...other });',
      'import { defineConfig } from "emulon"; export default defineConfig({ services: {}, services: {} });',
      initialConfig + 'console.log("side effect");',
      initialConfig.replace(
        'services: {}',
        'services: { ["dynamic"]: factory() }',
      ),
      'this is not TypeScript {{{',
    ]
  ) {
    const result = editConfig(source, ['@emulon/github']);

    assert(!result.safe && result.source === source);
    assert(result.additions[0]!.import.includes('from "@emulon/github"'));
    assert(result.additions[0]!.service.includes('emulonPlugin()'));
  }
});

Deno.test('add avoids binding and instance collisions including reserved names', () => {
  const result = editConfig(
    initialConfig.replace(
      'import { defineConfig }',
      'import emulonPlugin, { defineConfig }',
    ),
    ['@team/add', '@other/add'],
  );

  assert(result.safe);
  assert(result.additions[0]!.instance === 'addService');
  assert(result.additions[1]!.instance === 'addService2');
  assert(result.additions[0]!.import.startsWith('import emulonPlugin2 '));
});

Deno.test('add generates own services for prototype-like names and remains idempotent', () => {
  const name = resolvePluginName('emulon-plugin-__proto__');
  const existing = `import existing from "@team/existing";
import { defineConfig } from "emulon";
export default defineConfig({ services: { __proto__Service: existing() } });
`;

  for (const source of [initialConfig, existing]) {
    const result = editConfig(source, [name]);
    const instance = source === initialConfig
      ? '__proto__Service'
      : '__proto__Service2';

    assert(result.safe && result.additions[0]!.instance === instance);

    const plugin = { plugin: true };
    const previous = { existing: true };
    const config = new Function(
      'defineConfig',
      'emulonPlugin',
      'existing',
      result.source.replace(/^import .*;\n/gm, '').replace(
        'export default',
        'return',
      ),
    )((value: unknown) => value, () => plugin, () => previous);

    assert(Object.getPrototypeOf(config.services) === Object.prototype);
    assert(Object.hasOwn(config.services, instance));
    assert(config.services[instance] === plugin);
    assert(
      Object.keys(config.services).length ===
        (source === initialConfig ? 1 : 2),
    );

    if (source === existing) {
      assert(config.services.__proto__Service === previous);
    }

    const again = editConfig(result.source, [name]);

    assert(
      again.safe && !again.additions.length && again.source === result.source,
    );
  }

  const unsafe = initialConfig + 'void 0;\n';
  const manual = editConfig(unsafe, [name]);

  assert(!manual.safe && manual.source === unsafe);

  const services = new Function(
    'emulonPlugin',
    `return { ${manual.additions[0]!.service} };`,
  )(() => true);

  assert(Object.getPrototypeOf(services) === Object.prototype);
  assert(Object.hasOwn(services, manual.additions[0]!.instance));
});

Deno.test('add validates every dependency before any config write and preserves install failure', async () => {
  let writes = 0;
  let installed: readonly string[] = [];
  let invalid = true;

  const io = {
    files: async () => ['package-lock.json'],
    source: async () => ({ text: initialConfig, writable: true }),
    install: async (_manager: string, packages: readonly string[]) => {
      installed = packages;
    },
    metadata: async (name: string) => ({
      name,
      emulon: { apiVersion: invalid && name.endsWith('resend') ? 2 : 1 },
    }),
    factory: async () => () => {},
    write: async () => {
      writes++;
    },
  };

  try {
    await addPlugins(['github', 'resend'], io);

    throw new Error('Accepted incompatible plugin');
  } catch (error) {
    assert((error as { code?: string }).code === 'PLUGIN_INCOMPATIBLE');
  }

  assert(writes === 0 && installed.join() === '@emulon/github,@emulon/resend');

  invalid = false;

  assert(
    (await addPlugins(['github', 'github'], io)).configuration === 'updated',
  );
  assert(Number(writes) === 1);

  io.source = async () => ({ text: initialConfig, writable: false });

  assert((await addPlugins(['github'], io)).configuration === 'manual');
  assert(Number(writes) === 1);

  io.install = async () => {
    throw new Error('fake install failed');
  };

  try {
    await addPlugins(['github'], io);

    throw new Error('Accepted install failure');
  } catch (error) {
    assert((error as Error).message === 'fake install failed');
  }

  assert(Number(writes) === 1);
});

Deno.test('add recognizes versioned npm imports without duplicating instances', () => {
  const source = 'import { defineConfig } from "npm:emulon@0.1.0";\n' +
    'import github from "npm:@emulon/github@0.1.0";\n' +
    'export default defineConfig({ services: { existing: github() } });\n';
  const result = editConfig(source, ['@emulon/github']);

  assert(result.safe && result.source === source && !result.additions.length);
});

Deno.test('add runtime reads unexported metadata, cleans failed imports and fences changed files', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'emulon-add-test-' });

  try {
    await Deno.writeTextFile(`${directory}/package.json`, '{"type":"module"}');

    const plugin = `${directory}/node_modules/@emulon/test`;

    await Deno.mkdir(plugin, { recursive: true });
    await Deno.writeTextFile(
      `${plugin}/package.json`,
      JSON.stringify({
        name: '@emulon/test',
        type: 'module',
        exports: { '.': { import: './factory.js' } },
        emulon: { apiVersion: 1 },
      }),
    );
    await Deno.writeTextFile(
      `${plugin}/factory.js`,
      "export default () => 'factory';",
    );

    const io = addIO(directory);

    validateMetadata(await io.metadata('@emulon/test'), '@emulon/test');

    try {
      await io.factory('@emulon/missing');

      throw new Error('Loaded a missing factory');
    } catch (error) {
      assert((error as { code?: string }).code === 'PLUGIN_INVALID');
    }

    assert(!(await io.files()).some((name) => name.startsWith('.emulon-add-')));
    await Deno.writeTextFile(`${directory}/emulon.config.ts`, initialConfig);
    assert((await io.source()).writable);

    const changed = initialConfig + '// User edit\n';

    await Deno.writeTextFile(`${directory}/emulon.config.ts`, changed);

    try {
      await io.write(initialConfig, 'replacement');

      throw new Error('Overwrote changed configuration');
    } catch (error) {
      assert((error as { code?: string }).code === 'CONFIG_CHANGED');
    }

    assert(
      await Deno.readTextFile(`${directory}/emulon.config.ts`) === changed,
    );
    await Deno.rename(`${directory}/emulon.config.ts`, `${directory}/real.ts`);
    await Deno.symlink(`${directory}/real.ts`, `${directory}/emulon.config.ts`);
    assert(!(await io.source()).writable);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
