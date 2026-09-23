import { addProof } from './add-proof.ts';

/** Exercise installed managers without downloading missing executables. */
export async function managerProof(options: {
  temporary: string;
  archives: string[];
  nodeBin: string;
}) {
  const cwd = `${options.temporary}/managers`;
  const bin = `${cwd}/bin`;

  await Deno.mkdir(bin, { recursive: true });

  for (const name of ['node', 'sh']) {
    await Deno.symlink(`${options.nodeBin}/${name}`, `${bin}/${name}`);
  }

  for (const manager of ['pnpm', 'yarn', 'bun', 'deno'] as const) {
    let executable: string | undefined;

    for (const directory of (Deno.env.get('PATH') ?? '').split(':')) {
      try {
        executable = await Deno.realPath(`${directory}/${manager}`);

        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    if (!executable) {
      console.log(
        `SKIP manager ${manager}: executable unavailable on PATH; no download attempted`,
      );
      continue;
    }

    await Deno.symlink(executable, `${bin}/${manager}`);
    await addProof({
      cwd,
      archives: options.archives,
      env: {
        PATH: bin,
        TMPDIR: options.temporary,
        DENO_NO_UPDATE_CHECK: '1',
        COREPACK_HOME: Deno.env.get('COREPACK_HOME') ??
          `${Deno.env.get('HOME')}/.cache/node/corepack`,
        COREPACK_ENABLE_NETWORK: '0',
        COREPACK_DEFAULT_TO_LATEST: '0',
        COREPACK_ENABLE_AUTO_PIN: '0',
        NODE_OPTIONS: '--experimental-strip-types',
      },
      runtime: 'Node',
      denoArgs: [],
      manager,
    });
  }
}
