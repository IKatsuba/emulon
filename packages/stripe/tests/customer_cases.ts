import stripe from '@emulon/stripe';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { client, type Flavor } from './flavors.ts';

type Register = ReturnType<typeof caseRegistry>['register'];

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

async function officialClientContract(flavor: Flavor) {
  const f = observed();
  await using env = await Emulon.start({
    services: { stripe: f.plugin(flavor.options), other: stripe() },
  });
  const { apiKey } = await env.services.stripe.keys.create({});

  assert(apiKey.startsWith('sk_test_'));

  const sdk = client(flavor, env.endpoints.stripe.api!, apiKey);
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
  // Dahlia names the Account representing a customer, which the emulator
  // does not have.
  assert(
    flavor.accountFields
      ? read.customer_account === null
      : !Object.hasOwn(read, 'customer_account'),
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
    flavor,
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
    assert(e instanceof flavor.Stripe.errors.StripeIdempotencyError);
  }

  try {
    await sdk.customers.retrieve('cus_missing');

    throw new Error('Expected missing');
  } catch (e) {
    assert(
      e instanceof flavor.Stripe.errors.StripeInvalidRequestError &&
        e.code === 'resource_missing',
    );
  }

  const snapshot = await f.store().transaction(async (tx) => ({
    rows: await tx.list('customers'),
    events: await tx.outbox(),
  }));

  assert(snapshot.rows.length === 1 && snapshot.events.length === 1);

  // The store keeps a canonical fact; the event list shows it in the
  // version of the request that caused it.
  const event = (await env.events.list({}))[0]!.payload as {
    id: string;
    api_version: string;
    data: { object: { id: string } };
  };

  assert(
    event.id.startsWith('evt_') && event.api_version === flavor.version &&
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

    assert(response.headers.get('stripe-version') === flavor.version);

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

/** The official client contract for customers, through one flavor. */
export function customerCases(flavor: Flavor, register: Register) {
  register(
    `${flavor.prefix}.customers.1`,
    ['customers.create', 'customers.get'],
    ['customer.created'],
    false,
    'official client, concurrent replay, authentication and strict surface',
    () => officialClientContract(flavor),
  );
}
