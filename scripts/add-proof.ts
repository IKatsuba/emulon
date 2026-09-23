// npm reads its configuration from npm_config_* environment variables.
// deno-lint-ignore-file camelcase
import { withoutTypeStrippingNotice } from './runtime-warnings.ts';

/** Installed CLI acceptance against a loopback registry of the built archives. */
export async function addProof(options: {
  cwd: string;
  env: Record<string, string>;
  runtime: string;
  denoArgs: string[];
  archives: string[];
  combined?: boolean;
  manager?: 'pnpm' | 'yarn' | 'bun' | 'deno';
}) {
  const { runtime, denoArgs, archives } = options;
  const manager = options.manager ?? 'npm';
  const lockfile = {
    npm: 'package-lock.json',
    pnpm: 'pnpm-lock.yaml',
    yarn: 'yarn.lock',
    bun: 'bun.lock',
    deno: 'deno.lock',
  }[manager];
  const services = options.combined
    ? ['stripe', 'calcom']
    : ['github', 'resend'];
  const [first, second] = services as [string, string];
  const cwd = `${options.cwd}/${
    options.combined ? 'stripe-calcom' : `add-${manager}`
  }`;

  await Deno.mkdir(cwd);
  await Deno.writeTextFile(
    `${cwd}/package.json`,
    '{"private":true,"type":"module"}\n',
  );

  const decoder = new TextDecoder();
  const assert = (value: unknown, message: string) => {
    if (!value) {
      throw new Error(`${runtime} add: ${message}`);
    }
  };

  const manifests = new Map<
    string,
    { manifest: Record<string, unknown>; archive: string }
  >();

  for (const service of services) {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        new URL(`../dist/npm/${service}/package.json`, import.meta.url),
      ),
    );

    manifests.set(manifest.name, {
      manifest,
      archive: archives.find((name) => name.startsWith(`emulon-${service}-`))!,
    });
  }

  if (options.manager) {
    for (const archive of archives) {
      const result = await new Deno.Command('tar', {
        args: ['-xOf', `${options.cwd}/../${archive}`, 'package/package.json'],
        stdout: 'piped',
        stderr: 'piped',
      }).output();

      assert(result.success, `cannot read ${archive}`);

      const manifest = JSON.parse(decoder.decode(result.stdout));

      manifests.set(manifest.name, { manifest, archive });
    }
  }

  if (options.manager) {
    const fixture = `${cwd}/invalid-fixture`;

    await Deno.mkdir(`${fixture}/package`, { recursive: true });

    const manifest = {
      name: 'emulon-plugin-invalid',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      emulon: { apiVersion: 999 },
    };

    await Deno.writeTextFile(
      `${fixture}/package/package.json`,
      JSON.stringify(manifest),
    );
    await Deno.writeTextFile(
      `${fixture}/package/index.js`,
      'throw new Error("Invalid metadata must be rejected before import");\n',
    );

    const archive = `emulon-plugin-invalid-${manager}.tgz`;
    // Yarn Classic can stall when this fixture includes a directory header.
    const packed = await new Deno.Command('tar', {
      args: [
        '-czf',
        `${options.cwd}/../${archive}`,
        '-C',
        fixture,
        'package/package.json',
        'package/index.js',
      ],
      stdout: 'piped',
      stderr: 'piped',
    }).output();

    assert(packed.success, 'cannot pack invalid metadata fixture');
    manifests.set(manifest.name, { manifest, archive });
  }

  const integrity = new Map<string, string>();

  for (const entry of manifests.values()) {
    const bytes = await Deno.readFile(`${options.cwd}/../${entry.archive}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));

    integrity.set(
      entry.archive,
      `sha512-${btoa(String.fromCharCode(...hash))}`,
    );
  }

  const tarballs = new Set<string>();
  const registry = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.slice(1));
      const entry = manifests.get(name);

      if (entry) {
        return Response.json({
          name,
          'dist-tags': { latest: entry.manifest.version },
          versions: {
            [String(entry.manifest.version)]: {
              ...entry.manifest,
              dist: {
                tarball: `${url.origin}/archives/${entry.archive}`,
                integrity: integrity.get(entry.archive),
              },
            },
          },
        });
      }

      for (const entry of manifests.values()) {
        if (name === `archives/${entry.archive}`) {
          tarballs.add(String(entry.manifest.name));

          return new Response(
            await Deno.readFile(`${options.cwd}/../${entry.archive}`),
          );
        }
      }

      return new Response('Unknown local package', { status: 404 });
    },
  );
  const env = {
    ...options.env,
    npm_config_registry: `http://127.0.0.1:${registry.addr.port}`,
    npm_config_offline: 'false',
    npm_config_cache: `${cwd}/npm-cache`,
    ...(options.manager
      ? {
        HOME: cwd,
        XDG_CACHE_HOME: `${cwd}/cache`,
        XDG_CONFIG_HOME: `${cwd}/config`,
        XDG_DATA_HOME: `${cwd}/data`,
        DENO_DIR: `${cwd}/deno-cache`,
        npm_config_store_dir: `${cwd}/pnpm-store`,
        npm_config_update_notifier: 'false',
        YARN_CACHE_FOLDER: `${cwd}/yarn-cache`,
        BUN_INSTALL_CACHE_DIR: `${cwd}/bun-cache`,
        NPM_CONFIG_REGISTRY: `http://127.0.0.1:${registry.addr.port}`,
      }
      : {}),
  };
  const run = async (
    label: string,
    command: string,
    args: string[],
    expected = 0,
  ) => {
    const result = await new Deno.Command(command, {
      cwd,
      env,
      clearEnv: true,
      args,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const stdout = decoder.decode(result.stdout).trim();
    const stderr = decoder.decode(result.stderr).trim();

    assert(
      !withoutTypeStrippingNotice(stderr).includes('ExperimentalWarning'),
      `${label}: ${stderr}`,
    );
    assert(result.code === expected, `${label}: ${stdout}\n${stderr}`);
    console.log(`PASS ${runtime}: ${label}${stdout ? ` — ${stdout}` : ''}`);

    return expected === 0 ? stdout : stderr;
  };

  const cli = options.manager
    ? ['node', ['node_modules/emulon/esm/cli/main.js']] as const
    : runtime === 'Node'
    ? ['npx', ['--no-install', 'emulon']] as const
    : [Deno.execPath(), [
      ...denoArgs,
      '--allow-run=npm',
      'npm:emulon',
    ]] as const;
  const command = (label: string, args: string[], expected = 0) =>
    run(label, cli[0], [...cli[1], ...args], expected);

  try {
    if (options.manager) {
      const registryUrl = env.npm_config_registry;

      await Deno.writeTextFile(
        `${cwd}/.npmrc`,
        `registry=${registryUrl}\n@emulon:registry=${registryUrl}\nignore-scripts=true\naudit=false\nfund=false\nupdate-notifier=false\n`,
      );
      await Deno.writeTextFile(
        `${cwd}/.yarnrc`,
        `registry "${registryUrl}"\ndisable-self-update-check true\nignore-scripts true\n`,
      );
      await Deno.writeTextFile(
        `${cwd}/bunfig.toml`,
        `[install]\nregistry = "${registryUrl}"\n`,
      );

      if (manager === 'deno') {
        await Deno.remove(`${cwd}/package.json`);
        await Deno.writeTextFile(
          `${cwd}/deno.json`,
          '{"nodeModulesDir":"auto"}\n',
        );
      }

      await run(`${manager} version`, manager, ['--version']);
      await run(
        `${manager} installs core from local registry`,
        manager,
        manager === 'deno'
          ? ['add', '--node-modules-dir=auto', 'npm:emulon']
          : ['add', manager === 'pnpm' ? '--save-dev' : '--dev', 'emulon'],
      );
    } else {
      await run(
        'add fixture installs core and transitive archives only',
        'npm',
        [
          'install',
          '--offline',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          ...archives.filter((name) =>
            !/^emulon-(github|resend|stripe|calcom)-/.test(name)
          ).map((
            name,
          ) => `../../${name}`),
        ],
      );
    }

    for (const service of services) {
      let exists = false;

      try {
        await Deno.stat(`${cwd}/node_modules/@emulon/${service}`);

        exists = true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      assert(!exists, 'plugin was installed before add');
    }

    await command('add fixture CLI init', ['init', '--json']);

    const lockBefore = await Deno.readTextFile(`${cwd}/${lockfile}`);
    const added = JSON.parse(
      await command(`CLI add ${first} ${second}`, [
        'add',
        first,
        second,
        '--json',
      ]),
    );

    assert(
      added.configuration === 'updated' && added.manager === manager,
      'wrong add result',
    );

    const source = await Deno.readTextFile(`${cwd}/emulon.config.ts`);

    await run('generated config matches deno fmt', Deno.execPath(), [
      'fmt',
      '--check',
      '--no-config',
      'emulon.config.ts',
    ]);

    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${cwd}/${manager === 'deno' ? 'deno.json' : 'package.json'}`,
      ),
    );
    const dependencies = manager === 'deno'
      ? manifest.imports
      : manifest.devDependencies;

    assert(
      dependencies[`@emulon/${first}`] &&
        dependencies[`@emulon/${second}`],
      'dependencies were not saved',
    );

    const lock = await Deno.readTextFile(`${cwd}/${lockfile}`);

    assert(
      lock !== lockBefore &&
        lock.includes(`@emulon/${first}`) &&
        lock.includes(`@emulon/${second}`) &&
        (manager !== 'npm' ||
          (JSON.parse(lock).packages[`node_modules/@emulon/${first}`] &&
            JSON.parse(lock).packages[`node_modules/@emulon/${second}`])),
      'lockfile did not record both plugins',
    );
    assert(
      services.every((service) => tarballs.has(`@emulon/${service}`)),
      'add did not fetch both built archives from the local registry',
    );

    const repeat = JSON.parse(
      await command('CLI repeated add', [
        'add',
        `@emulon/${first}`,
        second,
        '--json',
      ]),
    );

    assert(
      repeat.configuration === 'unchanged' &&
        await Deno.readTextFile(`${cwd}/emulon.config.ts`) === source,
      'repeat add duplicated or changed instances',
    );

    const child = new Deno.Command(
      runtime === 'Node' ? 'node' : Deno.execPath(),
      {
        args: runtime === 'Node'
          ? ['node_modules/emulon/esm/cli/main.js', 'up', '--json']
          : [...denoArgs, 'npm:emulon', 'up', '--json'],
        cwd,
        env,
        clearEnv: true,
        stdout: 'piped',
        stderr: 'piped',
      },
    ).spawn();
    const hostErrors = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      let ready = '';

      await Promise.race([
        (async () => {
          while (!ready.includes('\n')) {
            const chunk = await reader.read();

            assert(!chunk.done, 'up exited before readiness');

            ready += decoder.decode(chunk.value);
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('add host readiness timeout')),
            15000,
          );
        }),
      ]);

      const identity = JSON.parse(ready.trim());

      await command('added plugins CLI status', ['status', '--json']);
      assert(
        identity.endpoints[first] && identity.endpoints[second],
        'up did not start both added plugins',
      );

      if (options.combined) {
        await Deno.copyFile(
          new URL('../examples/stripe-calcom/main.mjs', import.meta.url),
          `${cwd}/main.mjs`,
        );
        await run(
          'combined installed Stripe/Cal.com example',
          runtime === 'Node' ? 'node' : Deno.execPath(),
          runtime === 'Node' ? ['main.mjs', JSON.stringify(cli)] : [
            ...denoArgs,
            `--allow-run=${Deno.execPath()}`,
            'main.mjs',
            JSON.stringify(cli),
          ],
        );
      } else {
        const gh = await command('installed GitHub CLI command', [
          'github',
          'webhooks',
          'list',
          '--json',
        ]);
        const mail = await command('installed Resend CLI command', [
          'resend',
          'emails',
          'list',
          '--json',
        ]);

        await Deno.writeTextFile(
          `${cwd}/parity.mjs`,
          `import { Emulon } from "emulon";
const config = await Emulon.load();
const env = await Emulon.connect({ config });
try {
  const github = await env.services.github.webhooks.list({});
  const resend = await env.services.resend.emails.list({});
  if (JSON.stringify(github) !== ${
            JSON.stringify(gh)
          } || JSON.stringify(resend) !== ${
            JSON.stringify(mail)
          }) throw new Error("CLI/SDK mismatch");
  console.log("GitHub webhooks.list and Resend emails.list match the connected SDK");
} finally { await env.dispose(); }
`,
        );
        await run(
          'installed real plugin CLI/SDK parity',
          runtime === 'Node' ? 'node' : Deno.execPath(),
          runtime === 'Node' ? ['parity.mjs'] : [...denoArgs, 'parity.mjs'],
        );
      }

      await command('added plugins CLI down', ['down', '--json']);
      assert((await child.status).success, 'added host did not stop');

      const errors = await hostErrors;

      assert(
        !withoutTypeStrippingNotice(errors).includes('ExperimentalWarning'),
        `up: ${errors}`,
      );
    } finally {
      clearTimeout(timer);
      reader.releaseLock();

      try {
        child.kill('SIGKILL');
      } catch { /* Host may already have stopped. */ }

      await child.status;
      await child.stdout.cancel();
      await hostErrors;
    }

    if (options.manager) {
      for (
        const other of [
          'package-lock.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'bun.lock',
          'bun.lockb',
          'deno.lock',
        ]
      ) {
        if (other === lockfile) {
          continue;
        }

        let present = false;

        try {
          await Deno.stat(`${cwd}/${other}`);

          present = true;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            throw error;
          }
        }

        assert(!present, `unexpected manager lockfile ${other}`);
      }

      const error = await command('reject incompatible installed metadata', [
        'add',
        'emulon-plugin-invalid',
        '--json',
      ], 1);

      assert(
        error.includes('PLUGIN_INCOMPATIBLE'),
        'metadata was not validated',
      );
      assert(
        await Deno.readTextFile(`${cwd}/emulon.config.ts`) === source,
        'invalid metadata changed config',
      );
      console.log(
        `PASS manager ${manager}: init/add/repeat/up/down, lockfile and metadata`,
      );
    }

    if (options.combined || options.manager) {
      return;
    }

    const unsafe = source +
      '\n// Project-owned computation must stay intact.\nvoid (() => 42)();\n';

    await Deno.writeTextFile(`${cwd}/emulon.config.ts`, unsafe);

    const manual = await command(
      'unsafe config prints exact import and entry',
      ['add', 'github'],
    );

    assert(
      manual.includes('from "@emulon/github";') &&
        /github\d*: emulonPlugin\d*\(\),/.test(manual),
      'missing manual snippet',
    );
    assert(
      await Deno.readTextFile(`${cwd}/emulon.config.ts`) === unsafe,
      'unsafe config was modified',
    );

    const manualJson = JSON.parse(
      await command('unsafe config JSON instructions', [
        'add',
        'resend',
        '--json',
      ]),
    );

    assert(
      manualJson.configuration === 'manual' && manualJson.additions[0].import &&
        manualJson.additions[0].service,
      'missing structured manual instructions',
    );
    assert(
      await Deno.readTextFile(`${cwd}/emulon.config.ts`) === unsafe,
      'JSON fallback modified config',
    );
  } finally {
    await registry.shutdown();
  }
}
