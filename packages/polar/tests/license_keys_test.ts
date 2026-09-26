// Polar fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { memoryAdapter } from '../../emulon/src/state/store.ts';
import { sqliteCoordinator } from '../../emulon/src/runtime/sqlite-state.ts';
import { makeCustomer } from '../src/model/customers.ts';
import { fixtures } from '../src/model/customers.ts';
import { PolarError } from '../src/model/errors.ts';
import {
  activateLicenseKey,
  activationRefusal,
  addInterval,
  benefitInput,
  createBenefit,
  deactivateLicenseKey,
  displayKey,
  generateKey,
  getLicenseKey,
  grantLicenseKey,
  inspection,
  inspectLicenseKey,
  isExpired,
  listLicenseKeys,
  makeBenefit,
  makeKey,
  sameKey,
  type StoredKey,
  toActivation,
  updateLicenseKey,
} from '../src/model/license_keys.ts';
import { properties, readExcerpt, validate } from './schema.ts';
import { organizationId } from './customers_cases.ts';
import { assert, equal, rejects } from './assert.ts';

const excerpt = await readExcerpt('license-keys');
const createdAt = '2026-09-26T00:00:00.000Z';
const upper =
  /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;

function customer() {
  return makeCustomer(
    { email: 'ada@example.test', name: 'Ada' },
    crypto.randomUUID(),
    organizationId,
    createdAt,
  );
}

function benefit(input: Parameters<typeof makeBenefit>[0] = {
  description: 'Chorded Pro',
}) {
  return makeBenefit(input, crypto.randomUUID(), organizationId, createdAt);
}

const version = { pluginVersion: '0.1.0', schemaVersion: 1 };

async function open(
  extra: { collection: string; id: string; value: unknown }[] = [],
) {
  return await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'billing',
    version,
    fixtures: [...fixtures({ organizationId }), ...extra],
  });
}

/** The durable adapter serializes transactions independently of memory. */
async function openDurable() {
  // The coordinator requires a canonical path, and macOS temp is a symlink.
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const coordinator = sqliteCoordinator(`${directory}/state.db`);

  coordinator.prepare([{
    instanceId: 'billing',
    plugin: '@emulon/polar',
    version,
  }]);

  const handle = await coordinator.open({
    environmentId: coordinator.environmentId,
    instanceId: 'billing',
    version,
    fixtures: fixtures({ organizationId }),
  });

  return {
    store: handle.store,
    close() {
      handle.close();
      coordinator.close();
      Deno.removeSync(directory, { recursive: true });
    },
  };
}

async function refusal(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof PolarError, String(error));

    return { status: error.status, code: error.code, detail: error.message };
  }

  throw new Error('Expected a refusal');
}

Deno.test('Polar license key projections match the pinned 2026-04 schemas', () => {
  const full = benefit({
    description: 'Chorded Pro',
    prefix: 'chd',
    limitActivations: 3,
    enableCustomerAdmin: false,
    ttl: 1,
    timeframe: 'year',
    limitUsage: 10,
  });
  const bare = benefit();

  for (const value of [full, bare]) {
    equal(Object.keys(value), properties(excerpt, 'BenefitLicenseKeys'));
    equal(
      Object.keys(value.properties),
      properties(excerpt, 'BenefitLicenseKeysProperties'),
    );
    equal(
      validate(excerpt, '#/components/schemas/BenefitLicenseKeys', value),
      [],
    );
  }

  // The management input is the create schema, with the organization bound.
  equal(
    validate(excerpt, '#/components/schemas/BenefitLicenseKeysCreate', {
      type: 'license_keys',
      description: full.description,
      properties: full.properties,
    }),
    [],
  );

  const owner = customer();
  const key = makeKey(
    full,
    owner.id,
    crypto.randomUUID(),
    generateKey('chd'),
    createdAt,
  );
  const read = { ...key, customer: owner };

  equal(Object.keys(read).sort(), properties(excerpt, 'LicenseKeyRead').sort());
  equal(validate(excerpt, '#/components/schemas/LicenseKeyRead', read), []);
  equal(
    Object.keys(owner),
    properties(excerpt, 'LicenseKeyCustomer'),
  );

  const activation = toActivation({
    id: crypto.randomUUID(),
    license_key_id: key.id,
    label: 'MacBook',
    meta: { os: 'macos', cores: 8, beta: true },
    conditions: { major: 1 },
    created_at: createdAt,
    modified_at: null,
    deleted_at: null,
  });

  equal(
    Object.keys(activation),
    properties(excerpt, 'LicenseKeyActivationBase'),
  );
  equal(
    validate(excerpt, '#/components/schemas/LicenseKeyWithActivations', {
      ...read,
      activations: [activation],
    }),
    [],
  );
  assert(!('conditions' in activation), 'Conditions leaked into a projection');

  // The checker must reject, or it proves nothing about the projections.
  for (
    const [schema, broken] of [
      ['LicenseKeyRead', { ...read, status: 'pending' }],
      ['LicenseKeyRead', { ...read, customer: undefined }],
      ['LicenseKeyWithActivations', read],
      ['BenefitLicenseKeys', { ...full, type: 'custom' }],
      ['BenefitLicenseKeysCreate', {
        type: 'license_keys',
        description: 'ab',
        properties: {},
      }],
      ['BenefitLicenseKeysCreate', {
        type: 'license_keys',
        description: 'Chorded Pro',
        properties: { activations: { limit: 0, enable_customer_admin: true } },
      }],
    ] as const
  ) {
    assert(
      validate(excerpt, `#/components/schemas/${schema}`, broken).length > 0,
      `Schema checker accepted a broken ${schema}`,
    );
  }

  const diagnostic = inspection(key, []);

  assert(!('key' in diagnostic), 'Inspection exposed the key');
  equal(diagnostic.display_key, key.display_key);
});

Deno.test('Polar license key generation, display and comparison', () => {
  const keys = new Set<string>();

  for (let i = 0; i < 100; i++) {
    const key = generateKey(null);

    assert(upper.test(key), `Not an uppercase UUID4: ${key}`);
    keys.add(key);
  }

  equal(keys.size, 100);

  const prefixed = generateKey(' chd ');

  assert(prefixed.startsWith('CHD-') && upper.test(prefixed.slice(4)));
  // Only a present, nonempty prefix is prepended.
  assert(upper.test(generateKey('')));
  equal(
    generateKey('ab', () => '00000000-0000-4000-8000-00000000abcd'),
    'AB-00000000-0000-4000-8000-00000000ABCD',
  );
  equal(displayKey('AB-00000000-0000-4000-8000-00000000ABCD'), '****-00ABCD');
  assert(sameKey('ABC', 'ABC'));
  assert(!sameKey('ABC', 'abc'));
  assert(!sameKey('ABC', 'ABCD'));
});

Deno.test('Polar license key expiry uses calendar arithmetic', () => {
  equal(
    addInterval('2026-01-31T10:00:00.000Z', 1, 'month'),
    '2026-02-28T10:00:00.000Z',
  );
  equal(
    addInterval('2028-01-31T10:00:00.000Z', 1, 'month'),
    '2028-02-29T10:00:00.000Z',
  );
  equal(
    addInterval('2026-11-30T00:00:00.000Z', 3, 'month'),
    '2027-02-28T00:00:00.000Z',
  );
  equal(
    addInterval('2028-02-29T00:00:00.000Z', 1, 'year'),
    '2029-02-28T00:00:00.000Z',
  );
  equal(
    addInterval('2026-09-26T12:00:00.000Z', 2, 'year'),
    '2028-09-26T12:00:00.000Z',
  );
  equal(
    addInterval('2026-03-28T12:00:00.000Z', 30, 'day'),
    '2026-04-27T12:00:00.000Z',
  );

  const key = { expires_at: '2026-10-01T00:00:00.000Z' };
  const at = Date.parse(key.expires_at);

  assert(!isExpired(key, at - 1));
  assert(isExpired(key, at));
  assert(!isExpired({ expires_at: null }, Number.MAX_SAFE_INTEGER));

  const granted = makeKey(
    benefit({ description: 'Chorded Pro', ttl: 1, timeframe: 'month' }),
    crypto.randomUUID(),
    crypto.randomUUID(),
    generateKey(null),
    '2026-01-31T10:00:00.000Z',
  );

  equal(granted.expires_at, '2026-02-28T10:00:00.000Z');
  equal(
    makeKey(benefit(), crypto.randomUUID(), crypto.randomUUID(), 'K', createdAt)
      .expires_at,
    null,
  );
});

Deno.test('Polar benefit input binds paired fields and positive bounds', () => {
  const ok = [
    { description: 'Pro' },
    { description: 'x'.repeat(42) },
    { description: 'Pro', limitActivations: 3, enableCustomerAdmin: false },
    { description: 'Pro', ttl: 1, timeframe: 'day' },
    { description: 'Pro', limitUsage: 2147483647, prefix: 'chd' },
  ];

  for (const input of ok) {
    assert(benefitInput.safeParse(input).success, JSON.stringify(input));
  }

  const broken = [
    { description: 'ab' },
    { description: 'x'.repeat(43) },
    { description: 'Pro', limitActivations: 3 },
    { description: 'Pro', enableCustomerAdmin: true },
    { description: 'Pro', ttl: 1 },
    { description: 'Pro', timeframe: 'month' },
    { description: 'Pro', ttl: 1, timeframe: 'week' },
    { description: 'Pro', limitActivations: 0, enableCustomerAdmin: true },
    { description: 'Pro', ttl: -1, timeframe: 'day' },
    { description: 'Pro', limitUsage: 2147483648 },
    { description: 'Pro', limitUsage: 1.5 },
    { description: 'Pro', organizationId },
    { description: 'Pro', type: 'license_keys' },
    { description: 'Pro', key: 'CALLER-KEY' },
  ];

  for (const input of broken) {
    assert(!benefitInput.safeParse(input).success, JSON.stringify(input));
  }

  const made = benefit({
    description: 'Pro',
    limitActivations: 3,
    enableCustomerAdmin: true,
  });

  equal(made.properties, {
    prefix: null,
    expires: null,
    activations: { limit: 3, enable_customer_admin: true },
    limit_usage: null,
  });
  equal(
    makeKey(made, crypto.randomUUID(), crypto.randomUUID(), 'K', createdAt)
      .limit_activations,
    3,
  );
  equal(
    makeKey(benefit(), crypto.randomUUID(), crypto.randomUUID(), 'K', createdAt)
      .limit_activations,
    null,
  );
});

Deno.test('Polar activation refusals follow the pinned order', () => {
  const key: StoredKey = makeKey(
    benefit({
      description: 'Pro',
      limitActivations: 1,
      enableCustomerAdmin: false,
      ttl: 1,
      timeframe: 'day',
    }),
    crypto.randomUUID(),
    crypto.randomUUID(),
    'K',
    createdAt,
  );
  const now = Date.parse(createdAt);
  const expired = Date.parse(key.expires_at!);
  const inactive =
    'License key is no longer active. This license key can not be activated.';

  equal(activationRefusal(key, 0, now), null);
  equal(
    activationRefusal(key, 1, now),
    'License key activation limit already reached',
  );
  equal(activationRefusal(key, 1, expired), 'License key has expired.');
  equal(activationRefusal({ ...key, status: 'revoked' }, 1, expired), inactive);
  equal(activationRefusal({ ...key, status: 'disabled' }, 0, now), inactive);
  equal(
    activationRefusal({ ...key, limit_activations: null }, 0, now),
    'This license key does not support activations. Use the /validate endpoint instead to check license validity.',
  );
  equal(
    activationRefusal({ ...key, limit_activations: null }, 0, expired),
    'License key has expired.',
  );
});

Deno.test('Polar grant retries a colliding key and rejects foreign records', async () => {
  const foreign = crypto.randomUUID();
  const foreignCustomer = {
    ...customer(),
    email: 'foreign@example.test',
    organization_id: foreign,
  };
  const foreignBenefit = {
    ...benefit(),
    organization_id: foreign,
  };
  const handle = await open([
    { collection: 'customers', id: foreignCustomer.id, value: foreignCustomer },
    { collection: 'benefits', id: foreignBenefit.id, value: foreignBenefit },
  ]);
  const store = handle.store;

  try {
    const owner = customer();

    await store.transaction((tx) =>
      tx.put({ collection: 'customers', id: owner.id, value: owner })
    );

    const created = await createBenefit(store, { description: 'Chorded Pro' });
    const fixed = '00000000-0000-4000-8000-000000000001';
    const first = await grantLicenseKey(
      store,
      { benefitId: created.id, customerId: owner.id },
      Date.now,
      () => fixed,
    );
    const ids = [fixed, fixed, '00000000-0000-4000-8000-000000000002'];
    const second = await grantLicenseKey(
      store,
      { benefitId: created.id, customerId: owner.id },
      Date.now,
      () => ids.shift()!,
    );

    equal(first.key, fixed.toUpperCase());
    equal(second.key, '00000000-0000-4000-8000-000000000002');
    equal(ids, []);
    // Exhausted retries write nothing.
    await rejects(() =>
      grantLicenseKey(
        store,
        { benefitId: created.id, customerId: owner.id },
        Date.now,
        () => fixed,
      )
    );
    equal((await listLicenseKeys(store)).length, 2);

    for (
      const [input, detail] of [
        [
          { benefitId: created.id, customerId: crypto.randomUUID() },
          'Customer not found.',
        ],
        [
          { benefitId: crypto.randomUUID(), customerId: owner.id },
          'Benefit not found.',
        ],
        [
          { benefitId: created.id, customerId: foreignCustomer.id },
          'Customer not found.',
        ],
        [
          { benefitId: foreignBenefit.id, customerId: owner.id },
          'Benefit not found.',
        ],
        [
          { benefitId: 'not-a-uuid', customerId: owner.id },
          'Benefit not found.',
        ],
      ] as const
    ) {
      equal(await refusal(() => grantLicenseKey(store, input)), {
        status: 404,
        code: 'ResourceNotFound',
        detail,
      });
    }

    equal((await listLicenseKeys(store)).length, 2);
  } finally {
    handle.close();
  }
});

for (
  const [adapter, opener] of [['memory', open], [
    'sqlite',
    openDurable,
  ]] as const
) {
  Deno.test(`Polar activation limit holds under concurrent activation (${adapter})`, async () => {
    const handle = await opener();
    const store = handle.store;

    try {
      const owner = customer();

      await store.transaction((tx) =>
        tx.put({ collection: 'customers', id: owner.id, value: owner })
      );

      const created = await createBenefit(store, {
        description: 'Chorded Pro',
        limitActivations: 3,
        enableCustomerAdmin: false,
      });
      const granted = await grantLicenseKey(store, {
        benefitId: created.id,
        customerId: owner.id,
      });
      const activate = (label: string) =>
        activateLicenseKey(store, {
          key: granted.key,
          organizationId,
          label,
          conditions: {},
          meta: {},
        });
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) => activate(`device ${i}`)),
      );
      const accepted = results.filter((result) =>
        result.status === 'fulfilled'
      );
      const refused = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );

      equal(accepted.length, 3);
      equal(refused.length, 9);

      for (const reason of refused) {
        assert(reason instanceof PolarError);
        equal([reason.status, reason.code, reason.message], [
          403,
          'NotPermitted',
          'License key activation limit already reached',
        ]);
      }

      const live = (await getLicenseKey(store, granted.id)).activations;

      equal(live.length, 3);
      equal(
        (await inspectLicenseKey(store, granted.id)).activation_ids.sort(),
        live.map((activation) => activation.id).sort(),
      );

      // Freeing races with activation; the count never exceeds the limit.
      const [freed, ...more] = await Promise.allSettled([
        deactivateLicenseKey(store, {
          id: granted.id,
          activationId: live[0]!.id,
        }),
        ...Array.from({ length: 4 }, (_, i) => activate(`late ${i}`)),
      ]);

      equal(freed.status, 'fulfilled');
      equal(more.filter((result) => result.status === 'fulfilled').length, 1);
      equal((await getLicenseKey(store, granted.id)).activations.length, 3);

      // A freed activation cannot be freed again, nor through another key.
      equal(
        await refusal(() =>
          deactivateLicenseKey(store, {
            id: granted.id,
            activationId: live[0]!.id,
          })
        ),
        {
          status: 404,
          code: 'ResourceNotFound',
          detail: 'License key activation not found.',
        },
      );

      const other = await grantLicenseKey(store, {
        benefitId: created.id,
        customerId: owner.id,
      });

      equal(
        await refusal(() =>
          deactivateLicenseKey(store, {
            id: other.id,
            activationId: live[1]!.id,
          })
        ),
        {
          status: 404,
          code: 'ResourceNotFound',
          detail: 'License key activation not found.',
        },
      );

      // Status changes keep the key, counters and activations.
      const revoked = await updateLicenseKey(store, {
        id: granted.id,
        status: 'revoked',
      });

      equal(revoked.key, granted.key);
      equal(
        await refusal(() => activate('revoked')),
        {
          status: 403,
          code: 'NotPermitted',
          detail:
            'License key is no longer active. This license key can not be activated.',
        },
      );

      const regranted = await updateLicenseKey(store, {
        id: granted.id,
        status: 'granted',
      });

      equal(regranted.key, granted.key);
      equal((await getLicenseKey(store, granted.id)).activations.length, 3);

      // Lookup requires the exact key in this organization.
      for (
        const [key, organization] of [
          [granted.key.toLowerCase(), organizationId],
          [granted.key, crypto.randomUUID()],
          [`${granted.key} `, organizationId],
        ]
      ) {
        equal(
          await refusal(() =>
            activateLicenseKey(store, {
              key: key!,
              organizationId: organization!,
              label: 'x',
              conditions: {},
              meta: {},
            })
          ),
          { status: 404, code: 'ResourceNotFound', detail: 'Not found' },
        );
      }
    } finally {
      handle.close();
    }
  });
}
