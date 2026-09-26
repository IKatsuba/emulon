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
    {
      'id': 'customerPortal.licenseKeys.activate',
      'method': 'POST',
      'path': '/v1/customer-portal/license-keys/activate',
      'surface': 'api',
      'version': '2026-04',
      'auth': [
        'none',
      ],
      'input': [
        'key',
        'organization_id',
        'label',
        'conditions',
        'meta',
      ],
      'output':
        'LicenseKeyActivationCreated: id, license_key_id, label, meta, created_at, modified_at and license_key as GrantedLicenseKey (id, created_at, modified_at, organization_id, customer_id, customer, benefit_id, key, display_key, status, limit_activations, usage, limit_usage, validations, last_validated_at, expires_at)',
      'events': [],
      'cases': [
        'polar.licenseKeys.1',
        'polar.licenseKeys.2',
        'polar.licenseKeys.3',
        'polar.licenseKeys.4',
        'polar.licenseKeys.5',
      ],
    },
    {
      'id': 'customerPortal.licenseKeys.validate',
      'method': 'POST',
      'path': '/v1/customer-portal/license-keys/validate',
      'surface': 'api',
      'version': '2026-04',
      'auth': [
        'none',
      ],
      'input': [
        'key',
        'organization_id',
        'activation_id',
        'benefit_id',
        'customer_id',
        'increment_usage',
        'conditions',
      ],
      'output':
        'ValidatedLicenseKey: id, created_at, modified_at, organization_id, customer_id, customer, benefit_id, key, display_key, status, limit_activations, usage, limit_usage, validations, last_validated_at, expires_at, activation as LicenseKeyActivationBase or null',
      'events': [],
      'cases': [
        'polar.licenseKeys.1',
        'polar.licenseKeys.2',
        'polar.licenseKeys.3',
        'polar.licenseKeys.4',
        'polar.licenseKeys.5',
      ],
    },
    {
      'id': 'customerPortal.licenseKeys.deactivate',
      'method': 'POST',
      'path': '/v1/customer-portal/license-keys/deactivate',
      'surface': 'api',
      'version': '2026-04',
      'auth': [
        'none',
      ],
      'input': [
        'key',
        'organization_id',
        'activation_id',
      ],
      'output': '204 with no body',
      'events': [],
      'cases': [
        'polar.licenseKeys.1',
        'polar.licenseKeys.2',
        'polar.licenseKeys.3',
        'polar.licenseKeys.4',
        'polar.licenseKeys.5',
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
        'Any other value returns 404 UnsupportedOperation before mutation: after authentication on token routes, and without any token on the public customer-portal license-key routes.',
    },
  ],
  'authentication': {
    'flows': [
      'local-bearer-organization-access-token',
      'none',
    ],
    'keyFormats': [
      'polar_oat_ opaque local organization access token',
    ],
    'ownership':
      'One token authorizes one local organization instance; reset invalidates issued tokens. The public customer-portal license-key routes read no token: the exact key together with the instance organization_id is the credential, and a key of another organization is indistinguishable from an unknown key.',
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
        'Only customer creation and reading and the public customer-portal license-key activate, validate and deactivate routes over HTTP; products, prices, checkouts, orders, subscriptions, the rest of the customer portal, the authenticated benefit, benefit-grant and license-key APIs, benefit_grant events, payment methods, refunds, lists, updates and deletion are unsupported. License key benefits, grants and status changes exist only as local management commands',
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
      'id': 'polar.limitation.14',
      'description':
        'License keys are never deleted locally, so the deleted-key refusal rows of activate and lookup cannot occur',
    },
    {
      'id': 'polar.limitation.15',
      'description':
        'Public request validation is a safe projection of Pydantic: each issue carries only type, loc and msg; loc stops at the metadata field without the member name; an invalid UUID reports uuid_parsing without the parser suffix; an invalid metadata value reports only the first union member; UUIDs are not checked for version 4; strings are not coerced to integers',
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
        'path': 'packages/polar/tests/license_keys_cases.ts',
        'cases': [
          'polar.licenseKeys.1',
          'polar.licenseKeys.2',
          'polar.licenseKeys.3',
          'polar.licenseKeys.4',
          'polar.licenseKeys.5',
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
      'https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/customer_portal/endpoints/license_keys.py',
      'https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py',
      'https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/exception_handlers.py',
      'https://github.com/polarsource/polar-js/blob/v0.49.0/src/funcs/customerPortalLicenseKeysValidate.ts',
    ],
    'retrieved': '2026-09-22',
    'liveProviderCompared': false,
  },
  'details': {
    'licenseKeys':
      'Local management commands benefits.create and licenseKeys.grant, list, get, update, deactivate and inspect act on the instance organization only; grant generates an uppercase random UUID4 key behind the optional benefit prefix and returns it in full as LicenseKeyRead does, while inspection, errors, status and events never carry it; customers and benefits of another organization are not found; no benefit_grant event is recorded',
    'schema':
      'Pinned Polar OpenAPI 2026-04 at commit 5514f6a85e9e856857f8662a58d1deb69bc4a2fd, SHA-256 616cd5bad20b9170be8ba0640c9d729009b5dbd39c29e9ede928d36ea21fd0d6; the selected excerpts are retained in packages/polar/tests/fixtures/polar-2026-04-customers.openapi.json and polar-2026-04-license-keys.openapi.json',
    'organization':
      'One instance is one organization with a stable local UUID; on token routes the token fixes the organization, so organization_id is never accepted as input there; the public license-key routes require it in the body and accept only the instance organization',
    'webhookSecret':
      'The legacy custom-secret mode signs with the whole UTF-8 secret, matching the pinned @polar-sh/sdk@0.49.0 verifier, which base64-encodes the secret before handing it to Standard Webhooks; secrets generated by the dashboard after 2026-09-08 are decoded instead and are not claimed here',
    'errors':
      '401 Unauthorized for missing or unknown tokens, 404 UnsupportedOperation for unsupported routes and versions, 404 ResourceNotFound for a missing customer, 409 CustomerAlreadyExists for a duplicate email or external ID, 422 detail list for malformed, unsupported or invalid input; unsupported-field locations name the container only, never the supplied key; diagnostic codes and duplicate behavior are local contracts',
    'customerPortalLicenseKeys':
      'activate, validate and deactivate look the key up by exact case-sensitive key and organization_id first, and an unknown key or a key of another organization all answer 404 ResourceNotFound Not found. Activate then refuses revoked or disabled (403 NotPermitted License key is no longer active. This license key can not be activated.), expired (403 License key has expired.), a benefit without activations (403 This license key does not support activations. Use the /validate endpoint instead to check license validity.) and a full live activation count (403 License key activation limit already reached); it stores conditions and meta without checking them. Validate refuses revoked or disabled (404 License key is no longer active.), expired (404 License key has expired.), an unknown, deactivated or foreign activation_id (404 Not found), nonempty stored conditions unequal to the supplied object as whole JSON (404 License key does not match required conditions), a different benefit_id (404 License key does not match given benefit.), a different customer_id (404 License key does not match given user.) and a positive increment beyond limit_usage (400 BadRequest License key only has {remaining} more usages.), in that order; success increments validations, sets last_validated_at and adds a positive increment_usage. Deactivate soft-deletes one live activation of the key and answers 204, rechecking neither status nor expiry. Checks and writes share one serialized transaction; a refusal writes nothing. Expiry begins at expires_at. Non-422 refusals are exactly { error, detail }; 422 is { error: RequestValidationError, detail: [{ type, loc, msg }] } and precedes the lookup. Unknown body members are ignored. The key and conditions are never logged or echoed in failures',
  },
});
