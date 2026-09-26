# @emulon/polar

Local Polar customers and license keys over the pinned `2026-04` API, selected
in [ADR 0033](../../docs/decisions/0033-polar-initial-slice.md) and
[ADR 0038](../../docs/decisions/0038-polar-license-keys.md).
[The Polar guide](../../docs/polar.md) covers configuration, the official
client's conversions, signing, retries and the
[runnable example](../../examples/polar/main.mjs). The
[compatibility manifest](src/compatibility.ts) is the authoritative tested
scope. One instance is one organization: a local `polar_oat_` organization
access token fixes it, and creating a customer atomically records
`customer.created` and delivers it to the configured destinations.

```ts
import { Emulon } from 'emulon';
import polar from '@emulon/polar';

await using env = await Emulon.start({ services: { billing: polar() } });
const { apiKey } = await env.services.billing.keys.create({});
const response = await fetch(`${env.endpoints.billing.api}/v1/customers/`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'polar-version': '2026-04',
  },
  body: JSON.stringify({ email: 'ada@example.test', name: 'Ada' }),
});
console.log(await response.json());
console.log(await env.services.billing.customers.get({ id: 'the-uuid' }));
```

The official client reaches the same host without a network round trip:

```ts
import { Polar } from '@polar-sh/sdk';

const client = new Polar({
  accessToken: apiKey,
  serverURL: env.endpoints.billing.api,
  retryConfig: { strategy: 'none' },
});
await client.customers.create({ email: 'ada@example.test' });
```

For a running project configured with instance `billing`:

```sh
emulon billing keys create --json
emulon billing customers create --email ada@example.test --name Ada \
  --external-id usr_1 --json
emulon billing customers get --id <uuid> --json
emulon billing webhooks configure --id app --url http://127.0.0.1:4000/hooks \
  --secret whsec_local --types '["customer.created"]' --enabled --json
emulon billing webhooks list --json
emulon billing webhooks inspect <delivery-id> --json
emulon billing webhooks redeliver <delivery-id> --json
emulon billing compatibility get --json
```

Deliveries carry the Standard Webhooks framing Polar uses: `webhook-id`,
`webhook-timestamp`, `webhook-signature` and `webhook-api-version`. The
signature is an HMAC-SHA256 over the exact bytes of `id.timestamp.body`, keyed
by the **entire** configured secret as UTF-8 bytes, so the pinned
`@polar-sh/sdk` verifier accepts it:

```ts
import { validateEvent } from '@polar-sh/sdk/webhooks.js';

const event = validateEvent(body, headers, 'whsec_local');
```

This is Polar's legacy custom-secret mode. Secrets the Polar dashboard generated
after 2026-09-08 are base64-decoded instead and are not supported; see the
manifest limitations for that and for the local retry schedule.

## License keys

Local management commands create a `license_keys` benefit and grant it to a
customer; the grant returns Polar's `LicenseKeyRead` with the full `key`, which
is a credential. A desktop client then calls the public customer-portal routes
with that key and the instance `organization_id`, and no token:

```sh
emulon billing benefits create --description 'Desktop Pro' \
  --limit-activations 2 --enable-customer-admin --json
emulon billing license-keys grant --benefit-id <uuid> --customer-id <uuid> --json
emulon billing license-keys inspect --id <uuid> --json
```

```ts
const portal = `${env.endpoints.billing.api}/v1/customer-portal/license-keys`;
const activated = await fetch(`${portal}/activate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key, organization_id: organizationId, label: 'Mac' }),
});
```

`/validate` and `/deactivate` take the same `key` and `organization_id` with the
`activation_id`, and the official client's `customerPortal.licenseKeys` methods
reach the same routes. After deactivation, validating that activation returns
404 `{ "error": "ResourceNotFound", "detail": "Not found" }`. Refusals are
Polar's exact envelopes; inspection, errors and logs show only `display_key`.
[`examples/polar/license.mjs`](../../examples/polar/license.mjs) runs the whole
lifecycle through the CLI, the connected SDK, raw `fetch` and `@polar-sh/sdk`
with one command; [the guide](../../docs/polar.md#license-keys) describes it.

## Options

`polar(options)` accepts a fixed `organizationId` (a version 4 UUID), webhook
`destinations` and customer `fixtures`; fixtures take part in email and external
ID uniqueness and emit no events. Missing the `Polar-Version` header selects
this pinned slice; any other value is rejected. Tests never reach Polar: the
retained [schema excerpt](tests/fixtures/polar-2026-04-customers.openapi.json)
carries its own attribution.
