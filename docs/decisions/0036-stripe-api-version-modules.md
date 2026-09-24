# 0036: Stripe API versions as selectable modules

Status: Accepted. This replaces the single-version restriction in
[ADR 0035](0035-stripe-checkout-and-payments.md). Its resource scope and the
idempotency, signing, and delivery decisions in
[ADR 0029](0029-stripe-initial-slice.md) remain in force.

## Context and choice of owner

The Stripe plugin currently serves `2026-04-22.dahlia`. Its route, model, event,
and compatibility declarations all assume that one wire format.
`2025-03-31.basil` differs in both parameters and objects: promotion codes use
top-level `coupon` in basil and nested `promotion` in dahlia. Stripe's official
Node clients pin these respective versions: `stripe@18.0.0` pins basil and
`stripe@22.1.1` pins dahlia. A version header is therefore a behavioral
contract, not just a response header.

Options considered:

- A core version registry for every plugin would give one API, but would impose
  a request and webhook policy on providers whose rules differ. Cal.com selects
  versions by route, GitHub has versioned REST and unversioned web surfaces, and
  Polar has its own header and error contract. It would also change the plugin
  authoring API before a second plugin needs multiple implementations.
- Stripe-owned modules can normalize provider input and project provider output
  while the host continues to own neutral event, destination, and delivery
  machinery.

Choose Stripe-owned version selection and modules. There is no new core
`apiVersions` registry, resolver, or public versioned-plugin API. Existing
plugins keep their current definitions, routes, manifests, and version rules.
Core needs only the optional, provider-neutral presentation hooks and
destination settings described below; plugins that do not opt in retain their
current behavior. Another provider can adopt the pattern later without
inheriting Stripe's semantics. This decision does not migrate any other plugin.

## Configuration and resolution

The Stripe factory accepts these typed options in addition to existing options:

```ts
stripe({
  apiVersions: ['2026-04-22.dahlia', '2025-03-31.basil'],
  defaultApiVersion: '2026-04-22.dahlia',
  destinations: [{
    id: 'billing',
    url: 'http://127.0.0.1:3000/stripe',
    secret: 'whsec_local',
    types: ['checkout.session.completed'],
    enabled: true,
    apiVersion: '2025-03-31.basil',
  }],
});
```

`apiVersions` selects installed module IDs for one plugin instance, not a
downloadable module path. The package exports and registers both modules; a
later release adds a version by adding its module and manifest coverage. The
list must be nonempty, unique, and contain only shipped versions.
`defaultApiVersion` must be selected. If both options are absent, select only
dahlia and use it as the account default, preserving existing configuration
behavior. If `apiVersions` is supplied without `defaultApiVersion`, dahlia is
still the default when selected; otherwise startup requires an explicit default.
These values are fixed per started instance; neither `latest` nor a current-date
alias is accepted.

For an authenticated Stripe API request, an explicit `Stripe-Version` selects
that exact enabled module. Without the header, select the instance account
default. Unknown, disabled, empty, or malformed values fail before parsing
parameters, executing domain work, recording an event, or consuming an
idempotency key. Return a safe Stripe-style `400 invalid_request_error` with the
selected account default in `Stripe-Version` on this error; a successful
response and ordinary errors report the version actually selected. Keep the
existing authentication-before-version check, so invalid credentials still
return 401. There is no fallback to another installed version.

A webhook endpoint has its own pinned `apiVersion`. Stripe fixture destinations
and `webhooks.configure` accept it, and `webhooks.destinations` reports it
without exposing the secret. If omitted on creation, copy the account default at
that time. Reconfiguration without a value retains an existing endpoint's pinned
version; supplying a different enabled version changes only future deliveries.
Disabling a version that a retained endpoint uses fails startup with a safe
configuration error, rather than silently changing its projection. The selected
endpoint version governs the delivered event, even when the mutation came from a
request with a different `Stripe-Version`. This matches Stripe's
endpoint-version override. A new endpoint with no explicit version uses the
account default. Thus the source request's version governs its API response and
event view, while each subscribed endpoint receives its own versioned snapshot.

## Module boundary and neutral state

The plugin keeps a registry keyed by exact version ID. A version module owns
provider HTTP parameter decoding and validation after common form parsing,
version-specific error fields, expandable paths, object/list/response
projection, and event envelope and `data.object` projection. The same module
validates provider event input accepted by `events.publish` and `webhooks.send`.
Common routing, authentication, idempotency orchestration, resource IDs,
business rules, clock, store transactions, and outbox selection are shared. The
store contains semantic resource records and canonical event facts captured at
mutation time, with no Stripe API wire object or fixed API version as their
schema. Snapshotting the canonical fact at commit prevents a later resource
update from changing an already-created event.

This is the intended internal interface shape; the precise TypeScript types
belong to the Stripe package, not the `emulon` public API:

```ts
interface StripeVersionModule {
  readonly id: string;
  parse(operation: OperationId, form: Params): CanonicalInput;
  project(
    operation: OperationId,
    result: CanonicalResult,
    expand: readonly string[],
  ): Promise<unknown>;
  projectEvent(fact: CanonicalEvent): StripeEvent;
  parseEvent(type: EventType, input: unknown): CanonicalEvent;
  error(error: StripeDomainError): StripeHttpError;
}
```

The common route resolves a module once, asks it to parse, executes the shared
operation with canonical input, and asks it to project the result. A list
projects every member; nested objects and expanded references go through the
same module, so no dahlia-shaped field leaks inside basil output. Commands that
expose provider objects accept an optional `apiVersion` (CLI `--api-version`);
its absence selects the account default. They share these projections. The
module may use common helpers for identical shapes, but common route and model
code contains no branches on specific version IDs. Cross-version requests see
one state: a coupon or promotion code created through basil can be retrieved
through dahlia and vice versa.

For example, the basil module parses `coupon=cou_...` to canonical
`{ couponId: 'cou_...' }`, and projects a promotion code with a top-level
`coupon` object. The dahlia module parses
`promotion[type]=coupon&promotion[coupon]=cou_...` to the same canonical input
and projects `{ promotion: { type: 'coupon', coupon: 'cou_...' } }`. Each module
rejects the other's input shape with a version-appropriate parameter error. The
full basil `coupon` object, dahlia expansion behavior, and other differences
must follow their versioned references and official client tests, rather than
copying this example as the entire compatibility contract.

Idempotency compares method, path, resolved version, and canonical validated
parameters, as ADR 0029 requires. A committed replay returns a projection in the
original version without repeating state changes or events. Persist a neutral
result reference/snapshot for replay, not a dahlia response body. Using the same
key with a different version fails with Stripe's `idempotency_error`; invalid
version requests do not consume keys.

For service events, the canonical fact records the source request's resolved
version (or the account default for a control action) as event-view metadata.
`env.events.list` and `follow` must expose a provider event projected in that
source version, with matching `api_version`, while retaining the canonical fact
internally. A synthetic provider event supplied through control commands must
declare or unambiguously carry an enabled version, be validated by that module,
and normalize to a canonical fact before recording; it cannot smuggle an
unsupported wire payload into the outbox.

At queue materialization, project a separate immutable event body for each
destination's pinned version, set `api_version` accordingly, and retain those
exact bytes with the delivery. Retries and manual redelivery reuse the body and
event ID, and only regenerate the timestamp and signature. A later endpoint
version change cannot rewrite queued or historical deliveries.

Add these optional, provider-neutral hooks to the public plugin authoring
contract. `PluginDefinition.presentation?(options)` creates them before store
recovery and the first dispatch transaction, using the selected instance
options. They receive an immutable canonical event snapshot; no callback may
change the committed fact:

```ts
interface PluginDefinition<Options, Commands> {
  presentation?(options: Options): PluginPresentation;
}

interface PluginPresentation {
  eventView?(event: EventRecord): unknown;
  deliverySnapshot?(
    event: EventRecord,
    destination: Destination,
  ): Uint8Array;
}
```

The host uses `eventView` for event list, follow, and CLI output, replacing only
the returned payload. It calls `deliverySnapshot` inside the enqueue transaction
for subscribed and direct deliveries and stores the exact bytes in private
delivery state. The callback is deterministic and has no external effects, so
replaying recovery cannot change a delivery body. The worker sends that snapshot
when present; otherwise it uses the existing transport serializer. The shared
destination gains an optional JSON `provider` settings object; Stripe validates
and stores its endpoint `apiVersion` there, and reads it for projection. Its
public Stripe commands present the typed `apiVersion` field rather than a raw
settings bag. Existing plugins omit both hooks and the settings object, so their
event and delivery behavior remains the same. Neither hook resolves versions in
core.

If changing persisted Stripe records requires a new state schema, follow the
existing exact-version startup rejection and explicit reset guidance. Do not
reinterpret old dahlia event or idempotency bodies as canonical data, and do not
silently reset a retained environment. Startup also rejects removal of a version
referenced by retained events or deliveries until state is explicitly reset. The
no-options dahlia API behavior and existing operation scope remain the
compatibility baseline.

## Compatibility declaration

[ADR 0028](0028-compatibility-manifest.md) remains the single declaration and
the source of the CLI, started SDK, connected SDK, and npm metadata views. Its
current schema permits one official-client pin and requires globally unique
operation and event IDs, so duplicating the current entries for two versions
would be invalid. Introduce manifest schema version 2 alongside version 1; other
plugins remain valid with their existing version-1 manifests.

Version 2 keeps the existing fields, but keys operation and event claims by
`(id, version)`, permits a `webhooks` claim per version, and replaces the one
`verification.client` with `verification.byVersion[]`. Each entry names an exact
declared version, `official-client` or `documented-http`, the exact client pin
when applicable, suites and case IDs, source URLs, retrieval date, and
`liveProviderCompared: false`. Its case registry uses distinct IDs per version;
schema validation checks that every claimed operation, event, and webhook
version exists, every shipped version has coverage for the complete declared
slice, and every case reference points to an executed case. The version policies
state that the missing header selects the instance account default and an
unknown or disabled version fails. Static metadata lists both shipped versions
and verified coverage; instance selection and credentials are never inserted
into npm metadata or the static manifest.

`compatibility get` through CLI and either SDK connection returns this version-2
manifest from the host. It shows both versions, their individual operation,
event and webhook claims, and the respective official client pins. All views
must match the installed package metadata as ADR 0028 requires. The command does
not imply that every shipped version is enabled in this instance; `apiVersions`
determines that at runtime.

## Verification and consequences

Keep both official clients as exact, test-only aliases in root `deno.json`:

```json
{
  "imports": {
    "stripe": "npm:stripe@22.1.1",
    "stripe-basil": "npm:stripe@18.0.0"
  }
}
```

The dahlia suite imports `stripe`, and the basil suite imports `stripe-basil`;
each client uses its own pinned `apiVersion` and a loopback HTTP endpoint. The
aliases stay out of `packages/stripe/src`, its npm archive, and runtime
dependencies. Verify the built archive and its Node consumer with no Deno
installation. Deno's import-map aliases support two exact npm versions side by
side without changing published dependencies.

Run the entire ADR 0035 slice separately with each client: customers, catalog,
coupons, promotion codes, Checkout and its local payment completion, generated
intents and charges, refunds, disputes, the six declared events, signed
webhooks, errors, expansion, pagination, and idempotency. Add explicit
cross-version creation/read and concurrent mixed-version cases, a default
version case without a header, rejection for unknown and disabled versions, and
endpoint overrides in both directions. Assert basil's top-level coupon versus
dahlia's nested promotion in input, output, and expansions. Check event and
webhook envelopes and object projections for all six declared event types. Check
that a queued delivery retains its original bytes across retries, redelivery,
restart, and endpoint reconfiguration. Test CLI and both SDK connection modes
against the same manifest and exercise the installed Node consumer. Use loopback
receivers and fixtures only; no real provider or public network is involved. The
manifest claims only cases that actually pass.

No new production dependency is selected. This decision introduces optional
generic event and delivery presentation hooks in core, a version-2 compatibility
metadata shape, and Stripe-owned version modules. It does not add routes or
promise behavior beyond the existing bounded resource slice.

## References

- [Stripe API versioning](https://docs.stripe.com/api/versioning?lang=node)
  describes request overrides, account defaults, and webhook endpoint versions.
- [Stripe webhook endpoint version](https://docs.stripe.com/api/webhook_endpoints/create)
  describes the endpoint override of the account default.
- [Basil promotion code creation](https://docs.stripe.com/api/promotion_codes/create?api-version=2025-03-31.basil)
  and
  [object](https://docs.stripe.com/api/promotion_codes/object?api-version=2025-03-31.basil)
  show the top-level coupon.
- [Dahlia promotion code object](https://docs.stripe.com/api/promotion_codes/object?api-version=2026-04-22.dahlia)
  shows the nested promotion.
- [Stripe Node API pins for basil](https://raw.githubusercontent.com/stripe/stripe-node/v18.0.0/src/apiVersion.ts)
  and
  [dahlia](https://raw.githubusercontent.com/stripe/stripe-node/v22.1.1/src/apiVersion.ts),
  and
  [Deno import-map aliases](https://docs.deno.com/examples/add_remove_dependencies_tutorial/#aliasing-a-package).
