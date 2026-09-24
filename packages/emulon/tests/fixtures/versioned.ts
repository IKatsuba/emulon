import { z } from 'zod';
import {
  type CompatibilityManifest,
  defineCommand,
  defineCompatibility,
  definePlugin,
  Emulon,
} from 'emulon';
import { caseRegistry } from '../helpers/compatibility.ts';

export const alpha = '2025-01-01.alpha';
export const beta = '2026-01-01.beta';

function version(id: string) {
  return {
    id,
    accepted: [id],
    headers: ['Versioned-Api'],
    missing: 'instance account default',
    unknown: '400 unknown or disabled version',
  };
}

function slice(id: string, prefix: string) {
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
      cases: [`${prefix}.items.1`],
    },
    event: {
      id: 'item.created',
      providerName: 'item.created',
      version: id,
      projection: id === alpha ? 'title' : 'item.name',
      cases: [`${prefix}.items.1`],
    },
    webhook: {
      version: id,
      signing: 'Versioned-Signature HMAC-SHA256',
      id: 'evt_ ID reused across attempts',
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
        cases: [`${prefix}.items.1`, `${prefix}.webhooks.1`],
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

const plugin = definePlugin({
  name: 'versioned',
  apiVersion: 1,
  capabilities: ['events', 'webhooks'],
  compatibility,
  commands: {
    'items.create': defineCommand({
      description: 'Project an item in one API version',
      input: z.strictObject({
        name: z.string(),
        apiVersion: z.enum([alpha, beta]),
      }),
      output: z.json(),
      cli: {
        path: ['items', 'create'],
        positional: 'name',
        flags: { 'api-version': 'apiVersion' },
      },
      execute: (_ctx, { name, apiVersion }) =>
        apiVersion === alpha ? { title: name } : { item: { name } },
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

/** Contract cases of one fixture version, each executed against a started environment. */
export function versionedCases(
  prefix: 'alpha' | 'beta',
  expected: unknown,
) {
  const apiVersion = prefix === 'alpha' ? alpha : beta;
  const suite = caseRegistry(
    `packages/emulon/tests/versioned_${prefix}_cases.ts`,
  );
  const same = (actual: unknown, wanted: unknown, label: string) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`Versioned fixture mismatch: ${label}`);
    }
  };

  suite.register(
    `${prefix}.items.1`,
    ['items.create'],
    ['item.created'],
    false,
    `creates an item in the ${apiVersion} projection`,
    async () => {
      await using env = await Emulon.start({
        services: { versioned: plugin() },
      });

      same(
        await env.services.versioned.items.create({ name: 'a', apiVersion }),
        expected,
        'projection',
      );
    },
  );
  suite.register(
    `${prefix}.webhooks.1`,
    [],
    [],
    true,
    `declares the ${apiVersion} webhook claim through the host`,
    async () => {
      await using env = await Emulon.start({
        services: { versioned: plugin() },
      });
      const manifest = await env.services.versioned.compatibility.get({});

      same(
        manifest.schemaVersion === 2 &&
          manifest.webhooks.filter((entry) => entry.version === apiVersion)
            .length,
        1,
        'webhook claim',
      );
    },
  );

  return suite.cases;
}
