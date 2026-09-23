import { spawn } from 'node:child_process';
import { lstat, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CommandError } from '../commands/registry.ts';
import { installArguments, type Manager } from '../cli/add-rules.ts';

export function addIO(directory = process.cwd()) {
  const cwd = resolve(directory);
  const config = join(cwd, 'emulon.config.ts');

  return {
    files: () => readdir(cwd),
    async source() {
      try {
        const stat = await lstat(config);

        return {
          text: await readFile(config, 'utf8'),
          writable: stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        };
      } catch {
        throw new CommandError(
          'CONFIG_READ_FAILED',
          'Cannot read emulon.config.ts. Run emulon init first.',
        );
      }
    },
    async install(manager: Manager, packages: readonly string[]) {
      const success = await new Promise<boolean>((resolve) => {
        // Suppress package-manager output: it may include registry credentials.
        const child = spawn(manager, installArguments(manager, packages), {
          cwd,
          stdio: 'ignore',
          shell: false,
        });

        child.once('error', () => resolve(false));
        child.once('close', (code) => resolve(code === 0));
      });

      if (!success) {
        throw new CommandError(
          'PLUGIN_INSTALL_FAILED',
          `${manager} could not install plugins. Configuration was not changed.`,
        );
      }
    },
    async metadata(name: string): Promise<unknown> {
      try {
        const require = createRequire(pathToFileURL(join(cwd, 'package.json')));

        // Read metadata without requiring a package.json export or a CommonJS entry.
        for (const modules of require.resolve.paths(name) ?? []) {
          try {
            const value = JSON.parse(
              await readFile(join(modules, name, 'package.json'), 'utf8'),
            );

            return value;
          } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') {
              throw error;
            }
          }
        }
      } catch { /* Do not expose dependency loader errors or paths. */ }

      throw new CommandError(
        'PLUGIN_INVALID',
        `${name} cannot be resolved as an installed plugin.`,
      );
    },
    async factory(name: string): Promise<unknown> {
      const helper = join(cwd, `.emulon-add-${crypto.randomUUID()}.mjs`);
      let created = false;

      try {
        // Native ESM resolution must start in the project, including import-only exports.
        await writeFile(
          helper,
          `export { default } from ${JSON.stringify(name)};\n`,
          { flag: 'wx' },
        );

        created = true;

        return (await import(pathToFileURL(helper).href)).default;
      } catch {
        throw new CommandError(
          'PLUGIN_INVALID',
          `${name} has no loadable plugin factory.`,
        );
      } finally {
        if (created) {
          await unlink(helper);
        }
      }
    },
    async write(before: string, after: string) {
      const stat = await lstat(config);

      if (
        !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        await readFile(config, 'utf8') !== before
      ) {
        throw new CommandError(
          'CONFIG_CHANGED',
          'Configuration changed during installation; retry add.',
        );
      }

      await writeFile(config, after);
    },
  };
}
