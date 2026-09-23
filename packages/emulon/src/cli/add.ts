import { CommandError } from '../commands/registry.ts';
import { resolvePluginName } from '../plugins/resolve.ts';
import { addIO } from '../runtime/add.ts';
import { editConfig, packageManager, validateMetadata } from './add-rules.ts';

export async function addPlugins(names: readonly string[], io = addIO()) {
  if (!names.length) {
    throw new CommandError(
      'CLI_INVALID_ARGUMENTS',
      'Usage: emulon add <name>...',
    );
  }

  let packages: string[];

  try {
    packages = [...new Set(names.map(resolvePluginName))];
  } catch {
    throw new CommandError(
      'CLI_INVALID_ARGUMENTS',
      'Invalid plugin specifier.',
    );
  }

  const packageNames = packages.map((name) => name.replace(/@[^/@]+$/, ''));

  if (new Set(packageNames).size !== packageNames.length) {
    throw new CommandError(
      'CLI_INVALID_ARGUMENTS',
      'Conflicting versions of the same plugin.',
    );
  }

  const manager = packageManager(await io.files());
  const before = await io.source();

  await io.install(manager, packages);

  for (const name of packageNames) {
    validateMetadata(await io.metadata(name), name);

    if (typeof await io.factory(name) !== 'function') {
      throw new CommandError(
        'PLUGIN_INVALID',
        `${name} must default-export a plugin factory.`,
      );
    }
  }

  const edit = editConfig(before.text, packageNames);
  const safe = before.writable && edit.safe;

  if (safe && edit.source !== before.text) {
    await io.write(before.text, edit.source);
  }

  return {
    manager,
    packages,
    configuration: safe
      ? (edit.additions.length ? 'updated' : 'unchanged')
      : 'manual',
    additions: edit.additions,
  };
}
