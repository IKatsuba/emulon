import { type CompatibilityManifest, defineCompatibility } from 'emulon';

export const compatibility: CompatibilityManifest = defineCompatibility({
  schemaVersion: 1,
  plugin: '@emulon/calcom',
  provider: {
    name: 'Cal.com',
    api: 'API v2 fixed UTC availability and bookings',
  },
  operations: [
    {
      id: 'eventTypes.get',
      method: 'GET',
      path: '/v2/event-types/:eventTypeId',
      surface: 'api',
      version: '2026-06-12',
      auth: ['local-bearer-api-key'],
      input: ['eventTypeId'],
      output:
        'Success envelope; partial event type: id, title, slug, lengthInMinutes',
      events: [],
      cases: ['calcom.http.1'],
    },
    {
      id: 'slots.list',
      method: 'GET',
      path: '/v2/slots',
      surface: 'api',
      version: '2024-09-04',
      auth: ['local-bearer-api-key'],
      input: ['eventTypeId', 'start', 'end', 'timeZone: UTC (optional)'],
      output:
        'Success envelope; UTC date keys with arrays of { start } UTC timestamps',
      events: [],
      cases: ['calcom.http.1'],
    },
    ...(['create', 'get'] as const).map((action) => ({
      id: `bookings.${action}`,
      method: action === 'create' ? 'POST' as const : 'GET' as const,
      path: action === 'create' ? '/v2/bookings' : '/v2/bookings/:bookingUid',
      surface: 'api',
      version: '2026-02-25',
      auth: ['local-bearer-api-key'],
      input: action === 'create'
        ? [
          'eventTypeId',
          'start: UTC timestamp',
          'attendee: name, email, timeZone: UTC, language: en (optional)',
        ]
        : ['bookingUid'],
      output:
        'Success envelope; partial booking: id, uid, status: accepted, start, end, duration, eventTypeId, title, hosts: [{ name, email, username }], attendees: [{ name, email, timeZone, language? }]; create 201, get 200',
      events: action === 'create' ? ['BOOKING_CREATED'] : [],
      cases: ['calcom.bookings.1'],
    })),
  ],
  versions: ['2026-06-12', '2024-09-04', '2026-02-25'].map((id) => ({
    id,
    accepted: [id],
    headers: ['cal-api-version'],
    missing: '400 invalid_version; no older-version fallback',
    unknown: '400 invalid_version; each route requires its own date',
  })),
  authentication: {
    flows: ['local-bearer-api-key'],
    keyFormats: ['cal_ opaque local key'],
    ownership:
      'One organizer per instance; only keys issued by this instance; reset invalidates keys',
    unsupported: [
      'cal_live_ keys',
      'OAuth',
      'Platform client headers',
      'Managed users',
      'Real Cal.com accounts',
    ],
  },
  events: [{
    id: 'BOOKING_CREATED',
    providerName: 'BOOKING_CREATED',
    version: '2026-02-25',
    projection:
      'Atomic service event: uid, eventTypeId, title, startTime, endTime, organizer: { name, email, username }, attendees: [{ name, email, timeZone, language? }]; immutable booking snapshots. Service, published and direct events share the BOOKING_CREATED webhook projection.',
    cases: ['calcom.bookings.1'],
  }],
  webhooks: {
    signing:
      'X-Cal-Signature-256: lowercase hex HMAC-SHA256 over exact UTF-8 body with literal secret; X-Cal-Webhook-Version: 2021-10-20',
    id: 'Booking UID in payload; no provider delivery ID header',
    body:
      'Partial default payload: triggerEvent, createdAt, payload; no custom templates',
    success: 'Any 2xx response',
    timeoutMs: 5000,
    retries: 'Manual only; no hosted retry schedule equivalence claimed',
    redelivery:
      'Same body bytes and booking UID, signed with the current destination secret; no second booking/event',
    recovery:
      'Interrupted or transport-failed attempts may have unknown receiver outcome; manual redelivery can duplicate receiver effects',
    cases: ['calcom.webhooks.1'],
  },
  capabilities: ['http', 'authorization', 'events', 'webhooks', 'reset'],
  limitations: [
    {
      id: 'calcom.scheduling',
      description:
        'Fixed UTC slot starts only; strictly future slots, inclusive query bounds. Organizer-wide half-open occupied intervals exclude overlaps across event types; adjacent intervals are allowed. No calendar sync, recurrence, DST, alternate zones, teams, slugs in queries, range format or variable durations.',
    },
    {
      id: 'calcom.resources',
      description:
        'No reservations, cancellation, rescheduling, confirmation workflows, payments, meeting URLs, notifications or automatic completion events. No idempotency: overlapping duplicates conflict. Event type creation/listing are control-only.',
    },
    {
      id: 'calcom.errors',
      description:
        'Local error envelope: status:error and error:{code,message}; 401 keys, 404 missing or unsupported resource, 400 input/version, 409 slot_conflict. Partial responses and mandatory versions are explicit local contracts.',
    },
    {
      id: 'calcom.client',
      description:
        'Documented HTTP chosen because official @calcom/atoms is a React component/hook SDK with OAuth, not the required headless API-key client. The official starter kit uses a thin server-side HTTP client; no suitable official headless client was identified in the inspected documentation.',
    },
  ],
  verification: {
    mode: 'documented-http',
    suites: [{
      path: 'packages/calcom/tests/scheduling_test.ts',
      cases: ['calcom.http.1'],
    }, {
      path: 'packages/calcom/tests/bookings_cases.ts',
      cases: ['calcom.bookings.1'],
    }, {
      path: 'packages/calcom/tests/webhook_cases.ts',
      cases: ['calcom.webhooks.1'],
    }],
    sources: [
      'https://cal.com/docs/api-reference/v2/bookings/create-a-booking',
      'https://cal.com/docs/api-reference/v2/bookings/get-a-booking',
      'https://cal.com/docs/api-reference/v2/event-types/get-an-event-type',
      'https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type',
      'https://cal.com/docs/atoms/setup',
      'https://github.com/calcom/developer-starter-kit',
    ],
    retrieved: '2026-09-22',
    liveProviderCompared: false,
  },
});
