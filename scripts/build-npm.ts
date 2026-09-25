import { compatibility as calcomCompatibility } from '../packages/calcom/src/compatibility.ts';
import { compatibility as stripeCompatibility } from '../packages/stripe/src/compatibility.ts';
import { compatibility as githubCompatibility } from '../packages/github/src/compatibility.ts';
import { compatibility as polarCompatibility } from '../packages/polar/src/compatibility.ts';
import { compatibility as resendCompatibility } from '../packages/resend/src/compatibility.ts';
import { compatibility as telegramCompatibility } from '../packages/telegram/src/compatibility.ts';
import type { CompatibilityManifest } from 'emulon';
import { build, emptyDir } from '@deno/dnt';
// Materialize the compiler package even on a machine with an empty Deno cache.
import 'typescript';

const root = new URL('../', import.meta.url);
const manifests: Record<string, CompatibilityManifest> = {
  calcom: calcomCompatibility,
  github: githubCompatibility,
  polar: polarCompatibility,
  resend: resendCompatibility,
  stripe: stripeCompatibility,
  telegram: telegramCompatibility,
};

Deno.chdir(root);
Deno.env.set('npm_config_audit', 'false');
Deno.env.set('npm_config_fund', 'false');
Deno.env.set('npm_config_ignore_scripts', 'true');
await Deno.mkdir(new URL('dist/npm/', root), { recursive: true });

const output = await Deno.realPath(new URL('dist/npm/', root));

await emptyDir(output);

const workspace = JSON.parse(await Deno.readTextFile('deno.json'));
const coreConfig = JSON.parse(
  await Deno.readTextFile('packages/emulon/deno.json'),
);

for (
  const service of [
    'emulon',
    'resend',
    'github',
    'stripe',
    'calcom',
    'polar',
    'telegram',
  ]
) {
  const config = JSON.parse(
    await Deno.readTextFile(`packages/${service}/deno.json`),
  );
  const core = service === 'emulon';
  const directory = `${output}/${service}/`;

  await build({
    entryPoints: [
      `./packages/${service}/src/mod.ts`,
      ...(core
        ? [{
          kind: 'bin' as const,
          name: 'emulon',
          path: './packages/emulon/src/cli/main.ts',
        }, {
          name: './internal-state',
          path: './packages/emulon/src/runtime/sqlite-state.ts',
        }]
        : []),
    ],
    outDir: directory,
    shims: {},
    scriptModule: false,
    test: false,
    skipSourceOutput: true,
    compilerOptions: { target: 'ES2023' },
    mappings: core ? {} : {
      'hono': {
        name: 'hono',
        version: config.peerDependencies.hono,
        peerDependency: true,
      },
      'emulon': {
        name: 'emulon',
        version: config.peerDependencies.emulon,
        peerDependency: true,
      },
    },
    package: {
      name: config.name,
      version: config.version,
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/IKatsuba/emulon.git',
        directory: `packages/${service}`,
      },
      homepage: 'https://github.com/IKatsuba/emulon#readme',
      bugs: 'https://github.com/IKatsuba/emulon/issues',
      engines: { node: '>=22.13.0' },
      devDependencies: {
        '@types/node': workspace.imports['@types/node'].replace(
          'npm:@types/node@',
          '',
        ),
        ...(core ? {} : {
          emulon: `file:${output}/emulon-${coreConfig.version}.tgz`,
        }),
      },
      ...(core ? {} : {
        emulon: {
          ...config.emulon,
          compatibility: manifests[service],
        },
        peerDependencies: config.peerDependencies,
      }),
    },
  });

  await Deno.copyFile('LICENSE', `${directory}LICENSE`);
  await Deno.copyFile(
    core ? 'README.md' : `packages/${service}/README.md`,
    `${directory}README.md`,
  );

  const manifestPath = `${directory}package.json`;
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath));

  delete manifest.devDependencies;

  delete manifest.scripts;
  delete manifest.exports['./internal-state'];

  manifest.exports['.'] = {
    types: './esm/mod.d.ts',
    ...manifest.exports['.'],
  };
  manifest.types = './esm/mod.d.ts';
  manifest.files = ['esm'];

  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + '\n',
  );

  if (core) {
    const bin = `${directory}${manifest.bin.emulon}`;
    const source = await Deno.readTextFile(bin);

    // dnt can prepend lib references, so add the executable header after emit.
    if (!source.startsWith('#!')) {
      await Deno.writeTextFile(bin, '#!/usr/bin/env node\n' + source);
    }

    await Deno.chmod(bin, 0o755);
  }

  const result = await new Deno.Command('npm', {
    args: ['pack', '--ignore-scripts', '--pack-destination', output],
    cwd: directory,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();

  if (!result.success) {
    throw new Error(`npm pack failed for ${config.name}`);
  }
}

// Resolve dependency caches through Deno metadata, not a platform-specific layout.
const verificationArchives: string[] = [];
const packedDependencies = new Set<string>();

for (
  const dependency of [
    workspace.imports.stripe,
    workspace.imports['@polar-sh/sdk'],
    workspace.imports.typescript,
    workspace.imports.zod,
    workspace.imports.hono,
    workspace.imports['@hono/node-server'],
  ]
) {
  const info = await new Deno.Command(Deno.execPath(), {
    args: ['info', '--json', dependency],
    stdout: 'piped',
    stderr: 'inherit',
  }).output();

  if (!info.success) {
    throw new Error(
      'Cannot locate verification dependency cache',
    );
  }

  const metadata = JSON.parse(new TextDecoder().decode(info.stdout));
  // Deno metadata includes workspace packages; walk only this dependency's graph.
  const pending: string[] = metadata.modules.flatMap((
    entry: { npmPackage?: string },
  ) => entry.npmPackage ? [entry.npmPackage] : []);

  if (pending.length === 0) {
    throw new Error(`Missing npm root for ${dependency}`);
  }

  while (pending.length) {
    const id = pending.pop()!;

    if (packedDependencies.has(id)) {
      continue;
    }

    const cached = metadata.npmPackages[id];

    if (!cached?.localPath) {
      throw new Error(`Missing cache path for ${id}`);
    }

    pending.push(...cached.dependencies);

    const packed = await new Deno.Command('npm', {
      cwd: await packableCopy(cached.localPath),
      args: [
        'pack',
        '--offline',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        output,
      ],
      stdout: 'piped',
      stderr: 'inherit',
    }).output();

    if (!packed.success) {
      throw new Error(`Cannot pack verification dependency ${id}`);
    }

    const report = JSON.parse(new TextDecoder().decode(packed.stdout));

    // npm 12 keys the report by package name; earlier versions return a list.
    verificationArchives.push(
      (Array.isArray(report) ? report[0] : Object.values(report)[0]).filename,
    );
    packedDependencies.add(id);
  }
}

await Deno.writeTextFile(
  `${output}/verification-dependencies.json`,
  JSON.stringify(verificationArchives) + '\n',
);

/**
 * npm 10 runs `prepare` during `npm pack` despite `--ignore-scripts`, which
 * builds from sources the published package does not ship. Pack a copy without
 * lifecycle scripts instead; the packed files are unchanged.
 */
async function packableCopy(directory: string): Promise<string> {
  const manifest = JSON.parse(
    await Deno.readTextFile(`${directory}/package.json`),
  );

  if (
    !['prepack', 'prepare', 'postpack'].some((name) => manifest.scripts?.[name])
  ) {
    return directory;
  }

  const copy = await Deno.makeTempDir({ prefix: 'emulon-pack-' });
  const copied = await new Deno.Command('cp', {
    args: ['-R', `${directory}/.`, copy],
    stderr: 'inherit',
  }).output();

  if (!copied.success) {
    throw new Error(`Cannot stage ${manifest.name} for packing`);
  }

  delete manifest.scripts;
  await Deno.writeTextFile(
    `${copy}/package.json`,
    JSON.stringify(manifest, null, 2) + '\n',
  );

  return copy;
}
