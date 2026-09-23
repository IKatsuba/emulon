# 0035: Stripe catalog, discounts, Checkout and payments

Status: Accepted. Supersedes the resource scope, pinned version and official
client of ADR 0029; its idempotency, signing and delivery decisions stand.

## Context

ADR 0029 limited `@emulon/stripe` to customers to prove the plugin shape. A
typical application that sells a one-time digital product through Stripe needs
far more to run locally: it syncs products and prices by lookup key, issues and
deactivates promotion codes, opens hosted Checkout Sessions with a discount
either pre-applied or typed by the buyer, and reacts to
`checkout.session.completed`, `charge.refunded`, `charge.dispute.created` and
`charge.dispute.closed` webhooks. Such an application reads fields such as
`session.payment_intent`, `payment_intent.latest_charge`,
`promotion_code.promotion.coupon` and `dispute.status`, pins a current API
version (`2026-04-22.dahlia`) and uses the current official client
(`stripe@22`), whose promotion code shape differs from `basil`.

Three things in that flow have no API call: the buyer paying on the hosted page,
the card network opening and closing a dispute, and, often, a merchant refunding
from the dashboard.

## Options

- Keep customers only and let applications mock Stripe for everything else.
- Emulate the resources above over the API, and model the buyer, the bank and
  the dashboard as control commands plus a local hosted payment page.
- Emulate the complete Payments API, including PaymentIntents confirmation,
  payment methods, declines and 3DS.

## Decision

Emulate products, one-time prices, coupons, promotion codes, payment-mode hosted
Checkout Sessions, the payment intents and charges Checkout produces, refunds
and disputes, with the parameters, filters, errors and object projections that
the official client sends and reads. Pin `2026-04-22.dahlia` and verify against
`npm:stripe@22.1.1`, which replaces `stripe@18.0.0` as the test-only dependency.
One version is served; other `Stripe-Version` values are rejected before any
mutation, as before.

The buyer pays on a local page at the session's `url` (a second `web` surface)
or through `checkout sessions complete`; every payment succeeds. Paying redeems
the discount, creates a succeeded payment intent and charge (none for a free
total), completes the session and records `checkout.session.completed`. Sessions
expire on `POST .../expire` or lazily once `expires_at` passes, recording
`checkout.session.expired`. Refunds are available over the API and as a command;
disputes are opened and closed only through commands, standing in for the card
network.

Parameters are decoded from Stripe's bracket encoding into a tree and read
through a consuming reader that rejects unknown parameters, as Stripe does.
Every POST honors `Idempotency-Key` inside the mutating transaction, extending
ADR 0029's customer idempotency to all resources. `expand[]` resolves the ID
properties the covered objects carry; lists page newest first with
`starting_after`/`ending_before`.

`StripeError` is a `DomainError`, so commands report the same reason and code as
the API. Error messages name parameters and resource IDs but do not echo other
input.

The hosted page is reachable only through the unguessable session URL, and its
form carries a per-session token so another page cannot submit it.

## Consequences

Applications can run their real Stripe integration code, including webhook
verification with the official client, against the emulator. They only need to
point the client at the local `api` endpoint (`host`, `port`, `protocol`).

Stored objects changed shape, so the plugin's state `schemaVersion` moves to 2
and state from earlier versions is rejected, as the design requires for version
mismatches. Clients pinned to `basil` must move to `dahlia`.

Subscriptions, invoices, recurring prices, inline `price_data`, embedded
Checkout, the Payment Element, declines, taxes, Managed Payments behavior
(`managed_payments` is accepted and ignored), Connect and test clocks remain
unsupported and fail explicitly. Only the six declared event types are recorded.
The compatibility manifest lists every covered operation and its tested case.
