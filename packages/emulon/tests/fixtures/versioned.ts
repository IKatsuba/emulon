// Imports only published packages: verify-dist installs this module, stripped
// of types, as the two-version fixture package.
import { z } from 'zod';
import {
  type CompatibilityManifest,
  defineCommand,
  defineCompatibility,
  definePlugin,
  deliverySchema,
  type DeliveryTransport,
  destinationViewSchema,
  redeliverWebhook,
  setDestination,
  type SubscriptionPolicy,
  waitForDelivery,
  waitTimeoutSchema,
} from 'emulon';

export const alpha = '2025-01-01.alpha';
export const beta = '2026-01-01.beta';

type Version = typeof alpha | typeof beta;

function version(id: string) {
  return {
    id,
    accepted: [id],
    headers: ['Versioned-Api'],
    missing: 'instance account default',
    unknown: '400 unknown or disabled version',
  };
}

function slice(id: Version, prefix: string) {
  const cases = [`${prefix}.items.1`, `${prefix}.webhooks.1`];

  return {
    operation: {
      id: 'items.create',
      method: 'POST' as const,
      path: '/v1/items',
      surface: 'api',
      version: id,
      auth: ['local-key'],
      input: id === alpha ? ['title'] : ['item.name'],
      output: id === alpha ? 'item with top-level title' : 'item.name',
      events: ['item.created'],
      cases,
    },
    event: {
      id: 'item.created',
      providerName: 'item.created',
      version: id,
      projection: id === alpha ? 'title' : 'item.name',
      cases,
    },
    webhook: {
      version: id,
      signing: 'Versioned-Signature hex HMAC-SHA256 over the exact body',
      id: 'Webhook-Id reused across attempts',
      body: 'endpoint-version snapshot',
      success: '2xx',
      timeoutMs: 5000,
      retries: 'none',
      redelivery: 'manual',
      recovery: 'none',
      cases: [`${prefix}.webhooks.1`],
    },
    verification: {
      version: id,
      mode: 'official-client' as const,
      client: id === alpha ? 'versioned@1.0.0' : 'versioned@2.0.0',
      suites: [{
        path: `packages/emulon/tests/versioned_${prefix}_cases.ts`,
        cases,
      }],
      sources: [`https://example.com/docs/${id}`],
      retrieved: '2026-09-24',
      liveProviderCompared: false as const,
    },
  };
}

const slices = [slice(alpha, 'alpha'), slice(beta, 'beta')];

/** Raw two-version declaration; tests derive broken variants from it. */
export const versionedManifest = {
  schemaVersion: 2,
  plugin: 'versioned',
  provider: { name: 'Versioned', api: 'Versioned REST' },
  operations: slices.map((entry) => entry.operation),
  versions: [version(alpha), version(beta)],
  authentication: {
    flows: ['local-key'],
    keyFormats: ['vk_local_*'],
    ownership: 'instance',
    unsupported: [],
  },
  events: slices.map((entry) => entry.event),
  webhooks: slices.map((entry) => entry.webhook),
  capabilities: ['events', 'webhooks'],
  limitations: [{ id: 'no-live', description: 'Fixture only.' }],
  verification: { byVersion: slices.map((entry) => entry.verification) },
} as const satisfies CompatibilityManifest;

export const compatibility: CompatibilityManifest = defineCompatibility(
  versionedManifest,
);

const versionSchema = z.enum([alpha, beta]);
const itemSchema = z.strictObject({
  name: z.string(),
  apiVersion: versionSchema,
});

/** The provider shape of one neutral item in one API version. */
export function project(name: string, apiVersion: Version) {
  return apiVersion === alpha ? { title: name } : { item: { name } };
}

const policy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: ['item.created'],
};
const encoder = new TextEncoder();

export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));

  return Array.from(
    new Uint8Array(mac),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

const transport: DeliveryTransport = {
  timeoutMs: 5000,
  providerId: 'delivery',
  serialize: (event) => encoder.encode(JSON.stringify(event.payload)),
  async headers({ body, id, secret }) {
    return {
      'content-type': 'application/json',
      'webhook-id': id,
      'versioned-signature': await sign(secret, new TextDecoder().decode(body)),
    };
  },
  succeeds: (status) => status >= 200 && status < 300,
  retryDelayMs: () => undefined,
};

const plugin = definePlugin({
  name: 'versioned',
  apiVersion: 1,
  capabilities: ['events', 'webhooks'],
  compatibility,
  subscriptions: policy,
  transport,
  state: { pluginVersion: '1', schemaVersion: 1 },
  // Events render in the version that created them, deliveries in the
  // destination's version at enqueue time.
  presentation: () => ({
    eventView: (event) => {
      const { name, apiVersion } = itemSchema.parse(event.payload);

      return project(name, apiVersion);
    },
    deliverySnapshot: (event, destination) => {
      const { name } = itemSchema.parse(event.payload);
      const apiVersion = versionSchema.parse(destination.provider?.version);

      return encoder.encode(JSON.stringify({
        id: event.id,
        type: event.type,
        apiVersion,
        data: project(name, apiVersion),
      }));
    },
  }),
  commands: {
    'items.create': defineCommand({
      description: 'Create an item in one API version',
      input: itemSchema,
      output: z.json(),
      cli: {
        path: ['items', 'create'],
        positional: 'name',
        flags: { 'api-version': 'apiVersion' },
      },
      execute: (ctx, { name, apiVersion }) =>
        ctx.store.transaction(async (tx) => {
          await tx.put({ collection: 'items', id: name, value: { name } });
          await tx.record({
            type: 'item.created',
            origin: 'service',
            occurredAt: new Date(ctx.clock.now()).toISOString(),
            payload: { name, apiVersion },
          });

          return project(name, apiVersion);
        }),
    }),
    'webhooks.configure': defineCommand({
      description: 'Subscribe a destination pinned to one API version',
      input: z.strictObject({
        id: z.string(),
        url: z.string(),
        secret: z.string(),
        apiVersion: versionSchema,
      }),
      output: destinationViewSchema,
      cli: {
        path: ['webhooks', 'configure'],
        flags: {
          id: 'id',
          url: 'url',
          secret: 'secret',
          'api-version': 'apiVersion',
        },
      },
      execute: (ctx, { apiVersion, ...input }) =>
        setDestination(ctx.store, {
          ...input,
          types: ['item.created'],
          enabled: true,
          provider: { version: apiVersion },
        }, policy),
    }),
    'webhooks.redeliver': defineCommand({
      description: 'Redeliver the original body',
      input: z.strictObject({ id: z.string() }),
      output: deliverySchema,
      cli: { path: ['webhooks', 'redeliver'], positional: 'id', flags: {} },
      execute: (ctx, { id }) => redeliverWebhook(ctx.store, id),
    }),
    'webhooks.wait': defineCommand({
      description: 'Wait for a delivery status',
      input: z.strictObject({
        id: z.string(),
        status: z.enum(['succeeded', 'failed']),
        timeout: waitTimeoutSchema,
      }),
      output: deliverySchema,
      cli: {
        path: ['webhooks', 'wait'],
        positional: 'id',
        flags: { status: 'status', timeout: 'timeout' },
      },
      execute: (ctx, input) => waitForDelivery(ctx.store, input),
    }),
  },
  setup: () =>
    Promise.resolve({
      endpoints: {},
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    }),
});

export default plugin;
