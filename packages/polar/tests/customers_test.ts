import polar from '@emulon/polar';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { memoryAdapter, type Store } from '../../emulon/src/state/store.ts';
import {
  verifyCoverage,
  webhookCases as declaredWebhookCases,
} from '../../emulon/tests/helpers/compatibility.ts';
import { compatibility } from '../src/compatibility.ts';
import { issuedKey, matchesKey } from '../src/auth/keys.ts';
import {
  apiVersion,
  conflict,
  createCustomer,
  type Customer,
  fixtures,
  fromBody,
  getCustomer,
  getOrganizationId,
  makeCustomer,
  nameLimit,
} from '../src/model/customers.ts';
import { properties, readExcerpt, validate } from './schema.ts';
import { customerCases, organizationId } from './customers_cases.ts';
import { cases as webhookCases } from './webhook_cases.ts';
import { cases as parityCases } from './parity_cases.ts';
import { cases as licenseKeyCases } from './license_keys_cases.ts';
import { assert, equal, rejects } from './assert.ts';

const excerpt = await readExcerpt();

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    ...makeCustomer(
      { email: 'ada@example.test', name: 'Ada', externalId: 'usr_1' },
      crypto.randomUUID(),
      organizationId,
      '2026-09-22T00:00:00.000Z',
    ),
    ...overrides,
  };
}

Deno.test('Polar wire projection matches the pinned 2026-04 schema', () => {
  const value = customer();

  equal(Object.keys(value), properties(excerpt, 'CustomerIndividual'));
  equal(validate(excerpt, '#/components/schemas/Customer', value), []);
  equal(
    validate(excerpt, '#/components/schemas/WebhookCustomerCreatedPayload', {
      type: 'customer.created',
      timestamp: value.created_at,
      api_version: apiVersion,
      data: value,
    }),
    [],
  );

  // The checker must reject, or it proves nothing about the projection.
  for (
    const broken of [
      { ...value, email_verified: 'no' },
      { ...value, id: 42 },
      { ...value, type: 'team' },
      { ...value, created_at: null },
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'email'),
      ),
    ]
  ) {
    assert(
      validate(excerpt, '#/components/schemas/CustomerIndividual', broken)
        .length > 0,
      'Schema checker accepted a broken customer',
    );
  }

  equal(
    validate(excerpt, '#/components/schemas/CustomerCreate', {
      email: 'ada@example.test',
      name: 'Ada',
      external_id: 'usr_1',
      type: 'individual',
    }),
    [],
  );
  assert(
    validate(excerpt, '#/components/schemas/CustomerCreate', { name: 'Ada' })
      .length > 0,
  );
  equal(
    (excerpt as unknown as { 'x-emulon-attribution': { sha256: string } })[
      'x-emulon-attribution'
    ].sha256,
    '616cd5bad20b9170be8ba0640c9d729009b5dbd39c29e9ede928d36ea21fd0d6',
  );
});

Deno.test('Polar pure rules: tokens, body mapping and uniqueness', () => {
  const key = issuedKey();

  assert(key.startsWith('polar_oat_') && key.length === 74);
  assert(matchesKey(`Bearer ${key}`, key));
  assert(!matchesKey(`Bearer ${key} `, key));
  assert(!matchesKey(`bearer ${key}`, key));
  assert(!matchesKey(null, key));
  assert(!matchesKey(`Bearer ${issuedKey()}`, key));

  for (
    const foreign of [
      'polar_at_o_' + '0'.repeat(32),
      'polar_at_u_' + '0'.repeat(32),
      'polar_rt_o_' + '0'.repeat(32),
      'polar_ci_' + '0'.repeat(32),
      're_' + '0'.repeat(32),
    ]
  ) {
    assert(!matchesKey(`Bearer ${foreign}`, foreign), 'Foreign prefix issued');
  }

  equal(fromBody({ email: 'a@example.test' }), { email: 'a@example.test' });
  equal(fromBody({ email: 'a@example.test', name: null, external_id: null }), {
    email: 'a@example.test',
  });
  equal(
    fromBody({
      email: 'a@example.test',
      name: 'Ada',
      external_id: 'usr_1',
      type: 'individual',
    }),
    { email: 'a@example.test', name: 'Ada', externalId: 'usr_1' },
  );
  equal(nameLimit, 256);

  const existing = [customer()];

  equal(conflict(existing, { email: 'ada@example.test' }), 'email');
  equal(
    conflict(existing, { email: 'b@example.test', externalId: 'usr_1' }),
    'external_id',
  );
  equal(conflict(existing, { email: 'ADA@example.test' }), null);
  equal(conflict(existing, { email: 'b@example.test' }), null);
  equal(
    conflict([customer({ external_id: null })], { email: 'b@example.test' }),
    null,
  );
});

Deno.test('Polar fixtures seed one organization without events', async () => {
  const seeded = fixtures({
    organizationId,
    fixtures: {
      customers: [
        { email: 'seed@example.test', externalId: 'usr_seed', name: 'Seed' },
        { email: 'other@example.test' },
      ],
    },
  });

  equal(seeded.length, 3);
  equal(seeded[0], {
    collection: 'organization',
    id: 'self',
    value: { id: organizationId },
  });

  for (const row of seeded.slice(1)) {
    equal((row.value as Customer).organization_id, organizationId);
    equal(validate(excerpt, '#/components/schemas/Customer', row.value), []);
  }

  for (
    const invalid of [
      { organizationId: 'not-a-uuid' },
      { fixtures: { customers: [{ email: 'a@example.test', id: 'nope' }] } },
      {
        fixtures: {
          customers: [
            { email: 'a@example.test', id: organizationId },
            { email: 'b@example.test', id: organizationId },
          ],
        },
      },
      {
        fixtures: {
          customers: [
            { email: 'a@example.test' },
            { email: 'a@example.test' },
          ],
        },
      },
      {
        fixtures: {
          customers: [
            { email: 'a@example.test', externalId: 'usr' },
            { email: 'b@example.test', externalId: 'usr' },
          ],
        },
      },
      { fixtures: { customers: [{ email: 'not-an-email' }] } },
    ]
  ) {
    await rejects(() => Promise.resolve(fixtures(invalid)));
  }

  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'billing',
    version: { pluginVersion: '0.1.0', schemaVersion: 1 },
    fixtures: seeded,
  });

  try {
    equal(await handle.store.transaction((tx) => tx.outbox()), []);
    equal(await getOrganizationId(handle.store), organizationId);
  } finally {
    handle.close();
  }
});

Deno.test('Polar creation is atomic and reset invalidates stale scopes', async () => {
  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'billing',
    version: { pluginVersion: '0.1.0', schemaVersion: 1 },
    fixtures: fixtures({ organizationId }),
  });
  const store = handle.store;

  try {
    const broken: Store = {
      ...store,
      transaction: (work) =>
        store.transaction((tx) =>
          work({
            ...tx,
            record: () => Promise.reject(new Error('Injected failure')),
          })
        ),
    };

    await rejects(() =>
      createCustomer(broken, { email: 'rollback@example.test' })
    );
    equal(await store.transaction((tx) => tx.list('customers')), []);
    equal(await store.transaction((tx) => tx.outbox()), []);

    const created = await createCustomer(
      store,
      { email: 'ada@example.test', externalId: 'usr_1' },
      () => Date.parse('2026-09-22T00:00:00.000Z'),
    );

    equal(created.created_at, '2026-09-22T00:00:00.000Z');
    equal(created.organization_id, organizationId);
    equal((await store.transaction((tx) => tx.outbox())).length, 1);
    equal(
      (await store.transaction((tx) => tx.outbox()))[0]!.occurredAt,
      created.created_at,
    );
    equal((await getCustomer(store, created.id)).id, created.id);
    await rejects(() => getCustomer(store, 'not-a-uuid'));
    await rejects(() => getCustomer(store, crypto.randomUUID()));
    await rejects(() => createCustomer(store, { email: 'ada@example.test' }));
    await rejects(() =>
      createCustomer(store, { email: 'b@example.test', externalId: 'usr_1' })
    );
    await rejects(() => createCustomer(store, { email: 'not-an-email' }));
    equal((await store.transaction((tx) => tx.list('customers'))).length, 1);
    equal((await store.transaction((tx) => tx.outbox())).length, 1);

    const stale = store.scope();

    await handle.reset();
    await rejects(() => createCustomer(stale, { email: 'stale@example.test' }));
    equal(await store.transaction((tx) => tx.list('customers')), []);
    equal(await getOrganizationId(store), organizationId);
  } finally {
    handle.close();
  }
});

Deno.test('Polar declares the emulated capabilities exactly once', () => {
  const { definition } = readRegistration(polar());

  equal([...compatibility.capabilities], [
    'http',
    'authorization',
    'events',
    'webhooks',
    'reset',
  ]);
  equal(declaredWebhookCases(compatibility), [
    'polar.webhooks.1',
    'polar.webhooks.2',
    'polar.webhooks.3',
    'polar.parity.1',
  ]);
  equal(definition.capabilities, [...compatibility.capabilities]);
  equal(definition.name, compatibility.plugin);
});

const contractCases = [
  ...customerCases,
  ...webhookCases,
  ...parityCases,
  ...licenseKeyCases,
];

verifyCoverage(compatibility, contractCases);

for (const test of contractCases) {
  Deno.test(`${test.id}: ${test.name}`, test.run);
}

Deno.test('Polar untested compatibility operation fails even with a reused case ID', () => {
  const changed = structuredClone(compatibility);
  const mutant = {
    ...changed,
    operations: [...changed.operations, {
      ...changed.operations[1]!,
      id: 'customers.list',
      path: '/v1/customers/',
    }],
  };
  let rejected = false;

  try {
    verifyCoverage(mutant, contractCases);
  } catch (error) {
    assert(error instanceof Error);
    equal(error.message, 'Compatibility coverage mismatch: operations');

    rejected = true;
  }

  assert(rejected, 'Untested operation accepted');
});
