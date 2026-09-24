import Stripe from 'stripe';
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

function client(api: string, apiKey: string) {
  const url = new URL(api);

  return new Stripe(apiKey, {
    host: url.hostname,
    port: Number(url.port),
    protocol: 'http',
    apiVersion: '2026-04-22.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    telemetry: false,
  });
}

async function officialClientContract() {
  const f = observed();
  await using env = await Emulon.start({
    services: { stripe: f.plugin(), other: stripe() },
  });
  const { apiKey } = await env.services.stripe.keys.create({});

  assert(apiKey.startsWith('sk_test_'));

  const sdk = client(env.endpoints.stripe.api!, apiKey);
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        sdk.customers.create({ name: 'Ada', email: 'ada@example.test' }, {
          idempotencyKey: 'one',
        }),
    ),
  );
  const first = results[0]!;

  assert(results.every((x) => x.id === first.id));

  const read = await sdk.customers.retrieve(first.id);

  assert(
    !read.deleted && read.name === 'Ada' && !read.livemode &&
      read.description === null,
  );
  assert(
    (await env.services.stripe.customers.get({ id: first.id })).id ===
      first.id,
  );
  assert(
    (await env.services.stripe.customers.create({
      email: 'ada@example.test',
      name: 'Ada',
      idempotencyKey: 'one',
    })).id === first.id,
  );

  const rotated = client(
    env.endpoints.stripe.api!,
    (await env.services.stripe.keys.create({})).apiKey,
  );

  assert(
    (await rotated.customers.create(
      { name: 'Ada', email: 'ada@example.test' },
      { idempotencyKey: 'one' },
    )).id === first.id,
  );

  try {
    await sdk.customers.create({ name: 'Other' }, { idempotencyKey: 'one' });

    throw new Error('Expected idempotency error');
  } catch (e) {
    assert(e instanceof Stripe.errors.StripeIdempotencyError);
  }

  try {
    await sdk.customers.retrieve('cus_missing');

    throw new Error('Expected missing');
  } catch (e) {
    assert(
      e instanceof Stripe.errors.StripeInvalidRequestError &&
        e.code === 'resource_missing',
    );
  }

  const snapshot = await f.store().transaction(async (tx) => ({
    rows: await tx.list('customers'),
    events: await tx.outbox(),
  }));

  assert(snapshot.rows.length === 1 && snapshot.events.length === 1);

  // The store keeps a canonical fact; the event list shows its dahlia view.
  const event = (await env.events.list({}))[0]!.payload as {
    id: string;
    api_version: string;
    data: { object: { id: string } };
  };

  assert(
    event.id.startsWith('evt_') && event.api_version === '2026-04-22.dahlia' &&
      event.data.object.id === first.id,
  );

  const foreign = (await env.services.other.keys.create({})).apiKey;
  const request = async (
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(env.endpoints.stripe.api! + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    });
    const value = await response.json();

    assert(response.headers.get('stripe-version') === '2026-04-22.dahlia');

    return { status: response.status, value };
  };

  for (
    const credential of [
      '',
      'Bearer sk_test_unknown',
      'Bearer sk_live_bad',
      'Bearer ' + foreign,
      'Basic ignored',
    ]
  ) {
    const result = await request('/v1/customers/' + first.id, undefined, {
      authorization: credential,
    });

    assert(
      result.status === 401 &&
        result.value.error.type === 'authentication_error',
    );
    assert(!JSON.stringify(result.value).includes('sk_'));
  }

  for (
    const body of [
      'name=A&name=B',
      'metadata=x',
      'expand[]=x',
      'idempotencyKey=x',
      'unknown=x',
    ]
  ) {
    assert(
      (await request('/v1/customers', body, {
        'idempotency-key': 'valid-later',
      })).status === 400,
    );
  }

  assert(
    (await request('/v1/customers', 'name=A', {
      'stripe-version': '2024-01-01',
      'idempotency-key': 'valid-later',
    })).status === 400,
  );
  assert(
    (await request('/v1/customers', 'name=A', { 'idempotency-key': '' }))
      .status === 400,
  );
  assert(
    (await request('/v1/customers', 'name=A', {
      'idempotency-key': 'x'.repeat(256),
    })).status === 400,
  );
  assert(
    (await request('/v1/customers', '{}', {
      'content-type': 'application/json',
    })).status === 400,
  );
  assert(
    (await request('/v1/customers/' + first.id + '?expand[]=x')).status ===
      400,
  );
  assert((await request('/v1/customers')).status === 404);
  assert(
    (await request('/v1/customers', 'name=A', {
      'idempotency-key': 'valid-later',
    })).status === 200,
  );
  assert(
    (await request('/v1/customers/' + first.id, undefined, {
      'idempotency-key': 'get-key',
    })).status === 200,
  );
  assert(
    await f.store().transaction((tx) => tx.get('idempotency', 'get-key')) ===
      undefined,
  );
  await rejects(() => env.services.other.customers.get({ id: first.id }));
  await env.reset();
  assert((await request('/v1/customers/' + first.id)).status === 401);
  assert((await f.store().transaction((tx) => tx.outbox())).length === 0);
  assert(
    (await f.store().transaction((tx) => tx.list('idempotency'))).length ===
      0,
  );
  assert(
    (await env.services.stripe.customers.create({
      name: 'Ada',
      idempotencyKey: 'one',
    })).id !== first.id,
  );
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

register(
  'stripe.customers.1',
  ['customers.create', 'customers.get'],
  ['customer.created'],
  false,
  'official client, concurrent replay, authentication and strict surface',
  officialClientContract,
);
cases.push(...webhookCases, ...billingCases);
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
    const sdk = client(connected.endpoints.stripe.api!, key.apiKey);

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
