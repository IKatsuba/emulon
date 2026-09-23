# ADR 0009: Event publication and streaming

## Context

Applications and tests need to list and follow committed events. The existing
transactional outbox already owns the design's EventRecord. Publication and
streaming must use the existing control transport and add no new dependencies;
deliveries remain subsequent work.

## Options

- Poll outbox snapshots from clients.
- Create a separate event journal and streaming server.
- Notify subscribers after outbox commits through the existing control server.

## Decision

Use the third option. The outbox remains the only journal. State adapters
receive an optional host callback for each newly committed record. Rollback and
reset do not publish records. Reset clears history. As superseded by
[ADR 0026](0026-reset-observation-barrier.md), reset rejects overlapping reads
and interrupts existing subscriptions; subscribe again after reset.

The core read operations are `env.events.list({ type? })` and
`await env.events.follow({ type? })`. Follow returns a cancellable web
ReadableStream of EventRecord; its resolved promise establishes the
subscription. Started environments invoke these locally; connected environments
use authenticated `GET /events?type=...`, adding `follow=true` for
newline-delimited JSON. CLI `emulon events [--type <type>] [--follow]` invokes
these same operations. Follow includes only future commits, with no history
replay or reconnection. List preserves each instance's insertion order, grouped
by configured instance; there is no global ordering guarantee.

Resend declares `events.publish({ type: "email.sent", data })` in its command
registry. Data contains `email_id` (UUID), `from` (nonempty string), `to`
(nonempty array of nonempty strings), and `subject` (string), with no extra
fields. The referenced email need not exist. Publication only records origin
`published`; provider sending continues to record origin `service` in the same
transaction as the email. EventRecord is exported as a type from emulon.

Command CLI metadata gains one optional `positional` string field mapping:
`emulon mail events publish email.sent --data ./event.json`. For event
publication, the project CLI reads a data filename relative to the caller's
project directory before sending arguments to the server; inline JSON objects
also work. File contents and SDK data pass the same command schema. No
server-side file reads are performed for control requests.

Each subscriber buffers at most 256 records before its next stream stage;
overflow errors that subscription rather than blocking a committed mutation.
Environment disposal closes subscriptions, client disposal aborts remote
streams, and consumer cancellation releases the subscription. The Node adapter
forwards response chunks with backpressure instead of collecting the complete
body.

## Consequences

No dependencies or durable storage are added. In-memory history lasts until
reset or disposal and currently has no retention limit. Reconnect cursors,
durable recovery, delivery processing and direct webhook sending remain outside
this decision. Read operations use the same filter schema in local and remote
clients.

## Subsequent queue implementation

[ADR 0010](0010-subscriptions-and-dispatch.md) adds subscription state and a
transactional dispatcher, superseding the no-dispatcher boundary above. Resend
uses schema version 2. Sending and durable process recovery remain deferred.
