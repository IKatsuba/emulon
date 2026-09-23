# @emulon/calcom

Local Cal.com API v2 event types, fixed UTC availability and atomic bookings,
selected in [ADR 0030](../../docs/decisions/0030-calcom-initial-slice.md). The
[compatibility manifest](src/compatibility.ts) is the authoritative tested
scope. Bookings atomically record `BOOKING_CREATED` and deliver signed webhooks
to matching destinations.

```ts
import { Emulon } from 'emulon';
import calcom from '@emulon/calcom';

await using env = await Emulon.start({ services: { cal: calcom() } });
const type = await env.services.cal.eventTypes.create({
  title: 'Consultation',
  slug: 'consultation',
  lengthInMinutes: 30,
  slots: ['2099-06-01T10:00:00Z'],
});
const { apiKey } = await env.services.cal.keys.create({});
const response = await fetch(
  `${env.endpoints.cal.api}/v2/slots?eventTypeId=${type.id}&start=2099-06-01&end=2099-06-01`,
  {
    headers: {
      authorization: `Bearer ${apiKey}`,
      'cal-api-version': '2024-09-04',
    },
  },
);
console.log(await response.json());
```

For a running project configured with instance `cal`:

```sh
emulon cal event-types create --title Consultation --slug consultation \
  --length-in-minutes 30 --slots '["2099-06-01T10:00:00Z"]' --json
emulon cal event-types get --id 1 --json
emulon cal event-types list --json
emulon cal slots list --event-type-id 1 --start 2099-06-01 --end 2099-06-01 --json
emulon cal bookings create --event-type-id 1 --start 2099-06-01T10:00:00Z \
  --attendee '{"name":"Ada","email":"ada@example.test","timeZone":"UTC"}' --json
emulon cal bookings get --uid <booking-uid> --json
emulon cal keys create --json
emulon cal compatibility get --json
```

`GET /v2/event-types/:id` requires `cal-api-version: 2026-06-12` and returns
`{ status: "success", data: { id, title, slug, lengthInMinutes } }`.
`GET /v2/slots` requires `2024-09-04` and returns a success envelope with
UTC-date keys and arrays of `{ start }`. All routes require an instance-issued
Bearer `cal_...` key. Unknown, foreign and live keys fail with 401; reset
invalidates issued keys. Project restart preserves types, keys, bookings and
events.

Queries accept only numeric `eventTypeId`, required `start`/`end` and optional
`timeZone: UTC`. Bounds are UTC ISO timestamps or date-only values, inclusive
through the end of the final date. Slots must have unique valid UTC timestamps;
only starts strictly after the instance clock are returned, sorted by time,
excluding intervals occupied by bookings across all event types of the
organizer. Creation allows past fixture slots so tests can exercise their
exclusion.

`POST /v2/bookings` (201) and `GET /v2/bookings/:uid` (200) require
`cal-api-version: 2026-02-25`. Create accepts only `eventTypeId`, a declared
future UTC `start`, and `attendee` with `name`, `email`, `timeZone: UTC` and
optional `language: en`. The SDK uses the same fields:

```ts
const booking = await env.services.cal.bookings.create({
  eventTypeId: type.id,
  start: '2099-06-01T10:00:00Z',
  attendee: { name: 'Ada', email: 'ada@example.test', timeZone: 'UTC' },
});
console.log(await env.services.cal.bookings.get({ uid: booking.uid }));
```

Booking responses project `id`, `uid`, `status: accepted`, `start`, `end`,
`duration`, `eventTypeId`, `title`, `hosts` (name/email/username), and
`attendees` (name/email/timeZone/optional language). Organizer and attendee
snapshots are persisted with the booking and its atomic `BOOKING_CREATED` event.
Intervals are half-open: adjacent bookings are allowed, overlapping bookings
(including duplicates and different event types) receive local HTTP 409
`slot_conflict`. Other local errors use 400 for invalid inputs/versions, 401 for
keys and 404 for missing resources. There is no idempotency, calendar sync,
cancellation, rescheduling, reservations, payments, conferencing or notification
support. Reset removes bookings/events, restores fixtures and invalidates keys.

Factory options are `fixtures.organizer` (name, email, username) and
`fixtures.eventTypes` (the create fields plus optional positive numeric `id`).
Reset restores these fixtures. A local default organizer is supplied. Unknown
options, command fields, query fields and duplicate query parameters are
rejected.

Verification uses documented HTTP, with no provider client dependency. Official
Atoms is a React/OAuth SDK; the selected contract needs a headless API-key
client. Tests use loopback only and do not claim equivalence to live Cal.com.
The shared manifest schema encodes this as `verification.mode: documented-http`,
omitting `client` when no client is used.

## Webhook delivery

Set
`destinations: [{ id: "receiver", url: "http://127.0.0.1:3000/webhooks",
secret: "local-secret", types: ["BOOKING_CREATED"], enabled: true }]`
in factory options, or use `webhooks.configure` with the same fields. Secrets
must be nonempty. Subscription selection happens at processing time.

The POST body is `{ triggerEvent: "BOOKING_CREATED", createdAt, payload }`. The
partial payload contains `uid`, `eventTypeId`, `title`, `startTime`, `endTime`,
`organizer` and `attendees` from the immutable booking snapshot.
`X-Cal-Webhook-Version` is `2021-10-20`; `X-Cal-Signature-256` is lowercase hex
HMAC-SHA256 of the exact UTF-8 body using literal secret bytes, without a
prefix. Custom templates are unsupported. Any 2xx succeeds; timeout is 5
seconds.

Retries are **manual only**. This local policy does not claim equivalence to
hosted Cal.com's retry schedule. After HTTP 500, inspect the failed attempt and
queue another attempt:

```sh
emulon cal webhooks list --json
emulon cal webhooks inspect '<delivery-id>' --json
emulon cal webhooks redeliver '<delivery-id>' --json
emulon cal webhooks wait '<delivery-id>' --status succeeded --timeout 5s --json
```

The SDK equivalents are `webhooks.list({})`, `inspect({ id })`,
`redeliver({ id })` and `wait({ id, status: "succeeded", timeout: "5s" })`.
Redelivery retains body bytes and booking UID, uses the current destination
secret, and creates neither a second booking nor another event. Inspection and
`webhooks.destinations({})` omit secrets, signatures and response bodies.
Interrupted deliveries have an unknown receiver outcome and require manual
redelivery; receivers may observe duplicate effects. Reset interrupts pending
work, clears deliveries/events/bookings and restores destination fixtures; it
cannot undo a webhook already received externally.

`events.publish({ type: "BOOKING_CREATED", data: payload })` selects matching
subscriptions;
`webhooks.send({ type: "BOOKING_CREATED", data: payload,
destination: "receiver" })`
sends only to that destination. Both take the payload projection above, wrap it
in the standard envelope and do not reserve or book a slot. CLI equivalents
accept `BOOKING_CREATED --data payload.json` (with `--destination receiver` for
direct send).

For the complete installed Node/Deno scenario alongside Stripe, including CLI
`init/add/up`, connected SDK, versioned HTTP calls, independent webhook
verification and listener cleanup, see the
[Stripe and Cal.com example](../../examples/stripe-calcom/README.md).
