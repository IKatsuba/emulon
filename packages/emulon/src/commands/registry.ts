import { DeliveryError } from '../deliveries/errors.ts';
import { DomainError } from './domain-error.ts';
import type { z } from 'zod';
import type { Registration } from '../plugins/define.ts';
import type { ServiceEntry } from '../sdk/instances.ts';
import type { PluginContext } from '../plugins/types.ts';
import { type Command, metadata } from './define.ts';

export type Client<Commands> = UnionToIntersection<
  {
    [Key in keyof Commands & string]: Commands[Key] extends
      Command<infer Input, infer Output> ? Path<
        Key,
        Record<string, never> extends z.input<Input>
          ? (input?: z.input<Input>) => Promise<z.output<Output>>
          : (input: z.input<Input>) => Promise<z.output<Output>>
      >
      : never;
  }[keyof Commands & string]
>;
type UnionToIntersection<T> = [T] extends [never] ? Record<string, never>
  : (T extends unknown ? (value: T) => void : never) extends
    (value: infer I) => void ? I
  : never;
type Path<Key extends string, Value> = Key extends `${infer Head}.${infer Tail}`
  ? { readonly [K in Head]: Path<Tail, Value> }
  : { readonly [K in Key]: Value };
export type Services<
  Config extends { services: Record<string, ServiceEntry> },
> = {
  readonly [Name in keyof Config['services']]: Config['services'][Name] extends
    Registration<unknown, infer Commands> ? Client<Commands>
    : Config['services'][Name] extends
      { service: Registration<unknown, infer Commands> } ? Client<Commands>
    : never;
};

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fields: readonly {
      path: readonly (string | number)[];
      code: string;
    }[] = [],
    readonly available: readonly string[] = [],
  ) {
    super(message);
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      fields: this.fields,
      available: this.available,
    };
  }
}

export function commandEntries(commands: unknown): Map<string, Command> {
  const entries = new Map<string, Command>();
  const paths = new Set<string>();

  for (
    const [name, value] of Object.entries(commands as Record<string, Command>)
  ) {
    if (
      !name.split('.').every((part) =>
        /^[a-zA-Z][\w-]*$/.test(part) && part !== 'then'
      )
    ) {
      throw new TypeError('Invalid command name.');
    }

    metadata(value);

    const path = value.cli.path.join(' ');

    if (paths.has(path)) {
      throw new TypeError('Duplicate command CLI path.');
    }

    paths.add(path);
    entries.set(name, value);
  }

  for (const name of entries.keys()) {
    const parts = name.split('.');

    while (parts.pop() && parts.length) {
      if (entries.has(parts.join('.'))) {
        throw new TypeError('Conflicting SDK command paths.');
      }
    }
  }

  return entries;
}

export function jsonValue(value: unknown): unknown {
  const seen = new Set<object>();

  function visit(item: unknown): void {
    if (
      item === null || typeof item === 'string' || typeof item === 'boolean'
    ) {
      return;
    }

    if (typeof item === 'number' && Number.isFinite(item)) {
      return;
    }

    if (
      typeof item !== 'object' || seen.has(item) ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    ) {
      throw new Error('Not JSON');
    }

    seen.add(item);

    for (
      const value of Array.isArray(item)
        ? Array.from(item)
        : Object.values(item)
    ) {
      visit(value);
    }

    seen.delete(item);
  }

  visit(value);

  return JSON.parse(JSON.stringify(value));
}

export class Registry {
  readonly instances = new Map<
    string,
    { commands: Map<string, Command>; context?: PluginContext }
  >();
  closed = false;
  paused = false;
  generation = 0;
  async drain(): Promise<void> {
    await Promise.all(this.executing);
  }
  private readonly executing = new Set<Promise<void>>();
  async close(): Promise<void> {
    this.closed = true;

    await Promise.all(this.executing);
  }
  instance(name: string) {
    const entry = this.instances.get(name);

    if (!entry) {
      throw new CommandError(
        'UNKNOWN_INSTANCE',
        'Unknown service instance.',
        [],
        [...this.instances.keys()].sort(),
      );
    }

    return entry;
  }
  command(instance: string, name: string) {
    const entry = this.instance(instance);
    const command = entry.commands.get(name);

    if (!command) {
      throw new CommandError(
        'UNKNOWN_COMMAND',
        'Unknown command.',
        [],
        [...entry.commands.keys()].sort(),
      );
    }

    return { command, context: entry.context };
  }
  // This request boundary is shared by local clients and the control API.
  async invoke(
    request: { instance: string; command: string; input: unknown },
  ): Promise<unknown> {
    const { command, context } = this.command(
      request.instance,
      request.command,
    );

    if (this.paused) {
      throw new CommandError(
        'ENVIRONMENT_RESETTING',
        'Environment reset is in progress.',
      );
    }

    if (this.closed) {
      throw new CommandError('ENVIRONMENT_CLOSED', 'Environment is disposed.');
    }

    const parse = async (schema: z.ZodType, value: unknown, code: string) => {
      try {
        const parsed = await schema.safeParseAsync(jsonValue(value));

        if (!parsed.success) {
          throw new CommandError(
            code,
            'Command validation failed.',
            parsed.error.issues.map((issue) => ({
              path: issue.path.map((part) =>
                typeof part === 'number' ? part : String(part)
              ),
              code: issue.code,
            })),
          );
        }

        return jsonValue(parsed.data);
      } catch (error) {
        if (error instanceof CommandError) {
          throw error;
        }

        throw new CommandError(code, 'Command validation failed.', [{
          path: [],
          code: 'invalid_json',
        }]);
      }
    };

    if (!context) {
      throw new CommandError(
        'ENVIRONMENT_CLOSED',
        'Environment is not started.',
      );
    }

    const generation = this.generation;
    const input = await parse(command.input, request.input, 'VALIDATION_ERROR');

    if (generation !== this.generation) {
      throw new CommandError(
        'ENVIRONMENT_RESETTING',
        'Environment generation changed.',
      );
    }

    if (this.paused) {
      throw new CommandError(
        'ENVIRONMENT_RESETTING',
        'Environment reset is in progress.',
      );
    }

    if (this.closed) {
      throw new CommandError('ENVIRONMENT_CLOSED', 'Environment is disposed.');
    }

    let finish!: () => void;
    const completion = new Promise<void>((resolve) => finish = resolve);

    this.executing.add(completion);

    try {
      let output: unknown;

      try {
        output = await command.execute(context, input);
      } catch (error) {
        if (error instanceof DeliveryError || error instanceof DomainError) {
          throw new CommandError(error.code, error.message);
        }

        throw new CommandError('COMMAND_FAILED', 'Command execution failed.');
      }

      return await parse(command.output, output, 'OUTPUT_VALIDATION_ERROR');
    } finally {
      this.executing.delete(completion);
      finish();
    }
  }
  client(instance: string): object {
    const root = Object.create(null);

    for (const name of this.instance(instance).commands.keys()) {
      const parts = name.split('.');
      const leaf = parts.pop()!;
      let target = root;

      for (const part of parts) {
        target = target[part] ??= Object.create(null);
      }

      target[leaf] = (input: unknown = {}) =>
        this.invoke({ instance, command: name, input });
    }

    function freeze(value: Record<string, unknown>) {
      for (const child of Object.values(value)) {
        if (typeof child === 'object' && child) {
          freeze(child as Record<string, unknown>);
        }
      }

      return Object.freeze(value);
    }

    return freeze(root);
  }
}

const registries = new WeakMap<object, Registry>();

export function bindRegistry(environment: object, registry: Registry): void {
  registries.set(environment, registry);
}

export function environmentRegistry(environment: object): Registry {
  const registry = registries.get(environment);

  if (!registry) {
    throw new TypeError('Expected a started environment.');
  }

  return registry;
}
