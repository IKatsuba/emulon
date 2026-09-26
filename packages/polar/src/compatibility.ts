import { type CompatibilityManifest, defineCompatibility } from 'emulon';

export const compatibility: CompatibilityManifest = defineCompatibility({
  'schemaVersion': 1,
  'plugin': '@emulon/polar',
  'provider': {
    'name': 'Polar',
    'api': 'Polar API',
  },
  'operations': [
    {
      'id': 'customers.create',
      'method': 'POST',
      'path': '/v1/customers/',
      'surface': 'api',
      'version': '2026-04',
      'auth': [
        'local-bearer-organization-access-token',
      ],
      'input': [
        'email',
        'name',
        'external_id',
        'type',
      ],
      'output':
        'id, created_at, modified_at, metadata, external_id, email, email_verified, type, name, billing_name, billing_address, tax_id, locale, organization_id, default_payment_method_id, deleted_at, first_user_event_at, avatar_url',
      'events': [
        'customer.created',
      ],
      'cases': [
        'polar.customers.1',
        'polar.customers.2',
        'polar.webhooks.1',
        'polar.webhooks.2',
        'polar.webhooks.3',
        'polar.parity.1',
      ],
    },
    {
      'id': 'customers.get',
      'method': 'GET',
      'path': '/v1/customers/:id',
      'surface': 'api',
      'version': '2026-04',
      'auth': [
        'local-bearer-organization-access-token',
      ],
      'input': [
        'id',
      ],
      'output':
        'id, created_at, modified_at, metadata, external_id, email, email_verified, type, name, billing_name, billing_address, tax_id, locale, organization_id, default_payment_method_id, deleted_at, first_user_event_at, avatar_url',
      'events': [],
      'cases': [
        'polar.customers.1',
        'polar.customers.2',
        'polar.webhooks.2',
        'polar.webhooks.3',
        'polar.parity.1',
      ],
    },
  ],
  'versions': [
    {
      'id': '2026-04',
      'accepted': [
        '2026-04',
      ],
      'headers': [
        'polar-version',
      ],
      'missing':
        'A missing header selects the pinned 2026-04 slice, never a moving current version.',
      'unknown':
        'Any other value returns 404 UnsupportedOperation after authentication and before mutation.',
    },
  ],
  'authentication': {
    'flows': [
      'local-bearer-organization-access-token',
    ],
    'keyFormats': [
      'polar_oat_ opaque local organization access token',
    ],
    'ownership':
      'One token authorizes one local organization instance; reset invalidates issued tokens.',
    'unsupported': [
      'Real Polar organizations and sandbox accounts',
      'OAuth access and refresh tokens, personal access tokens',
      'Customer and member sessions',
      'Token scopes and expiration',
    ],
  },
  'events': [
    {
      'id': 'customer.created',
      'providerName': 'customer.created',
      'version': '2026-04',
      'projection':
        'type, timestamp, api_version and data containing the customer projection',
      'cases': [
        'polar.customers.1',
        'polar.customers.2',
        'polar.webhooks.1',
        'polar.webhooks.2',
        'polar.webhooks.3',
        'polar.parity.1',
      ],
    },
  ],
  'webhooks': {
    'signing':
      'Standard Webhooks framing: webhook-id, webhook-timestamp, webhook-signature v1,<base64 HMAC-SHA256> over the exact bytes of id.timestamp.body, plus webhook-api-version 2026-04; the key is the entire configured secret as UTF-8 bytes, including any whsec_ prefix',
    'id':
      'Delivery-scoped webhook-id, stable across retries and manual redelivery',
    'body': 'Exact serialized envelope bytes frozen on the first attempt',
    'success': 'Any 2xx response; redirects are not followed',
    'timeoutMs': 10000,
    'retries':
      'Local deterministic approximation: ten attempts in total, with min(1000 * 2 ** n, 1200000) milliseconds after failed attempt n from 1 to 9; the tenth failure is terminal',
    'redelivery':
      'Manual after a terminal state; refused while a delivery is queued or in flight',
    'recovery':
      'An interrupted in-flight send becomes failed with an unknown outcome and needs a manual redelivery; queued retries resume after a restart',
    'cases': [
      'polar.webhooks.1',
      'polar.webhooks.2',
      'polar.webhooks.3',
      'polar.parity.1',
    ],
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
      'id': 'polar.limitation.1',
      'description':
        'Only customer creation and reading over HTTP; products, prices, checkouts, orders, subscriptions, the customer portal including license key activation and validation, the authenticated benefit, benefit-grant and license-key APIs, benefit_grant events, payment methods, refunds, lists, updates and deletion are unsupported. License key benefits, grants, status changes and activation release exist only as local management commands',
    },
    {
      'id': 'polar.limitation.2',
      'description':
        'Only type individual; team customers, owner members, metadata, billing address, tax ID, locale and organization_id inputs are rejected before mutation',
    },
    {
      'id': 'polar.limitation.3',
      'description':
        'Billing, identity verification, member creation and avatar lookup are not implemented, so billing_name, billing_address, tax_id, locale, default_payment_method_id, first_user_event_at and avatar_url are always null and email_verified is always false',
    },
    {
      'id': 'polar.limitation.4',
      'description':
        'Local email and external ID uniqueness is case-sensitive and there is no idempotency-key promise',
    },
    {
      'id': 'polar.limitation.5',
      'description': 'An empty external ID is rejected locally',
    },
    {
      'id': 'polar.limitation.6',
      'description':
        'Issued polar_oat_ tokens are random local secrets without the upstream checksum suffix, scopes or expiration',
    },
    {
      'id': 'polar.limitation.7',
      'description':
        'Only the legacy custom-secret signing mode: the secret is never stripped or base64-decoded, so newly generated dashboard whsec_ secrets, which Standard Webhooks decodes instead, are not supported and no signing-mode selection is offered',
    },
    {
      'id': 'polar.limitation.8',
      'description':
        'POST accepts /v1/customers with or without the trailing slash instead of redirecting the unslashed form',
    },
    {
      'id': 'polar.limitation.10',
      'description':
        'The retry schedule is a local deterministic approximation of the documented exponential retries, without jitter, endpoint disablement, delivery ordering guarantees or email notifications',
    },
    {
      'id': 'polar.limitation.11',
      'description':
        'webhook-id is scoped to one delivery to one destination rather than being a Polar event ID shared across destinations',
    },
    {
      'id': 'polar.limitation.12',
      'description':
        'Interrupted sends are not recovered automatically: they end failed with an unknown outcome and a manual redelivery is required, which is itself refused while an automatic attempt is queued or in flight',
    },
    {
      'id': 'polar.limitation.13',
      'description':
        'Local license_keys benefits always report selectable, deletable and visibility_configurable true, is_deleted false, visibility public and empty metadata; product attachment, visibility and deletion are not implemented',
    },
    {
      'id': 'polar.limitation.9',
      'description':
        'Credentials are checked before the Polar-Version header, so an unauthorized request with an unsupported version returns 401',
    },
  ],
  'verification': {
    'mode': 'official-client',
    'client': '@polar-sh/sdk@0.49.0',
    'suites': [
      {
        'path': 'packages/polar/tests/customers_cases.ts',
        'cases': [
          'polar.customers.1',
          'polar.customers.2',
        ],
      },
      {
        'path': 'packages/polar/tests/webhook_cases.ts',
        'cases': [
          'polar.webhooks.1',
          'polar.webhooks.2',
          'polar.webhooks.3',
        ],
      },
      {
        'path': 'packages/polar/tests/parity_cases.ts',
        'cases': [
          'polar.parity.1',
        ],
      },
    ],
    'sources': [
      'https://raw.githubusercontent.com/polarsource/polar/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/docs/openapi/2026-04.openapi.json',
      'https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/docs/snippets/api-reference/versioning.mdx',
      'https://polar.sh/docs/integrate/authentication',
      'https://github.com/polarsource/polar-js/blob/v0.49.0/src/lib/config.ts',
      'https://polar.sh/docs/integrate/webhooks/delivery',
      'https://github.com/polarsource/polar-js/blob/v0.49.0/src/webhooks.ts',
      'https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/webhook/tasks.py',
    ],
    'retrieved': '2026-09-22',
    'liveProviderCompared': false,
  },
  'details': {
    'licenseKeys':
      'Local management commands benefits.create and licenseKeys.grant, list, get, update, deactivate and inspect act on the instance organization only; grant generates an uppercase random UUID4 key behind the optional benefit prefix and returns it in full as LicenseKeyRead does, while inspection, errors, status and events never carry it; customers and benefits of another organization are not found; no benefit_grant event is recorded',
    'schema':
      'Pinned Polar OpenAPI 2026-04 at commit 5514f6a85e9e856857f8662a58d1deb69bc4a2fd, SHA-256 616cd5bad20b9170be8ba0640c9d729009b5dbd39c29e9ede928d36ea21fd0d6; the selected excerpt is retained in packages/polar/tests/fixtures/polar-2026-04-customers.openapi.json',
    'organization':
      'One instance is one organization with a stable local UUID; the token fixes the organization, so organization_id is never accepted as input',
    'webhookSecret':
      'The legacy custom-secret mode signs with the whole UTF-8 secret, matching the pinned @polar-sh/sdk@0.49.0 verifier, which base64-encodes the secret before handing it to Standard Webhooks; secrets generated by the dashboard after 2026-09-08 are decoded instead and are not claimed here',
    'errors':
      '401 Unauthorized for missing or unknown tokens, 404 UnsupportedOperation for unsupported routes and versions, 404 ResourceNotFound for a missing customer, 409 CustomerAlreadyExists for a duplicate email or external ID, 422 detail list for malformed, unsupported or invalid input; unsupported-field locations name the container only, never the supplied key; diagnostic codes and duplicate behavior are local contracts',
  },
});
