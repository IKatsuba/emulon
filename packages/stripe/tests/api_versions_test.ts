// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import type Stripe from 'stripe';
import stripe, { type Options } from '@emulon/stripe';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import {
  basilFlavor,
  type BasilPromotionCode,
  basilVersion,
  client,
  dahliaFlavor,
  dahliaVersion,
  type Flavor,
} from './flavors.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function failure(
  action: () => Promise<unknown>,
): Promise<InstanceType<typeof Stripe.errors.StripeError>> {
  try {
    await action();
  } catch (error) {
    return error as InstanceType<typeof Stripe.errors.StripeError>;
  }

  throw new Error('Expected a Stripe error');
}

const both: Options = { apiVersions: [dahliaVersion, basilVersion] };
const eventTypes = [
  'customer.created',
  'checkout.session.completed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;
const envelopeKeys = [
  'api_version',
  'created',
  'data',
  'id',
  'livemode',
  'object',
  'pending_webhooks',
  'request',
  'type',
];

/** Raw HTTP in an explicit version, to see exactly what each one accepts. */
function http(base: string, apiKey: string) {
  return async (
    version: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': version,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    });

    return {
      status: response.status,
      version: response.headers.get('stripe-version'),
      // deno-lint-ignore no-explicit-any
      value: await response.json() as any,
    };
  };
}

/** A webhook endpoint that verifies with its own flavor's official client. */
function endpoint(flavor: Flavor, secret: string) {
  const events: Stripe.Event[] = [];
  const verifier = new flavor.Stripe('sk_test_unused', {
    apiVersion: flavor.version as typeof dahliaVersion,
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      events.push(
        await verifier.webhooks.constructEventAsync(
          await request.text(),
          request.headers.get('stripe-signature')!,
          secret,
          undefined,
          flavor.Stripe.createSubtleCryptoProvider(),
        ),
      );

      return new Response(null, { status: 204 });
    },
  );

  return {
    events,
    url: `http://127.0.0.1:${server.addr.port}/stripe`,
    [Symbol.asyncDispose]: () => server.shutdown(),
  };
}

async function hostedPay(url: string, fields: Record<string, string> = {}) {
  const page = await (await fetch(url)).text();
  const token = /name="token" value="([^"]+)"/.exec(page)?.[1];

  assert(token, 'Hosted page without a form');

  const paid = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ token, action: 'pay', ...fields }),
  });

  await paid.body?.cancel();
  assert(paid.status === 303, 'Hosted payment failed');
}

/**
 * One application's life against the shared emulator through its own
 * official client: the whole slice, in its own wire format.
 */
async function application(
  flavor: Flavor,
  sdk: Stripe,
  env: Awaited<ReturnType<typeof started>>['env'],
  tag: string,
) {
  const service = env.services.stripe;
  const customers = await Promise.all(
    [1, 2, 3].map(() =>
      sdk.customers.create({ name: tag, email: `${tag}@example.test` }, {
        idempotencyKey: `${tag}-customer`,
      })
    ),
  );

  assert(new Set(customers.map((c) => c.id)).size === 1);

  const customer = customers[0]!;
  const product = await sdk.products.create({ id: `prod_${tag}`, name: tag });
  const price = await sdk.prices.create({
    product: product.id,
    unit_amount: 10000,
    currency: 'usd',
  });

  await sdk.products.create({ name: `${tag} extra` });

  const page = await sdk.prices.list({ product: product.id, limit: 1 });

  assert(page.data[0]!.id === price.id && !page.has_more);

  const coupon = await sdk.coupons.create({ percent_off: 10 });
  const code = await flavor.createPromotionCode(sdk, coupon.id, {
    code: `${tag.toUpperCase()}10`,
    customer: customer.id,
    expand: flavor.expandCoupon,
  });

  assert((flavor.couponOf(code) as Stripe.Coupon).id === coupon.id);

  const base = {
    mode: 'payment' as const,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: 'http://localhost:3000/ok',
  };
  const session = await sdk.checkout.sessions.create({
    ...base,
    customer: customer.id,
    discounts: [{ promotion_code: code.id }],
    metadata: { tag },
  });

  assert(session.amount_total === 9000);
  await hostedPay(session.url!, { name: tag });

  const paid = await sdk.checkout.sessions.retrieve(session.id, {
    expand: ['payment_intent'],
  });
  const intent = paid.payment_intent as Stripe.PaymentIntent;

  assert(paid.status === 'complete' && intent.amount === 9000);

  const expanded = await sdk.paymentIntents.retrieve(intent.id, {
    expand: ['latest_charge'],
  });
  const charge = expanded.latest_charge as Stripe.Charge;

  assert(charge.amount === 9000);
  assert(
    (await sdk.refunds.create({ charge: charge.id, amount: 1000 })).amount ===
      1000,
  );

  const lapsed = await sdk.checkout.sessions.create(base);

  assert((await sdk.checkout.sessions.expire(lapsed.id)).status === 'expired');

  const dispute = await service.disputes.create({
    charge: charge.id,
    apiVersion: flavor.version,
  });

  await service.disputes.close({ id: dispute.id, status: 'won' });
  assert((await sdk.disputes.retrieve(dispute.id)).status === 'won');

  return { customer, code, coupon, session, lapsed, charge };
}

async function started(options: Parameters<typeof stripe>[0]) {
  const env = await Emulon.start({ services: { stripe: stripe(options) } });
  const { apiKey } = await env.services.stripe.keys.create({});

  return { env, apiKey };
}

Deno.test('Stripe serves apps on stripe@18.0.0 and stripe@22.1.1 at once, each endpoint in its pinned version', async () => {
  await using toDahlia = endpoint(dahliaFlavor, 'whsec_dahlia');
  await using toBasil = endpoint(basilFlavor, 'whsec_basil');
  const { env, apiKey } = await started({
    ...both,
    destinations: [{
      id: 'dahlia-app',
      url: toDahlia.url,
      secret: 'whsec_dahlia',
      types: [...eventTypes],
      enabled: true,
    }, {
      id: 'basil-app',
      url: toBasil.url,
      secret: 'whsec_basil',
      types: [...eventTypes],
      enabled: true,
      apiVersion: basilVersion,
    }],
  });

  await using _ = env;

  const api = env.endpoints.stripe.api!;
  const dahlia = client(dahliaFlavor, api, apiKey);
  const basil = client(basilFlavor, api, apiKey);

  assert(basilFlavor.Stripe.PACKAGE_VERSION === '18.0.0');
  assert(dahliaFlavor.Stripe.PACKAGE_VERSION === '22.1.1');

  const [fromDahlia, fromBasil] = await Promise.all([
    application(dahliaFlavor, dahlia, env, 'dahlia'),
    application(basilFlavor, basil, env, 'basil'),
  ]);

  // Created in one version, read in the other: one state behind both.
  const basilCode = await basil.promotionCodes.retrieve(
    fromDahlia.code.id,
  ) as unknown as BasilPromotionCode;

  assert(basilCode.coupon.id === fromDahlia.coupon.id);
  assert(
    (await dahlia.promotionCodes.retrieve(fromBasil.code.id)).promotion
      .coupon === fromBasil.coupon.id,
  );
  assert(
    (await dahlia.checkout.sessions.retrieve(fromBasil.session.id)).metadata
      ?.tag === 'basil',
  );
  assert((await basil.customers.retrieve(fromDahlia.customer.id)).id);

  for (const delivery of await env.services.stripe.webhooks.list({})) {
    await env.services.stripe.webhooks.wait({
      id: delivery.id,
      status: 'succeeded',
      timeout: '10s',
    });
  }

  // Each endpoint gets every event, including those the other app caused,
  // in its own pinned version: endpoint overrides in both directions.
  assert(toDahlia.events.length === 12 && toBasil.events.length === 12);
  assert(toDahlia.events.every((e) => e.api_version === dahliaVersion));
  assert(toBasil.events.every((e) => e.api_version === basilVersion));

  for (const type of eventTypes) {
    const dahliaEvents = toDahlia.events.filter((e) => e.type === type);

    assert(dahliaEvents.length === 2, type);

    for (const event of dahliaEvents) {
      const twin = toBasil.events.find((e) => e.id === event.id)!;

      assert(
        JSON.stringify(Object.keys(event).sort()) ===
            JSON.stringify(envelopeKeys) &&
          JSON.stringify(Object.keys(twin).sort()) ===
            JSON.stringify(envelopeKeys),
        type,
      );
      // The six declared objects have one shape in both versions.
      assert(
        JSON.stringify({ ...event, api_version: '' }) ===
          JSON.stringify({ ...twin, api_version: '' }),
        type,
      );
    }
  }

  // The event list shows each event in the version that caused it; control
  // actions use the account default.
  const views = (await env.events.list({})).map((event) => ({
    type: event.type,
    payload: event.payload as Stripe.Event,
  }));
  const versionOf = (type: string, id: string) =>
    views.find((view) =>
      view.type === type &&
      (view.payload.data.object as { id: string }).id === id
    )!.payload.api_version;

  assert(views.length === 12);

  for (
    const [app, version] of [[fromDahlia, dahliaVersion], [
      fromBasil,
      basilVersion,
    ]] as const
  ) {
    assert(versionOf('customer.created', app.customer.id) === version);
    assert(versionOf('checkout.session.expired', app.lapsed.id) === version);
    assert(versionOf('charge.refunded', app.charge.id) === version);
    // The buyer's hosted page and the network's dispute are not API
    // requests of either app.
    assert(
      versionOf('checkout.session.completed', app.session.id) === dahliaVersion,
    );
  }

  assert(
    views.filter((view) => view.type.startsWith('charge.dispute')).every(
      (view) => view.payload.api_version === dahliaVersion,
    ),
  );
});

Deno.test('Stripe basil embeds the coupon where dahlia nests promotion, and each rejects the other', async () => {
  const { env, apiKey } = await started(both);

  await using _ = env;

  const request = http(env.endpoints.stripe.api!, apiKey);
  const coupon = (await request(basilVersion, '/v1/coupons', 'percent_off=20'))
    .value;
  const basil = await request(
    basilVersion,
    '/v1/promotion_codes',
    `coupon=${coupon.id}&code=BASIL`,
  );
  const dahlia = await request(
    dahliaVersion,
    '/v1/promotion_codes',
    `promotion[type]=coupon&promotion[coupon]=${coupon.id}&code=DAHLIA`,
  );

  // Output: the whole coupon at the top level against a nested reference.
  assert(basil.status === 200 && basil.version === basilVersion);
  assert(
    !('promotion' in basil.value) && basil.value.coupon.object === 'coupon',
  );
  assert(
    basil.value.coupon.id === coupon.id &&
      basil.value.coupon.percent_off === 20 && basil.value.coupon.valid,
  );
  assert(dahlia.status === 200 && dahlia.version === dahliaVersion);
  assert(!('coupon' in dahlia.value));
  assert(
    JSON.stringify(dahlia.value.promotion) ===
      JSON.stringify({ type: 'coupon', coupon: coupon.id }),
  );

  // Everything else is the same object.
  const { coupon: _coupon, ...basilRest } = basil.value;
  const { promotion: _promotion, ...dahliaRest } = await request(
    dahliaVersion,
    `/v1/promotion_codes/${basil.value.id}`,
  ).then((r) => r.value);

  assert(JSON.stringify(basilRest) === JSON.stringify(dahliaRest));

  // Input: each version names the coupon its own way only.
  for (
    const [version, body, param, code] of [
      [
        basilVersion,
        `promotion[type]=coupon&promotion[coupon]=${coupon.id}`,
        'coupon',
        'parameter_missing',
      ],
      [
        basilVersion,
        `coupon=${coupon.id}&promotion[type]=coupon`,
        'promotion',
        'parameter_unknown',
      ],
      [dahliaVersion, `coupon=${coupon.id}`, 'promotion', 'parameter_missing'],
      [
        dahliaVersion,
        `promotion[type]=coupon&promotion[coupon]=${coupon.id}&coupon=${coupon.id}`,
        'coupon',
        'parameter_unknown',
      ],
      [basilVersion, 'coupon=NOPE', 'coupon', 'resource_missing'],
      [
        dahliaVersion,
        'promotion[type]=coupon&promotion[coupon]=NOPE',
        'promotion[coupon]',
        'resource_missing',
      ],
    ] as const
  ) {
    const rejected = await request(version, '/v1/promotion_codes', body);

    assert(
      rejected.status === (code === 'resource_missing' ? 404 : 400) &&
        rejected.version === version &&
        rejected.value.error.type === 'invalid_request_error' &&
        rejected.value.error.param === param &&
        rejected.value.error.code === code,
      `${version} ${body}: ${JSON.stringify(rejected.value)}`,
    );
  }

  // Expansion: dahlia expands promotion.coupon; basil has nothing to expand.
  const expanded = await request(
    dahliaVersion,
    `/v1/promotion_codes/${dahlia.value.id}?expand[]=promotion.coupon`,
  );

  assert(expanded.value.promotion.coupon.id === coupon.id);

  const listed = await request(
    dahliaVersion,
    '/v1/promotion_codes?expand[]=data.promotion.coupon',
  );

  assert(
    listed.value.data.length === 2 &&
      listed.value.data.every((p: { promotion: { coupon: object } }) =>
        typeof p.promotion.coupon === 'object'
      ),
  );

  for (
    const [version, path] of [
      [basilVersion, `/v1/promotion_codes/${basil.value.id}?expand[]=coupon`],
      [
        basilVersion,
        `/v1/promotion_codes/${basil.value.id}?expand[]=promotion.coupon`,
      ],
      [basilVersion, '/v1/promotion_codes?expand[]=data.coupon'],
      [dahliaVersion, `/v1/promotion_codes/${dahlia.value.id}?expand[]=coupon`],
    ] as const
  ) {
    const refused = await request(version, path);

    assert(
      refused.status === 400 && refused.value.error.param === 'expand',
      `${version} ${path}`,
    );
  }

  const basilList = await request(basilVersion, '/v1/promotion_codes');

  assert(
    basilList.value.data.every((p: { coupon: { id: string } }) =>
      p.coupon.id === coupon.id
    ),
  );

  // Official clients see their own shapes of the same codes.
  const api = env.endpoints.stripe.api!;
  const basilClient = client(basilFlavor, api, apiKey);
  const dahliaClient = client(dahliaFlavor, api, apiKey);
  const viaBasil = await basilClient.promotionCodes.retrieve(
    dahlia.value.id,
  ) as unknown as BasilPromotionCode;

  assert(viaBasil.coupon.percent_off === 20);
  assert(
    (await dahliaClient.promotionCodes.retrieve(basil.value.id)).promotion
      .coupon === coupon.id,
  );

  // Basil predates managed payments.
  const price = await dahliaClient.prices.create({
    product: (await dahliaClient.products.create({ name: 'P' })).id,
    unit_amount: 100,
    currency: 'usd',
  });
  const session = {
    mode: 'payment' as const,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: 'http://localhost:3000/ok',
    managed_payments: { enabled: true },
  };
  const refused = await failure(() =>
    basilClient.checkout.sessions.create(session as never)
  );

  assert(
    refused.code === 'parameter_unknown' &&
      refused.param === 'managed_payments',
  );
  assert(
    (await dahliaClient.checkout.sessions.create(session)).status === 'open',
  );

  // A deleted coupon leaves basil a deleted stub, dahlia its ID.
  await dahliaClient.coupons.del(coupon.id);

  const orphan = await request(
    basilVersion,
    `/v1/promotion_codes/${basil.value.id}`,
  );

  assert(
    JSON.stringify(orphan.value.coupon) ===
      JSON.stringify({ id: coupon.id, object: 'coupon', deleted: true }),
  );
  assert(!orphan.value.active);
});

Deno.test('Stripe binds an idempotency key to the version that first used it', async () => {
  const { env, apiKey } = await started(both);

  await using _ = env;

  const api = env.endpoints.stripe.api!;
  const dahlia = client(dahliaFlavor, api, apiKey);
  const basil = client(basilFlavor, api, apiKey);
  const coupon = await dahlia.coupons.create({ percent_off: 5 });
  const again = await basil.promotionCodes.create(
    { coupon: coupon.id, code: 'TWICE' } as never,
    { idempotencyKey: 'twice' },
  );
  const replayed = await basil.promotionCodes.create(
    { coupon: coupon.id, code: 'TWICE' } as never,
    { idempotencyKey: 'twice' },
  );

  // A replay projects the original in the original version.
  assert(JSON.stringify(replayed) === JSON.stringify(again));

  const crossed = await failure(() =>
    dahlia.promotionCodes.create(
      { promotion: { type: 'coupon', coupon: coupon.id }, code: 'TWICE' },
      { idempotencyKey: 'twice' },
    )
  );

  assert(crossed instanceof dahliaFlavor.Stripe.errors.StripeIdempotencyError);

  await dahlia.customers.create({ name: 'Ada' }, { idempotencyKey: 'ada' });

  const other = await failure(() =>
    basil.customers.create({ name: 'Ada' }, { idempotencyKey: 'ada' })
  );

  assert(other instanceof basilFlavor.Stripe.errors.StripeIdempotencyError);
  assert(other.type === 'StripeIdempotencyError');
  assert(
    (await env.events.list({})).filter((e) => e.type === 'customer.created')
      .length === 1,
  );
});

Deno.test('Stripe serves only the versions an instance enables', async () => {
  const { env, apiKey } = await started({
    apiVersions: [basilVersion],
    defaultApiVersion: basilVersion,
  });

  await using _ = env;

  const api = env.endpoints.stripe.api!;
  const refused = await failure(() =>
    client(dahliaFlavor, api, apiKey).customers.create({ name: 'Ada' })
  );

  assert(
    refused.statusCode === 400 && refused.type === 'StripeInvalidRequestError',
  );
  assert(refused.headers?.['stripe-version'] === basilVersion);

  const created = await client(basilFlavor, api, apiKey).customers.create({
    name: 'Ada',
  });
  const request = http(api, apiKey);
  const defaulted = await fetch(`${api}/v1/customers/${created.id}`, {
    headers: { authorization: 'Bearer ' + apiKey },
  });

  assert(defaulted.headers.get('stripe-version') === basilVersion);
  await defaulted.body?.cancel();
  assert(
    (await request(dahliaVersion, `/v1/customers/${created.id}`)).status ===
      400,
  );
  assert(
    ((await env.events.list({}))[0]!.payload as Stripe.Event).api_version ===
      basilVersion,
  );
});

Deno.test('Stripe compatibility shows both versions and their pins through CLI and both SDK modes', async () => {
  const directory = await Deno.makeTempDir();
  const config = { services: { stripe: stripe(both) } };
  const host = await serveEnvironment(config, { directory });

  try {
    await using connected = await Emulon.connect({ config, directory });
    await using start = await Emulon.start(config);
    const cli = await runProjectCLI(
      ['stripe', 'compatibility', 'get', '--json'],
      undefined,
      directory,
    );

    assert(cli.code === 0, cli.stderr);

    const manifest = JSON.parse(cli.stdout);

    assert(
      JSON.stringify(manifest) ===
        JSON.stringify(await connected.services.stripe.compatibility.get({})),
    );
    assert(
      JSON.stringify(manifest) ===
        JSON.stringify(await start.services.stripe.compatibility.get({})),
    );
    assert(manifest.schemaVersion === 2);
    assert(
      JSON.stringify(
        manifest.verification.byVersion.map((
          entry: { version: string; client: string },
        ) => [entry.version, entry.client]),
      ) ===
        JSON.stringify([
          [dahliaVersion, 'stripe@22.1.1'],
          [basilVersion, 'stripe@18.0.0'],
        ]),
    );

    const promotion = (version: string) =>
      manifest.operations.find((
        op: { id: string; version: string },
      ) => op.id === 'promotion_codes.create' && op.version === version);

    assert(promotion(basilVersion).input.includes('coupon'));
    assert(promotion(dahliaVersion).input.includes('promotion[coupon]'));
    assert(
      manifest.events.filter((e: { version: string }) =>
        e.version === basilVersion
      ).length === 6,
    );
  } finally {
    await host[Symbol.asyncDispose]();
    await Deno.remove(directory, { recursive: true });
  }
});
