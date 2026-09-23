import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { CommandError } from '../commands/registry.ts';
import {
  type Connection,
  connection,
  environmentName,
  stale,
  type Target,
} from '../control/protocol.ts';

function paths(target: Target) {
  const directory = resolve(target.directory ?? process.cwd(), '.emulon');

  return {
    directory,
    file: resolve(directory, `${environmentName(target.environment)}.json`),
  };
}

export async function readDiscovery(target: Target): Promise<Connection> {
  const { file } = paths(target);

  try {
    const stat = await lstat(file);

    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw stale();
    }

    return connection(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new CommandError(
        'ENVIRONMENT_NOT_FOUND',
        'No environment record. Run emulon up first (with the same --environment if used).',
      );
    }

    throw stale();
  }
}

export async function publishDiscovery(
  target: Target,
  record: Connection,
): Promise<void> {
  const { directory, file } = paths(target);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const stat = await lstat(directory);

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Invalid discovery directory.');
  }

  await chmod(directory, 0o700);

  let handle;

  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new CommandError(
        'ENVIRONMENT_EXISTS',
        'Environment record already exists. Run emulon status to authenticate it; use --environment for another environment.',
      );
    }

    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify(record));
  } catch (error) {
    await unlink(file);

    throw error;
  } finally {
    await handle.close();
  }
}

export async function removeDiscovery(
  target: Target,
  id: string,
): Promise<void> {
  try {
    if ((await readDiscovery(target)).id === id) {
      await unlink(paths(target).file);
    }
  } catch (error) {
    if (
      error instanceof CommandError && error.code === 'ENVIRONMENT_NOT_FOUND'
    ) {
      return;
    }

    throw error;
  }
}

export function onShutdown(stop: () => void): () => void {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
}

/** Canonicalize the project once so state and discovery share the same slot. */
export async function projectTarget(target: Target): Promise<Target> {
  return {
    directory: await realpath(target.directory ?? process.cwd()),
    environment: environmentName(target.environment),
  };
}

export async function requireVacantDiscovery(target: Target): Promise<void> {
  try {
    await lstat(paths(target).file);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  throw new CommandError(
    'ENVIRONMENT_EXISTS',
    'Environment record already exists. Run emulon status to authenticate it; remove stale discovery explicitly before restarting.',
  );
}

export async function statePath(target: Target): Promise<string> {
  const root = paths(target).directory;
  const state = resolve(root, 'state');

  for (
    const directory of [
      root,
      state,
      resolve(state, environmentName(target.environment)),
    ]
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const stat = await lstat(directory);

    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
      throw new Error('Invalid state directory.');
    }
  }

  return resolve(state, environmentName(target.environment), 'state.sqlite');
}
