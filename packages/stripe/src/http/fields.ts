import { invalidRequest } from '../errors.ts';
import type { Param, Params } from './form.ts';

function name(prefix: string, key: string): string {
  return prefix ? `${prefix}[${key}]` : key;
}

/**
 * Typed, consuming access to decoded parameters. Every read marks the key as
 * known; `done()` rejects whatever is left, as Stripe rejects unknown
 * parameters instead of ignoring them.
 */
export class Fields {
  readonly #params: Params;
  readonly #prefix: string;
  readonly #seen = new Set<string>();

  constructor(params: Params, prefix = '') {
    this.#params = params;
    this.#prefix = prefix;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#params, key);
  }

  #raw(key: string): Param | undefined {
    this.#seen.add(key);

    return Object.hasOwn(this.#params, key) ? this.#params[key] : undefined;
  }

  #scalar(key: string): string | undefined {
    const value = this.#raw(key);

    if (value !== undefined && typeof value !== 'string') {
      throw invalidRequest(
        `Invalid value for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return value;
  }

  string(key: string, options: { max?: number; empty?: boolean } = {}) {
    const value = this.#scalar(key);

    if (value === undefined) {
      return undefined;
    }

    if (
      (!options.empty && value === '') ||
      value.length > (options.max ?? 5000)
    ) {
      throw invalidRequest(
        `Invalid string for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return value;
  }

  required(key: string, options: { max?: number } = {}): string {
    const value = this.string(key, options);

    if (value === undefined) {
      throw invalidRequest(
        `Missing required param: ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
        'parameter_missing',
      );
    }

    return value;
  }

  int(key: string, options: { min?: number; max?: number } = {}) {
    const value = this.#scalar(key);

    if (value === undefined) {
      return undefined;
    }

    const number = Number(value);

    if (
      !/^-?\d+$/.test(value) || !Number.isSafeInteger(number) ||
      number < (options.min ?? Number.MIN_SAFE_INTEGER) ||
      number > (options.max ?? Number.MAX_SAFE_INTEGER)
    ) {
      throw invalidRequest(
        `Invalid integer for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return number;
  }

  decimal(key: string, options: { min?: number; max?: number } = {}) {
    const value = this.#scalar(key);

    if (value === undefined) {
      return undefined;
    }

    const number = Number(value);

    if (
      !/^\d+(\.\d+)?$/.test(value) || number < (options.min ?? 0) ||
      number > (options.max ?? Number.MAX_SAFE_INTEGER)
    ) {
      throw invalidRequest(
        `Invalid decimal for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return number;
  }

  bool(key: string): boolean | undefined {
    const value = this.#scalar(key);

    if (value === undefined) {
      return undefined;
    }

    if (value !== 'true' && value !== 'false') {
      throw invalidRequest(
        `Invalid boolean for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return value === 'true';
  }

  oneOf<const T extends string>(
    key: string,
    values: readonly T[],
  ): T | undefined {
    const value = this.#scalar(key);

    if (value === undefined) {
      return undefined;
    }

    if (!values.includes(value as T)) {
      throw invalidRequest(
        `Invalid ${name(this.#prefix, key)}: must be one of ${
          values.join(', ')
        }.`,
        name(this.#prefix, key),
      );
    }

    return value as T;
  }

  object(key: string): Fields | undefined {
    const value = this.#raw(key);

    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw invalidRequest(
        `Invalid object for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return new Fields(value, name(this.#prefix, key));
  }

  /** An array of nested objects, or of strings with `strings`. */
  list(key: string): Fields[] | undefined {
    const value = this.#array(key);

    return value?.map((item, index) => {
      const itemName = `${name(this.#prefix, key)}[${index}]`;

      if (typeof item !== 'object' || Array.isArray(item)) {
        throw invalidRequest(`Invalid object for ${itemName}.`, itemName);
      }

      return new Fields(item, itemName);
    });
  }

  strings(key: string): string[] | undefined {
    const value = this.#array(key);

    return value?.map((item, index) => {
      if (typeof item !== 'string') {
        const itemName = `${name(this.#prefix, key)}[${index}]`;

        throw invalidRequest(`Invalid string for ${itemName}.`, itemName);
      }

      return item;
    });
  }

  #array(key: string): Param[] | undefined {
    const value = this.#raw(key);

    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value) || value.some((item) => item === undefined)) {
      throw invalidRequest(
        `Invalid array for ${name(this.#prefix, key)}.`,
        name(this.#prefix, key),
      );
    }

    return value;
  }

  /**
   * Stripe metadata: up to 50 keys of at most 40 characters and values of at
   * most 500. An empty value removes the key when updating.
   */
  metadata(key = 'metadata'): Record<string, string> | undefined {
    const value = this.#raw(key);

    if (value === undefined) {
      return undefined;
    }

    // `metadata=` clears every key.
    if (value === '') {
      return {};
    }

    if (
      typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length > 50 ||
      Object.entries(value).some(([entry, item]) =>
        entry.length > 40 || typeof item !== 'string' || item.length > 500
      )
    ) {
      throw invalidRequest('Invalid metadata.', name(this.#prefix, key));
    }

    return value as Record<string, string>;
  }

  expand(): string[] {
    return this.strings('expand') ?? [];
  }

  /** Reject unread keys. Nested readers check their own keys. */
  done(): void {
    for (const key of Object.keys(this.#params)) {
      if (!this.#seen.has(key)) {
        throw invalidRequest(
          `Received unknown parameter: ${name(this.#prefix, key)}`,
          name(this.#prefix, key),
          'parameter_unknown',
        );
      }
    }
  }
}

/** Apply a metadata update: empty values delete keys, `{}` from `metadata=` clears all. */
export function mergeMetadata(
  current: Record<string, string>,
  update: Record<string, string> | undefined,
): Record<string, string> {
  if (update === undefined) {
    return current;
  }

  if (Object.keys(update).length === 0) {
    return {};
  }

  const next = { ...current };

  for (const [key, value] of Object.entries(update)) {
    if (value === '') {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  return next;
}
