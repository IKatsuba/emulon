import { type CompatibilityManifest, defineCompatibility } from 'emulon';

export const compatibility: CompatibilityManifest = defineCompatibility({
  'schemaVersion': 1,
  'plugin': '@emulon/resend',
  'provider': {
    'name': 'Resend',
    'api': 'Email API',
  },
  'operations': [
    {
      'id': 'emails.send',
      'method': 'POST',
      'path': '/emails',
      'surface': 'api',
      'version': 'unversioned',
      'auth': [
        'local-bearer-api-key',
      ],
      'input': [
        'from',
        'to',
        'subject',
        'html',
        'text',
        'cc',
        'bcc',
        'reply_to',
      ],
      'output': 'id',
      'events': [
        'email.sent',
      ],
      'cases': [
        'resend.surface.1',
        'resend.surface.2',
        'resend.surface.3',
        'resend.surface.4',
      ],
    },
    {
      'id': 'emails.get',
      'method': 'GET',
      'path': '/emails/:id',
      'surface': 'api',
      'version': 'unversioned',
      'auth': [
        'local-bearer-api-key',
      ],
      'input': [
        'id',
      ],
      'output':
        'object, id, from, to, subject, html, text, cc, bcc, reply_to, created_at, last_event',
      'events': [],
      'cases': [
        'resend.surface.1',
        'resend.surface.2',
        'resend.surface.3',
      ],
    },
  ],
  'versions': [
    {
      'id': 'unversioned',
      'accepted': [
        'unversioned',
      ],
      'headers': [
        'resend-version',
        'x-api-version',
      ],
      'missing': 'Unversioned API',
      'unknown':
        'Any explicit version header returns 501 unsupported_operation after authentication.',
    },
  ],
  'authentication': {
    'flows': [
      'local-bearer-api-key',
    ],
    'keyFormats': [
      're_ opaque local API key',
    ],
    'ownership':
      'Keys belong to one environment and instance; reset invalidates issued keys.',
    'unsupported': [
      'Real Resend accounts',
      'Provider key permissions and domains',
    ],
  },
  'events': [
    {
      'id': 'email.sent',
      'providerName': 'email.sent',
      'version': 'unversioned',
      'projection': 'type, created_at, data containing email payload',
      'cases': [
        'resend.surface.1',
        'resend.surface.3',
      ],
    },
  ],
  'webhooks': {
    'signing':
      'svix-signature: v1,<base64 HMAC-SHA256 over svix-id.timestamp.exact-body>; base64 secret with optional whsec_ prefix',
    'id': 'svix-id retained across attempts; svix-timestamp regenerated',
    'body': 'Persisted serialized event bytes reused on redelivery',
    'success': '200-299',
    'timeoutMs': 5000,
    'retries': 'No automatic retries',
    'redelivery':
      'Manual only; same provider ID and body; fresh timestamp/signature',
    'recovery':
      'Processing-time subscriptions; retained queues recover pending work without duplicate event/destination entries; interrupted in-flight outcome is unknown.',
    'cases': [
      'resend.worker.1',
      'resend.delivery_scenarios.1',
      'resend.delivery_scenarios.2',
      'resend.delivery_scenarios.3',
      'resend.delivery_scenarios.4',
    ],
  },
  'capabilities': [
    'http',
    'authorization',
    'events',
    'webhooks',
    'faults',
    'reset',
  ],
  'limitations': [
    {
      'id': 'resend.limitation.1',
      'description':
        'No domains, audiences, attachments, templates, scheduling, tags, custom headers or idempotency keys',
    },
    {
      'id': 'resend.limitation.2',
      'description': 'No generated plain text from HTML',
    },
    {
      'id': 'resend.limitation.3',
      'description': 'Explicit version headers are unsupported',
    },
  ],
  'verification': {
    'mode': 'official-client',
    'client': 'resend@6.28.1',
    'suites': [
      {
        'path': 'packages/resend/tests/surface_cases.ts',
        'cases': [
          'resend.surface.1',
          'resend.surface.2',
          'resend.surface.3',
          'resend.surface.4',
        ],
      },
      {
        'path': 'packages/resend/tests/delivery_scenarios_cases.ts',
        'cases': [
          'resend.delivery_scenarios.1',
          'resend.delivery_scenarios.2',
          'resend.delivery_scenarios.3',
          'resend.delivery_scenarios.4',
        ],
      },
      {
        'path': 'packages/resend/tests/worker_cases.ts',
        'cases': [
          'resend.worker.1',
        ],
      },
    ],
    'sources': [
      'https://resend.com/docs/api-reference/emails/send-email',
      'https://resend.com/docs/api-reference/emails/retrieve-email',
      'https://resend.com/docs/webhooks/introduction',
    ],
    'retrieved': '2026-09-21',
    'liveProviderCompared': false,
  },
  'details': {
    'health': 'GET /health is an unauthenticated lifecycle probe',
    'errors':
      'statusCode, name, message; 401 missing key, 403 invalid key, 404 email not found, 400 malformed JSON, 422 invalid fields, 501 unsupported fields/versions/idempotency',
  },
});
