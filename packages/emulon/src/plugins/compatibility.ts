import { z } from 'zod';
import { type Command, defineCommand } from '../commands/define.ts';

const text = z.string().min(1);
const ids = z.array(text);
const cases = ids.min(1);
const capability = z.enum([
  'http',
  'managed-engine',
  'authorization',
  'events',
  'webhooks',
  'reset',
  'virtual-time',
  'snapshot',
  'faults',
]);

/** Static declarations contain descriptions, never instance configuration or credentials. */
export const compatibilitySchema: z.ZodType<CompatibilityManifest> = z
  .strictObject({
    schemaVersion: z.literal(1),
    plugin: text,
    provider: z.strictObject({ name: text, api: text }),
    operations: z.array(z.strictObject({
      id: text,
      method: z.enum([
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ]),
      path: text.regex(/^\//),
      surface: text,
      version: text,
      auth: ids.min(1),
      input: ids,
      output: text,
      events: ids,
      cases,
    })),
    versions: z.array(z.strictObject({
      id: text,
      accepted: ids.min(1),
      headers: ids,
      missing: text,
      unknown: text,
    })).min(1),
    authentication: z.strictObject({
      flows: ids,
      keyFormats: ids,
      ownership: text,
      unsupported: ids,
    }),
    events: z.array(
      z.strictObject({
        id: text,
        providerName: text,
        version: text,
        projection: text,
        cases,
      }),
    ),
    webhooks: z.strictObject({
      signing: text,
      id: text,
      body: text,
      success: text,
      timeoutMs: z.number().int().nonnegative(),
      retries: text,
      redelivery: text,
      recovery: text,
      cases: ids,
    }),
    capabilities: z.array(capability),
    limitations: z.array(z.strictObject({ id: text, description: text })),
    verification: z.strictObject({
      mode: z.enum(['official-client', 'documented-http']),
      client: text.optional(),
      suites: z.array(z.strictObject({ path: text, cases })).min(1),
      sources: z.array(z.url()).min(1),
      retrieved: text.regex(/^\d{4}-\d{2}-\d{2}$/),
      liveProviderCompared: z.literal(false),
    }),
    details: z.record(z.string(), z.json()).optional(),
  }).superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) {
        fail(`Duplicate ${label}.`);
      }
    };

    for (
      const key of ['operations', 'versions', 'events', 'limitations'] as const
    ) {
      unique(value[key].map((entry) => entry.id), key);
    }

    unique(value.capabilities, 'capabilities');
    unique(value.authentication.flows, 'authentication flows');

    if (
      value.capabilities.includes('webhooks') && !value.webhooks.cases.length
    ) {
      fail('Webhooks require coverage.');
    }

    unique(value.verification.suites.map((suite) => suite.path), 'suite paths');

    const declared = value.verification.suites.flatMap((suite) => suite.cases);

    unique(declared, 'case IDs');

    const referenced = new Set<string>();

    for (
      const entry of [...value.operations, ...value.events, value.webhooks]
    ) {
      unique(entry.cases, 'case references');

      for (const id of entry.cases) {
        referenced.add(id);

        if (!declared.includes(id)) {
          fail(`Unknown case ID: ${id}.`);
        }
      }
    }

    for (const id of declared) {
      if (!referenced.has(id)) {
        fail(`Unreferenced case ID: ${id}.`);
      }
    }

    for (const operation of value.operations) {
      if (!value.versions.some((policy) => policy.id === operation.version)) {
        fail(`Unknown version policy: ${operation.version}.`);
      }

      for (const flow of operation.auth) {
        if (!value.authentication.flows.includes(flow)) {
          fail(`Unknown authentication flow: ${flow}.`);
        }
      }

      for (const id of operation.events) {
        if (!value.events.some((event) => event.id === id)) {
          fail(`Unknown event: ${id}.`);
        }
      }
    }

    if (
      value.verification.mode === 'official-client' &&
      !value.verification.client?.match(/@\d+\.\d+\.\d+$/)
    ) {
      fail('Official client requires an exact version pin.');
    }
  });

export interface CompatibilityManifest {
  readonly schemaVersion: 1;
  readonly plugin: string;
  readonly provider: { readonly name: string; readonly api: string };
  readonly operations: readonly {
    readonly id: string;
    readonly method:
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'PATCH'
      | 'DELETE'
      | 'HEAD'
      | 'OPTIONS';
    readonly path: string;
    readonly surface: string;
    readonly version: string;
    readonly auth: readonly string[];
    readonly input: readonly string[];
    readonly output: string;
    readonly events: readonly string[];
    readonly cases: readonly string[];
  }[];
  readonly versions: readonly {
    readonly id: string;
    readonly accepted: readonly string[];
    readonly headers: readonly string[];
    readonly missing: string;
    readonly unknown: string;
  }[];
  readonly authentication: {
    readonly flows: readonly string[];
    readonly keyFormats: readonly string[];
    readonly ownership: string;
    readonly unsupported: readonly string[];
  };
  readonly events: readonly {
    readonly id: string;
    readonly providerName: string;
    readonly version: string;
    readonly projection: string;
    readonly cases: readonly string[];
  }[];
  readonly webhooks: {
    readonly signing: string;
    readonly id: string;
    readonly body: string;
    readonly success: string;
    readonly timeoutMs: number;
    readonly retries: string;
    readonly redelivery: string;
    readonly recovery: string;
    readonly cases: readonly string[];
  };
  readonly capabilities: readonly import('./types.ts').Capability[];
  readonly limitations: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly verification: {
    readonly mode: 'official-client' | 'documented-http';
    readonly client?: string | undefined;
    readonly suites: readonly {
      readonly path: string;
      readonly cases: readonly string[];
    }[];
    readonly sources: readonly string[];
    readonly retrieved: string;
    readonly liveProviderCompared: false;
  };
  readonly details?: { readonly [key: string]: MetadataJSON } | undefined;
}
type MetadataJSON =
  | string
  | number
  | boolean
  | null
  | readonly MetadataJSON[]
  | { readonly [key: string]: MetadataJSON };

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child);
    }

    Object.freeze(value);
  }

  return value;
}

/** Validate, detach from caller-owned data, and deeply freeze a manifest. */
export function defineCompatibility(value: unknown): CompatibilityManifest {
  const result = compatibilitySchema.safeParse(value);

  // Do not echo rejected data: a malformed declaration may contain credentials.
  if (!result.success) {
    throw new TypeError('Invalid compatibility manifest.');
  }

  return freeze(result.data);
}

const generatedCommands = new WeakSet<object>();

export function isCompatibilityCommand(command: object): boolean {
  return generatedCommands.has(command);
}

export function compatibilityCommand(
  manifest: CompatibilityManifest,
): Command<
  z.ZodObject<Record<string, never>>,
  z.ZodType<CompatibilityManifest>
> {
  const command = defineCommand({
    description: 'Read the host plugin compatibility manifest',
    input: z.strictObject({}),
    output: compatibilitySchema,
    cli: { path: ['compatibility', 'get'], flags: {} },
    execute: () => manifest,
  });

  generatedCommands.add(command);

  return command;
}

export type CompatibilityCommands = {
  'compatibility.get': ReturnType<typeof compatibilityCommand>;
};
