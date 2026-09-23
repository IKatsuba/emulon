# ADR 0012: Webhook commands and state-driven waits

## Context

This decision exposes the design's webhook commands through the existing shared
registry. Waiting needs committed state notifications, and command failures must
remain useful without exposing arbitrary plugin or transport exceptions. No new
dependency or durable storage is introduced.

## Options

- Poll delivery state on a timer.
- Observe committed writes, subscribe before the initial read, and use a timer
  only for the caller's deadline.

## Decision

Use state notifications. Add `Store.subscribe(listener): () => void` to the
plugin store contract. It signals committed writes, reset and close, never
read-only transactions or rolled-back writes. Scoped stores and host wrappers
preserve subscriptions; listeners cannot roll back commits. Delivery waits
coalesce notifications and release the subscription on every exit. State closure
or generation change cancels a wait. Environment reset retains the existing
drain policy: outstanding commands, including waits, finish or reach their
requested timeout before reset. Disposing an attached client cancels its HTTP
request; host-side waits remain bounded by their requested deadline.

Export `sendWebhook`, `inspectDelivery`, `redeliverWebhook`, `waitForDelivery`,
`deliveryInspectionSchema`, `DeliveryInspection` and `waitTimeoutSchema` as
plugin-author helpers alongside ADR 0010/0011's existing queue helpers. Resend
declares `webhooks.send({ type, data, destination })`,
`webhooks.inspect({ id })`, `webhooks.redeliver({ id })`, and
`webhooks.wait({ id, status, timeout })`. Existing `webhooks.list()` is
unchanged. CLI uses the event type or delivery ID positionally, with
corresponding flags for other fields. Timeout is a positive integer with `ms`,
`s` or `m`, capped at 2147483647 milliseconds; status is any delivery status.
Both frontends use identical schemas. Control deadlines accommodate the
requested wait plus transport overhead.

Direct send atomically records an origin `direct` event and exactly one queued
delivery to an enabled configured destination ID. Direct events bypass
subscription selection, even when other destinations subscribe to that type. It
never changes emails. Missing or disabled destinations reject before any write.
Send and redeliver return the queued record from their transaction; subsequent
list/inspect/wait reads the latest committed status.

[ADR 0013](0013-delivery-fault-scenarios.md) adds delivery fault settings;
redelivery clears a delivery's injected delay and response loss. Redelivery
queues the existing delivery unless it is already queued or in-flight.
Disabled/missing destinations reject. Resend keeps its original bytes and
provider delivery ID, resolves current credentials, and regenerates the
timestamp/signature per attempt under ADR 0011. Success and failure records
remain available as separate attempts. Inspect returns `{ delivery, attempts }`
from one transaction and omits destination secrets, unsafe request headers and
response bytes; event bodies remain application-owned data.

The core's fixed delivery errors cross the command exception boundary:
`DELIVERY_NOT_FOUND`, `DESTINATION_UNAVAILABLE`, `DELIVERY_ACTIVE`,
`WAIT_CANCELLED` and `WAIT_TIMEOUT`. Timeout includes the last observed status.
A later change additionally permits explicitly safe plugin `DomainError` codes
and messages, as documented in [the command contract](../commands.md). Other
plugin exceptions remain generic `COMMAND_FAILED` failures.

## Consequences

Custom adapters must implement commit/lifecycle notification. Host read-only
transactions no longer wait behind a worker's network request, so inspection and
deadlines remain responsive during delivery. Mutations retain the existing
wait-for-due-sends behavior. Tests verify idle waits perform one read, committed
changes wake waiters, cancellation removes listeners, explicit send bypasses
subscriptions, and CLI/SDK parity includes failure, timeout and redelivery.
Persistence across process restart is implemented by ADR 0016;
[delivery verification](../events-and-delivery.md) describes the crash/reopen
tests.
