# Polar customers from an installed project

`@emulon/polar` emulates one Polar organization: creating and reading customers
over the pinned `2026-04` API, and the `customer.created` webhook that creation
records. [ADR 0033](decisions/0033-polar-initial-slice.md) selected that slice,
and [the compatibility manifest](../packages/polar/src/compatibility.ts) is the
authoritative tested scope — nothing below claims coverage the manifest does not
declare.

## Configure and start

```ts
// emulon.config.ts
import { defineConfig } from 'emulon';
import polar from '@emulon/polar';

export default defineConfig({ services: { billing: polar() } });
```

```sh
emulon up
```

`polar(options?)` accepts `organizationId` (a fixed local UUID instead of a
generated one), `fixtures.customers` and webhook `destinations`. Fixtures take
part in email and external ID uniqueness and emit no events. One instance is one
organization; a second instance is a second organization with its own customers
and its own credentials.

## One state behind every caller

A running project serves the CLI, the connected typed SDK, plain HTTP and the
official client from the same instance state.

```sh
emulon billing keys create --json
emulon billing customers create --email ada@example.test --name Ada \
  --external-id usr_1 --json
emulon billing customers get --id <uuid> --json
emulon billing compatibility get --json
```

```ts
import { Emulon } from 'emulon';

await using env = await Emulon.connect({ config: await Emulon.load() });
const { apiKey } = await env.services.billing.keys.create({});
const customer = await env.services.billing.customers.create({
  email: 'ada@example.test',
  name: 'Ada',
  externalId: 'usr_1',
});
```

Management input is camelCase (`externalId`); every management result is the
provider wire projection with snake_case names and ISO strings, never a `Date`.

### The official client

```ts
import { Polar } from '@polar-sh/sdk';

const client = new Polar({
  accessToken: apiKey,
  serverURL: env.endpoints.billing.api,
  retryConfig: { strategy: 'none' },
});
const read = await client.customers.get({ id: customer.id });
```

Pass the endpoint without `/v1`: the generated methods append it. Never use
`server: 'sandbox'`, which selects the real public sandbox.

`@polar-sh/sdk@0.49.0` converts what it parses, so compare explicitly rather
than deep-equalling its result against the wire projection:

- properties become camelCase: `external_id` → `externalId`, `organization_id` →
  `organizationId`, `email_verified` → `emailVerified`;
- `created_at`, `modified_at` and `deleted_at` become `Date` objects, so
  `read.createdAt.toISOString()` is what equals `customer.created_at`;
- `first_user_event_at` is dropped: the pinned schema still requires it and the
  emulator emits it as `null`, but this client version does not model it;
- the webhook verifier returns the same camelCase/`Date` shape and drops
  `api_version`, which is present in the delivered bytes.

[`examples/polar/main.mjs`](../examples/polar/main.mjs) writes both
normalizations out field by field.

## Versioning: API 2026-04

Requests may send `Polar-Version: 2026-04`. A **missing header is a fixed
fallback to this pinned slice**, never a moving current version; any other value
returns 404 `UnsupportedOperation` after authentication and before any mutation.
Responses that passed authentication and version selection carry the selected
version back in `polar-version`. Credentials are checked first, so an
unauthorized request with an unsupported version returns 401
(`polar.limitation.9`).

## Credentials

`keys create` issues a random local `polar_oat_` organization access token. It
is the only output that contains a secret: status, inspection, destination
listings and errors never echo a token, a signing secret or supplied input.
Tokens are bound to their instance and environment, and `emulon reset`
invalidates them. They carry no upstream checksum suffix, scopes or expiration
(`polar.limitation.6`), and no OAuth, refresh, personal or session credential is
emulated.

## Webhooks: custom-secret signing

Creating a customer records one immutable `customer.created` event in the same
transaction and delivers it to the subscribed destinations:

```sh
emulon billing webhooks configure --id app --url http://127.0.0.1:4000/hooks \
  --secret whsec_local --types '["customer.created"]' --enabled --json
emulon billing webhooks list --json
emulon billing webhooks inspect <delivery-id> --json
emulon billing webhooks redeliver <delivery-id> --json
```

Deliveries use the Standard Webhooks framing Polar uses: `webhook-id`,
`webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` over the exact
bytes of `id.timestamp.body`, plus `webhook-api-version: 2026-04`.

**The key is the entire configured secret as UTF-8 bytes**, including any
`whsec_` prefix, which is never stripped and never base64-decoded. This is
Polar's legacy custom-secret mode, and the mode the pinned verifier expects:

```ts
import { validateEvent } from '@polar-sh/sdk/webhooks.js';

const event = validateEvent(body, headers, 'whsec_local');
```

Secrets the Polar dashboard generated after 2026-09-08 are interpreted by
Standard Webhooks decoding instead. **That mode is not supported and not
claimed** (`polar.limitation.7`): both modes can produce the same `whsec_`
prefix, so nothing is silently selected from the secret's shape. Use your own
configured secret locally.

### Retries and recovery differ from the hosted service

The local schedule is a deterministic approximation, not the hosted timing
contract (`polar.limitation.10`):

- ten attempts in total; after failed attempt _n_ (1..9) the next one is
  `min(1000 * 2 ** n, 1200000)` milliseconds later, and the tenth failure is
  terminal;
- no jitter, no endpoint disablement, no ordering guarantee, no email
  notification;
- 10-second request timeout, 2xx is success, redirects are not followed;
- `webhook-id` is scoped to one delivery to one destination and stays stable
  across retries and manual redelivery, rather than being a Polar event ID
  shared across destinations (`polar.limitation.11`);
- an interrupted in-flight attempt is not replayed automatically: it ends failed
  with an unknown outcome and needs a manual `webhooks redeliver`, which is
  itself refused while an automatic attempt is queued or in flight
  (`polar.limitation.12`). Queued retries do resume after a restart.

The frozen request bytes are reused by every retry and by manual redelivery, so
a receiver sees the same body and the same `webhook-id` each time.

## Reset and restart

`emulon reset --environment default` restores fixtures, drops customers, events
and deliveries, and invalidates issued tokens. A restarted foreground
`emulon up` reopens the retained state: the same customers, events and queued
retries, with previously issued tokens still valid.

## Errors

| Status | Body                                 | When                                       |
| ------ | ------------------------------------ | ------------------------------------------ |
| 401    | `{ error: 'Unauthorized' }`          | missing, unknown, foreign or reset token   |
| 404    | `{ error: 'UnsupportedOperation' }`  | unsupported route or `Polar-Version` value |
| 404    | `{ error: 'ResourceNotFound' }`      | no such customer                           |
| 409    | `{ error: 'CustomerAlreadyExists' }` | duplicate email or external ID             |
| 422    | `{ detail: [...] }`                  | malformed, unsupported or invalid input    |

Validation detail names the container (`body`, `query`, `path`) and, for known
fields, the field; an unrecognized key is never echoed, because a key can carry
caller data or a credential. These diagnostic codes and the duplicate behavior
are local contracts, not claims about Polar's error equivalence. Local
uniqueness is case-sensitive and there is no idempotency-key promise
(`polar.limitation.4`).

## Run the example

[`examples/polar/main.mjs`](../examples/polar/main.mjs) is the acceptance a user
can repeat. In a project that installed `emulon`, `@emulon/polar` and
`@polar-sh/sdk@0.49.0` and configured `billing: polar()`:

```sh
npx emulon up
```

In a second terminal:

```sh
node main.mjs
npx emulon down
```

For Deno, run both through `deno run` and pass the CLI prefix to the example so
its subprocess CLI uses Deno too:

```sh
deno run --no-config --no-lock --node-modules-dir=manual --cached-only \
  --allow-net=127.0.0.1 --allow-read --allow-write --allow-env --allow-run=deno \
  main.mjs '["deno",["run","--no-config","--no-lock","--node-modules-dir=manual","--cached-only","--allow-net=127.0.0.1","--allow-read","--allow-write","--allow-env","npm:emulon"]]'
```

It creates customers through the CLI, the connected SDK and the official client,
reads each one back through the other paths, receives four signed deliveries on
a loopback receiver and verifies every one twice — once with its own HMAC
computation and once with `validateEvent` — compares the manifest from the CLI,
the connected SDK and installed npm metadata, and finally proves a private
environment keeps its own state and releases its listener.

`deno task verify:dist` runs exactly this example inside fresh offline
installations under Node without Deno and under Deno, after installing the built
archives and the cached `@polar-sh/sdk` graph from local files. The official
client is a consumer test dependency: it is absent from the published plugin and
core packages, together with its `standardwebhooks` verifier, and no registry or
provider is contacted during verification.

## License keys

Local management commands create a `license_keys` benefit, grant it to an
existing customer of the same organization and manage the resulting key, as
[ADR 0038](decisions/0038-polar-license-keys.md) describes. They are not Polar
HTTP endpoints and record no `benefit_grant.*` event.

```sh
emulon billing benefits create --description 'Chorded Pro' \
  --limit-activations 3 --enable-customer-admin --json
emulon billing license-keys grant --benefit-id <uuid> --customer-id <uuid> --json
emulon billing license-keys list --json
emulon billing license-keys get --id <uuid> --json
emulon billing license-keys update --id <uuid> --status revoked --json
emulon billing license-keys deactivate --id <uuid> --activation-id <uuid> --json
emulon billing license-keys inspect --id <uuid> --json
```

`grant`, `list`, `get` and `update` return Polar's `LicenseKeyRead` with the
full `key`, which is a credential. `inspect` shows `display_key`, counters,
limits and live activation IDs only; failures, status and events never carry the
key. Paired flags go together: `--limit-activations` with
`--enable-customer-admin`, `--ttl` with `--timeframe`.

A desktop client uses the public customer-portal routes on the `api` endpoint:
`POST /v1/customer-portal/license-keys/activate`, `/validate` and `/deactivate`.
They read no token; the exact key together with the instance `organization_id`
is the credential. Activation stores `conditions`, and validation with that
`activation_id` requires the same JSON object. Refusals are Polar's exact
`{ error, detail }` envelopes, checked in the order the ADR lists, and a body
that fails validation returns `422 RequestValidationError` with `type`, `loc`
and `msg` only, never the submitted key or conditions.

## Not emulated

Products, prices, checkouts, orders, subscriptions, the customer portal other
than license key activate, validate and deactivate, the authenticated benefit,
benefit-grant and license-key APIs, payment methods, refunds, listing, updating
and deleting customers are unsupported, and so are team customers, metadata,
billing addresses, tax IDs and locales. This is a customer integration emulator,
not a payment or licensing simulator. Every limitation has a stable ID in the
manifest, and no comparison with a live Polar account was made
(`liveProviderCompared: false`).
