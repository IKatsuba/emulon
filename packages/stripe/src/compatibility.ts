import { type CompatibilityManifest, defineCompatibility } from 'emulon';

export const compatibility: CompatibilityManifest = defineCompatibility({
  'schemaVersion': 1,
  'plugin': '@emulon/stripe',
  'provider': {
    'name': 'Stripe',
    'api': 'Customers',
  },
  'operations': [
    {
      'id': 'customers.create',
      'method': 'POST',
      'path': '/v1/customers',
      'surface': 'api',
      'version': '2025-03-31.basil',
      'auth': [
        'local-bearer-api-key',
      ],
      'input': [
        'name',
        'email',
        'description',
        'Idempotency-Key header',
      ],
      'output':
        'Partial customer: id, object, created, livemode, name, email, description, metadata',
      'events': [
        'customer.created',
      ],
      'cases': [
        'stripe.customers.1',
      ],
    },
    {
      'id': 'customers.get',
      'method': 'GET',
      'path': '/v1/customers/:id',
      'surface': 'api',
      'version': '2025-03-31.basil',
      'auth': [
        'local-bearer-api-key',
      ],
      'input': [
        'id',
      ],
      'output':
        'Partial customer: id, object, created, livemode, name, email, description, metadata',
      'events': [],
      'cases': [
        'stripe.customers.1',
      ],
    },
  ],
  'versions': [
    {
      'id': '2025-03-31.basil',
      'accepted': [
        '2025-03-31.basil',
      ],
      'headers': [
        'stripe-version',
      ],
      'missing': 'Select 2025-03-31.basil',
      'unknown': '400 invalid_request_error before mutation',
    },
  ],
  'authentication': {
    'flows': [
      'local-bearer-api-key',
    ],
    'keyFormats': [
      'sk_test_ opaque key',
    ],
    'ownership': 'One local account per instance; reset invalidates keys.',
    'unsupported': [
      'HTTP Basic',
      'Live keys',
      'Real Stripe accounts',
    ],
  },
  'events': [
    {
      'id': 'customer.created',
      'providerName': 'customer.created',
      'version': '2025-03-31.basil',
      'projection':
        'id, object, api_version, created, type, livemode, data.object',
      'cases': [
        'stripe.customers.1',
      ],
    },
  ],
  'webhooks': {
    'signing':
      'Stripe-Signature: t=Unix seconds,v1=HMAC-SHA256 hex; literal UTF-8 secret',
    'id': 'Stable evt_ ID in the event envelope across retries and redelivery',
    'body': 'Exact serialized event snapshot bytes retained across attempts',
    'success': 'Any 2xx response',
    'retries':
      'Local sandbox approximation: 60s, 1h, 2h after failures; four attempts total; stop on success or disabled destination',
    'redelivery':
      'Manual after terminal state; unavailable while queued or in-flight',
    'recovery':
      'Interrupted in-flight sends become failed/unknown and require manual redelivery; queued retries resume on restart',
    'timeoutMs': 5000,
    'cases': ['stripe.webhooks.1', 'stripe.webhooks.2'],
  },
  'capabilities': [
    'http',
    'authorization',
    'events',
    'webhooks',
    'reset',
  ],
  'limitations': [
    {
      'id': 'stripe.resources',
      'description':
        'No payments, lists, updates, deletion, expansions, metadata input, Connect or test clocks.',
    },
    {
      'id': 'stripe.idempotency',
      'description':
        'Concurrent same-key requests serialize and replay; only committed results are cached. Infrastructure failures roll back instead of caching 500s. Lazy expiry after 24 hours.',
    },
    {
      'id': 'stripe.webhooks',
      'description':
        'Retry timing is a local approximation, not the exact Stripe schedule. No ordering guarantee, automatic recovery of interrupted sends, public virtual time or manual resend while an automatic retry is queued.',
    },
  ],
  'verification': {
    'mode': 'official-client',
    'client': 'stripe@18.0.0',
    'suites': [{
      'path': 'packages/stripe/tests/webhook_cases.ts',
      'cases': ['stripe.webhooks.1', 'stripe.webhooks.2'],
    }, {
      'path': 'packages/stripe/tests/customers_test.ts',
      'cases': [
        'stripe.customers.1',
      ],
    }],
    'sources': [
      'https://docs.stripe.com/api/customers/create?api-version=2025-03-31.basil',
    ],
    'retrieved': '2026-09-22',
    'liveProviderCompared': false,
  },
});
