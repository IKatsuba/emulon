import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function configURL(directory = process.cwd()): URL {
  return pathToFileURL(resolve(directory, 'emulon.config.ts'));
}

export async function configExists(url: URL): Promise<boolean> {
  try {
    await lstat(url);

    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function createConfig(url: URL, source: string): Promise<void> {
  await writeFile(url, source, { flag: 'wx' });
}

export function cliArguments(): string[] {
  return process.argv.slice(2);
}

export function finishCLI(code: number): void {
  process.exitCode = code;
}

export async function readDataFile(
  path: string,
  directory = process.cwd(),
): Promise<string> {
  return await readFile(resolve(directory, path), 'utf8');
}
