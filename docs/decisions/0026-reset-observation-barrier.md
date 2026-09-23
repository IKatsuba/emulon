# ADR 0026: Reset is an observation barrier

## Context

Compatibility verification item 8 of the design covers reset during in-flight
work, partial startup failures and owned-resource cleanup. Reset is a barrier:
an operation overlapping reset must complete against the old generation or
explicitly fail, never return a successful partial or empty observation of state
being cleared. Commands and provider handlers already have admission and drain
barriers. Event listing and follow subscription admission bypassed them.

ADRs 0007 and 0016 remain binding: SIGKILL may leave stale discovery and
committed state; failed startup retains committed state.

## Options

- Keep best-effort event reads: can combine snapshots across reset generations.
- Drain long-lived event subscriptions: reset could wait forever for consumers.
- Fence event observations by host generation and interrupt subscriptions.

## Decision

Use the third option, with no new public API, plugin, mode or dependency.

Event listing checks admission before reading and checks admission and
generation again after collecting every instance's outbox. A read spanning reset
fails with `ENVIRONMENT_RESETTING`, even if reset has already finished or a
store returned a stale-generation error. Reads during reset fail with the same
code. Reads after reset completes see the complete new generation. Disposal
rejects observations with `ENVIRONMENT_CLOSED`.

Reset errors existing follow streams and discards their host-side buffered
records; it does not leave subscriptions spanning generations. Consumers must
subscribe again after reset. New follow subscriptions, including HTTP HEAD
probes, are refused while admission is paused. Remote follow admission preserves
the control error code. An already-open remote stream receives a terminal NDJSON
`{ error: { code, message, fields, available } }` frame, using the control error
shape, then ends. The SDK converts it into a stream error and CLI follow fails
with a nonzero exit. Successful frames remain EventRecord objects. Events
already delivered before the barrier cannot be retracted. This supersedes ADR
0009's original keep-subscriptions-open policy.

Commands and provider requests admitted before reset drain before fixture
replacement. Operations still validating command input are rejected if their
captured generation changed. Workers pause after callers drain and before state
replacement; their generation-scoped writes cannot reach the new state. Reset
then restores fixtures and clears generated resources, credentials, events,
deliveries and attempts. No external receiver side effect is rolled back.

Startup fixture, setup and readiness failures use the existing
`ENVIRONMENT_FAILED` control error code with a host-generated instance name. CLI
and SDK retain that safe message without exposing the plugin exception, which
may contain secrets.

Orderly shutdown (`down`, SIGINT, SIGTERM) and startup rollback release owned
listeners, remove owned discovery and retain committed durable state. SIGKILL
relies on the OS to release listeners and database ownership. The stale
discovery record is retained and a subsequent `up` refuses to overwrite it,
requiring explicit removal. Foreign files, slots, listeners and live databases
remain untouched. There is no new automatic orphan cleanup mechanism.

## Consequences

An event reader racing reset may be rejected even when individual snapshots were
read before reset. This conservative boundary avoids mixed-generation success.
Event followers now need explicit resubscription after reset; no automatic
replay or reconnection is introduced. Ordinary event lists remain per-instance
snapshots, not a global transaction against unrelated concurrent writes.

Verification uses GitHub and Resend, deterministic test barriers, dynamically
allocated loopback ports, and separate offline Deno processes. Test-only
wrappers retain the official plugin declarations and inject timing or startup
failures; there are no production hooks or new plugins.
