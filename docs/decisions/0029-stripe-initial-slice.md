# 0029: Stripe customers, idempotency and signed events

## Context

The first Stripe plugin needs the smallest useful provider slice proving the
plugin shape. Payments would add confirmation, payment-method and failure-state
semantics; billing would additionally require time-driven transitions. Neither
is needed to prove commands, state, a real client and reliable signed delivery.

## Options

- Customers only, with real idempotency and `customer.created` delivery.
- PaymentIntents plus customers: more useful for checkout, a larger state
  machine.
- Checkout Sessions or subscriptions: additional resources and scheduled
  behavior.

## Decision

Select customers only. PaymentIntents, Checkout Sessions, Charges,
PaymentMethods, subscriptions, test clocks, Connect, live mode, lists, updates
and deletion are explicitly unsupported. Do not advertise a payment simulator
yet.

Pin the test-only official dependency to `npm:stripe@18.0.0` in root `deno.json`
and the lockfile. Its release pins `2025-03-31.basil`; select that exact
`Stripe-Version`, not an implicit moving latest version. This ADR approves the
new development dependency. Production plugin modules use Hono, Zod and Web
Crypto and never import Stripe. The dependency must not enter plugin archives.
[Pinned API constant](https://raw.githubusercontent.com/stripe/stripe-node/v18.0.0/src/apiVersion.ts),
[official client configuration](https://raw.githubusercontent.com/stripe/stripe-node/v18.0.0/README.md).

`@emulon/stripe` exports the default `stripe(options?)` factory. Options allow
customer fixtures and existing destination fixtures; fixture loading emits no
events. All keys belong to the one local account represented by the instance.
`keys.create({})` returns a securely random `sk_test_...` only in its explicit
credential response. Provider Bearer authentication requires an issued key;
prefix matching alone is insufficient. Foreign-instance, unknown, missing and
live keys fail with 401 and a Stripe-style error envelope without echoing them.
HTTP Basic authentication is outside this first slice and disclosed as such.

| Provider operation      | Management command                                                   | Accepted input                                                                |
| ----------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/customers`    | `customers.create({ name?, email?, description?, idempotencyKey? })` | Optional strings `name`, `email`, `description`; HTTP idempotency is a header |
| `GET /v1/customers/:id` | `customers.get({ id })`                                              | Customer ID only                                                              |

CLI paths are `customers create`, `customers get --id`, and `keys create`;
camel-case `idempotencyKey` maps to `--idempotency-key`. Each remaining scalar
input uses the same-named flag. Creation accepts form-urlencoded HTTP requests
from the official client. Reject unknown fields, duplicate scalar fields,
expansions and unsupported query parameters explicitly before mutation. Output
is the declared partial projection `id`, `object: customer`, `created` (Unix
seconds), `livemode: false`, `name`, `email`, `description`, and `metadata: {}`;
absent optional strings serialize as null. Never claim the full Customer type.
Missing resources return 404 `invalid_request_error` / `resource_missing`.
Unknown routes and invalid input/version return explicit Stripe-style errors.
Absent version selects the pinned subset; any other supplied version is rejected
with 400 before mutation. Include the selected version in response headers.
[Customer API](https://docs.stripe.com/api/customers/create?api-version=2025-03-31.basil).

Creation commits customer and `customer.created` outbox event together. Its
snapshot envelope contains stable `evt_...` ID, `object: event`, `api_version`,
`created`, `type`, `livemode: false`, and `data.object`. Additional envelope
fields are declared in the manifest if implemented, not guessed. Synthetic
publication and direct send validate this projection and do not create a
customer.

### Idempotency

Stripe documents saving executed results (including 500), comparing parameters,
and allowing removal after 24 hours; validation and concurrent execution
failures do not start a saved result.
[Idempotent requests](https://docs.stripe.com/api/idempotent_requests).

Use a Stripe-owned module and collection, not a new general public core API.
Scope keys by instance/account, not credential, so key rotation cannot create a
second customer. Accept nonempty keys up to 255 characters. The fingerprint
includes method, path, resolved API version and canonical validated parameters;
form field ordering does not change it. Store the response status/body and
creation time atomically with the resource/outbox. Same key and fingerprint
replays the same result with no second event. Different parameters return 400
`idempotency_error`. Invalid/auth/version requests do not consume the key. GET
does not consume idempotency keys. After at least 24 hours, lazy expiry permits
a new execution; use an injected `now` in pure-rule tests.

The local transaction serializes concurrent same-key calls and replays the
winner; it does not reproduce Stripe's possible concurrent-request conflict.
Only committed domain outcomes are cached; pre-commit infrastructure failures
roll back and are not cached 500s. Both are explicit limitations. Persist
records with durable state, clear them on reset and verify crash/restart replay.

### Webhooks and retries

Reuse destination commands, event publication, explicit send, list, inspect,
wait and redeliver from the existing service command pattern. Require a nonempty
destination secret (fixture may use `whsec_...`); treat it as literal UTF-8, not
Svix base64. `Stripe-Signature` is `t=<unix seconds>,v1=<lowercase hex>`:
HMAC-SHA256 over UTF-8 timestamp, a dot, and the exact transmitted body bytes.
Retries preserve event ID and body and sign again with the current timestamp and
current destination secret. Same-second retries may have identical headers.

Stripe documents sandbox retries three times over a few hours and live retries
over three days, without publishing an exact universal schedule. Select a local
sandbox approximation: initial attempt, then delays of 60 seconds, 1 hour and 2
hours after successive failures. Stop after four total attempts, on 2xx, or when
the destination is disabled. Timeout is 5 seconds; network failures and non-2xx
retry. Manual redelivery is allowed after terminal state. Existing core recovery
marks interrupted sends unknown/failed, requiring manual redelivery; do not
claim Stripe's automatic crash recovery, exact schedule, ordering, or manual
resend while an automatic retry is queued.
[Stripe delivery and signatures](https://docs.stripe.com/webhooks).

## Verification and consequences

Use
`new Stripe(key, { host: '127.0.0.1', port, protocol: 'http',
apiVersion: '2025-03-31.basil', httpClient: Stripe.createFetchHttpClient(),
maxNetworkRetries: 0, telemetry: false })`.
Ports come from the environment. Exercise customers create/retrieve and error
paths through that actual client; verify webhooks with `constructEventAsync` and
the SubtleCrypto provider, plus an independent known-byte HMAC vector, tampered
body and wrong-secret negatives. Separate client request retries from webhook
delivery retries.

CLI/started SDK/connected SDK share domain and idempotency behavior. Test
concurrent same-key creation, changed parameters, rollback, expiry, isolation,
reset, durable replay and one event only. Fake scheduling proves all automatic
retry boundaries without real waits; a loopback receiver proves actual bytes,
500 then success, response loss, redelivery and inspection redaction. Sources
were inspected on 2026-09-22; no live Stripe account was used.
