# ADR 0010: Subscription state and transactional dispatch

## Context

This decision adds subscription selection and queued deliveries to the event
outbox ([ADR 0009](0009-event-publication-and-stream.md)). Recovery is limited
to reopening a state-preserving test adapter. Durable process restart, storage
selection, stable environment identity and migrations are decided in
[ADR 0016](0016-durable-state.md). No dependency is added.

## Options

- Run an asynchronous dispatcher with a scheduler and a separate transaction.
- Materialize inside the host's store transaction boundary and recover retained
  outbox records before plugin setup.

## Decision

Use the second option. Plugins declare `subscriptions` with
`selection: "processing-time"` and supported `eventTypes`. Resend declares
`email.sent`, the `webhooks` capability and state schema version 2.

Core wraps the plugin store, including scoped stores, and dispatches before and
after each transaction callback. Existing outbox events are selected before a
callback can change subscriptions; newly recorded events use subscriptions at
the end of that callback. Startup performs a recovery transaction before setup.
Selection, deliveries and per-event completion markers commit atomically. Failed
transactions commit none of them. Events with no eligible subscriptions are also
marked processed; adding or enabling a subscription never backfills history.

`emulon.destinations`, `emulon.deliveries` and `emulon.dispatched` are
host-owned collections reserved for these facilities. A delivery's storage key
and ID are `JSON.stringify([eventId, destinationId])`, which unambiguously
identifies the pair. Both the marker and existing delivery key are checked.
Dispatch creates `queued` records with `nextAttemptAt` equal to the event
timestamp; there is no worker, transport, signing, attempt or retry in this
change.

Resend factory options accept `destinations: Destination[]`. Each destination
has an instance-local stable `id`, HTTP(S) `url` without userinfo or fragment,
nonempty `secret` for Resend, supported event `types` and explicit boolean
`enabled`. ADR 0020 permits an empty core destination secret for unsigned GitHub
delivery; Resend input validation still requires a signing secret. Duplicate
fixture IDs and unsupported types fail. Fixtures initialize/reset state, not
overwrite retained state on reopen. The shared typed commands are:

- `webhooks.configure`: full replacement by ID; returns destination without
  secret.
- `webhooks.destinations`: list destinations without secrets.
- `webhooks.list`: list delivery records, including cancellations.

CLI paths mirror these names; configure takes `--id`, `--url`, `--secret`,
`--types` (JSON array) and `--enabled` (boolean). SDK and control API use the
same schemas and handlers. Core exports `Destination`, `DeliveryRecord`,
`SubscriptionPolicy`, the destination/view/delivery schemas,
`destinationFixture`, `setDestination`, `listDestinations` and `listDeliveries`
for plugin authors.

Disabling a destination cancels its queued deliveries and removes their
schedule. Re-enabling does not revive them. Rotation replaces the stored secret
without copying it into deliveries or changing delivery identity. The future
Resend worker must resolve the current destination URL and secret immediately
before sending; it must respect enabled state and cancellation. This defines
queued behavior only; in-flight credential/disable races are left to the
delivery worker (ADR 0011). Changing event types only affects future selection.
Ordinary command results never include secrets.

## Consequences

Dispatch is synchronous and scans retained outbox history on each transaction;
this prioritizes atomicity and correctness over throughput. Reset clears
deliveries and markers along with events and restores configured destinations.
Generation guards and adapter serialization cover stale/concurrent work.
Production adapters must provide the same atomic transaction semantics.

`startWithAdapter` accepts an internal optional environment identity so a test
adapter can reuse state across opens. The public SDK remains unchanged. The
memory adapter still discards state on each open; no process-crash durability is
claimed. Tests cover control API/CLI configuration, two recipients, isolation,
disablement, rotation, reset, rollback, concurrent/repeated dispatch and
retained outbox recovery. Actual HTTP webhook sending is added by ADR 0011.

## Follow-up

ADR 0011 implements the previously deferred worker, signing, attempts and retry
policy, including the in-flight destination race policy. The descriptions above
of queue-only behavior apply to the revision before the worker was added.
