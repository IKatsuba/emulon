# ADR 0013: Delivery fault scenarios and unknown outcomes

## Context

Delivery scenarios must run through one environment's control API, with local
receivers, no dependencies, and recovery over retained memory within one
process. This records the command shape for those scenarios; process-exit
persistence was deferred. [ADR 0016](0016-durable-state.md) and
[delivery verification](../events-and-delivery.md) now cover that later work.

## Options

- Add a separate test server with hidden SDK-only mutation methods.
- Declare a normal authenticated command and retain scenario choices in instance
  state, with delivery-level snapshots.

## Decision

Use the shared command contract. Resend advertises `faults` and declares
`webhooks.faults({ delayMs, loseResponse })`, also available as
`emulon mail webhooks faults --delay-ms 1000 --lose-response false`. Both fields
are required. Delay is an integer from zero to 86400000 milliseconds. Core
exports `DeliveryFaults` and `deliveryFaultsSchema` for plugin command
declarations.

Settings replace the instance's `emulon.faults/delivery` row and apply to newly
materialized deliveries, including direct sends. Defaults are zero delay and no
response loss. Reset removes settings. Delay uses wall time, starting at
materialization, not the event timestamp. A delivery snapshots its schedule and
optional `loseResponse` flag, visible in inspection. Changing settings does not
reschedule existing deliveries.

Response loss simulates the sender losing the response after the local receiver
has processed the request: the worker performs real HTTP I/O, then deliberately
ignores the returned response. It does not physically sever a TCP connection.
The attempt records `TRANSPORT_ERROR` and `outcome: "unknown"`, without a
claimed response status. Ordinary transport failure, timeout and abort also
record `outcome: "unknown"` conservatively; this does not prove receiver
execution. HTTP rejections remain `HTTP_STATUS`. Exception text is never
exposed.

Duplicate events use repeated `events.publish` calls with identical validated
payloads; their distinct event IDs and delivery records remain inspectable.
Ordering scenarios delay an earlier publication/send while later deliveries are
immediately eligible. No separate duplicate or ordering command is needed.
Explicit redelivery clears the injected response-loss flag and previous delay,
preserves the body, and creates another attempt. Resend retains the provider ID;
GitHub uses a new provider ID per attempt under ADR 0020. Settings still apply
to subsequent newly created deliveries.

On environment startup, retained in-flight attempts become completed with
`INTERRUPTED` and unknown outcome; their delivery becomes failed, requiring
explicit redelivery. Queued deliveries and unprocessed outbox events recover
normally. Completed deliveries are never automatically replayed. This avoids
claiming exactly-once external execution after an ambiguous interruption.

## Consequences

Scenarios exercise the existing worker and authenticated CLI/SDK paths without
public-network traffic or new dependencies. Delay tests wait for recorded state,
and pure scheduling rules accept an explicit time. Response loss is a model of
transport ambiguity, not a TCP fault injector. Settings and added optional
fields are backward-compatible with retained schema-2 rows. There is no
persistent adapter, migration, virtual clock, or full Resend-equivalence claim.
