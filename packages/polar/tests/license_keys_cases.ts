// Polar request and response fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { Polar } from '@polar-sh/sdk';
import { NotPermitted } from '@polar-sh/sdk/models/errors/notpermitted.js';
import { ResourceNotFound } from '@polar-sh/sdk/models/errors/resourcenotfound.js';
import { HTTPValidationError } from '@polar-sh/sdk/models/errors/httpvalidationerror.js';
import polar from '@emulon/polar';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { apiVersion } from '../src/model/customers.ts';
import type { LicenseKey } from '../src/model/license_keys.ts';
import { readExcerpt, validate } from './schema.ts';
import { organizationId } from './customers_cases.ts';
import { assert, equal } from './assert.ts';

export const { cases, register } = caseRegistry(
  'packages/polar/tests/license_keys_cases.ts',
);

const customerId = '0d4c9a52-7f5e-4f7d-9a38-1f4ce6f5a0b1';
const otherCustomerId = '6f0f0f86-3d2b-4d5e-8f8a-2a1b9c3d4e5f';
const foreignOrganization = '9a1e5c3b-4d2f-4a6b-8c7d-0e1f2a3b4c5d';
const unknownActivation = '2b7f1a9c-5e3d-4c8b-9a6f-1d2e3f4a5b6c';
const day = 86_400_000;
const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
const portal = '/v1/customer-portal/license-keys';
const operations = [
  'customerPortal.licenseKeys.activate',
  'customerPortal.licenseKeys.validate',
  'customerPortal.licenseKeys.deactivate',
];

/** Everything printed while a case runs, to prove no key or condition leaks. */
function captureConsole() {
  const lines: string[] = [];
  const original = methods.map((method) => [method, console[method]] as const);

  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };
  }

  return {
    lines,
    restore() {
      for (const [method, fn] of original) {
        console[method] = fn;
      }
    },
  };
}

/** A plugin whose HTTP handlers read a controllable clock. */
function timed() {
  const clock = { now: Date.now() };
  const { definition } = readRegistration(polar());
  const plugin = definePlugin({
    ...definition,
    setup(ctx: PluginContext, options) {
      return definition.setup(
        { ...ctx, clock: { now: () => clock.now } },
        options,
      );
    },
  });

  return { plugin, clock };
}

async function started() {
  const { plugin, clock } = timed();
  const env = await Emulon.start({
    services: {
      billing: plugin({
        organizationId,
        fixtures: {
          customers: [
            { id: customerId, email: 'ada@example.test' },
            { id: otherCustomerId, email: 'grace@example.test' },
          ],
        },
      }),
    },
  });
  const sdk = env.services.billing;
  const api = env.endpoints.billing.api!;

  /** A key under a fresh benefit; no organization access token exists. */
  async function grant(
    properties: {
      limitActivations?: number;
      ttl?: number;
      limitUsage?: number;
      customer?: string;
    } = {},
  ): Promise<LicenseKey> {
    const benefit = await sdk.benefits.create({
      description: 'Chorded licence',
      prefix: 'chd',
      ...(properties.limitActivations === undefined ? {} : {
        limitActivations: properties.limitActivations,
        enableCustomerAdmin: false,
      }),
      ...(properties.ttl === undefined
        ? {}
        : { ttl: properties.ttl, timeframe: 'day' as const }),
      ...(properties.limitUsage === undefined
        ? {}
        : { limitUsage: properties.limitUsage }),
    });

    return await sdk.licenseKeys.grant({
      benefitId: benefit.id,
      customerId: properties.customer ?? customerId,
    });
  }

  /** The desktop client's transport: JSON POST, no Authorization header. */
  async function post(
    operation: 'activate' | 'validate' | 'deactivate',
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${api}${portal}/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();

    return { status: response.status, text, headers: response.headers };
  }

  return {
    env,
    sdk,
    api,
    clock,
    grant,
    post,
    [Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
  };
}

/** The exact envelope bytes: status, error and detail as the ADR table states. */
function refused(
  result: { status: number; text: string },
  status: number,
  error: string,
  detail: string,
  label: string,
) {
  assert(
    result.status === status &&
      result.text === JSON.stringify({ error, detail }),
    `${label}: ${result.status} ${result.text}`,
  );
}

/** The official client reads the environment on construction; keep it empty. */
function officialClient(api: string) {
  const environment = Deno.env.toObject;

  Deno.env.toObject = () => ({});

  try {
    return new Polar({ serverURL: api, retryConfig: { strategy: 'none' } });
  } finally {
    Deno.env.toObject = environment;
  }
}

const notFound = 'Not found';
const notActive = 'License key is no longer active.';
const notActiveActivate =
  'License key is no longer active. This license key can not be activated.';
const expired = 'License key has expired.';
const noActivations =
  'This license key does not support activations. Use the /validate endpoint instead to check license validity.';
const limitReached = 'License key activation limit already reached';
const conditionsDiffer = 'License key does not match required conditions';
const benefitDiffers = 'License key does not match given benefit.';
const customerDiffers = 'License key does not match given user.';

register(
  'polar.licenseKeys.1',
  operations,
  [],
  false,
  'Desktop-shaped raw fetch runs grant, activate, validate with and without the activation, deactivate and a Not found validation without a token',
  async () => {
    const document = await readExcerpt('license-keys');
    const output = captureConsole();
    let key = '';

    try {
      await using host = await started();
      const granted = await host.grant({ limitActivations: 3 });
      const conditions = { major_version: 2 };

      key = granted.key;

      const activated = await host.post('activate', {
        key,
        organization_id: organizationId,
        label: 'Ada’s MacBook',
        conditions,
      });

      equal(activated.status, 200);
      equal(activated.headers.get('polar-version'), apiVersion);

      const activation = JSON.parse(activated.text);

      equal(
        validate(
          document,
          '#/components/schemas/LicenseKeyActivationCreated',
          activation,
        ),
        [],
      );
      assert(!('conditions' in activation), 'Conditions were projected');
      equal(activation.label, 'Ada’s MacBook');
      equal(activation.meta, {});
      equal(activation.license_key_id, granted.id);
      equal(
        [
          activation.license_key.status,
          activation.license_key.limit_activations,
        ],
        ['granted', 3],
      );

      const withActivation = {
        key,
        organization_id: organizationId,
        activation_id: activation.id,
        conditions,
      };
      const first = await host.post('validate', withActivation);

      equal(first.status, 200);

      const validated = JSON.parse(first.text);

      equal(
        validate(
          document,
          '#/components/schemas/ValidatedLicenseKey',
          validated,
        ),
        [],
      );
      equal(validated.activation.id, activation.id);
      assert(!('conditions' in validated.activation), 'Conditions projected');
      equal([validated.validations, validated.usage], [1, 0]);
      assert(validated.last_validated_at !== null, 'Validation not recorded');

      // Member order is not part of JSON equality.
      const reordered = await host.post(
        'validate',
        `{"conditions":{"major_version":2},"activation_id":"${activation.id}","organization_id":"${organizationId}","key":"${key}"}`,
      );

      equal(reordered.status, 200);

      const plain = await host.post('validate', {
        key,
        organization_id: organizationId,
      });

      equal(plain.status, 200);
      equal(JSON.parse(plain.text).activation, null);
      equal(JSON.parse(plain.text).validations, 3);

      const deactivated = await host.post('deactivate', {
        key,
        organization_id: organizationId,
        activation_id: activation.id,
      });

      equal([deactivated.status, deactivated.text], [204, '']);

      refused(
        await host.post('validate', withActivation),
        404,
        'ResourceNotFound',
        notFound,
        'validate after deactivate',
      );

      // The desktop fallback: the key still answers, so the activation went.
      const fallback = await host.post('validate', {
        key,
        organization_id: organizationId,
      });

      equal(fallback.status, 200);
      equal(JSON.parse(fallback.text).validations, 4);

      const inspected = await host.sdk.licenseKeys.inspect({ id: granted.id });

      equal(inspected.activation_ids, []);
      equal(inspected.validations, 4);
      equal(
        JSON.stringify(await host.sdk.licenseKeys.list({})).includes(
          'major_version',
        ),
        false,
      );
    } finally {
      output.restore();
    }

    assert(key !== '', 'No key was granted');

    for (const line of output.lines) {
      assert(!line.includes(key), 'The license key reached the console');
      assert(!line.includes('major_version'), 'Conditions reached the console');
    }
  },
);

register(
  'polar.licenseKeys.2',
  operations,
  [],
  false,
  'The pinned @polar-sh/sdk runs the same lifecycle against a loopback serverURL without an access token',
  async () => {
    await using host = await started();
    const granted = await host.grant({ limitActivations: 1 });
    const official = officialClient(host.api);
    const conditions = { major_version: 2 };

    assert(
      new URL(host.api).hostname === '127.0.0.1',
      'The official client left loopback',
    );

    const activation = await official.customerPortal.licenseKeys.activate({
      key: granted.key,
      organizationId,
      label: 'studio',
      conditions,
    });

    equal(activation.licenseKey.id, granted.id);
    equal(activation.licenseKey.status, 'granted');

    const limit = await official.customerPortal.licenseKeys.activate({
      key: granted.key,
      organizationId,
      label: 'second',
    }).catch((error) => error);

    assert(limit instanceof NotPermitted, String(limit));
    equal([limit.error, limit.detail], ['NotPermitted', limitReached]);

    const validated = await official.customerPortal.licenseKeys.validate({
      key: granted.key,
      organizationId,
      activationId: activation.id,
      conditions,
    });

    equal(validated.activation?.id, activation.id);
    equal(validated.validations, 1);

    const plain = await official.customerPortal.licenseKeys.validate({
      key: granted.key,
      organizationId,
    });

    equal(plain.activation ?? null, null);
    equal(plain.validations, 2);

    const mismatch = await official.customerPortal.licenseKeys.validate({
      key: granted.key,
      organizationId,
      activationId: activation.id,
      conditions: { major_version: 3 },
    }).catch((error) => error);

    assert(mismatch instanceof ResourceNotFound, String(mismatch));
    equal(mismatch.detail, conditionsDiffer);

    await official.customerPortal.licenseKeys.deactivate({
      key: granted.key,
      organizationId,
      activationId: activation.id,
    });

    const gone = await official.customerPortal.licenseKeys.validate({
      key: granted.key,
      organizationId,
      activationId: activation.id,
      conditions,
    }).catch((error) => error);

    assert(gone instanceof ResourceNotFound, String(gone));
    equal([gone.error, gone.detail], ['ResourceNotFound', notFound]);

    const invalid = await official.customerPortal.licenseKeys.validate({
      key: granted.key,
      organizationId: 'not-a-uuid',
    }).catch((error) => error);

    assert(invalid instanceof HTTPValidationError, String(invalid));
    equal(invalid.detail?.[0]?.loc, ['body', 'organization_id']);
  },
);

interface Row {
  name: string;
  status: number;
  error: string;
  detail: string;
  /** Builds the state, then returns the request that must be refused. */
  arrange: (host: Awaited<ReturnType<typeof started>>) => Promise<{
    operation: 'activate' | 'validate' | 'deactivate';
    body: Record<string, unknown>;
  }>;
}

async function activate(
  host: Awaited<ReturnType<typeof started>>,
  key: string,
  conditions: Record<string, unknown> = {},
): Promise<string> {
  const result = await host.post('activate', {
    key,
    organization_id: organizationId,
    label: 'device',
    conditions,
  });

  assert(result.status === 200, result.text);

  return JSON.parse(result.text).id;
}

function body(key: unknown, extra: Record<string, unknown> = {}) {
  return { key, organization_id: organizationId, ...extra };
}

async function revoke(
  host: Awaited<ReturnType<typeof started>>,
  key: LicenseKey,
  status: 'revoked' | 'disabled' = 'revoked',
) {
  await host.sdk.licenseKeys.update({ id: key.id, status });
}

function expire(host: Awaited<ReturnType<typeof started>>) {
  host.clock.now += 2 * day;
}

/**
 * Every refusal row of ADR 0038 and the precedence combinations: each row is
 * a fresh host whose state satisfies more than one check where that matters.
 */
const rows: Row[] = [
  ...(['activate', 'validate', 'deactivate'] as const).flatMap((
    operation,
  ): Row[] => [
    {
      name: `${operation}: unknown key`,
      status: 404,
      error: 'ResourceNotFound',
      detail: notFound,
      arrange: () =>
        Promise.resolve({
          operation,
          body: body('CHD-00000000-0000-4000-8000-000000000000', {
            label: 'device',
            activation_id: unknownActivation,
          }),
        }),
    },
    {
      name: `${operation}: wrong organization before a revoked status`,
      status: 404,
      error: 'ResourceNotFound',
      detail: notFound,
      arrange: async (host) => {
        const key = await host.grant({ limitActivations: 1 });
        const activation = await activate(host, key.key);

        await revoke(host, key);

        return {
          operation,
          body: {
            key: key.key,
            organization_id: foreignOrganization,
            label: 'device',
            activation_id: activation,
          },
        };
      },
    },
    {
      name: `${operation}: a key differing only in case is unknown`,
      status: 404,
      error: 'ResourceNotFound',
      detail: notFound,
      arrange: async (host) => {
        const key = await host.grant({ limitActivations: 1 });
        const activation = await activate(host, key.key);

        return {
          operation,
          body: body(key.key.toLowerCase(), {
            label: 'device',
            activation_id: activation,
          }),
        };
      },
    },
  ]),
  ...(['revoked', 'disabled'] as const).map((status): Row => ({
    name: `activate: ${status} before expiry, missing activations and limit`,
    status: 403,
    error: 'NotPermitted',
    detail: notActiveActivate,
    arrange: async (host) => {
      const key = await host.grant({ ttl: 1 });

      await revoke(host, key, status);
      expire(host);

      return { operation: 'activate', body: body(key.key, { label: 'x' }) };
    },
  })),
  {
    name: 'activate: revoked at the activation limit',
    status: 403,
    error: 'NotPermitted',
    detail: notActiveActivate,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1 });

      await activate(host, key.key);
      await revoke(host, key);

      return { operation: 'activate', body: body(key.key, { label: 'x' }) };
    },
  },
  {
    name: 'activate: expired before a benefit without activations',
    status: 403,
    error: 'NotPermitted',
    detail: expired,
    arrange: async (host) => {
      const key = await host.grant({ ttl: 1 });

      expire(host);

      return { operation: 'activate', body: body(key.key, { label: 'x' }) };
    },
  },
  {
    name: 'activate: expired at the activation limit',
    status: 403,
    error: 'NotPermitted',
    detail: expired,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1, ttl: 1 });

      await activate(host, key.key);
      expire(host);

      return { operation: 'activate', body: body(key.key, { label: 'x' }) };
    },
  },
  {
    name: 'activate: benefit without activations',
    status: 403,
    error: 'NotPermitted',
    detail: noActivations,
    arrange: async (host) => ({
      operation: 'activate',
      body: body((await host.grant()).key, { label: 'x' }),
    }),
  },
  {
    name: 'activate: live activation count at the limit',
    status: 403,
    error: 'NotPermitted',
    detail: limitReached,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 2 });

      await activate(host, key.key);
      await activate(host, key.key);

      return { operation: 'activate', body: body(key.key, { label: 'x' }) };
    },
  },
  ...(['revoked', 'disabled'] as const).map((status): Row => ({
    name: `validate: ${status} before expiry and every mismatch`,
    status: 404,
    error: 'ResourceNotFound',
    detail: notActive,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1, ttl: 1 });

      await revoke(host, key, status);
      expire(host);

      return {
        operation: 'validate',
        body: body(key.key, {
          activation_id: unknownActivation,
          benefit_id: unknownActivation,
          customer_id: otherCustomerId,
        }),
      };
    },
  })),
  {
    name: 'validate: expired before an unknown activation and mismatches',
    status: 404,
    error: 'ResourceNotFound',
    detail: expired,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1, ttl: 1 });

      expire(host);

      return {
        operation: 'validate',
        body: body(key.key, {
          activation_id: unknownActivation,
          benefit_id: unknownActivation,
          customer_id: otherCustomerId,
        }),
      };
    },
  },
  {
    name: 'validate: unknown activation before benefit and customer',
    status: 404,
    error: 'ResourceNotFound',
    detail: notFound,
    arrange: async (host) => ({
      operation: 'validate',
      body: body((await host.grant({ limitActivations: 1 })).key, {
        activation_id: unknownActivation,
        benefit_id: unknownActivation,
        customer_id: otherCustomerId,
      }),
    }),
  },
  {
    name: 'validate: deactivated activation',
    status: 404,
    error: 'ResourceNotFound',
    detail: notFound,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1 });
      const activation = await activate(host, key.key);

      await host.sdk.licenseKeys.deactivate({
        id: key.id,
        activationId: activation,
      });

      return {
        operation: 'validate',
        body: body(key.key, { activation_id: activation }),
      };
    },
  },
  {
    name: 'validate: activation of another key',
    status: 404,
    error: 'ResourceNotFound',
    detail: notFound,
    arrange: async (host) => {
      const other = await host.grant({ limitActivations: 1 });
      const key = await host.grant({ limitActivations: 1 });

      return {
        operation: 'validate',
        body: body(key.key, {
          activation_id: await activate(host, other.key),
        }),
      };
    },
  },
  ...([
    ['a different value', { major_version: 3 }],
    ['omitted conditions', undefined],
    ['a subset', {}],
    ['a superset', { major_version: 2, edition: 'pro' }],
    ['a string for a number', { major_version: '2' }],
    ['a boolean for a number', { major_version: true }],
  ] as const).map(([label, conditions]): Row => ({
    name:
      `validate: nonempty conditions differ by ${label} before benefit, customer and usage`,
    status: 404,
    error: 'ResourceNotFound',
    detail: conditionsDiffer,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1, limitUsage: 1 });
      const activation = await activate(host, key.key, { major_version: 2 });

      return {
        operation: 'validate',
        body: body(key.key, {
          activation_id: activation,
          ...(conditions === undefined ? {} : { conditions }),
          benefit_id: unknownActivation,
          customer_id: otherCustomerId,
          increment_usage: 5,
        }),
      };
    },
  })),
  {
    name: 'validate: benefit differs before customer and usage',
    status: 404,
    error: 'ResourceNotFound',
    detail: benefitDiffers,
    arrange: async (host) => ({
      operation: 'validate',
      body: body((await host.grant({ limitUsage: 1 })).key, {
        benefit_id: unknownActivation,
        customer_id: otherCustomerId,
        increment_usage: 5,
      }),
    }),
  },
  {
    name: 'validate: customer differs before usage',
    status: 404,
    error: 'ResourceNotFound',
    detail: customerDiffers,
    arrange: async (host) => {
      const key = await host.grant({ limitUsage: 1 });

      return {
        operation: 'validate',
        body: body(key.key, {
          benefit_id: key.benefit_id,
          customer_id: otherCustomerId,
          increment_usage: 5,
        }),
      };
    },
  },
  {
    name: 'validate: increment exceeds remaining usage',
    status: 400,
    error: 'BadRequest',
    detail: 'License key only has 1 more usages.',
    arrange: async (host) => {
      const key = await host.grant({ limitUsage: 3 });
      const spent = await host.post(
        'validate',
        body(key.key, { increment_usage: 2 }),
      );

      assert(spent.status === 200, spent.text);

      return {
        operation: 'validate',
        body: body(key.key, {
          benefit_id: key.benefit_id,
          customer_id: key.customer_id,
          increment_usage: 2,
        }),
      };
    },
  },
  {
    name: 'deactivate: unknown activation',
    status: 404,
    error: 'ResourceNotFound',
    detail: notFound,
    arrange: async (host) => ({
      operation: 'deactivate',
      body: body((await host.grant({ limitActivations: 1 })).key, {
        activation_id: unknownActivation,
      }),
    }),
  },
  {
    name: 'deactivate: already deactivated activation',
    status: 404,
    error: 'ResourceNotFound',
    detail: notFound,
    arrange: async (host) => {
      const key = await host.grant({ limitActivations: 1 });
      const activation = await activate(host, key.key);
      const first = await host.post(
        'deactivate',
        body(key.key, { activation_id: activation }),
      );

      assert(first.status === 204, first.text);

      return {
        operation: 'deactivate',
        body: body(key.key, { activation_id: activation }),
      };
    },
  },
  {
    name: 'deactivate: activation of another key',
    status: 404,
    error: 'ResourceNotFound',
    detail: notFound,
    arrange: async (host) => {
      const other = await host.grant({ limitActivations: 1 });
      const key = await host.grant({ limitActivations: 1 });

      return {
        operation: 'deactivate',
        body: body(key.key, {
          activation_id: await activate(host, other.key),
        }),
      };
    },
  },
];

register(
  'polar.licenseKeys.3',
  operations,
  [],
  false,
  'Every refusal row and precedence combination answers the exact status, error and detail bytes',
  async (t) => {
    for (const row of rows) {
      await t.step(row.name, async () => {
        await using host = await started();
        const { operation, body } = await row.arrange(host);

        refused(
          await host.post(operation, body),
          row.status,
          row.error,
          row.detail,
          row.name,
        );
      });
    }

    // A refused call changes neither counter nor activations.
    await t.step('refusals leave the counters alone', async () => {
      await using host = await started();
      const key = await host.grant({ limitActivations: 1, limitUsage: 1 });
      const activation = await activate(host, key.key, { major_version: 2 });

      for (
        const request of [
          body(key.key, { activation_id: activation }),
          body(key.key, { customer_id: otherCustomerId }),
          body(key.key, { increment_usage: 2 }),
        ]
      ) {
        assert((await host.post('validate', request)).status !== 200);
      }

      assert(
        (await host.post('activate', body(key.key, { label: 'x' }))).status ===
          403,
      );

      const inspected = await host.sdk.licenseKeys.inspect({ id: key.id });

      equal(
        [inspected.validations, inspected.usage, inspected.last_validated_at],
        [0, 0, null],
      );
      equal(inspected.activation_ids, [activation]);
    });

    // Deactivate rechecks neither status nor expiry.
    await t.step('deactivate frees a revoked and expired key', async () => {
      await using host = await started();
      const key = await host.grant({ limitActivations: 2, ttl: 1 });
      const first = await activate(host, key.key);
      const second = await activate(host, key.key);

      await revoke(host, key);

      equal(
        (await host.post('deactivate', body(key.key, { activation_id: first })))
          .status,
        204,
      );

      expire(host);

      equal(
        (await host.post(
          'deactivate',
          body(key.key, { activation_id: second }),
        ))
          .status,
        204,
      );
      equal(
        (await host.sdk.licenseKeys.inspect({ id: key.id })).activation_ids,
        [],
      );
    });

    // Expiry begins at the instant itself.
    await t.step('expiry starts exactly at expires_at', async () => {
      await using host = await started();
      const key = await host.grant({ ttl: 1 });

      host.clock.now = Date.parse(key.expires_at!) - 1;

      equal((await host.post('validate', body(key.key))).status, 200);

      host.clock.now = Date.parse(key.expires_at!);

      refused(
        await host.post('validate', body(key.key)),
        404,
        'ResourceNotFound',
        expired,
        'validate at expires_at',
      );
    });
  },
);

register(
  'polar.licenseKeys.4',
  operations,
  [],
  false,
  'Validations, usage and the activation limit are counted atomically under concurrency',
  async (t) => {
    await t.step('usage grows only by positive increments', async () => {
      await using host = await started();
      const key = await host.grant({ limitUsage: 5 });

      for (const increment of [undefined, null, 0, 2, 3]) {
        const result = await host.post(
          'validate',
          body(key.key, { increment_usage: increment }),
        );

        assert(result.status === 200, result.text);
      }

      const inspected = await host.sdk.licenseKeys.inspect({ id: key.id });

      equal([inspected.validations, inspected.usage], [5, 5]);

      refused(
        await host.post('validate', body(key.key, { increment_usage: 1 })),
        400,
        'BadRequest',
        'License key only has 0 more usages.',
        'exhausted usage',
      );

      // A plain validation consumes nothing and still succeeds.
      equal((await host.post('validate', body(key.key))).status, 200);
    });

    await t.step('an unlimited key counts usage without a bound', async () => {
      await using host = await started();
      const key = await host.grant();
      const result = await host.post(
        'validate',
        body(key.key, { increment_usage: 1000 }),
      );

      equal(JSON.parse(result.text).usage, 1000);
    });

    await t.step('concurrent activations never exceed the limit', async () => {
      await using host = await started();
      const key = await host.grant({ limitActivations: 3 });
      const results = await Promise.all(
        Array.from(
          { length: 12 },
          (_, index) =>
            host.post('activate', body(key.key, { label: `mac-${index}` })),
        ),
      );

      equal(results.filter((result) => result.status === 200).length, 3);

      for (const result of results.filter((result) => result.status !== 200)) {
        refused(result, 403, 'NotPermitted', limitReached, 'concurrent');
      }

      equal(
        (await host.sdk.licenseKeys.inspect({ id: key.id })).activation_ids
          .length,
        3,
      );
    });

    await t.step(
      'concurrent validations neither lose nor overrun',
      async () => {
        await using host = await started();
        const key = await host.grant({ limitUsage: 10 });
        const results = await Promise.all(
          Array.from(
            { length: 16 },
            () => host.post('validate', body(key.key, { increment_usage: 1 })),
          ),
        );

        equal(results.filter((result) => result.status === 200).length, 10);

        const inspected = await host.sdk.licenseKeys.inspect({ id: key.id });

        equal([inspected.validations, inspected.usage], [10, 10]);
      },
    );
  },
);

register(
  'polar.licenseKeys.5',
  operations,
  [],
  false,
  'Request validation and version selection refuse before lookup and mutation without echoing the key or conditions',
  async (t) => {
    await using host = await started();
    const key = await host.grant({ limitActivations: 1 });
    const secret = key.key;
    const cases: [
      string,
      'activate' | 'validate' | 'deactivate',
      unknown,
      { loc: (string | number)[]; msg: string; type: string }[],
    ][] = [
      ['malformed JSON', 'activate', `{"key":"${secret}"`, [
        { type: 'json_invalid', loc: ['body'], msg: 'JSON decode error' },
      ]],
      ['empty body', 'validate', '', [
        { type: 'missing', loc: ['body'], msg: 'Field required' },
      ]],
      ['array body', 'deactivate', [secret], [{
        type: 'model_attributes_type',
        loc: ['body'],
        msg:
          'Input should be a valid dictionary or object to extract fields from',
      }]],
      ['missing activate fields', 'activate', {}, [
        { type: 'missing', loc: ['body', 'key'], msg: 'Field required' },
        {
          type: 'missing',
          loc: ['body', 'organization_id'],
          msg: 'Field required',
        },
        { type: 'missing', loc: ['body', 'label'], msg: 'Field required' },
      ]],
      ['missing deactivate activation', 'deactivate', body(secret), [
        {
          type: 'missing',
          loc: ['body', 'activation_id'],
          msg: 'Field required',
        },
      ]],
      ['invalid organization UUID', 'validate', {
        key: secret,
        organization_id: `${secret}-x`,
      }, [{
        type: 'uuid_parsing',
        loc: ['body', 'organization_id'],
        msg: 'Input should be a valid UUID',
      }]],
      ['non-string key', 'validate', body(42), [{
        type: 'string_type',
        loc: ['body', 'key'],
        msg: 'Input should be a valid string',
      }]],
      [
        'invalid activation UUID',
        'validate',
        body(secret, {
          activation_id: secret,
        }),
        [{
          type: 'uuid_parsing',
          loc: ['body', 'activation_id'],
          msg: 'Input should be a valid UUID',
        }],
      ],
      [
        'negative increment',
        'validate',
        body(secret, {
          increment_usage: -1,
        }),
        [{
          type: 'greater_than_equal',
          loc: ['body', 'increment_usage'],
          msg: 'Input should be greater than or equal to 0',
        }],
      ],
      [
        'fractional increment',
        'validate',
        body(secret, {
          increment_usage: 1.5,
        }),
        [{
          type: 'int_from_float',
          loc: ['body', 'increment_usage'],
          msg:
            'Input should be a valid integer, got a number with a fractional part',
        }],
      ],
      [
        'conditions not an object',
        'validate',
        body(secret, {
          conditions: [secret],
        }),
        [{
          type: 'dict_type',
          loc: ['body', 'conditions'],
          msg: 'Input should be a valid dictionary',
        }],
      ],
      [
        'condition name too long',
        'activate',
        body(secret, {
          label: 'x',
          conditions: { [`major_version_${'x'.repeat(40)}`]: 2 },
        }),
        [{
          type: 'string_too_long',
          loc: ['body', 'conditions'],
          msg: 'String should have at most 40 characters',
        }],
      ],
      [
        'empty condition value',
        'activate',
        body(secret, {
          label: 'x',
          conditions: { major_version: '' },
        }),
        [{
          type: 'string_too_short',
          loc: ['body', 'conditions'],
          msg: 'String should have at least 1 character',
        }],
      ],
      [
        'nested meta value',
        'activate',
        body(secret, {
          label: 'x',
          meta: { device: { serial: secret } },
        }),
        [{
          type: 'string_type',
          loc: ['body', 'meta'],
          msg: 'Input should be a valid string',
        }],
      ],
      [
        'too many conditions',
        'activate',
        body(secret, {
          label: 'x',
          conditions: Object.fromEntries(
            Array.from({ length: 51 }, (_, index) => [`c${index}`, index]),
          ),
        }),
        [{
          type: 'too_long',
          loc: ['body', 'conditions'],
          msg:
            'Dictionary should have at most 50 items after validation, not 51',
        }],
      ],
    ];

    for (const [name, operation, request, detail] of cases) {
      await t.step(name, async () => {
        const result = await host.post(operation, request);

        equal(result.status, 422);
        equal(JSON.parse(result.text), {
          error: 'RequestValidationError',
          detail,
        });
        assert(!result.text.includes(secret), 'The key was echoed');
        assert(!result.text.includes('major_version'), 'A condition leaked');
        equal(result.headers.get('polar-version'), apiVersion);
      });
    }

    await t.step('validation precedes the key lookup', async () => {
      const result = await host.post('validate', {
        key: 'CHD-UNKNOWN',
        organization_id: organizationId,
        increment_usage: -1,
      });

      equal(result.status, 422);
    });

    await t.step('unknown members are ignored', async () => {
      const result = await host.post('validate', body(secret, { extra: 1 }));

      equal(result.status, 200);
    });

    await t.step(
      'an unsupported Polar-Version refuses before mutation',
      async () => {
        const result = await host.post(
          'activate',
          body(secret, { label: 'x' }),
          { 'polar-version': '2025-01' },
        );

        refused(
          result,
          404,
          'UnsupportedOperation',
          `Only Polar-Version ${apiVersion} is emulated.`,
          'unsupported version',
        );
        equal(
          (await host.sdk.licenseKeys.inspect({ id: key.id })).activation_ids,
          [],
        );

        const pinned = await host.post(
          'validate',
          body(secret),
          { 'polar-version': apiVersion },
        );

        equal(pinned.status, 200);
      },
    );

    await t.step('only the three routes are public', async () => {
      for (
        const [method, path] of [
          ['POST', '/v1/license-keys/validate'],
          ['GET', '/v1/customer-portal/license-keys'],
          ['GET', `${portal}/validate`],
          ['POST', '/v1/customers/'],
        ]
      ) {
        const response = await fetch(`${host.api}${path}`, {
          method: method!,
          headers: { 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(body(secret)) } : {}),
        });

        equal(
          [response.status, (await response.json()).error],
          [401, 'Unauthorized'],
        );
      }

      const { apiKey } = await host.sdk.keys.create({});
      const unsupported = await fetch(
        `${host.api}/v1/license-keys/validate`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body(secret)),
        },
      );

      equal(
        [unsupported.status, (await unsupported.json()).error],
        [404, 'UnsupportedOperation'],
      );
    });
  },
);
