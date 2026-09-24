import stripe from '@emulon/stripe';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { memoryAdapter, type Store } from '../../emulon/src/state/store.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { expired, fingerprint, fixtures } from '../src/model/customers.ts';
import type { CustomerCommandInput } from '../src/model/customers.ts';
import { perform } from '../src/operations.ts';
import { dahlia } from '../src/versions/dahlia/mod.ts';
import { matchesKey } from '../src/auth/keys.ts';
import { compatibility } from '../src/compatibility.ts';
import {
  caseRegistry,
  verifyCoverage,
} from '../../emulon/tests/helpers/compatibility.ts';

import { cases as webhookCases } from './webhook_cases.ts';
import { cases as billingCases } from './billing_cases.ts';
import { cases as basilCases } from './basil_cases.ts';
import { customerCases } from './customer_cases.ts';
import { client, dahliaFlavor } from './flavors.ts';

const { cases, register } = caseRegistry(
  'packages/stripe/tests/customers_test.ts',
);

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function rejects(action: () => unknown) {
  try {
    await action();
  } catch {
    return;
  }

  throw new Error('Expected rejection');
}

/** Create a customer as the control command does, without a started host. */
function createCustomer(
  store: Store,
  { idempotencyKey, ...input }: CustomerCommandInput,
  now: () => number = Date.now,
) {
  return perform(store, dahlia, {
    operation: 'customers.create',
    path: '/v1/customers',
    parsed: { input, expand: [] },
    idempotencyKey,
  }, now()) as Promise<{ id: string }>;
}

function observed() {
  let store!: PluginContext['store'];
  const { definition } = readRegistration(stripe());
  const plugin = definePlugin({
    ...definition,
    setup(ctx, options) {
      store = ctx.store;

      return definition.setup(ctx, options);
    },
  });

  return { plugin, store: () => store };
}

Deno.test('Stripe pure rules, expiry boundary, transactional rollback and fixtures', async () => {
  assert(
    fingerprint('POST', '/v1/customers', { name: 'A', email: 'B' }) ===
      fingerprint('POST', '/v1/customers', { email: 'B', name: 'A' }),
  );
  assert(
    fingerprint('POST', '/v1/customers', { name: '' }) !==
      fingerprint('POST', '/v1/customers', {}),
  );
  assert(!expired(100, 86400099) && expired(100, 86400100));
  assert(
    matchesKey('Bearer sk_test_a', 'sk_test_a') &&
      !matchesKey('Bearer sk_test_b', 'sk_test_a'),
  );

  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'stripe',
    version: { pluginVersion: '0.1.0', schemaVersion: 1 },
    fixtures: fixtures({
      fixtures: { customers: [{ id: 'cus_fixture', name: 'Seed' }] },
    }),
  });
  const store = handle.store;

  try {
    assert((await store.transaction((tx) => tx.outbox())).length === 0);
    await rejects(() =>
      Promise.resolve(
        fixtures({
          fixtures: { customers: [{ id: 'cus_same' }, { id: 'cus_same' }] },
        }),
      )
    );

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
      createCustomer(broken, { name: 'A', idempotencyKey: 'retry' }, () => 100)
    );
    assert(
      (await store.transaction((tx) => tx.list('customers'))).length === 1,
    );
    assert(
      (await store.transaction((tx) => tx.list('idempotency'))).length === 0,
    );
    assert((await store.transaction((tx) => tx.outbox())).length === 0);

    const first = await createCustomer(store, {
      name: 'A',
      idempotencyKey: 'retry',
    }, () => 100);

    assert(
      (await createCustomer(
        store,
        { name: 'A', idempotencyKey: 'retry' },
        () => 86400099,
      )).id === first.id,
    );
    assert(
      (await createCustomer(
        store,
        { name: 'B', idempotencyKey: 'retry' },
        () => 86400100,
      )).id !== first.id,
    );
    assert((await store.transaction((tx) => tx.outbox())).length === 2);

    const stale = store.scope();

    await handle.reset();
    await rejects(() => createCustomer(stale, { idempotencyKey: 'stale' }));
    assert(
      (await store.transaction((tx) => tx.list('customers'))).length === 1,
    );
  } finally {
    handle.close();
  }
});

customerCases(dahliaFlavor, register);
cases.push(...webhookCases, ...billingCases, ...basilCases);
verifyCoverage(compatibility, cases);

for (const test of cases) {
  Deno.test(`${test.id}: ${test.name}`, test.run);
}

Deno.test('Stripe untested compatibility operation fails even with a reused case ID', () => {
  const changed = structuredClone(compatibility);
  const mutant = {
    ...changed,
    operations: [...changed.operations, {
      ...changed.operations[1]!,
      id: 'customers.untested',
      path: '/v1/untested',
    }],
  };
  let rejected = false;

  try {
    verifyCoverage(mutant, cases);
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message === 'Compatibility coverage mismatch: operations');

    rejected = true;
  }

  assert(rejected, 'Untested operation accepted');
});

Deno.test('Stripe CLI and connected SDK share durable customer and idempotency state', async () => {
  const directory = await Deno.makeTempDir();
  const f = observed();
  const config = { services: { stripe: f.plugin() } };
  let host = await serveEnvironment(config, { directory });

  try {
    const cli = async (args: string[]) => {
      const result = await runProjectCLI(
        ['stripe', ...args, '--json'],
        undefined,
        directory,
      );

      assert(result.code === 0, result.stderr);

      return JSON.parse(result.stdout);
    };

    const first = await cli([
      'customers',
      'create',
      '--name',
      'CLI',
      '--idempotency-key',
      'shared',
    ]);
    const key = await cli(['keys', 'create']);

    {
      await using connected = await Emulon.connect({ config, directory });

      assert(
        (await connected.services.stripe.customers.create({
          name: 'CLI',
          idempotencyKey: 'shared',
        })).id === first.id,
      );
      assert(
        (await cli(['customers', 'get', '--id', first.id])).id === first.id,
      );

      const created = await connected.services.stripe.customers.create({
        name: 'SDK',
        idempotencyKey: 'sdk',
      });

      assert(
        (await cli([
          'customers',
          'create',
          '--name',
          'SDK',
          '--idempotency-key',
          'sdk',
        ])).id === created.id,
      );
    }

    const before = await f.store().transaction((tx) => tx.outbox());

    await host[Symbol.asyncDispose]();

    host = await serveEnvironment(config, { directory });

    await using connected = await Emulon.connect({ config, directory });
    const sdk = client(
      dahliaFlavor,
      connected.endpoints.stripe.api!,
      key.apiKey,
    );

    assert(
      (await sdk.customers.create({ name: 'CLI' }, {
        idempotencyKey: 'shared',
      })).id === first.id,
    );
    assert(
      JSON.stringify(await f.store().transaction((tx) => tx.outbox())) ===
        JSON.stringify(before),
    );

    const changed = await runProjectCLI(
      [
        'stripe',
        'customers',
        'create',
        '--name',
        'changed',
        '--idempotency-key',
        'shared',
        '--json',
      ],
      undefined,
      directory,
    );

    assert(changed.code !== 0);
  } finally {
    await host[Symbol.asyncDispose]();
    await Deno.remove(directory, { recursive: true });
  }
});
