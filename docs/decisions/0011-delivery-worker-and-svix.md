# ADR 0011: Delivery worker and Svix transport

## Context

This decision adds sending to ADR 0010's queue, using Web Crypto with no new
dependencies and manual retries by default for Resend. Persistence is decided in
[ADR 0016](0016-durable-state.md). Public send/inspect/wait/redeliver commands
are now specified in [ADR 0012](0012-webhook-commands.md).

## Options

- Embed provider signatures and retry policy in core.
- Let plugins serialize events, sign bytes and declare delivery policy, while
  core owns attempts, runtime HTTP and lifecycle.

## Decision

Use the second option. Export `DeliveryTransport` and `DeliveryAttempt`, add
`PluginDefinition.transport`, and export `inspectAttempts(store, deliveryId)`
for plugin authors. The transport supplies serialization, header generation,
`timeoutMs`, `succeeds(status)` and `retryDelayMs(attemptNumber)`. Undefined
retry delay means no automatic retry. Invalid delays also stop retries,
including finite delays whose resulting timestamp is outside the JavaScript Date
range.

A worker atomically claims queued rows and writes an attempt with `startedAt`
before I/O. It resolves current destination credentials at claim time. Rotation
and disablement after the claim do not retract an already claimed send; retries
resolve credentials again, and disablement prevents further attempts. Completion
records `completedAt`, response status when available and a stable error code:
`HTTP_STATUS`, `TRANSPORT_ERROR`, `TIMEOUT`, or `ABORTED`.
[ADR 0013](0013-delivery-fault-scenarios.md) adds unknown outcomes and
`INTERRUPTED` on recovery of retained in-flight attempts. Provider exception
text is never stored. Success is terminal; failure either terminates or returns
to queued with the plugin's next attempt time. A body-read failure retains the
received status and bounded partial bytes alongside the transport error code.
Scheduled retries use wall time; virtual-time integration is not claimed.

Store operations trigger a drain after committing, outside the transaction lock.
Mutating operations wait for currently due sends before returning; ADR 0012
allows read-only observation without waiting for worker I/O. A failed receiver
does not roll back a service action. Workers serialize sends per instance and
schedule the earliest future retry. Startup drains retained queues. Disposal
aborts and drains the worker before closing state. Reset drains callers, pauses
the worker and resets state before resuming; generation-scoped transactions
prevent stale completion writes. Already received requests cannot be undone.

Resend sends UTF-8 JSON `{ type, created_at, data }`. Its Svix headers are
`svix-id`, `svix-timestamp` (Unix seconds), and `svix-signature` with value
`v1,<base64 HMAC-SHA256>`. The signing input concatenates UTF-8 `id.timestamp.`
and the exact serialized body bytes. The destination secret is a base64 key,
optionally prefixed by `whsec_`; malformed keys fail the attempt without
exposing the secret. Web Crypto computes the signature. See the
[Svix verification reference](https://www.svix.com/guides/receiving/receive-webhooks-with-svix-cli/).
Resend uses a five-second real I/O timeout, accepts only 2xx responses, and
never retries automatically. Core retains the first body across attempts. The
default policy also retains the random provider delivery ID, as used by Resend;
ADR 0020 adds per-attempt IDs for GitHub. Each attempt regenerates its timestamp
and signature.

The internal `emulon.attempts` collection holds serialized byte arrays and safe
header metadata. Header inspection uses an allowlist (content type and provider
identifiers), excluding signatures, authorization, cookies and custom secrets.
Responses are capped at 4096 bytes while streaming and the remainder is
cancelled. Ordinary attempt inspection omits response bytes entirely because a
receiver can echo credentials. Transport redirects are not followed. Request
bodies remain inspectable application event data; they must not contain
credentials supplied by the application itself.

## Consequences

No dependency or persistent storage is added. Backpressure includes receiver
latency; a background command/wait experience can be added independently. The
existing queue-only tests explicitly omit transport to retain their
deterministic queue assertions. New local receiver tests verify signatures
independently over received Unicode bytes, failure records, bounded responses,
redaction, concurrent claims, opt-in retries, timeouts and shutdown
cancellation.
