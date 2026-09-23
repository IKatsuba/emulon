import { z } from 'zod';
import type { PluginContext } from '../plugins/types.ts';

export interface Command<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> {
  description: string;
  input: Input;
  output: Output;
  cli: {
    path: readonly string[];
    flags: Readonly<Record<string, string>>;
    positional?: string;
  };
  execute(
    ctx: PluginContext,
    input: z.output<Input>,
  ): z.input<Output> | Promise<z.input<Output>>;
}

export function defineCommand<
  Input extends z.ZodType,
  Output extends z.ZodType,
>(
  command: Command<Input, Output>,
): Command<Input, Output> {
  metadata(command);

  return command;
}

export function metadata(command: Command) {
  // Both sides must survive the control transport without lossy coercion.
  const input = z.toJSONSchema(command.input, { io: 'input' });

  z.toJSONSchema(command.input, { io: 'output' });
  z.toJSONSchema(command.output, { io: 'input' });
  z.toJSONSchema(command.output, { io: 'output' });

  if (
    input.type !== 'object' || input.anyOf || input.oneOf || input.allOf ||
    input.$ref || (input.additionalProperties !== undefined &&
      input.additionalProperties !== false)
  ) {
    throw new TypeError(
      'Command input must be an object with declared fields.',
    );
  }

  if (
    !command.description || typeof command.execute !== 'function' ||
    !command.cli.path.length ||
    command.cli.path.some((part) => !/^[a-zA-Z][\w-]*$/.test(part))
  ) {
    throw new TypeError('Invalid command declaration.');
  }

  const fields = new Set<string>();

  if (command.cli.positional) {
    if (
      !Object.hasOwn(input.properties ?? {}, command.cli.positional) ||
      flagEncoding(input.properties![command.cli.positional]!) !== 'string'
    ) {
      throw new TypeError('Invalid positional field.');
    }

    fields.add(command.cli.positional);
  }

  for (const [flag, field] of Object.entries(command.cli.flags)) {
    if (
      !/^[a-zA-Z][\w-]*$/.test(flag) ||
      ['help', 'json', 'environment'].includes(flag) ||
      fields.has(field) || !Object.hasOwn(input.properties ?? {}, field)
    ) {
      throw new TypeError('Invalid command flag mapping.');
    }

    fields.add(field);
    flagEncoding(input.properties![field]!);
  }

  if (Object.keys(input.properties ?? {}).some((field) => !fields.has(field))) {
    throw new TypeError('Every command input field must have a CLI flag.');
  }

  return input;
}

export function flagEncoding(
  schema: z.core.JSONSchema.BaseSchema | boolean,
): 'string' | 'boolean' | 'json' {
  if (typeof schema === 'boolean') {
    return 'json';
  }

  if (schema.$ref || schema.allOf) {
    throw new TypeError(
      'Referenced or intersected CLI flag schemas are unsupported.',
    );
  }

  const alternatives = schema.anyOf ?? schema.oneOf;

  if (alternatives) {
    const encodings = alternatives.map(flagEncoding);

    if (encodings.every((encoding) => encoding === 'string')) {
      return 'string';
    }

    if (encodings.includes('string')) {
      throw new TypeError(
        'CLI flag schemas cannot mix strings with other types.',
      );
    }

    return 'json';
  }

  if (Array.isArray(schema.type) && schema.type.includes('string')) {
    if (schema.type.every((type) => type === 'string')) {
      return 'string';
    }

    throw new TypeError(
      'CLI flag schemas cannot mix strings with other types.',
    );
  }

  if (schema.type === 'string') {
    return 'string';
  }

  if (schema.type === 'boolean') {
    return 'boolean';
  }

  return 'json';
}
