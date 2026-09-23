import {
  compatibilityCommand,
  type CompatibilityCommands,
  type CompatibilityManifest,
  defineCompatibility,
  isCompatibilityCommand,
} from './compatibility.ts';
import type { Command } from '../commands/define.ts';
import type { PluginDefinition } from './types.ts';
import { validateDefinition } from './validation.ts';

const registration = Symbol('emulon.plugin');

/** Internal registration; only the environment interprets its contents. */
export interface Registration<
  Options = unknown,
  Commands extends Record<string, Command> = Record<string, Command>,
> {
  readonly [registration]: {
    readonly definition: PluginDefinition<Options, Commands>;
    readonly sourceDefinition?: PluginDefinition<Options, Commands>;
    readonly options: Options;
  };
}

export function readRegistration<
  Options,
  Commands extends Record<string, Command>,
>(
  value: Registration<Options, Commands>,
) {
  const { sourceDefinition } = value[registration];

  if (sourceDefinition) {
    validateDefinition(sourceDefinition);
  }

  validateDefinition(value[registration].definition);

  return value[registration];
}

export function isRegistration(value: unknown): value is Registration {
  return typeof value === 'object' && value !== null && registration in value;
}

type Factory<Options, Commands extends Record<string, Command>> = (
  ...args: undefined extends Options ? [options?: Options] : [options: Options]
) => Registration<Options, Commands>;

/** Capture configuration now; the environment owns setup and resource creation. */
export function definePlugin<
  Options = void,
  Commands extends Record<string, Command> = Record<string, never>,
>(
  definition: PluginDefinition<Options, Commands> & {
    compatibility: CompatibilityManifest;
  },
): Factory<Options, Commands & CompatibilityCommands>;
export function definePlugin<
  Options = void,
  Commands extends Record<string, Command> = Record<string, never>,
>(
  definition: PluginDefinition<Options, Commands>,
): Factory<Options, Commands>;

export function definePlugin<Options, Commands extends Record<string, Command>>(
  definition: PluginDefinition<Options, Commands>,
): Factory<Options, Commands> {
  validateDefinition(definition);

  const sourceDefinition = definition;

  if (
    definition.compatibility &&
    Object.entries(definition.commands).some(([name, command]) =>
      (name === 'compatibility.get' ||
        command.cli.path.join(' ') === 'compatibility get') &&
      !isCompatibilityCommand(command)
    )
  ) {
    throw new TypeError('Plugin command collides with compatibility.get.');
  }

  if (definition.compatibility) {
    const compatibility = defineCompatibility(definition.compatibility);

    definition = {
      ...definition,
      compatibility,
      commands: {
        ...definition.commands,
        'compatibility.get': compatibilityCommand(compatibility),
      },
    };
  }

  return (...args) => ({
    [registration]: {
      definition,
      sourceDefinition,
      options: args[0] as Options,
    },
  });
}
