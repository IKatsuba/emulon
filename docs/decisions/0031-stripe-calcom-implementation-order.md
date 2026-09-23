# 0031: Stripe and Cal.com implementation order and shared mechanics

## Context

Stripe ([ADR 0029](0029-stripe-initial-slice.md)) and Cal.com
([ADR 0030](0030-calcom-initial-slice.md)) are the next official plugins after
GitHub and Resend. Their work needs an order and a decision on which mechanics
become shared. The npm build gate of [ADR 0027](0027-distribution-gate.md)
applies to every part.

## Options

- Start both plugins and generalize all provider mechanisms in advance.
- Build a public virtual clock and payment/scheduling engines before either
  plugin.
- Establish a shared compatibility contract, then complete bounded vertical
  slices.

## Decision

Choose vertical slices. Stripe comes first because customer creation isolates
the official-client, idempotency and signature/retry boundaries without needing
a scheduling engine. Cal.com then reuses the established transport and manifest
pattern, adding only explicit slot allocation rules.

Reuse existing environment ownership, isolated stores, generation/reset
barriers, SQLite durability, command schemas, authenticated control transport,
transactional outbox, subscription dispatcher, delivery inspection and owned
Hono surfaces. Provider authentication and projections stay in their plugin.
Stripe idempotency stays provider-local until a second actual consumer justifies
sharing it.

The shared additions are ADR 0028 metadata/command/build integration and an
internal injected scheduling seam for `deliveries/worker.ts`. That seam supplies
`now`, timer scheduling and cancellation, with real-time defaults; fake tests
drive due times and signature timestamps without sleeping hours. Keep it out of
the public package exports. Scope timers to worker pause/reset/dispose and prove
other instances and existing GitHub/Resend delivery policies are unchanged. Do
not replace the host clock globally or claim `virtual-time` capability.

Public virtual time, Stripe subscription/test-clock semantics and Cal.com
recurring availability are deferred. Customers have no time-driven state
machine; fixed UTC slots and injected pure-rule `now` prove booking boundaries.
If later work needs public clock advancement, a separate ADR must specify
durable time, cross-service effects, CLI/SDK parity and reset semantics first.

## Implementation parts

The work is split into seven parts, each delivered in order: a part starts only
after the previous one passes. Every part runs the full `deno task check`,
including archive and offline Node/Deno consumer checks. Each new package is
added to build/verification when introduced, not postponed until the final
example. Manifest coverage grows only with passing tests.

| Order | Part and principal files                                                                                                                              | Independently observable readiness                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Shared manifest and migration: `plugins/{compatibility,types,define,validation}.ts`, GitHub/Resend declarations, `scripts/{build-npm,verify-dist}.ts` | CLI, started/connected SDK and installed package metadata return the same tested GitHub/Resend scope; untested claims fail the gate                                                              |
| 2     | Stripe customers and idempotency: `packages/stripe/{deno.json,src,tests}`, root imports, distribution scripts                                         | Official stripe client and CLI/SDK create/read one customer for concurrent/replayed same-key requests; exactly one outbox event survives restart; manifest declares webhooks not yet implemented |
| 3     | Stripe delivery: Stripe webhook/command modules, core worker and its tests                                                                            | Receiver verifies actual Stripe signature, gets automatic retry after failure and manual redelivery after terminal failure; no second customer; manifest now declares delivery                   |
| 4     | Cal.com event types and slots: `packages/calcom/{deno.json,src,tests}`, distribution scripts                                                          | CLI/SDK create an event type and both HTTP read routes expose its UTC slots with per-operation version checks; no booking support claimed yet                                                    |
| 5     | Cal.com bookings: Cal.com model/routes/commands/tests                                                                                                 | CLI/SDK and HTTP create/read a booking; one of two concurrent competitors wins, slots reflect occupancy, one event commits, reset/restart are proven                                             |
| 6     | Cal.com delivery: Cal.com webhook/command modules/tests                                                                                               | A loopback receiver verifies BOOKING_CREATED bytes and manual redelivery; controls are available through CLI/SDK and failures are inspectable                                                    |
| 7     | Installed combined example: `examples/stripe-calcom/`, READMEs, `scripts/verify-dist.ts`                                                              | Clean offline npm consumers under Node and Deno start both services, use CLI/SDK and official Stripe client/Cal.com HTTP, receive both signatures and inspect both manifests                     |

Part 7 additionally depends on `emulon add` ([ADR 0032](0032-plugin-add.md)),
because its scenario includes `init/add/up`; earlier parts can load explicit
config without that command.

The final example is a separate part because installed CLI discovery, npm client
dependencies, generated declarations and simultaneous listener cleanup must be
proved as a consumer, beyond source tests. Provision all necessary archives and
test-only client dependencies before offline execution. No package manager other
than Deno is introduced into development; npm is used only for distribution.

## Consequences and uncertainty

This deliberately proves customer lifecycle rather than payments, and fixed UTC
availability rather than calendar synchronization. Provider error projections,
retry timing and incomplete payloads are disclosed limitations. Cal.com's SDK
finding is scoped to the official sources inspected, and its version dates are
per-resource snapshots. These are not full-provider compatibility claims.

The Stripe and Cal.com work is complete only when all seven parts pass and the
final installed-consumer scenario succeeds.
