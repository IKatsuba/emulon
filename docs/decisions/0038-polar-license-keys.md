# 0038: Polar license keys and public activation

## Context

The existing Polar customer and webhook slice is defined by
[ADR 0033](0033-polar-initial-slice.md). A desktop client needs to activate and
validate a purchased license without embedding an organization access token.
Local management commands replace the hosted purchase and benefit-grant
workflow. This extends the same pinned `2026-04` API, organization instance,
customer records, durable store and
[compatibility manifest](0028-compatibility-manifest.md); it does not change the
product decision to provide a Polar plugin.

Sources were inspected on 2026-09-26. The only shape and message authorities are
the
[pinned Polar OpenAPI](https://raw.githubusercontent.com/polarsource/polar/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/docs/openapi/2026-04.openapi.json)
(SHA-256 `616cd5bad20b9170be8ba0640c9d729009b5dbd39c29e9ede928d36ea21fd0d6`),
[Polar server source](https://github.com/polarsource/polar/tree/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar),
and the already pinned
[`@polar-sh/sdk@0.49.0`](https://github.com/polarsource/polar-js/tree/v0.49.0).
No live account or provider mutation was used.

## Options

- Implement only public activate and validate with seeded keys. This cannot
  exercise the benefit-to-key lifecycle or give callers a way to free an
  activation.
- Add the three public customer-portal operations and local management commands
  for benefit, grant, key, activation and inspection. This covers the desktop
  lifecycle without pretending to run checkout, orders or subscriptions.
- Implement Polar's authenticated license-key and benefit-grant HTTP APIs too.
  That expands authentication, grant scopes and billing dependencies beyond this
  use case.

## Decision

Select the second option. Add only
`POST /v1/customer-portal/license-keys/activate`, `/validate` and `/deactivate`
on the existing `api` surface. All three are public: no Bearer token is required
or checked. The key itself is the credential, and a lookup uses **both** exact
`key` and `organization_id` in the request body. A key from a different
organization is indistinguishable from an unknown key. The current
single-organization instance accepts only its configured organization ID.
Because these bodies accept only a version 4 UUID of the RFC 4122 variant, the
`organizationId` option is held to the same rule when `polar(options)` is called
and is stored lowercased; any other value fails at configuration time rather
than on every public call. Apply ADR 0033's fixed `Polar-Version: 2026-04`
selection to these routes independently of OAT authentication; missing selects
the pin, and an unsupported supplied version still fails before mutation. The
[customer-portal endpoints](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/customer_portal/endpoints/license_keys.py#L144-L233)
and the pinned SDK's
[activate](https://github.com/polarsource/polar-js/blob/v0.49.0/src/funcs/customerPortalLicenseKeysActivate.ts),
[validate](https://github.com/polarsource/polar-js/blob/v0.49.0/src/funcs/customerPortalLicenseKeysValidate.ts),
and
[deactivate](https://github.com/polarsource/polar-js/blob/v0.49.0/src/funcs/customerPortalLicenseKeysDeactivate.ts)
methods all use these paths without request security. Do not add the
authenticated `/v1/license-keys/*` routes.

### Resource and wire model

A `license_keys` benefit belongs to the instance organization and has an ID,
description and `properties` following `BenefitLicenseKeysCreate`: optional
`prefix`, `expires: { ttl, timeframe: "year" | "month" | "day" }`,
`activations: { limit, enable_customer_admin }`, and `limit_usage`. The positive
activation limit is stored on each granted key as `limit_activations`; absent
`activations` means `null` and does **not** permit activation. The positive TTL
is applied at grant time to produce `expires_at` (null when absent), with
calendar months/years as in Polar, not a fixed day approximation. A
subscription-backed non-expiring exception is unnecessary because this slice has
no subscriptions. An absent usage limit is `null`. The create schema also
requires `type: "license_keys"` and a 3–42 character description; local
management binds `organization_id` to the instance. Keep the schema's positive
bounds and required `enable_customer_admin`, even though customer-admin portal
pages are outside this slice.
[Benefit schemas](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/benefit/strategies/license_keys/schemas.py),
[grant mapping](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L467-L507),
[key construction](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/schemas.py#L245-L345).

A grant connects that benefit and an existing customer in the same organization
to one license key. The key has a UUID ID; `organization_id`, `customer_id`,
`benefit_id`; the full `key` and `display_key`; `status`; `limit_activations`,
`usage`, `limit_usage`, `validations`, `last_validated_at`, `expires_at`; and
created/modified timestamps. Initialize status `granted`, usage and validations
`0`, last validation `null`. Only `granted`, `revoked`, `disabled` exist in the
pinned schema; there is no `pending`. Explicit management may set any of those
three, including regranting a revoked/disabled key. `granted` alone is active.
Generate `key` as an uppercase cryptographically random UUID4, optionally
preceded by the trimmed, uppercased benefit prefix and `-`. `display_key` is
`****-` plus the last six key characters. Compare full keys case-sensitively.
Uniqueness is organization-scoped, and generation must use secure randomness and
retry a collision.
[Key schema and generation](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/schemas.py#L155-L258),
[UUID source](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/kit/utils.py#L9-L10),
[key model](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/models/license_key.py).

An activation has a UUID ID, `license_key_id`, `label`, `meta`,
creation/modification timestamps, stored `conditions`, and a deletion marker.
Both `meta` and `conditions` default to `{}` and accept the schema's bounded
metadata object (at most 50 keys, key length 1–40; string values length 1–500,
or number/boolean). `activate` **stores** conditions; it does not check them.
`deactivate` soft-deletes only an activation belonging to the supplied key;
active counts and the get projection omit deleted activations. Conditions are
internal state, not a field in `LicenseKeyActivationBase` or
`LicenseKeyActivationCreated` responses.
[Activation model](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/models/license_key_activation.py),
[input and output schemas](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/schemas.py#L71-L234),
[activation service](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L359-L465).

The public request/response contract is:

| Operation  | JSON body                                                                                            | Success                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activate   | `{ key, organization_id, label, conditions?, meta? }`                                                | `200` `LicenseKeyActivationCreated`: `id`, `license_key_id`, `label`, `meta`, `created_at`, `modified_at`, and `license_key: LicenseKeyRead` with `status: "granted"`. |
| Validate   | `{ key, organization_id, activation_id?, benefit_id?, customer_id?, increment_usage?, conditions? }` | `200` `ValidatedLicenseKey`: all `LicenseKeyRead` fields, `status: "granted"`, and nullable `activation`.                                                              |
| Deactivate | `{ key, organization_id, activation_id }`                                                            | `204` with no body.                                                                                                                                                    |

`LicenseKeyRead` includes the required `customer` projection; reuse the existing
customer record and its 2026-04 fields. `conditions` and `meta` are omitted by
the desktop client and must default to `{}`. `activation` is null when
validation omits `activation_id`; a key with activations can still be validated
without one. If an activation has nonempty stored conditions, validation with
its ID requires equality of the **entire JSON object**: same members and JSON
values, independent of object member order, with no subset, string conversion or
version-specific interpretation. Empty stored conditions impose no comparison.
No condition comparison happens without an activation ID.
[Validation order](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L289-L357),
[OpenAPI response schemas](https://raw.githubusercontent.com/polarsource/polar/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/docs/openapi/2026-04.openapi.json).

Each successful validation increments `validations`, sets `last_validated_at`
and adds `increment_usage` to `usage` only when the increment is positive. The
remaining allowance is checked only when a positive increment and `limit_usage`
exist; a plain validation consumes no usage. Failed validation does not change
either counter. Activation-count checks and counter updates must be atomic for
concurrent requests, as the pinned service locks the key row before checking and
writing. Time comparisons use the supplied clock, and expiry begins at
`now >= expires_at`.
[Validation and locking](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L289-L410),
[counter model](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/models/license_key.py).

### Refusals and their precedence

For well-formed requests, the first applicable check wins. A missing
`(organization_id, key)` match comes first on all three routes. For activate,
the order is deleted key, status, expiry, no activation benefit, then live
activation count. For validate, the order is status, expiry, activation lookup,
nonempty activation conditions, benefit ID, customer ID, then usage allowance.
Deactivate checks key lookup then live activation lookup; it does not recheck
key status or expiry. These orders are taken from
[endpoint lookup](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/customer_portal/endpoints/license_keys.py#L153-L233)
and
[service branches](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L289-L463),
rather than sorted by HTTP status. Request-body validation happens before the
endpoint lookup.

Every non-422 row below is the exact JSON envelope
`{ "error": <error>, "detail": <detail> }`. The
[Polar exception handler](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/exception_handlers.py#L16-L38)
uses the exception class name for `error`;
[exception definitions](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/exceptions.py#L83-L114)
set the default status and `Not found` text.

| Route and condition                                            | Status | `error`            | Exact `detail`                                                                                                 | Polar source                                                                                                                                              |
| -------------------------------------------------------------- | -----: | ------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any: unknown key, wrong organization, or deleted key at lookup |    404 | `ResourceNotFound` | `Not found`                                                                                                    | [lookup](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L118-L131)                |
| Activate: deleted key after lookup                             |    404 | `ResourceNotFound` | `Not found`                                                                                                    | [activate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L380-L387)              |
| Activate: `revoked` or `disabled`                              |    403 | `NotPermitted`     | `License key is no longer active. This license key can not be activated.`                                      | [activate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L389-L393)              |
| Activate: expired                                              |    403 | `NotPermitted`     | `License key has expired.`                                                                                     | [activate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L395-L396)              |
| Activate: benefit has no activations                           |    403 | `NotPermitted`     | `This license key does not support activations. Use the /validate endpoint instead to check license validity.` | [activate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L398-L402)              |
| Activate: live activation count at limit                       |    403 | `NotPermitted`     | `License key activation limit already reached`                                                                 | [activate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L404-L416)              |
| Validate: `revoked` or `disabled`                              |    404 | `ResourceNotFound` | `License key is no longer active.`                                                                             | [validate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L313-L315)              |
| Validate: expired                                              |    404 | `ResourceNotFound` | `License key has expired.`                                                                                     | [validate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L317-L319)              |
| Validate: unknown, deleted, or foreign activation ID           |    404 | `ResourceNotFound` | `Not found`                                                                                                    | [activation lookup](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L151-L168)     |
| Validate: nonempty activation conditions differ                |    404 | `ResourceNotFound` | `License key does not match required conditions`                                                               | [validate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L321-L331)              |
| Validate: supplied benefit ID differs                          |    404 | `ResourceNotFound` | `License key does not match given benefit.`                                                                    | [validate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L333-L335)              |
| Validate: supplied customer ID differs                         |    404 | `ResourceNotFound` | `License key does not match given user.`                                                                       | [validate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L337-L342)              |
| Validate: increment exceeds remaining usage                    |    400 | `BadRequest`       | `License key only has {remaining} more usages.`                                                                | [validate](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L344-L352)              |
| Deactivate: unknown, deleted, or foreign activation ID         |    404 | `ResourceNotFound` | `Not found`                                                                                                    | [deactivate and lookup](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L151-L168) |

Malformed JSON or a schema-invalid body on any public route returns `422` with
`{ "error": "RequestValidationError", "detail": [{ "type": "...", "loc": ["body", "..."], "msg": "..." }] }`.
Use Pydantic's `missing` / `Field required` for a missing required field, and
field-specific types and messages for invalid UUID, negative `increment_usage`,
and invalid metadata. The pinned OpenAPI's `HTTPValidationError` lists only
`detail`, while its `ValidationError` element requires `type`, `loc`, `msg` and
permits `input` and `ctx`; the pinned
[runtime handler](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/exception_handlers.py#L25-L38)
adds `error` and may include `input`. Local validation must omit `input`, `ctx`,
submitted values and unknown field names because these may contain the license
key. This is a disclosed safe diagnostic projection; tests assert the required
trio and the absence of secrets. The request field constraints come from
[Polar's input schemas](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/schemas.py#L71-L121)
and the pinned OpenAPI components `LicenseKeyActivate`, `LicenseKeyValidate`,
`LicenseKeyDeactivate`, `ValidationError`.

### Management, events and compatibility

Add these typed commands and corresponding CLI paths, using the existing command
registry and organization-local control authorization:

| Command                  | CLI path and flags                                                                                                           | Input and result                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `benefits.create`        | `benefits create --description [--prefix] [--limit-activations --enable-customer-admin] [--ttl --timeframe] [--limit-usage]` | `{ description, prefix?, limitActivations?, enableCustomerAdmin?, ttl?, timeframe?, limitUsage? }` creates `BenefitLicenseKeys`; the flat input keeps one flag per top-level field as the command registry requires and is mapped to the nested provider `properties`. `type` is fixed to `license_keys` and the organization comes from the instance. Paired fields must be supplied together. |
| `licenseKeys.grant`      | `license-keys grant --benefit-id --customer-id`                                                                              | `{ benefitId, customerId }` requires an existing local customer and benefit in the same organization, creates a random key and returns `LicenseKeyRead` with its full `key`. Caller-supplied key material is excluded.                                                                                                                                                                          |
| `licenseKeys.list`       | `license-keys list`                                                                                                          | `{}` returns `LicenseKeyRead[]` for the instance organization.                                                                                                                                                                                                                                                                                                                                  |
| `licenseKeys.get`        | `license-keys get --id`                                                                                                      | `{ id }` returns `LicenseKeyWithActivations`, including only live activations. The list schema has no `activations` field; callers use get for those records.                                                                                                                                                                                                                                   |
| `licenseKeys.update`     | `license-keys update --id --status`                                                                                          | `{ id, status }` sets `granted`, `revoked` or `disabled`, returns `LicenseKeyRead`, and preserves the key and counters.                                                                                                                                                                                                                                                                         |
| `licenseKeys.deactivate` | `license-keys deactivate --id --activation-id`                                                                               | `{ id, activationId }` frees one activation belonging to the specified key; return `{ deactivated: true }`.                                                                                                                                                                                                                                                                                     |
| `licenseKeys.inspect`    | `license-keys inspect --id`                                                                                                  | `{ id }` returns diagnostic state with `display_key` only, including counters, limits and live activation IDs.                                                                                                                                                                                                                                                                                  |

These are **local management commands**, not claims that Polar has matching
grant HTTP endpoints. Management inputs use camelCase like the existing customer
commands; provider JSON uses the pinned schema's snake_case. The explicit
grant/list/get results include the full `key` as Polar's `LicenseKeyRead` does;
treat it as a credential. Redact it in logs, generic status, failures,
event/delivery inspection and diagnostics just as OATs are redacted. Never log
request bodies or conditions. Keep command and CLI errors free of supplied key
text. The schema-derived projections, command flags and output types need direct
parity tests.
[Polar key output schema](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/schemas.py#L155-L214).

Polar emits `benefit_grant.created`, `benefit_grant.updated`,
`benefit_grant.revoked` and `benefit_grant.cycled` through its full grant
lifecycle;
[grant service](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/benefit/grant/service.py#L180-L230)
and
[key update](https://github.com/polarsource/polar/blob/5514f6a85e9e856857f8662a58d1deb69bc4a2fd/server/polar/license_key/service.py#L159-L183)
show this. Defer these events here: the local grant command creates a key
without modeling benefit-grant scope or checkout, and the desktop flow consumes
the key directly. Do not publish a partial `benefit_grant.*` payload or claim
these events in the manifest. A future grant-lifecycle decision can add them
with full schema and delivery tests. Existing `customer.created` remains the
only automatic Polar event in this slice.

Extend `packages/polar/src/compatibility.ts` under ADR 0028 only as each
operation and case is implemented. Record the three public operations, request
and response projections, `auth: none`, organization/key scoping, SDK pin,
source revision, version policy, refusal and redaction cases, and explicit
unsupported management/provider operations. Update the case registry, installed
npm metadata, `packages/polar/README.md`, `docs/polar.md` and a runnable local
example. Products, checkout, orders, subscriptions, authenticated license-key
API, hosted customer portal pages, rotation, benefit-grant HTTP API and all
other Polar operations still return `UnsupportedOperation`; no request is
proxied to Polar.

### Amendment after part 1

Part 1 resolved three gaps in this decision:

- `benefits.create` takes the flat camelCase input shown in the table instead of
  a nested `properties` object. The command registry derives exactly one flag
  per top-level input field; dotted flag paths would be a separate core
  decision. Pair validation (`limitActivations` with `enableCustomerAdmin`,
  `ttl` with `timeframe`) is unchanged, and the provider projection still emits
  the nested `properties` of `BenefitLicenseKeys`.
- The ADR 0028 manifest schema accepts cases only for HTTP operations, events
  and webhooks. Local management commands are therefore recorded as a limitation
  and in the service details, not as cases.
- `BenefitLicenseKeys` fields this decision did not specify are fixed local
  values: `selectable`, `deletable` and `visibility_configurable` are `true`,
  `is_deleted` is `false`, `visibility` is `public` and `metadata` is empty.
  Product attachment, visibility changes and deletion remain unsupported, and
  the manifest discloses this as a limitation.

## Suggested implementation parts

Each part is large enough for one development run, is reviewed and independently
checked before the next part, and passes `deno task check`.

1. **Management model and commands.** Add durable benefit/key/activation records
   and customer linkage, secure key generation, expiry/counters/status
   transitions, local management commands, redacted inspection and
   command/CLI/started/connected SDK parity. A developer can grant and manage a
   key without the public routes. Test reset, restart, cross-organization
   rejection and concurrent activation-limit state primitives. Claim only
   executable management coverage in the manifest.
2. **Public license lifecycle.** Add the three no-token routes, response
   projections, precise refusal table, request validation and atomic
   transitions. Run a table-driven case for every row and precedence
   combination, including raw desktop-shaped fetch bodies and
   `@polar-sh/sdk@0.49.0` with `serverURL` on a dynamic loopback port. Prove
   grant → activate → validate → deactivate → validate (`Not found`), plus plain
   validate without activation ID, counters, usage and redaction. Register only
   passing operations/cases in the manifest.
3. **Installed consumer and documentation.** Use offline built archives under
   Node without Deno on `PATH` and Deno with cached dependencies. Prove the same
   CLI, connected SDK, raw fetch and official SDK lifecycle in an isolated
   installed consumer. Compare runtime and npm manifests; add README,
   `docs/polar.md` and a runnable example. No real provider, public network or
   account is used by tests.

## Consequences

The public key is sufficient to activate, validate and deactivate its own
allocations, matching Polar's customer-portal contract. Anyone who knows a key
and organization ID can free an activation; that is an upstream property, so key
generation and diagnostic redaction matter. This slice does not simulate payment
completion, subscription grant rules, customer portal login or benefit-grant
events. The explicit 422 diagnostic projection differs from Polar's runtime
optional `input` field to avoid echoing a secret. The existing version and
installed-distribution limits in ADR 0033 remain in force.
