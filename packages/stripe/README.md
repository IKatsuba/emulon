# Local Stripe customers

This plugin implements the customer projection in
[ADR 0029](../../docs/decisions/0029-stripe-initial-slice.md), pinned to
`2025-03-31.basil`. It is not a payment simulator.

```ts
import { Emulon } from 'emulon';
import stripe from '@emulon/stripe';
import Stripe from 'stripe';

await using env = await Emulon.start({ services: { stripe: stripe() } });
const { apiKey } = await env.services.stripe.keys.create({});
const endpoint = new URL(env.endpoints.stripe.api!);
const client = new Stripe(apiKey, {
  host: endpoint.hostname,
  port: Number(endpoint.port),
  protocol: 'http',
  apiVersion: '2025-03-31.basil',
  httpClient: Stripe.createFetchHttpClient(),
  maxNetworkRetries: 0,
  telemetry: false,
});
const customer = await client.customers.create(
  { name: 'Ada', email: 'ada@example.test' },
  { idempotencyKey: 'customer-ada' },
);
await env.services.stripe.customers.get({ id: customer.id });
```

The equivalent management commands are:

```sh
emulon stripe keys create --json
emulon stripe customers create --name Ada --idempotency-key customer-ada --json
emulon stripe customers get --id cus_example --json
emulon stripe compatibility get --json
```

Accepted customer fields are optional strings: name, email and description.
Responses contain only id, object, created, livemode, name, email, description
and empty metadata. Absent strings are null. Unknown fields, duplicate form
fields, query parameters, expansions and other API versions are rejected.

Keys are securely generated local test keys; every key belongs to one instance.
Creating a customer atomically records a customer.created snapshot event.
Repeated or concurrent identical idempotency keys replay one result, even with
another issued key. Changed parameters fail. Records expire lazily after 24
hours and survive project-host restarts; reset clears them and restores customer
fixtures without events. Pre-commit failures roll back rather than caching a 500
response.

Webhook destinations can be supplied as `destinations` fixtures or through
`webhooks.configure`. `events.publish` and `webhooks.send` accept the complete
validated event projection as `data` without creating a customer. CLI paths are
`events publish customer.created --data ./event.json` and
`webhooks send customer.created --data ./event.json --destination receiver`. Use
`webhooks list`, `inspect <id>`, `wait <id> --status succeeded --timeout 5s` and
`redeliver <id>` to observe and repeat delivery; SDK methods take objects.

Stripe-Signature signs the exact event bytes with the literal UTF-8 destination
secret. Retries preserve bytes and event ID, refreshing the timestamp and
secret. The local sandbox schedule retries after 60 seconds, 1 hour and 2 hours,
stopping after four attempts, on 2xx or when disabled. Each attempt times out
after 5 seconds. Manual redelivery requires terminal state. Interrupted sends
become failed/unknown and require manual redelivery; queued retries resume on
restart. There is no exact Stripe timing, ordering or public virtual-time
guarantee.

Basic authentication, live mode, payments, lists, updates, deletion, Connect and
Stripe test clocks are unsupported. The official Stripe client is a test
dependency only; the plugin never contacts Stripe.

For the complete installed Node/Deno scenario with CLI `init/add/up`, connected
SDK, pinned official client, independent webhook verification and listener
cleanup, see the
[Stripe and Cal.com example](../../examples/stripe-calcom/README.md).
