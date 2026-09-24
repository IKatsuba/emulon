# @emulon/stripe

A local Stripe for applications that sell with hosted Checkout: customers,
products, one-time prices, coupons, promotion codes, Checkout Sessions, payment
intents, charges, refunds, disputes and their signed webhooks. It serves API
versions `2026-04-22.dahlia` and `2025-03-31.basil`, verified with the official
`stripe@22.1.1` and `stripe@18.0.0` clients that pin them. See
[ADR 0035](../../docs/decisions/0035-stripe-checkout-and-payments.md) for the
scope and [the compatibility manifest](src/compatibility.ts) for every covered
operation.

## Point your client at it

```ts
import { Emulon } from 'emulon';
import stripe from '@emulon/stripe';
import Stripe from 'stripe';

await using env = await Emulon.start({ services: { stripe: stripe() } });
const { apiKey } = await env.services.stripe.keys.create({});
const api = new URL(env.endpoints.stripe.api!);
const client = new Stripe(apiKey, {
  host: api.hostname,
  port: Number(api.port),
  protocol: 'http',
  apiVersion: '2026-04-22.dahlia',
});
```

Only the connection options change; the rest of your integration code stays as
it is.

## API versions

Each instance serves the API versions it enables. Without options that is
`2026-04-22.dahlia` alone. To let an application on `stripe@18.0.0` and one on
`stripe@22.1.1` share one emulator, enable both:

```ts
stripe({
  apiVersions: ['2026-04-22.dahlia', '2025-03-31.basil'],
  // Optional while dahlia is enabled; required otherwise.
  defaultApiVersion: '2026-04-22.dahlia',
});
```

`defaultApiVersion` is the account default and must be one of `apiVersions`;
with dahlia enabled it defaults to dahlia, and an instance that serves only
basil must name it. Each official client sends the version it pins, so point it
at the emulator with its own `apiVersion`.

A request's `Stripe-Version` selects that exact enabled version; without the
header the account default applies, and every response names the version it
used. Unknown, disabled, empty or malformed values fail with
`invalid_request_error` before parameters are read, anything changes or an
idempotency key is used; invalid credentials still fail first with 401. There is
no fallback to another version and no `latest` alias.

All versions share one state: a promotion code created through basil reads
through dahlia, and the other way round. Only the wire format differs. Within
the implemented slice that is the promotion code, where basil takes a top-level
`coupon` and shows the whole coupon object there (it does not expand), while
dahlia takes and shows `promotion: { type: 'coupon', coupon }` and expands
`promotion.coupon`; each version rejects the other's parameters. Checkout's
`managed_payments` exists only in dahlia. Every other object in the slice has
the same shape in both.

An event shows the version of the request that caused it (commands and the
hosted page use the account default), while each webhook endpoint receives
events in its own pinned version. Commands that return Stripe objects accept
`apiVersion` (`--api-version` on the CLI) and otherwise use the account default.

If saved events, webhook endpoints or past deliveries still use a version you
remove from `apiVersions`, the instance refuses to start; enable the version
again or run `emulon reset`.

## Sell something

```ts
const product = await client.products.create({
  id: 'prod_course',
  name: 'Course',
});
const price = await client.prices.create({
  product: product.id,
  unit_amount: 9900,
  currency: 'usd',
  lookup_key: 'course',
});
const coupon = await client.coupons.create({ percent_off: 25 });
await client.promotionCodes.create({
  promotion: { type: 'coupon', coupon: coupon.id },
  code: 'LAUNCH',
});
// With stripe@18.0.0 and 2025-03-31.basil:
// await client.promotionCodes.create({ coupon: coupon.id, code: 'LAUNCH' });

const session = await client.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price: price.id, quantity: 1 }],
  customer_email: 'ada@example.test',
  allow_promotion_codes: true,
  metadata: { orderId: 'order_1' },
  success_url: 'http://localhost:3000/thanks?session={CHECKOUT_SESSION_ID}',
  cancel_url: 'http://localhost:3000/cart',
});
```

`session.url` opens a local payment page on the plugin's `web` endpoint. It
shows the items and total, asks for an email when the session has none, offers a
promotion code field when `allow_promotion_codes` is set, and redirects to
`success_url` (with `{CHECKOUT_SESSION_ID}` substituted) or `cancel_url`. Tests
can pay without a browser:

```ts
await env.services.stripe.checkout.sessions.complete({
  id: session.id,
  promotionCode: 'LAUNCH',
});
```

Paying redeems the discount, creates a succeeded payment intent and charge,
completes the session and records `checkout.session.completed`. A free total
completes with `payment_status: 'no_payment_required'` and no payment intent.
Every payment succeeds: there are no cards, declines, 3DS, taxes or shipping.

Sessions expire through `client.checkout.sessions.expire` or on their own when
`expires_at` passes (24 hours by default), recording `checkout.session.expired`.

## After the sale

Refund over the API, or as the dashboard would:

```ts
await client.refunds.create({ payment_intent: 'pi_...', amount: 500 });
await env.services.stripe.refunds.create({ charge: 'ch_...' });
```

Each refund updates the charge and records `charge.refunded`. The card network
opens and closes disputes:

```ts
const dispute = await env.services.stripe.disputes.create({
  charge: 'ch_...',
  reason: 'product_not_received',
});
await env.services.stripe.disputes.close({ id: dispute.id, status: 'lost' });
```

These record `charge.dispute.created` and `charge.dispute.closed`.

## Commands

The same operations are available on a project running `emulon up`:

```sh
emulon stripe keys create --json
emulon stripe customers create --email ada@example.test --json
emulon stripe checkout sessions get cs_test_... --api-version 2026-04-22.dahlia --json
emulon stripe checkout sessions complete cs_test_... --promotion-code LAUNCH --json
emulon stripe checkout sessions expire cs_test_... --json
emulon stripe charges get ch_... --json
emulon stripe refunds create --charge ch_... --amount 500 --json
emulon stripe disputes create --charge ch_... --reason fraudulent --json
emulon stripe disputes close dp_... --status won --json
emulon stripe compatibility get --json
```

Failures carry Stripe's reason and code to the CLI and SDK, for example when a
session has already expired or a promotion code is no longer active.

## API behavior

- Parameters use Stripe's bracket form encoding; unknown parameters are rejected
  with `parameter_unknown`, as Stripe does.
- Every POST honors `Idempotency-Key`: concurrent and repeated requests with one
  key replay one result, a different payload or another API version fails with
  `idempotency_error`, and failures cache nothing. Keys expire after 24 hours.
- Lists page newest first with `limit`, `starting_after` and `ending_before`.
- `expand[]` resolves ID properties such as `payment_intent`, `latest_charge`
  and, in dahlia, `promotion.coupon` or `data.promotion.coupon`. A property that
  is not a reference in the request's version is refused, like basil's embedded
  promotion code `coupon`.
- Products accept your own IDs and `tax_code`; a price `lookup_key` belongs to
  one price and moves with `transfer_lookup_key`.
- A promotion code reports `active: false` once it is switched off, expired,
  used up, or its coupon is gone; basil then shows the coupon as
  `{ id, object: 'coupon', deleted: true }`. A coupon limited to products
  discounts only those line items.
- Missing objects return `resource_missing` with the parameter that named them.

## Webhooks

Configure destinations as `destinations` options or with `webhooks.configure`:

```ts
stripe({
  destinations: [{
    id: 'app',
    url: 'http://127.0.0.1:3000/api/webhooks/stripe',
    secret: 'whsec_local',
    types: ['checkout.session.completed', 'charge.refunded'],
    enabled: true,
    apiVersion: '2026-04-22.dahlia',
  }],
});
```

`apiVersion` pins the endpoint's event format; a new endpoint without one takes
the account default, and reconfiguring without one keeps the pinned version.
Changing it affects only later deliveries. `webhooks destinations` lists each
endpoint with its version and without its secret.

Deliveries carry `Stripe-Signature` over the exact event bytes, keyed by the
literal UTF-8 secret, so `stripe.webhooks.constructEventAsync` accepts them. The
body is fixed when the delivery is queued: retries, redelivery and restarts keep
the bytes and event ID; the local schedule retries after 60 seconds, 1 hour and
2 hours. Use `webhooks list`, `inspect`, `wait` and `redeliver` to observe and
repeat deliveries, and `events publish` or `webhooks send` to deliver a
synthetic event without changing state. A synthetic event must name an enabled
version in `api_version` and match that version's event and object shape.

## Not supported

Subscriptions, invoices, recurring prices, inline `price_data`, embedded
Checkout, the Payment Element, payment methods, Connect, test clocks, search,
customer lists and live mode. `managed_payments` is accepted and ignored. Events
other than `customer.created`, `checkout.session.completed`,
`checkout.session.expired`, `charge.refunded`, `charge.dispute.created` and
`charge.dispute.closed` are not recorded. The plugin never contacts Stripe.

For an installed Node and Deno scenario with `init`, `add` and `up`, see the
[Stripe and Cal.com example](../../examples/stripe-calcom/README.md).
