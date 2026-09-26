# 0033: Polar customers and signed delivery

## Context

Polar is an official plugin, `@emulon/polar`, listed among the confirmed
decisions and packages in `docs/design.md`. This ADR selects its initial
protocol coverage and dependencies; it does not reconsider that product
decision.

Sources were inspected on 2026-09-22. Upstream documentation, generated SDKs and
API schemas are moving independently. `/v1/` alone is not a sufficient version
promise. No live account or provider mutation was used in this investigation.

## Options

- Customers create/get plus `customer.created`: proves a real resource, shared
  commands, organization authentication, atomic outbox and signed delivery.
- Products and checkouts: additionally needs price unions, checkout secrets,
  expiry, customer association and an explicit payment-completion boundary.
- Orders and subscriptions: additionally needs payment outcomes, recurring
  billing, cancellation and clock-driven state transitions.

## Decision

Select customers only. Products, prices, checkout creation/confirmation, orders,
subscriptions, benefits, license keys, customer portal, payment methods,
refunds, lists, updates and deletion are unsupported. This is a customer
integration emulator, not a payment or licensing simulator. No subscription fake
clock or new general billing mechanism is needed.

### API and official client

Target `/v1/` routes and the `2026-04` API schema, pinned to Polar repository
commit `5514f6a85e9e856857f8662a58d1deb69bc4a2fd`:
[OpenAPI](https://raw.githubusercontent.com/polarsource/polar/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/docs/openapi/2026-04.openapi.json).
The fetched file SHA-256 is
`616cd5bad20b9170be8ba0640c9d729009b5dbd39c29e9ede928d36ea21fd0d6`.
`https://api.polar.sh/openapi.json`, referenced by the SDK generator, returned
404 during this inspection; use the pinned repository artifact, not a guessed
live schema. Implementation must retain an attributed minimal schema fixture
covering these operations and their reachable response/event types.

Polar now documents `Polar-Version` request/response headers and independently
versioned webhook payloads. Unsupported versions return 404 upstream.
[Versioning source](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/docs/snippets/api-reference/versioning.mdx).
Locally, accept `Polar-Version: 2026-04`; missing means this pinned slice, never
moving Current. Reject every other supplied value with 404 before mutation and
return the selected header on supported responses. Disclose the fixed fallback.

Approve the exact test-only import `npm:@polar-sh/sdk@0.49.0` in root
`deno.json` and lockfile. This was the npm latest dist-tag during inspection,
not a promise of newest API coverage. Its metadata declares OpenAPI `2026-04`.
The client supports `serverURL`; `server: 'sandbox'` instead selects the real
public sandbox and must never be used by tests.
[SDK configuration](https://github.com/polarsource/polar-js/blob/v0.49.0/src/lib/config.ts),
[package](https://github.com/polarsource/polar-js/blob/v0.49.0/package.json).

Use
`new Polar({ accessToken: apiKey, serverURL: apiOrigin,
retryConfig: { strategy: 'none' } })`
against a dynamically allocated loopback origin, without appending `/v1`: the
generated methods append it. Exercise
`customers.create({ email, name?, externalId? })` and `customers.get({ id })`.
The pinned create method does not add `Polar-Version`; test the explicit header
separately over HTTP as well as its missing-header default through the SDK.
[Create implementation](https://github.com/polarsource/polar-js/blob/v0.49.0/src/funcs/customersCreate.ts).
No production module imports this client or its transitive `standardwebhooks`;
archive verification must exclude them from production dependency metadata.
Choose `verification.mode: official-client`, not `documented-http`. Suitability
is established by source inspection; executable contract proof is required in
part 1 and is not claimed by this ADR.

### Resource, credentials and commands

`@emulon/polar` exports only the default `polar(options?)` factory. Each
instance represents one organization with a stable local UUID, optional customer
fixtures and destination fixtures. Fixtures emit no events. Organization
identity and customers persist together; reset restores fixtures and invalidates
issued keys.

Authorize these public commands and their corresponding CLI paths:

| Command                                           | CLI                                             | Provider operation      |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------- |
| `keys.create({})` -> `{ apiKey }`                 | `keys create`                                   | Local provisioning only |
| `customers.create({ email, name?, externalId? })` | `customers create --email --name --external-id` | `POST /v1/customers/`   |
| `customers.get({ id })`                           | `customers get --id`                            | `GET /v1/customers/:id` |

Provider JSON uses `external_id`; management inputs use `externalId`. Accept
only email, optional nullable name/external ID and optional `type: individual`
on HTTP create. Reject all other inputs, query fields and customer types before
mutation, including `organization_id`; the local OAT fixes the organization.
Validate email and the schema's name limit. Enforce organization-local unique
email and non-null external ID transactionally, including concurrent requests.
There is no idempotency-key promise; disclose case-sensitive local uniqueness.

Return 201 for create and 200 for get. The wire customer has UUID `id`, ISO
`created_at`, instance `organization_id`, `type: individual`,
email/name/external ID, `email_verified: false`, `metadata: {}`, and null
`modified_at`, `billing_name`, `billing_address`, `tax_id`, `locale`,
`default_payment_method_id`, `deleted_at`, `first_user_event_at`, `avatar_url`.
These defaults make the declared individual projection parseable by both the
pinned schema and client; they do not implement billing, identity verification,
member creation or avatar lookup. Management outputs use the same JSON wire
projection, avoiding Date objects across the control API.

Missing resources return 404 `{ error: 'ResourceNotFound', detail }`. Validation
and unsupported fields return 422 `{ detail: [...] }` with safe field locations;
never include supplied tokens or values in error details. Select local 409
`{ error: 'CustomerAlreadyExists', detail }` for duplicates, 401
`{ error: 'Unauthorized', detail }` for bad credentials, and 404
`{ error: 'UnsupportedOperation', detail }` for unsupported routes/versions. The
latter diagnostic codes and exact duplicate behavior are local contracts, not
unverified claims about Polar's error equivalence.

Polar OATs use Bearer authentication and the prefix `polar_oat_`, with one
organization as principal.
[Authentication](https://polar.sh/docs/integrate/authentication),
[OAT issuance](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/organization_access_token/service.py).
OAuth access prefixes are `polar_at_u_` / `polar_at_o_`; refresh prefixes are
`polar_rt_u_` / `polar_rt_o_`. Client IDs/secrets, registration tokens and codes
use `polar_ci_`, `polar_cs_`, `polar_crt_`, `polar_ac_` respectively.
[OAuth constants](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/oauth2/constants.py).
None is an alternative local credential. No OAuth, refresh, customer sessions,
PATs, scope administration or token expiration is claimed.

Issue cryptographically random `polar_oat_` local keys and check actual issued
membership, never prefix alone. Use one fixed local grant sufficient for these
two operations; no full upstream scope model. Reject missing, unknown, foreign
instance/environment and reset-invalidated keys. Only the explicit authenticated
key command returns a key. The suffix need not reproduce upstream's checksum;
record that limitation. Do not introduce a fictitious sandbox token prefix.

Creation commits one customer and one immutable `customer.created` event in a
single instance transaction. Rollback, duplicate rejection and fixture loading
produce no event. Reads never mutate. The provider payload is
`{ type: 'customer.created', timestamp, api_version: '2026-04', data: customer }`.
No other business event is supported.

### Webhooks and the secret migration

Polar uses Standard Webhooks framing: `webhook-id`, `webhook-timestamp`,
`webhook-signature: v1,<base64 HMAC-SHA256>`, signing the exact bytes of
`id.timestamp.body`. Include `webhook-api-version: 2026-04`.

The documentation distinguishes two key interpretations: secrets generated
before 2026-09-08 use the UTF-8 bytes of the entire secret; newer generated
`whsec_...` secrets use Standard Webhooks decoding. It mentions SDK
`1.0.0-alpha.19` supporting both, whereas inspected npm latest `0.49.0` uses
only the former. This is a concrete compatibility boundary, not an inference
that both formats are interchangeable.
[Delivery documentation](https://polar.sh/docs/integrate/webhooks/delivery),
[pinned SDK verifier](https://github.com/polarsource/polar-js/blob/v0.49.0/src/webhooks.ts).

Select the legacy/custom-secret Polar HMAC mode for this first slice. Require a
nonempty configured secret and sign with its entire UTF-8 bytes, including any
`whsec_` prefix. Never strip or base64-decode it. This is also how the inspected
server handles caller-supplied secrets (`secret_generated_at: None`).
[Endpoint implementation](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/webhook/service.py),
[signing implementation](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/webhook/tasks.py).
Do not claim compatibility with newly generated dashboard secrets. A future
explicit signing-mode contract can add that behavior; it is not silently
selected from a prefix because both modes can have the same prefix.

Reuse the core worker, stored exact body bytes, current-secret lookup,
processing-time subscriptions, destination management, attempts, faults,
inspect/wait/redeliver and transactional outbox. Follow existing plugin command
patterns for `events.publish` and
`webhooks.configure|destinations|send|list|inspect|wait|redeliver`; publication
and direct send validate the entire selected event envelope and must not create
customers. Expose the same operations through CLI and SDK.

Resend's Web Crypto HMAC concatenation is a useful implementation reference, but
its `svix-*` headers, base64 key decoding, `created_at` envelope and manual
retry policy are not Polar behavior. Implement a small Polar-owned transport; no
dependency from one plugin into another and no new public crypto API. Retain
core's delivery-scoped ID across retries and manual redelivery, regenerate
attempt timestamps/signatures, and freeze the first body. Disclose that this ID
is delivery-scoped rather than Polar's event ID shared across destinations.

Use a 10-second real I/O timeout, 2xx success and no redirect following. The
public guide says exponential retries up to ten times; the inspected server
counts attempts against its configured maximum and uses jittered worker backoff.
Choose a deterministic local approximation: ten total attempts, delay after
failed attempt n (1..9) is `min(1000 * 2 ** n, 1200000)` milliseconds. Failure
of attempt 10 is terminal. This schedule and attempt-count choice are explicit
limitations, not the exact hosted timing contract. Tests use the existing
internal `DeliveryScheduler`, not actual multi-minute sleeps.

Do not add automatic endpoint disablement, provider ordering guarantees, jitter,
email notifications or automatic recovery of interrupted sends in this slice.
Disclose those differences: current core recovery marks interrupted outcomes
unknown/failed and requires manual redelivery. Destination disablement and
rotation continue to use existing claim-time semantics. Redelivery while an
automatic attempt is pending follows core's existing restrictions.

### Shared infrastructure and manifest

Use `packages/emulon` lifecycle, instance state/versioning, Hono surfaces and
bounded bodies, command registry, durable store, reset barrier, events/outbox,
delivery queue and scheduler as they exist. No new storage, scheduler, public
facility or runtime adapter is required. Business timestamps use the supplied
clock; network timeout remains real time.

One small shared extension is justified: add `webhook-id`, `webhook-timestamp`
and `webhook-api-version` to the worker's safe inspection header allowlist, with
regression tests that signatures/secrets remain absent. Keep all Polar rules in
tested plugin modules. Do not refactor Resend or other plugins merely to share a
few signing lines.

Follow ADR 0028 with `packages/polar/src/compatibility.ts`, the existing
`compatibility.get` command, generated npm metadata and executable case
registry. Record the pinned schema revision/hash, API/header policy, official
SDK pin, selected input/output projections, auth, event and signature mode,
retry and recovery differences, and `liveProviderCompared: false`. Every
limitation above must have a stable ID. Intermediate releases advertise only
implemented and executed coverage: part 1 has no webhook capability or delivery
claims; part 2 adds them after receiver and scheduler evidence. The ADR is a
target, not a compatibility manifest or evidence of implementation.

## Implementation parts

The work is delivered in three parts, in order: part 2 depends on part 1 and
part 3 on part 2. Every part passes `deno task check`.

1. **Customer contract and usable package.** Add the Polar entries to the
   design, `packages/polar/{deno.json,src/**,tests/**}`, root
   workspace/import/lock entries, initial manifest and build/installed-consumer
   registration in `scripts/build-npm.ts` and `scripts/verify-dist.ts`. Prove
   `polar()` loads, key issuance, create/get through CLI/started/connected SDK
   and official Polar client against the same host, schema parsing,
   version/auth/input rejection, uniqueness races, atomic event, reset,
   isolation and durable restart. Build an installable npm archive with basic
   Node/Deno resource smoke proof. No webhook support is advertised yet. This is
   usable independently.
2. **Signed delivery and management.** Add Polar webhooks and event commands,
   transport, policy and manifest cases; extend only the shared safe-header
   allowlist. A caller-owned loopback receiver verifies captured Unicode bytes
   with `@polar-sh/sdk/webhooks` `validateEvent`, plus an independent Web Crypto
   vector and wrong-secret/tampered-body negatives. Prove 500 then success,
   timeout/non-2xx scheduling, all retry boundaries/exhaustion with fake
   scheduling, byte/ID reuse, current-secret rotation, explicit redelivery, no
   synthetic resource mutation, redaction and pending-delivery reset/restart
   boundaries. Existing Resend/Stripe/Cal.com tests remain green.
3. **Installed end-to-end verification.** Extend `scripts/verify-dist.ts` and a
   bounded Polar proof helper, parity/manifest cases, negative type fixtures,
   `docs/polar.md` and a runnable local example. Offline installed Node and Deno
   consumers use `polar()` plus foreground `emulon up`, create/read via CLI,
   connected SDK and official client on loopback, receive and independently
   verify a signed event, and compare CLI/started SDK/connected SDK/npm metadata
   manifests. Normalize SDK Date/camelCase conversions explicitly. Verify no
   development-only SDK dependency leaks into production archives. Include the
   exact endpoint/client recipe and custom-secret migration limitation.

## Consequences and remaining uncertainty

This scope deliberately prioritizes proving the plugin contract over checkout
usefulness. Payment and subscription behavior needs a later scoped decision.
Source inspection shows client/schema drift (for example the current pinned
OpenAPI requires `first_user_event_at`, which SDK 0.49.0 does not require).
Tests must assert the stored wire fixture as well as client parsing; success of
one permissive client is insufficient. If implementation uncovers incompatible
required fields, record the concrete mismatch in an amendment rather than
silently changing the version, widening the slice or downgrading to documented
HTTP.

Only documentation research accessed public sources. All implementation,
verification and installed-client tests use local fixtures, dynamic loopback
ports and cached archives; neither production nor sandbox Polar is a test
target.

## Addendum: customer contract implementation decisions

These choices were open inside the scope above and are settled by the first part
(customer contract and usable package). They add no provider operation,
credential mode or public facility beyond this ADR.

- `polar(options)` accepts an optional `organizationId`. The instance
  organization is otherwise a fresh local UUID, which a durable environment
  keeps across restarts but a fresh one regenerates; callers that need a fixed
  organization in assertions or fixtures set it. Invalid values fail at
  configuration time; [ADR 0038](0038-polar-license-keys.md) narrows valid
  values to version 4 UUIDs.
- Credentials are checked before `Polar-Version`, matching the existing plugins.
  An unauthorized request with an unsupported version therefore returns 401, and
  the selected version header appears only on responses that passed both checks.
  Recorded as `polar.limitation.9`.
- `POST /v1/customers` is accepted with and without the trailing slash instead
  of emulating the upstream redirect of the unslashed form
  (`polar.limitation.8`).
- An empty external ID is rejected rather than stored (`polar.limitation.5`), so
  uniqueness has no ambiguous empty value.
- Validation detail locations name the container (`body`, `query`, `path`) and,
  for known fields, the field. An unrecognized key is reported as an unsupported
  field without echoing the supplied key, because a key can carry caller data or
  a credential.
- An explicit `null` and an omitted `name` or `external_id` are the same local
  input; both store null.
- The selected OpenAPI excerpt is retained as
  `packages/polar/tests/fixtures/polar-2026-04-customers.openapi.json` with its
  source, commit, SHA-256 and retrieval date in `x-emulon-attribution`. It
  carries the two operations and the transitive closure of the reachable
  response and event schemas, copied verbatim. A test-only subset checker
  validates the wire projection and the recorded event against it, separately
  from official client parsing. The pinned `first_user_event_at` requirement is
  emitted; SDK 0.49.0 simply drops it when parsing, so no incompatible required
  field was found.
- `@polar-sh/sdk@0.49.0` reads the whole environment on construction. The
  workspace suite stubs `Deno.env.toObject` for that call instead of widening
  the test task's environment permission.
