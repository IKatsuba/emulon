/** Resolve explicit conventions without consulting a registry or falling back. */
export function resolvePluginName(specifier: string): string {
  const match =
    /^(?:(community:)|(@[a-z0-9][a-z0-9._-]*\/))?([a-z0-9][a-z0-9._-]*)(@[a-z0-9][a-z0-9.+_-]*)?$/
      .exec(specifier);

  if (!match) {
    throw new TypeError('Invalid plugin specifier.');
  }

  const [, community, scope, name, version = ''] = match;

  if (community) {
    return `emulon-plugin-${name}${version}`;
  }

  if (scope) {
    return `${scope}${name}${version}`;
  }

  if (name!.startsWith('emulon-plugin-')) {
    return `${name}${version}`;
  }

  return `@emulon/${name}${version}`;
}
