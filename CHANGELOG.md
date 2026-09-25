# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@emulon/telegram`: a Telegram Bot API emulator for the pinned grammY client.
  `bots create` issues a bot token once, the `api` endpoint serves
  `/bot<token>/getMe` with Bot API envelopes, and `fixtures.channels` declares
  channels. Other typed Bot API methods, including the webhook methods, return
  explicit 501 errors.
- `@emulon/telegram`: `sendMessage` posts to a configured channel by ID or
  `@username`, as plain text or MarkdownV2 parsed into entities with UTF-16
  offsets, with per-chat monotone message IDs; malformed markup and text over
  4096 rendered units fail without writing. `messages list` shows the submitted
  and rendered text of a channel's messages.
- `@emulon/stripe`: products, one-time prices, coupons, promotion codes, hosted
  Checkout Sessions with a local payment page, payment intents, charges, refunds
  and disputes, with `checkout.session.completed`, `checkout.session.expired`,
  `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed`
  webhooks. Every POST honors `Idempotency-Key`, lists paginate and `expand[]`
  resolves related objects.
- `@emulon/stripe` commands to pay or expire a Checkout Session, refund a charge
  and open or close a dispute.
- `@emulon/stripe` options `apiVersions` and `defaultApiVersion` select the
  Stripe API versions an instance serves; `Stripe-Version` picks one per request
  and the account default applies without it. Webhook endpoints pin an
  `apiVersion`, shown by `webhooks destinations`, and commands that return
  Stripe objects accept `apiVersion` (`--api-version`). The compatibility
  manifest uses schema version 2 with coverage for each version.
- `emulon`: optional `PluginDefinition.presentation` hooks. `eventView` shapes
  the payload shown by event list and follow; `deliverySnapshot` captures the
  exact webhook body when a delivery is enqueued, and retries, redelivery and
  restarts send those bytes. Webhook destinations accept an optional JSON
  `provider` settings object. Plugins without hooks are unchanged.

### Changed

- `@emulon/stripe` serves Stripe API `2026-04-22.dahlia` by default, verified
  with `stripe@22.1.1`, and also ships `2025-03-31.basil`, verified with
  `stripe@18.0.0`; `apiVersions` enables both at once. Customers carry the full
  object and accept `metadata` and `phone`.
- `@emulon/stripe` exposes a second `web` endpoint and stores state in schema
  version 3, holding resources and events independently of an API version; state
  saved by earlier versions must be reset. Unknown and disabled `Stripe-Version`
  values fail before parameters are read.
- `@emulon/stripe` command failures report the Stripe reason and code.

## [0.1.2] - 2026-09-23

### Fixed

- `@emulon/polar`: webhook CLI examples pass `--types` as a JSON array.

## [0.1.0] - 2026-09-23

### Added

- `emulon` CLI, SDK and plugin authoring API with durable project environments.
- `@emulon/github`: GitHub Apps, installations, local consent, user tokens,
  issues and webhooks.
- `@emulon/resend`: Resend email sending and reading with signed webhooks.
- `@emulon/stripe`: Stripe customers and webhooks.
- `@emulon/calcom`: Cal.com API v2 event types, availability, bookings and
  webhooks.
- `@emulon/polar`: Polar customers and webhooks.
