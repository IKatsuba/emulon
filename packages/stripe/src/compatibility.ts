import { type CompatibilityManifest, defineCompatibility } from 'emulon';

const dahlia = '2026-04-22.dahlia';
const basil = '2025-03-31.basil';
const auth = ['local-bearer-api-key'];

type Operation = CompatibilityManifest['operations'][number];
type Event = CompatibilityManifest['events'][number];

/** What one shipped version spells differently, and its verification. */
interface Flavor {
  version: string;
  /** Case ID prefix, distinct per version. */
  prefix: string;
  client: string;
  promotionInput: string[];
  promotionOutput: string;
  promotionExpand: string[];
  managedPayments: string[];
  /** Hosted Checkout, the only `ui_mode` emulated, as the version spells it. */
  uiMode: string;
  suites: { path: string; cases: string[] }[];
}

const flavors: Flavor[] = [{
  version: dahlia,
  prefix: 'stripe',
  client: 'stripe@22.1.1',
  promotionInput: ['promotion[type]=coupon', 'promotion[coupon]'],
  promotionOutput: 'PromotionCode with promotion { type, coupon }',
  promotionExpand: ['expand[] (promotion.coupon)'],
  managedPayments: ['managed_payments[enabled]'],
  uiMode: 'ui_mode=hosted_page',
  suites: [{
    path: 'packages/stripe/tests/webhook_cases.ts',
    cases: ['stripe.webhooks.1', 'stripe.webhooks.2'],
  }, {
    path: 'packages/stripe/tests/customers_test.ts',
    cases: ['stripe.customers.1'],
  }, {
    path: 'packages/stripe/tests/billing_cases.ts',
    cases: [
      'stripe.catalog.1',
      'stripe.discounts.1',
      'stripe.checkout.1',
      'stripe.payments.1',
      'stripe.webhooks.3',
    ],
  }],
}, {
  version: basil,
  prefix: 'stripe.basil',
  client: 'stripe@18.0.0',
  promotionInput: ['coupon'],
  promotionOutput: 'PromotionCode with the whole Coupon as top-level coupon',
  promotionExpand: ['expand[] (coupon is always embedded)'],
  managedPayments: [],
  uiMode: 'ui_mode=hosted',
  suites: [{
    path: 'packages/stripe/tests/basil_cases.ts',
    cases: [
      'stripe.basil.customers.1',
      'stripe.basil.webhooks.1',
      'stripe.basil.webhooks.2',
      'stripe.basil.catalog.1',
      'stripe.basil.discounts.1',
      'stripe.basil.checkout.1',
      'stripe.basil.payments.1',
      'stripe.basil.webhooks.3',
    ],
  }],
}];

function operations(flavor: Flavor): Operation[] {
  const { version } = flavor;
  const list = ['limit', 'starting_after', 'ending_before', 'expand[]'];
  const catalog = [`${flavor.prefix}.catalog.1`];
  const discounts = [`${flavor.prefix}.discounts.1`];
  const checkout = [`${flavor.prefix}.checkout.1`];
  const payments = [`${flavor.prefix}.payments.1`];

  function api(
    id: string,
    method: Operation['method'],
    path: string,
    input: string[],
    output: string,
    cases: string[],
    events: string[] = [],
  ): Operation {
    return {
      id,
      method,
      path,
      surface: 'api',
      version,
      auth,
      input,
      output,
      events,
      cases,
    };
  }

  return [
    api(
      'customers.create',
      'POST',
      '/v1/customers',
      [
        'name',
        'email',
        'description',
        'phone',
        'metadata',
        'Idempotency-Key header',
      ],
      'Customer',
      [`${flavor.prefix}.customers.1`],
      ['customer.created'],
    ),
    api(
      'customers.get',
      'GET',
      '/v1/customers/:id',
      ['id'],
      'Customer',
      [`${flavor.prefix}.customers.1`],
    ),
    api(
      'products.create',
      'POST',
      '/v1/products',
      [
        'id',
        'name',
        'active',
        'description',
        'metadata',
        'tax_code',
        'statement_descriptor',
        'unit_label',
        'url',
      ],
      'Product',
      catalog,
    ),
    api(
      'products.get',
      'GET',
      '/v1/products/:id',
      ['id'],
      'Product',
      catalog,
    ),
    api(
      'products.update',
      'POST',
      '/v1/products/:id',
      [
        'name',
        'active',
        'description',
        'metadata',
        'tax_code',
        'default_price',
      ],
      'Product',
      catalog,
    ),
    api(
      'products.list',
      'GET',
      '/v1/products',
      ['active', 'ids', ...list],
      'List of products, newest first',
      catalog,
    ),
    api(
      'prices.create',
      'POST',
      '/v1/prices',
      [
        'product',
        'unit_amount',
        'currency',
        'lookup_key',
        'transfer_lookup_key',
        'active',
        'nickname',
        'tax_behavior',
        'metadata',
      ],
      'One-time Price',
      catalog,
    ),
    api(
      'prices.get',
      'GET',
      '/v1/prices/:id',
      ['id'],
      'Price',
      catalog,
    ),
    api(
      'prices.update',
      'POST',
      '/v1/prices/:id',
      [
        'active',
        'nickname',
        'lookup_key',
        'transfer_lookup_key',
        'tax_behavior',
        'metadata',
      ],
      'Price',
      catalog,
    ),
    api(
      'prices.list',
      'GET',
      '/v1/prices',
      ['active', 'product', 'currency', 'type', 'lookup_keys[]', ...list],
      'List of prices, newest first',
      catalog,
    ),
    api(
      'coupons.create',
      'POST',
      '/v1/coupons',
      [
        'id',
        'percent_off',
        'amount_off',
        'currency',
        'duration',
        'duration_in_months',
        'max_redemptions',
        'redeem_by',
        'name',
        'applies_to[products][]',
        'metadata',
      ],
      'Coupon',
      discounts,
    ),
    api(
      'coupons.get',
      'GET',
      '/v1/coupons/:id',
      ['id'],
      'Coupon',
      discounts,
    ),
    api(
      'coupons.delete',
      'DELETE',
      '/v1/coupons/:id',
      ['id'],
      'Deleted coupon',
      discounts,
    ),
    api(
      'promotion_codes.create',
      'POST',
      '/v1/promotion_codes',
      [
        ...flavor.promotionInput,
        'code',
        'active',
        'customer',
        'expires_at',
        'max_redemptions',
        'restrictions[first_time_transaction]',
        'restrictions[minimum_amount]',
        'restrictions[minimum_amount_currency]',
        'metadata',
        ...flavor.promotionExpand,
      ],
      flavor.promotionOutput,
      discounts,
    ),
    api(
      'promotion_codes.get',
      'GET',
      '/v1/promotion_codes/:id',
      ['id', ...flavor.promotionExpand],
      flavor.promotionOutput,
      discounts,
    ),
    api(
      'promotion_codes.update',
      'POST',
      '/v1/promotion_codes/:id',
      ['active', 'metadata', ...flavor.promotionExpand],
      flavor.promotionOutput,
      discounts,
    ),
    api(
      'promotion_codes.list',
      'GET',
      '/v1/promotion_codes',
      ['active', 'code', 'coupon', 'customer', ...list],
      'List of promotion codes, newest first',
      discounts,
    ),
    api(
      'checkout.sessions.create',
      'POST',
      '/v1/checkout/sessions',
      [
        'mode=payment',
        'line_items[][price]',
        'line_items[][quantity]',
        'customer',
        'customer_email',
        'customer_creation',
        'client_reference_id',
        'allow_promotion_codes',
        'discounts[][promotion_code]',
        'discounts[][coupon]',
        'success_url',
        'cancel_url',
        'expires_at',
        'locale',
        'payment_method_types[]',
        flavor.uiMode,
        ...flavor.managedPayments,
        'metadata',
      ],
      'Checkout Session with a local hosted url',
      checkout,
    ),
    api(
      'checkout.sessions.get',
      'GET',
      '/v1/checkout/sessions/:id',
      ['id', 'expand[]'],
      'Checkout Session',
      checkout,
    ),
    api(
      'checkout.sessions.list',
      'GET',
      '/v1/checkout/sessions',
      ['payment_intent', 'customer', 'status', ...list],
      'List of Checkout Sessions, newest first',
      checkout,
    ),
    api(
      'checkout.sessions.line_items',
      'GET',
      '/v1/checkout/sessions/:id/line_items',
      ['id', 'limit'],
      'List of line items',
      checkout,
    ),
    api(
      'checkout.sessions.expire',
      'POST',
      '/v1/checkout/sessions/:id/expire',
      ['id'],
      'Expired Checkout Session',
      checkout,
      ['checkout.session.expired'],
    ),
    {
      'id': 'checkout.page.get',
      'method': 'GET',
      'path': '/c/pay/:id',
      'surface': 'web',
      'version': version,
      'auth': ['unguessable-session-url'],
      'input': ['id'],
      'output': 'Local HTML payment page',
      'events': [],
      'cases': checkout,
    },
    {
      'id': 'checkout.page.pay',
      'method': 'POST',
      'path': '/c/pay/:id',
      'surface': 'web',
      'version': version,
      'auth': ['unguessable-session-url', 'form-token'],
      'input': ['action=pay|cancel', 'email', 'name', 'promotion_code'],
      'output': '303 to success_url with {CHECKOUT_SESSION_ID}, or cancel_url',
      'events': ['checkout.session.completed'],
      'cases': checkout,
    },
    api(
      'payment_intents.get',
      'GET',
      '/v1/payment_intents/:id',
      ['id', 'expand[]'],
      'Succeeded PaymentIntent with latest_charge',
      checkout,
    ),
    api(
      'charges.get',
      'GET',
      '/v1/charges/:id',
      ['id', 'expand[]'],
      'Charge',
      checkout,
    ),
    api(
      'refunds.create',
      'POST',
      '/v1/refunds',
      ['charge', 'payment_intent', 'amount', 'reason', 'metadata'],
      'Succeeded Refund',
      payments,
      ['charge.refunded'],
    ),
    api(
      'refunds.get',
      'GET',
      '/v1/refunds/:id',
      ['id'],
      'Refund',
      payments,
    ),
    api(
      'disputes.get',
      'GET',
      '/v1/disputes/:id',
      ['id'],
      'Dispute',
      payments,
    ),
  ];
}

function events(flavor: Flavor): Event[] {
  const { version } = flavor;
  const checkout = [`${flavor.prefix}.checkout.1`];
  const payments = [`${flavor.prefix}.payments.1`];

  return [
    {
      id: 'customer.created',
      providerName: 'customer.created',
      version,
      projection: 'Event envelope with data.object Customer',
      cases: [`${flavor.prefix}.customers.1`],
    },
    {
      id: 'checkout.session.completed',
      providerName: 'checkout.session.completed',
      version,
      projection:
        'Event envelope with data.object Checkout Session (payment_intent set when paid)',
      cases: checkout,
    },
    {
      id: 'checkout.session.expired',
      providerName: 'checkout.session.expired',
      version,
      projection: 'Event envelope with data.object Checkout Session',
      cases: checkout,
    },
    {
      id: 'charge.refunded',
      providerName: 'charge.refunded',
      version,
      projection:
        'Event envelope with data.object Charge and previous_attributes amount_refunded, refunded',
      cases: payments,
    },
    {
      id: 'charge.dispute.created',
      providerName: 'charge.dispute.created',
      version,
      projection: 'Event envelope with data.object Dispute',
      cases: payments,
    },
    {
      id: 'charge.dispute.closed',
      providerName: 'charge.dispute.closed',
      version,
      projection:
        'Event envelope with data.object Dispute and previous_attributes status',
      cases: payments,
    },
  ];
}

const references = [
  'customers/create',
  'products',
  'prices',
  'coupons',
  'promotion_codes',
  'checkout/sessions',
  'refunds',
  'disputes',
];

export const compatibility: CompatibilityManifest = defineCompatibility({
  schemaVersion: 2,
  plugin: '@emulon/stripe',
  provider: {
    name: 'Stripe',
    api: 'Customers, catalog, discounts, Checkout and payments',
  },
  operations: flavors.flatMap(operations),
  versions: flavors.map(({ version }) => ({
    id: version,
    accepted: [version],
    headers: ['stripe-version'],
    missing:
      'Select the instance account default (apiVersions and defaultApiVersion; dahlia without options)',
    unknown:
      '400 invalid_request_error for unknown or disabled versions before mutation',
  })),
  authentication: {
    flows: ['local-bearer-api-key', 'unguessable-session-url', 'form-token'],
    keyFormats: ['sk_test_ opaque key'],
    ownership:
      'One local account per instance; reset invalidates keys, sessions and page tokens.',
    unsupported: [
      'HTTP Basic',
      'Live keys',
      'Real Stripe accounts',
      'Publishable keys',
    ],
  },
  events: flavors.flatMap(events),
  webhooks: flavors.map(({ version, prefix }) => ({
    version,
    signing:
      'Stripe-Signature: t=Unix seconds,v1=HMAC-SHA256 hex; literal UTF-8 secret',
    id: 'Stable evt_ ID in the event envelope across retries and redelivery',
    body:
      "Exact event snapshot bytes in the endpoint's pinned version, retained across attempts",
    success: 'Any 2xx response',
    retries:
      'Local sandbox approximation: 60s, 1h, 2h after failures; four attempts total; stop on success or disabled destination',
    redelivery:
      'Manual after terminal state; unavailable while queued or in-flight',
    recovery:
      'Interrupted in-flight sends become failed/unknown and require manual redelivery; queued retries resume on restart',
    timeoutMs: 5000,
    cases: [
      `${prefix}.webhooks.1`,
      `${prefix}.webhooks.2`,
      `${prefix}.webhooks.3`,
    ],
  })),
  capabilities: ['http', 'authorization', 'events', 'webhooks', 'reset'],
  limitations: [
    {
      id: 'stripe.versions',
      description:
        'Ships 2026-04-22.dahlia and 2025-03-31.basil; apiVersions selects which an instance serves. Only the differences inside the implemented slice are modeled: basil embeds the whole coupon in a promotion code, has no managed_payments and spells hosted Checkout ui_mode=hosted where dahlia uses hosted_page. In dahlia, customer_account and customer_details business_name and individual_name are always null: the emulator has no Accounts and collects neither name. A promotion code whose coupon was deleted shows basil a deleted coupon stub.',
    },
    {
      id: 'stripe.resources',
      description:
        'Implemented: customers (create, retrieve), products, one-time prices, coupons, promotion codes, payment-mode hosted Checkout (other ui_mode values fail explicitly), payment intents and charges as Checkout produces them, refunds and disputes. Not implemented: subscriptions, invoices, recurring prices, price_data, embedded Checkout, Payment Element, Connect, test clocks, search and customer lists.',
    },
    {
      id: 'stripe.checkout',
      description:
        'Payment happens on the local hosted page or through checkout.sessions.complete; every payment succeeds. No card numbers, 3DS, declines, taxes, shipping, adaptive pricing or Managed Payments behavior: dahlia accepts and ignores managed_payments. customer_creation defaults to if_required, so payment mode creates no Customer.',
    },
    {
      id: 'stripe.disputes',
      description:
        'Disputes are opened and closed through control commands, standing in for the card network. No evidence submission, withdrawals or balance transactions.',
    },
    {
      id: 'stripe.events',
      description:
        'Only the six declared event types are recorded; for example payment_intent.succeeded, charge.succeeded and refund.created are not.',
    },
    {
      id: 'stripe.idempotency',
      description:
        'Every POST honors Idempotency-Key. Concurrent same-key requests serialize and replay; only committed results are cached. Infrastructure failures roll back instead of caching 500s. Lazy expiry after 24 hours. A key is bound to the API version of its first request.',
    },
    {
      id: 'stripe.webhooks',
      description:
        'Retry timing is a local approximation, not the exact Stripe schedule. No ordering guarantee, automatic recovery of interrupted sends, public virtual time or manual resend while an automatic retry is queued.',
    },
  ],
  verification: {
    byVersion: flavors.map(({ version, client, suites }) => ({
      version,
      mode: 'official-client',
      client,
      suites,
      sources: [
        `https://www.npmjs.com/package/stripe/v/${client.split('@')[1]}`,
        ...references.map((path) =>
          `https://docs.stripe.com/api/${path}?api-version=${version}`
        ),
      ],
      retrieved: '2026-09-24',
      liveProviderCompared: false,
    })),
  },
});
