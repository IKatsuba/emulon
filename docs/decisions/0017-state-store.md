# ADR 0017: Transactional instance state

## Context

Stateful plugins need isolated state, atomic domain mutations and outbox
records, version checks, and fixture reset. The first implementation uses an
in-memory adapter; selecting a durable engine is left to a later decision. No
dependency is added.

## Options

- Plugin-owned maps or separate event queues: cannot guarantee atomicity.
- Choose a durable database now: exceeds what the first stateful plugins need
  and prematurely settles an open implementation decision.
- Host-owned adapter with an in-memory implementation and a transactional
  contract.

## Decision

Use the third option. The host alone constructs the adapter and owns its
lifecycle. The plugin receives a frozen `ctx.store`, with no adapter replacement
hook. `StateAdapter` and `startWithAdapter` are internal seams, not package
exports.

The concrete plugin API extends the design's store facility as follows:

- Optional `definition.state` declares `pluginVersion`, positive integer
  `schemaVersion`, and `fixtures(options)`, returning
  `{ collection, id, value }` entities. Plugins without state metadata retain
  empty version `0`, schema `1` stores for compatibility with the initial
  stateless plugins. Stateful plugins should declare their actual versions.
- `store.transaction(async tx => ...)` reads with `get`/`list`, writes with
  `put`/`delete`, appends events with `record`, and reads events with `outbox`.
  Values must support structured cloning and contain only primitives, plain
  objects, arrays, Map, Set, Date, RegExp, Error, ArrayBuffer and its views.
  SharedArrayBuffer (including nested buffers and views) and other host objects
  are rejected at fixture, entity and event ingress: structured cloning alone
  preserves shared memory and cannot guarantee isolation or rollback. Validation
  traverses the cloned graph, including map keys and error causes, so getters
  cannot change the value between validation and copying. Cycles are supported.
  Missing entities read as `undefined`. All methods return promises so storage
  I/O can be introduced without changing plugin call sites. Transaction
  callbacks must await all their operations.
- `record` takes the design's event fields except `id` and `instanceId`, which
  the host supplies. Events and entities commit together, or neither commits. No
  delivery or dispatcher runs in this implementation.
- `store.generation` identifies reset epochs. `store.scope()` captures an epoch
  before asynchronous work; commands automatically receive a scoped store before
  input validation. Plugin jobs must capture a scope before awaiting external
  work or keep the entire operation inside a transaction. Nested transactions on
  the same store are unsupported; pass the current transaction to domain
  helpers.
- `env.reset()` implements the design's SDK reset operation. It pauses command
  admission and provider handlers, drains executing commands and admitted HTTP
  handlers, then restores startup fixtures and clears the outbox under a new
  generation. New HTTP requests receive 503 while paused. Old transactions and
  scopes reject subsequent writes and commits; reset does not wait for old
  transaction callbacks outside commands and HTTP handlers to finish. Commands
  still validating input when reset begins are rejected before execution, even
  if validation finishes after reset. It resumes admission after all stores
  reset. There are no delivery workers yet.

Each adapter open receives environment and instance identity. The memory adapter
allocates independent maps on every open, even for reused configuration.
Fixtures are copied at startup; reset does not rerun user code. Generated state,
including credentials, must be stored through the facility to participate in
reset.

Transactions serialize within one instance using private drafts and an atomic
reference replacement. Reads, writes and events are cloned; escaped transaction
handles are revoked after completion. Reset can abandon an old queue because its
callbacks remain fenced by generation. Disposal revokes stores before draining
commands and closing resources.

Startup compares required and actual plugin/schema versions before plugin setup.
Both must match exactly; no migrations are implemented. A mismatch reports both
versions and rolls back opened resources. Plugin setup errors remain redacted.

A future durable adapter must preserve environment/instance ownership,
transaction serialization and rollback, atomic entity/outbox commits, detached
values and transaction lifetimes, generation fencing, fixture replacement, and
version metadata. Its `reset()` must fence old commits and complete replacement
before resolving; its `close()` must revoke new commits. Crash recovery must
never expose half a commit. Host startup must validate persisted versions before
plugin code runs; migration policy and engine selection require a later ADR.
Adapters are trusted host infrastructure, not plugin-supplied facilities.

## Consequences

The in-memory adapter loses state on disposal or process exit. It copies the
whole instance per transaction and does not target large datasets. It proves
atomic state/outbox behavior in-process, not durability or crash recovery. HTTP
draining can wait for a slow handler; job cancellation, external delivery
outcomes and retention belong to later changes. Store reads can contain secrets
and are internal plugin facilities, not redacted management inspection
endpoints.

This decision was renumbered from 0006 to 0017 to give every ADR a unique
number. ADR 0006 remains the earlier environment HTTP lifecycle decision.

## Subsequent queue implementation

[ADR 0010](0010-subscriptions-and-dispatch.md) adds subscription state and a
transactional dispatcher, superseding the no-dispatcher boundary above. Resend
uses schema version 2. Sending and durable process recovery remain deferred.

## Durable adapter

[ADR 0016](0016-durable-state.md) resolves the later engine decision. An
internal SQLite adapter implements the same store contract and is connected to
project host startup and lifecycle. See [durable state](../durable-state.md).
