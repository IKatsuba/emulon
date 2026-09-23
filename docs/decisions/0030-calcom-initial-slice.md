# 0030: Cal.com API v2 with fixed availability and bookings

## Context

Cal.com is an official plugin. This ADR only selects its initial protocol
coverage. API v2 has per-resource date versions, not one date that can safely be
applied to every route. A full scheduling engine would add calendar sync,
time-zone recurrence, team assignment and external conferencing.

## Options

- Full Platform OAuth and Atoms UI integration: browser dependencies and a much
  larger authorization scope; the legacy Platform flow is deprecated.
- API-key HTTP contract with fixture-backed individual scheduling.
- Adopt an unofficial SDK: adds a dependency without an independent provider
  contract guarantee.

## Decision

Choose API-key HTTP, with no new dependency. Official `@calcom/atoms` exists and
supports an API URL override, but is a React component/hook SDK with an OAuth
provider, not the headless API-key client needed here. The official developer
starter kit uses a thin server-side HTTP client rather than a standalone npm
client. No suitable official headless npm client was identified in the inspected
official documentation; this is a scoped finding, not proof that none can exist.
Record `verification.mode: documented-http` and omit `client` in the manifest,
following ADR 0028 and the shared strict manifest schema.
[Atoms setup](https://cal.com/docs/atoms/setup),
[official starter kit](https://github.com/calcom/developer-starter-kit).

The default `calcom(options?)` factory accepts a single organizer fixture,
individual event types with fixed-length UTC slot starts, and destination
fixtures. `keys.create({})` returns a securely generated instance-bound
`cal_...` key only in its explicit response. Known local Bearer keys authorize
all selected routes; reject unknown, foreign and `cal_live_...` keys. Do not
accept an OAuth token or Platform client headers as a shortcut around local key
validation. OAuth, managed users and client-secret flows remain explicitly
unsupported. Provider docs describe API keys, OAuth and deprecated Platform
authentication.
[API v2 authentication](https://cal.com/docs/api-reference/v2/introduction).

| HTTP operation                     | Required `cal-api-version` | Management command                                   |
| ---------------------------------- | -------------------------- | ---------------------------------------------------- |
| `GET /v2/event-types/:eventTypeId` | `2026-06-12`               | `eventTypes.get({ id })`                             |
| `GET /v2/slots`                    | `2024-09-04`               | `slots.list({ eventTypeId, start, end, timeZone? })` |
| `POST /v2/bookings`                | `2026-02-25`               | `bookings.create({ eventTypeId, start, attendee })`  |
| `GET /v2/bookings/:bookingUid`     | `2026-02-25`               | `bookings.get({ uid })`                              |

These dates were checked on the individual official pages on 2026-09-22:
[event type](https://cal.com/docs/api-reference/v2/event-types/get-an-event-type),
[slots](https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type),
[create booking](https://cal.com/docs/api-reference/v2/bookings/create-a-booking),
[get booking](https://cal.com/docs/api-reference/v2/bookings/get-a-booking). The
manifest must describe each operation's version, not merely say "v2". Missing or
wrong date headers receive explicit 400 errors. This intentionally differs from
the provider's older-version fallback. All selected routes require the local API
key, including booking creation; unauthenticated public booking is not claimed.
Local errors use `{ status: "error", error: { code, message } }`: 401
unauthorized, 404 missing resource, 400 validation/version/unsupported input,
409 slot conflict. These diagnostic error bodies/statuses are explicit local
contracts, not a claim about every provider error.

### Resource and command boundaries

Additional control-only commands are
`eventTypes.create({ title, slug,
lengthInMinutes, slots })`,
`eventTypes.list({})` and `keys.create({})`. `slots` is an array of absolute UTC
ISO timestamps. The single organizer fixture has name, email and username; a
local default is allowed. No event-type creation HTTP route is claimed. CLI
paths use `event-types create|get|list`, `slots list`, `bookings create|get`,
and `keys create`; scalar flags use kebab case, `--slots` and `--attendee` use
the existing JSON flag encoding. All inputs are objects, with an optional empty
object for no-argument commands.

Select one organizer, one fixed duration per type, and no overlapping bookings
for that organizer, even across event types. Validate positive integral
duration, unique slots and valid dates. Slot queries require numeric
`eventTypeId`, `start` and `end`; accept date-only UTC bounds (start of first
day through end of last day) or UTC ISO instants, with an inclusive query end.
Only omitted/`UTC` `timeZone` is supported. Reject alternate zones, slugs,
teams, range format, variable durations and every other query field explicitly.

Availability is the sorted declared slot starts within the requested bounds,
strictly after the instance clock's `now`, excluding half-open occupied
intervals `[start, end)`. Adjacent bookings are allowed. Return the documented
success envelope with UTC-date keys mapping to arrays of `{ start }` objects.
The event type read projection is `id`, `title`, `slug`, `lengthInMinutes`; do
not claim the provider's complete event-type object.

Booking create accepts `eventTypeId`, UTC `start`, and `attendee` with `name`,
`email`, `timeZone: UTC`, optional `language: en`. Reject other fields and other
languages/zones. In a single transaction, validate that a future declared slot
is still free, create the booking and record `BOOKING_CREATED`. A competing
booking receives the documented local 409, with no extra booking or event.
Return HTTP 201 (read: 200), `{ status: "success", data }`; data projects `id`,
`uid`, `status: accepted`, `start`, `end`, `duration`, `eventTypeId`, `title`,
`hosts` and `attendees`. Persist the immutable organizer/attendee snapshot used
for the webhook. IDs are local and must not be confused with production IDs.

No reservations, recurrence, cancellation/rescheduling, confirmation workflows,
payments, calendar integrations, availability-rule API, team scheduling, meeting
URLs, email/SMS, DST calculation or automatic completion events. No Cal.com
idempotency promise; an overlapping duplicate request conflicts. These omissions
and partial response projections ship in the compatibility manifest.

### Webhooks

Only `BOOKING_CREATED` is supported. Serialize
`{ triggerEvent, createdAt,
payload }`, with payload projection `uid`,
`eventTypeId`, `title`, `startTime`, `endTime`, `organizer`, `attendees`. Use
`X-Cal-Webhook-Version: 2021-10-20` and `X-Cal-Signature-256` containing
lowercase hex HMAC-SHA256 over the exact UTF-8 JSON body using the literal
secret bytes; no timestamp prefix and no `sha256=` prefix. Require a nonempty
secret for local destinations. This is a partial default payload, not support
for custom templates.
[Webhook protocol](https://cal.com/docs/developing/guides/automation/webhooks),
[public implementation reference](https://raw.githubusercontent.com/calcom/cal.diy/main/packages/features/webhooks/lib/sendPayload.ts).
The latter is the public Cal.diy source, not evidence of current hosted Cal.com
behavior; the documented header and HMAC contract are the compatibility target.

Reuse processing-time subscriptions and explicit publish/send/inspect/wait/
redeliver commands. Synthetic publication and direct sending do not book a slot.
Use 5-second timeout and 2xx success. Select manual-only redelivery: the
inspected public guide does not establish an exact retry schedule, so no hosted
retry equivalence is claimed. Keep body bytes/booking UID across redelivery,
sign with the current secret, and preserve existing unknown-outcome recovery
semantics.

## Verification and consequences

HTTP contract cases use fetch against dynamically allocated loopback endpoints,
asserting the selected fields and date headers from the linked documentation.
They are independent of the plugin's own serializers and schemas. Verify
CLI/started SDK/connected SDK resources can be read through HTTP and vice versa.
Prove concurrent competing bookings, cross-event-type overlap, adjacent slots,
wrong versions/keys/fields, reset and durable restart. Pure scheduling tests
take explicit `now`; fixtures for real-loopback tests use known future dates.

The receiver verifies exact captured bytes independently, including non-ASCII
names, wrong secrets and tampering. It returns 500, observes a failed attempt,
then receives successful manual redelivery with the same booking and no second
mutation. Verify secret redaction, isolation and reset during pending delivery.
No provider account, calendar service or public network is used by tests.
