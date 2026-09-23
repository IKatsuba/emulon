/**
 * A small JSON Schema subset, enough to check the emulated wire projection
 * against the retained Polar OpenAPI excerpt. Tests own it: the plugin never
 * parses the provider schema at runtime.
 */
export type Schema = Record<string, unknown>;

export interface Document {
  components: { schemas: Record<string, Schema> };
}

const excerpt = new URL(
  './fixtures/polar-2026-04-customers.openapi.json',
  import.meta.url,
);

export async function readExcerpt(): Promise<Document> {
  return JSON.parse(await Deno.readTextFile(excerpt)) as Document;
}

/** The declared property names of an object schema, in declaration order. */
export function properties(document: Document, name: string): string[] {
  const schema = document.components.schemas[name];

  return Object.keys((schema?.properties ?? {}) as Record<string, unknown>);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value === 'number' && Number.isInteger(value)
    ? 'integer'
    : typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'number') {
    return typeof value === 'number';
  }

  return typeOf(value) === type;
}

/** Every violation found, as readable locations; an empty array means valid. */
export function validate(
  document: Document,
  schema: Schema | string,
  value: unknown,
  path = '$',
): string[] {
  if (typeof schema === 'string') {
    return validate(document, resolve(document, schema), value, path);
  }

  const fail = (reason: string) => [`${path}: ${reason}`];

  if (typeof schema.$ref === 'string') {
    return validate(document, resolve(document, schema.$ref), value, path);
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    const alternatives = schema[key] as Schema[] | undefined;

    if (alternatives) {
      const matched = alternatives.filter((alternative) =>
        validate(document, alternative, value, path).length === 0
      );

      if (matched.length === 0 || (key === 'oneOf' && matched.length > 1)) {
        return fail(`${matched.length} of ${alternatives.length} ${key}`);
      }

      return [];
    }
  }

  if ('const' in schema && value !== schema.const) {
    return fail(`expected const ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return fail('value is not in the declared enum');
  }

  const types = typeof schema.type === 'string'
    ? [schema.type]
    : schema.type as string[] | undefined;

  if (types && !types.some((type) => matchesType(value, type))) {
    return fail(`expected ${types.join(' or ')}, found ${typeOf(value)}`);
  }

  if (typeof value === 'string') {
    if (
      typeof schema.maxLength === 'number' && value.length > schema.maxLength
    ) {
      return fail('longer than maxLength');
    }

    if (
      typeof schema.minLength === 'number' && value.length < schema.minLength
    ) {
      return fail('shorter than minLength');
    }
  }

  if (Array.isArray(value)) {
    return validateArray(document, schema, value, path);
  }

  if (value !== null && typeof value === 'object') {
    return validateObject(
      document,
      schema,
      value as Record<string, unknown>,
      path,
    );
  }

  return [];
}

function resolve(document: Document, ref: string): Schema {
  const name = ref.replace('#/components/schemas/', '');
  const schema = document.components.schemas[name];

  if (!schema) {
    throw new Error(`Unknown schema reference: ${ref}`);
  }

  return schema;
}

function validateArray(
  document: Document,
  schema: Schema,
  value: unknown[],
  path: string,
): string[] {
  const problems: string[] = [];
  const prefix = schema.prefixItems as Schema[] | undefined;

  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    problems.push(`${path}: fewer than minItems`);
  }

  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    problems.push(`${path}: more than maxItems`);
  }

  value.forEach((item, index) => {
    const item_ = prefix?.[index] ?? (schema.items as Schema | undefined);

    if (item_) {
      problems.push(...validate(document, item_, item, `${path}[${index}]`));
    }
  });

  return problems;
}

function validateObject(
  document: Document,
  schema: Schema,
  value: Record<string, unknown>,
  path: string,
): string[] {
  const problems: string[] = [];
  const declared = (schema.properties ?? {}) as Record<string, Schema>;
  const required = (schema.required ?? []) as string[];
  const additional = schema.additionalProperties as Schema | undefined;

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      problems.push(`${path}.${key}: required property is missing`);
    }
  }

  for (const [key, item] of Object.entries(value)) {
    const property = declared[key] ?? additional;

    if (property) {
      problems.push(...validate(document, property, item, `${path}.${key}`));
    }
  }

  return problems;
}
