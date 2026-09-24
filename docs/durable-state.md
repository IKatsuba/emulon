# Durable project runtime

[ADR 0016](decisions/0016-durable-state.md) selects built-in `node:sqlite` and
refines the Node floor to 22.13.0. The runtime provides a SQLite coordinator and
a portable graph codec. Project hosts (`emulon up`) use durable state by
default. Private `Emulon.start()` remains isolated and memory-only. Process-kill
delivery recovery is proved independently (see
[events and delivery](events-and-delivery.md)). These functions are internal,
without package exports or a new public SDK storage option.

The host canonicalizes the project directory and opens
`.emulon/state/<environment>/state.sqlite` (the default slot is `default`). Its
stored UUID is stable across restarts. Instances are keyed by service name with
checked plugin identity: renaming starts fresh, removal leaves dormant rows, and
re-adding restores compatible state. Slots have separate databases and UUIDs.
Moving a stopped project retains its identity.

Discovery `.emulon/<environment>.json` has fresh per-run id/token credentials.
`down` removes discovery and keeps state. Existing records, including stale
ones, reject startup before callbacks; authenticate with `status`, stop the old
process and explicitly remove stale discovery before restarting. Removing
discovery never bypasses the database lock or deletes state.

The host opens `sqliteCoordinator(path)` on a canonical local POSIX path. The
coordinator rejects symlinks, requires an owner-only parent directory and files,
creates missing directories/files with 0700/0600 permissions, acquires an
exclusive WAL write lock and retains it until `close()`. It checks effective
PRAGMAs and SQLite integrity before loading data. A competing opener fails with
`STATE_IN_USE`. Diagnostics never include SQL parameter values or raw engine
errors. Existing empty or malformed databases are rejected without reseeding.

Call `prepare(registrations)` for the complete configured environment before
running fixture functions or plugin setup. It checks instance plugin identity
and exact plugin/schema versions, then validates core destinations, deliveries,
attempts, delivery snapshots, dispatch markers and fault records for every
configured instance. Malformed records fail without exposing stored values or
changing snapshots. SQL, codec and core formats are independently versioned at
1; every persisted snapshot, including dormant instances, is decoded and checked
for graph/snapshot structure at coordinator construction. No migration or
implicit reset is implemented. Opening an instance requires the prepared
registration and database UUID, captures detached fixtures for reset, and
initializes only missing rows. The host performs this whole-environment
preflight before fixture functions, setup, subscription selection or transport
callbacks. Existing rows retain resources, credentials and outbox; changed
startup fixtures apply only on explicit reset. `up` reports a `STATE_RESTORED`
notice for restored instances in both ordinary and JSON readiness output, with
an environment-specific reset command and its destructive effect. The notice is
unconditional on restore: no fixture comparison or persisted fixture fingerprint
is introduced.

Memory and SQLite share callback serialization, detached drafts, transaction
lifetimes, generation scopes and observer handling. A changed draft commits
through a synchronous compare-and-replace SQL transaction with revision and
generation predicates. Async callbacks never hold a SQL transaction open.
Observers run only after commit and cache installation and cannot mutate an
escaped transaction. SQL failures revoke every handle and require reopen,
including uncertain commit outcomes. No callback is retried automatically.

`resetAll()` replaces every opened instance in one SQL transaction, installs all
new generations before notifying observers, and preserves dormant rows. It
abandons old callback queues without waiting for them. Handle close immediately
revokes that handle; coordinator close revokes all handles and releases
ownership. The host pauses admission, drains callers and workers, then invokes
one `resetAll()` for active instances. A failed reset leaves handles fenced and
terminates the host. SQL failures revoke handles but retain database ownership
until explicit coordinator close; shutdown closes provider admission, aborts
connections and waits for admitted middleware/handlers as well as commands and
workers before stopping plugin resources. It then removes this run's discovery
and stops the control listener before closing the database. Startup rollback
also releases ownership without undoing committed state.

The UTF-8 graph envelope is `[codecVersion, rootReference, nodeTable]`. Tags
represent primitives explicitly; indexed references preserve cycles and aliases.
Arrays retain holes and own keys, maps/sets retain order, and views reference
buffer nodes with byte offsets and lengths. Resizable buffers retain maximum
capacity and fixed versus length-tracking views. Error names use a fixed
built-in allowlist and preserve cloned message, stack and cause. Data never
selects an arbitrary constructor. Unsupported runtime-specific kinds (for
example Float16Array on a runtime without that constructor) fail closed.
Cross-runtime reopening requires both runtimes to support the stored value
kinds, just as structured cloning does. Shared memory and unsupported host
objects remain rejected by `cloneState`.

Verification lives in `codec_test.ts`, `state_conformance_test.ts` and
`sqlite_state_test.ts`. `durable_host_test.ts` covers fresh host reopening,
identity/fixture/dormant-instance behavior, preflight, failed startup cleanup,
atomic reset failure and close fencing through the real control listener. The
conformance suite runs against both adapters; SQL triggers inject commit
failures and revision conflicts without public test hooks. The installed-package
verifier additionally exercises fresh-process reopening and competing owners
across Node and Deno. `durable_process_test.ts` and the installed verifier now
exercise SQL and receiver crash barriers, lock release, persistent recovery and
explicit redelivery; see [delivery verification](events-and-delivery.md). These
process-kill checks do not prove power-loss durability or exactly-once delivery.
