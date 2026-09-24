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

const operation = z.strictObject({
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
});
const policy = z.strictObject({
  id: text,
  accepted: ids.min(1),
  headers: ids,
  missing: text,
  unknown: text,
});
const authentication = z.strictObject({
  flows: ids,
  keyFormats: ids,
  ownership: text,
  unsupported: ids,
});
const event = z.strictObject({
  id: text,
  providerName: text,
  version: text,
  projection: text,
  cases,
});
const webhookFields = {
  signing: text,
  id: text,
  body: text,
  success: text,
  timeoutMs: z.number().int().nonnegative(),
  retries: text,
  redelivery: text,
  recovery: text,
  cases: ids,
};
const verificationFields = {
  mode: z.enum(['official-client', 'documented-http']),
  client: text.optional(),
  suites: z.array(z.strictObject({ path: text, cases })).min(1),
  sources: z.array(z.url()).min(1),
  retrieved: text.regex(/^\d{4}-\d{2}-\d{2}$/),
  liveProviderCompared: z.literal(false),
};
const details = z.record(z.string(), z.json()).optional();

type Fail = (message: string, path?: PropertyKey[]) => void;

function checker(ctx: z.core.$RefinementCtx): Fail {
  // Messages name positions, never values: rejected data may hold credentials.
  return (message, path = []) =>
    ctx.addIssue({ code: 'custom', message, path });
}

function unique(
  fail: Fail,
  values: readonly string[],
  label: string,
  path: PropertyKey[],
) {
  values.forEach((value, index) => {
    if (values.indexOf(value) !== index) {
      fail(`Duplicate ${label}.`, [...path, index]);
    }
  });
}

function checkCommon(
  fail: Fail,
  value: {
    readonly versions: readonly { readonly id: string }[];
    readonly limitations: readonly { readonly id: string }[];
    readonly capabilities: readonly string[];
    readonly authentication: { readonly flows: readonly string[] };
    readonly operations: readonly {
      readonly version: string;
      readonly auth: readonly string[];
    }[];
  },
) {
  unique(fail, value.versions.map((entry) => entry.id), 'version policy ID', [
    'versions',
  ]);
  unique(fail, value.limitations.map((entry) => entry.id), 'limitation ID', [
    'limitations',
  ]);
  unique(fail, value.capabilities, 'capability', ['capabilities']);
  unique(fail, value.authentication.flows, 'authentication flow', [
    'authentication',
    'flows',
  ]);

  value.operations.forEach((operation, index) => {
    if (!value.versions.some((policy) => policy.id === operation.version)) {
      fail('Unknown version policy.', ['operations', index, 'version']);
    }

    operation.auth.forEach((flow, position) => {
      if (!value.authentication.flows.includes(flow)) {
        fail('Unknown authentication flow.', [
          'operations',
          index,
          'auth',
          position,
        ]);
      }
    });
  });
}

function checkPin(
  fail: Fail,
  verification: { readonly mode: string; readonly client?: string | undefined },
  path: PropertyKey[],
) {
  if (
    verification.mode === 'official-client' &&
    !verification.client?.match(/@\d+\.\d+\.\d+$/)
  ) {
    fail('Official client requires an exact version pin.', [
      ...path,
      'client',
    ]);
  }
}

/** Version 1: one verification record; operation and event IDs are global. */
const manifestV1 = z.strictObject({
  schemaVersion: z.literal(1),
  plugin: text,
  provider: z.strictObject({ name: text, api: text }),
  operations: z.array(operation),
  versions: z.array(policy).min(1),
  authentication,
  events: z.array(event),
  webhooks: z.strictObject(webhookFields),
  capabilities: z.array(capability),
  limitations: z.array(z.strictObject({ id: text, description: text })),
  verification: z.strictObject(verificationFields),
  details,
}).superRefine((value, ctx) => {
  const fail = checker(ctx);

  checkCommon(fail, value);

  for (const key of ['operations', 'events'] as const) {
    unique(fail, value[key].map((entry) => entry.id), `${key} ID`, [key]);
  }

  if (
    value.capabilities.includes('webhooks') && !value.webhooks.cases.length
  ) {
    fail('Webhooks require coverage.', ['webhooks', 'cases']);
  }

  const suites = value.verification.suites;

  unique(fail, suites.map((suite) => suite.path), 'suite path', [
    'verification',
    'suites',
  ]);

  const declared = suites.flatMap((suite) => suite.cases);

  unique(fail, declared, 'case ID', ['verification', 'suites']);

  const referenced = new Set<string>();
  const claims = [
    ...value.operations.map((entry, index) => ({
      entry,
      path: ['operations', index],
    })),
    ...value.events.map((entry, index) => ({ entry, path: ['events', index] })),
    { entry: value.webhooks, path: ['webhooks'] },
  ];

  for (const { entry, path } of claims) {
    unique(fail, entry.cases, 'case reference', [...path, 'cases']);
    entry.cases.forEach((id, position) => {
      referenced.add(id);

      if (!declared.includes(id)) {
        fail('Case reference is not an executed suite case.', [
          ...path,
          'cases',
          position,
        ]);
      }
    });
  }

  suites.forEach((suite, index) => {
    suite.cases.forEach((id, position) => {
      if (!referenced.has(id)) {
        fail('Suite case is not referenced by any claim.', [
          'verification',
          'suites',
          index,
          'cases',
          position,
        ]);
      }
    });
  });

  value.operations.forEach((operation, index) => {
    operation.events.forEach((id, position) => {
      if (!value.events.some((event) => event.id === id)) {
        fail('Unknown event.', ['operations', index, 'events', position]);
      }
    });
  });

  checkPin(fail, value.verification, ['verification']);
});

/**
 * Version 2 keys operation, event and webhook claims by provider API version,
 * and records verification separately for every shipped version.
 */
const manifestV2 = z.strictObject({
  schemaVersion: z.literal(2),
  plugin: text,
  provider: z.strictObject({ name: text, api: text }),
  operations: z.array(operation),
  versions: z.array(policy).min(1),
  authentication,
  events: z.array(event),
  webhooks: z.array(z.strictObject({ version: text, ...webhookFields })),
  capabilities: z.array(capability),
  limitations: z.array(z.strictObject({ id: text, description: text })),
  verification: z.strictObject({
    byVersion: z.array(z.strictObject({ version: text, ...verificationFields }))
      .min(1),
  }),
  details,
}).superRefine((value, ctx) => {
  const fail = checker(ctx);
  const versions = value.versions.map((entry) => entry.id);
  const byVersion = value.verification.byVersion;

  checkCommon(fail, value);

  for (const key of ['operations', 'events'] as const) {
    unique(
      fail,
      value[key].map((entry) => JSON.stringify([entry.id, entry.version])),
      `${key} (id, version) claim`,
      [key],
    );
  }

  unique(
    fail,
    value.webhooks.map((entry) => entry.version),
    'webhook version',
    [
      'webhooks',
    ],
  );
  unique(fail, byVersion.map((entry) => entry.version), 'verified version', [
    'verification',
    'byVersion',
  ]);

  for (
    const [key, entries] of [
      ['events', value.events],
      ['webhooks', value.webhooks],
      ['verification.byVersion', byVersion],
    ] as const
  ) {
    entries.forEach((entry, index) => {
      if (!versions.includes(entry.version)) {
        fail('Unknown version policy.', [...key.split('.'), index, 'version']);
      }
    });
  }

  // Every shipped version must claim the complete declared slice.
  const slices = [
    ['operations', value.operations.map((entry) => entry.id)],
    ['events', value.events.map((entry) => entry.id)],
    ['webhooks', value.webhooks.length ? ['webhooks'] : []],
  ] as const;

  value.versions.forEach((policy, index) => {
    if (!byVersion.some((entry) => entry.version === policy.id)) {
      fail('Version has no verification record.', ['versions', index]);
    }

    for (const [key, all] of slices) {
      const claimed = key === 'webhooks'
        ? value.webhooks.filter((entry) => entry.version === policy.id)
          .map(() => 'webhooks')
        : value[key].filter((entry) => entry.version === policy.id)
          .map((entry) => entry.id);

      if (all.some((id) => !claimed.includes(id))) {
        fail(`Version does not cover the complete ${key} slice.`, [
          'versions',
          index,
        ]);
      }
    }
  });

  if (value.capabilities.includes('webhooks')) {
    if (!value.webhooks.length) {
      fail('Webhooks require coverage.', ['webhooks']);
    }

    value.webhooks.forEach((entry, index) => {
      if (!entry.cases.length) {
        fail('Webhooks require coverage.', ['webhooks', index, 'cases']);
      }
    });
  }

  const suites = byVersion.flatMap((entry) => entry.suites);

  unique(fail, suites.map((suite) => suite.path), 'suite path', [
    'verification',
    'byVersion',
  ]);
  unique(fail, suites.flatMap((suite) => suite.cases), 'case ID', [
    'verification',
    'byVersion',
  ]);

  const referenced = new Set<string>();
  const claims = [
    ...value.operations.map((entry, index) => ({
      entry,
      path: ['operations', index],
    })),
    ...value.events.map((entry, index) => ({ entry, path: ['events', index] })),
    ...value.webhooks.map((entry, index) => ({
      entry,
      path: ['webhooks', index],
    })),
  ];

  for (const { entry, path } of claims) {
    const executed = byVersion
      .filter((record) => record.version === entry.version)
      .flatMap((record) => record.suites.flatMap((suite) => suite.cases));

    unique(fail, entry.cases, 'case reference', [...path, 'cases']);
    entry.cases.forEach((id, position) => {
      referenced.add(JSON.stringify([id, entry.version]));

      if (!executed.includes(id)) {
        fail('Case reference is not an executed case of its version.', [
          ...path,
          'cases',
          position,
        ]);
      }
    });
  }

  byVersion.forEach((record, index) => {
    record.suites.forEach((suite, suiteIndex) => {
      suite.cases.forEach((id, position) => {
        if (!referenced.has(JSON.stringify([id, record.version]))) {
          fail('Suite case is not referenced by any claim of its version.', [
            'verification',
            'byVersion',
            index,
            'suites',
            suiteIndex,
            'cases',
            position,
          ]);
        }
      });
    });

    checkPin(fail, record, ['verification', 'byVersion', index]);
  });

  value.operations.forEach((operation, index) => {
    operation.events.forEach((id, position) => {
      if (
        !value.events.some((event) =>
          event.id === id && event.version === operation.version
        )
      ) {
        fail('Unknown event for the operation version.', [
          'operations',
          index,
          'events',
          position,
        ]);
      }
    });
  });
});

/** Static declarations contain descriptions, never instance configuration or credentials. */
export const compatibilitySchema: z.ZodType<CompatibilityManifest> = z
  .discriminatedUnion('schemaVersion', [manifestV1, manifestV2]);

type Method =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

interface OperationClaim {
  readonly id: string;
  readonly method: Method;
  readonly path: string;
  readonly surface: string;
  readonly version: string;
  readonly auth: readonly string[];
  readonly input: readonly string[];
  readonly output: string;
  readonly events: readonly string[];
  readonly cases: readonly string[];
}

interface VersionPolicy {
  readonly id: string;
  readonly accepted: readonly string[];
  readonly headers: readonly string[];
  readonly missing: string;
  readonly unknown: string;
}

interface EventClaim {
  readonly id: string;
  readonly providerName: string;
  readonly version: string;
  readonly projection: string;
  readonly cases: readonly string[];
}

interface WebhookClaim {
  readonly signing: string;
  readonly id: string;
  readonly body: string;
  readonly success: string;
  readonly timeoutMs: number;
  readonly retries: string;
  readonly redelivery: string;
  readonly recovery: string;
  readonly cases: readonly string[];
}

interface Verification {
  readonly mode: 'official-client' | 'documented-http';
  readonly client?: string | undefined;
  readonly suites: readonly {
    readonly path: string;
    readonly cases: readonly string[];
  }[];
  readonly sources: readonly string[];
  readonly retrieved: string;
  readonly liveProviderCompared: false;
}

interface ManifestBase {
  readonly plugin: string;
  readonly provider: { readonly name: string; readonly api: string };
  readonly operations: readonly OperationClaim[];
  readonly versions: readonly VersionPolicy[];
  readonly authentication: {
    readonly flows: readonly string[];
    readonly keyFormats: readonly string[];
    readonly ownership: string;
    readonly unsupported: readonly string[];
  };
  readonly events: readonly EventClaim[];
  readonly capabilities: readonly import('./types.ts').Capability[];
  readonly limitations: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly details?: { readonly [key: string]: MetadataJSON } | undefined;
}

/** Narrow with `schemaVersion`; version 2 keys claims by `(id, version)`. */
export type CompatibilityManifest =
  | ManifestBase & {
    readonly schemaVersion: 1;
    readonly webhooks: WebhookClaim;
    readonly verification: Verification;
  }
  | ManifestBase & {
    readonly schemaVersion: 2;
    readonly webhooks: readonly (WebhookClaim & { readonly version: string })[];
    readonly verification: {
      readonly byVersion: readonly (Verification & {
        readonly version: string;
      })[];
    };
  };

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

/** Report a location and rule, never a rejected value, key or credential. */
function describe(issue: z.core.$ZodIssue): string {
  const detail = issue.path.findIndex((key) => key === 'details');
  const path = (detail === -1 ? issue.path : issue.path.slice(0, detail + 1))
    .map((key, index) =>
      typeof key === 'number' ? `[${key}]` : `${index ? '.' : ''}${String(key)}`
    ).join('') || 'manifest';
  const message = issue.code === 'custom'
    ? issue.message
    : issue.code === 'unrecognized_keys'
    ? 'Unknown field.'
    : `Invalid value (${issue.code}).`;

  return `${path}: ${message}`;
}

/** Validate, detach from caller-owned data, and deeply freeze a manifest. */
export function defineCompatibility(value: unknown): CompatibilityManifest {
  const result = compatibilitySchema.safeParse(value);

  if (!result.success) {
    throw new TypeError(
      `Invalid compatibility manifest: ${
        result.error.issues.slice(0, 5).map(describe).join(' ')
      }`,
    );
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
