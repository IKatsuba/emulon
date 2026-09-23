# ADR 0016: Durable environment state

Status: Accepted.

## Context

[ADR 0017](0017-state-store.md) defines the binding store contract, including
cyclic structured-clone values, transaction lifetimes and reset generations. Its
memory adapter loses everything on exit. `sdk/start.ts` generates a new storage
identity, while `control/server.ts` independently generates a discovery
identity. Dispatcher and worker recovery already exist, but only retained-memory
tests exercise them. Durable state must make the same recovery work after
process death.

The durable unit must include resources, credentials, outbox, subscriptions,
materialized deliveries, attempts, fault settings and version metadata.
Splitting those across independent files or databases would break their commit
boundary. Neither process recovery nor storage transactions make webhook
execution exactly-once; ADR 0013's unknown-outcome policy remains binding.

## Options

| Option                                               | Assessment                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| JSON files with rename and a custom journal          | No dependency, but requires our own locking, recovery and flush protocol; plain JSON also loses accepted value types.     |
| SQLite through `better-sqlite3` or a Deno FFI driver | Transactions and recovery, but adds native packaging, lifecycle-script or FFI requirements to distribution.               |
| SQLite through built-in `node:sqlite`                | One runtime boundary for Node and Deno, no added dependency; requires a precise Node minimum and a value codec. Selected. |
| External database server                             | Introduces a prerequisite for core state before any managed-service plugin is requested.                                  |

## Decision

### Engine and runtime support

Use a single SQLite database per persistent environment, accessed through
`node:sqlite` only inside `packages/emulon/src/runtime/`. There is no new npm or
JSR dependency and no native install script. Use the common `DatabaseSync`,
prepared statement and explicit SQL transaction subset; do not rely on newer
session, backup or connection-option APIs. Deno documents this module from 2.2;
our Deno development minimum remains 2.9.

Refine ADR 0001's npm runtime target from Node >= 22 to **Node >= 22.13.0**,
where built-in SQLite is available without an experimental enablement flag. This
is an explicit technical compatibility change: 22.0–22.12 are no longer
supported. The implementation must update package engine generation, runtime
documentation and distribution verification together. It must verify the minimum
and supported LTS/current runtimes, not infer support from the locally installed
Node. This changes no confirmed product decision: development remains Deno and
published packages run without Deno. Some Node releases emit an experimental
SQLite notice. The runtime adapter suppresses that specific notice during its
synchronous builtin load, leaving other warnings visible.

Engine availability is documented in the
[Node 22.13 API](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)
and [Deno compatibility reference](https://docs.deno.com/api/node/sqlite/).

### Location, ownership and identities

`emulon up` selects durable state by default. Resolve the project directory as
in ADR 0007, canonicalize it, validate the existing environment selector, and
use `<project>/.emulon/state/<environment>/state.sqlite`. A new slot creates a
cryptographically random environment UUID in database metadata exactly once.
Reopening that database keeps the UUID. Different slots have different UUIDs;
moving a stopped project preserves its identity. Copying a stopped database
copies its identity and is a clone, not creation of an independent environment.

Instance ownership is `(environment UUID, config service key)`. Persist the
plugin definition name alongside its plugin/schema versions; a different plugin
cannot silently inherit another plugin's rows under the same key. Renaming a
service creates a new instance. Removing a service leaves its rows dormant:
there is no dispatcher, worker or setup for it, and re-adding it requires the
same identity and compatible versions. No automatic deletion or rename guessing.

`Emulon.start(config)` stays private, isolated and in-memory. Durable SDK users
attach to `emulon up` through `Emulon.connect()`. This ADR adds no public
adapter export, storage option, migration command or storage management command.

ADR 0007's discovery `id`, token and URL remain **per-run** connection identity,
with a fresh random id and token on every start. They are not the database UUID
and are never restored from state. Existing clients cannot authenticate a later
run using old credentials. `down` removes discovery but retains the database;
`reset` preserves both storage identity and current connection identity.

Keep ADR 0007's explicit stale-record removal policy. Removing
`.emulon/<environment>.json` does not remove state. Acquire database ownership
and reject an existing discovery record before plugin setup, fixture
installation, recovery or delivery I/O. A stale record is not authorization to
steal a live database. Release database ownership only after workers and callers
are stopped and this run's discovery record has been removed. Failed startup
releases all owned resources and retains previously committed state.

Directories are owner-only (0700), database files owner-only (0600), including
SQLite sidecars. Reject symlink storage directories/files and unsafe existing
permissions before opening. Create the protected directory/file before SQLite
can create sidecars. The initial support boundary is a local filesystem with
POSIX permission and locking semantics, matching discovery; network/synchronized
live storage and Windows ACL support are not claimed. State contains
credentials: no database contents, bound SQL values or raw engine errors in
diagnostics.

### One host and atomic commits

Use one database connection for the environment, with
`PRAGMA locking_mode=EXCLUSIVE`, `journal_mode=WAL`, `synchronous=FULL` and
`foreign_keys=ON`. Set exclusive mode before accessing WAL, acquire the actual
write lock before startup, verify effective settings, and keep ownership until
connection close. A second host fails promptly with `STATE_IN_USE`; it must not
run plugins or send deliveries. SQLite releases OS locks after process exit;
there is no PID file, expiring lease, lock-file deletion or timeout takeover.
[SQLite locking](https://www.sqlite.org/pragma.html#pragma_locking_mode)
documents connection-held locks; [WAL](https://www.sqlite.org/wal.html)
documents recovery and the FULL commit synchronization choice.

Store metadata and instance snapshots in SQL tables. Each instance snapshot
contains the complete ordered collection maps and outbox, encoded as one graph;
metadata includes its generation and revision. Queue and attempt collections are
ordinary rows inside that snapshot, not a separate persistence path. This
deliberately keeps ADR 0017's whole-instance draft cost for the first durable
release.

Keep a serial callback queue per instance. Run an async transaction callback
against a detached private draft without holding an SQL transaction across its
awaits. After successful callback completion, validate/encode the draft, check
the handle and generation, then use a short synchronous SQL transaction to
compare the expected revision/generation and replace the snapshot and revision.
On reset or close, stale callbacks cannot reach a commit. Never automatically
rerun a plugin callback after a conflict or I/O error. Cross-instance SQL
commits serialize on the shared connection, without promising cross-instance
plugin transactions.

Publish committed events and notify subscribers only after SQL COMMIT succeeds
and the in-memory view is installed. Observer exceptions cannot turn a committed
mutation into a reported rollback. On any engine failure, roll back if possible;
if the connection's commit outcome is uncertain, revoke the environment and
require reopen rather than continue from a potentially stale cache. The caller
may receive an unknown result after a crash immediately following COMMIT.

The database coordinator owns the connection separately from instance handles.
Closing a handle synchronously revokes its scopes and callbacks; final
environment disposal closes the connection after revoking every handle. Opening
and rolling back partially constructed environments must also close it.

### Persisted value format

Use a versioned, portable tagged graph codec in `state/`, encoded as UTF-8 bytes
in a SQLite BLOB. Do not serialize plugin values with plain JSON, and do not
make the file format depend on a particular V8 serializer version. An envelope
contains a codec version, root reference and indexed node table. Explicit tags
distinguish primitives and object kinds; reference IDs preserve cycles and
aliasing. Allocate nodes before resolving their edges on decode.

Round trips must preserve the result of `cloneState`, including undefined,
bigint, non-finite numbers and negative zero, sparse arrays, Map/Set order and
keys, Date (including invalid dates), RegExp, supported Error fields and causes,
ArrayBuffer bytes, and typed arrays/DataView with offsets and shared backing
buffer relationships. Preserve collection/entity/outbox iteration order too. The
normalized structured clone is the contract, not custom prototypes or properties
already discarded by structured cloning. Reject SharedArrayBuffer, unsupported
host objects and functions as before.

Validate the entire envelope before exposing it: known tags/versions, valid
references, lengths, offsets, bounds and unique required metadata. Define own
properties safely, including a key named `__proto__`; never resolve constructors
or execute code named by the data. Malformed state fails closed without silently
replacing it with fixtures. Run decoded graphs through the existing clone
validation. Codec conformance must include reopening across Node and Deno.

### Versions, initialization and migrations

Maintain separate versions for the SQL storage format (starting at 1), graph
codec (starting at 1), core queue/attempt record format (starting at 1), and
each instance's existing pluginVersion/schemaVersion pair. Do not use package
version or SQLite's own version as the storage format version.

Startup has a whole-environment preflight: read registrations and validate all
configured instance identities, versions and snapshot formats **before invoking
fixture functions, plugin setup, subscription policies or delivery transports**.
The current per-instance setup loop is insufficient: a mismatch in the last
instance must not let the first instance send a webhook. Configuration loading
itself remains execution of trusted project code, as in the design.

For this first durable release, plugin and schema versions must match exactly,
as in ADR 0017. A changed pluginVersion is rejected even with an unchanged
schema number. There is no public plugin migration hook and no implicit reset or
best-effort conversion. Report actual/required versions and instance name, with
no stored values. Unknown newer core or codec formats are also rejected.

Core format upgrades, when introduced, require explicit ordered migrations
shipped and tested with that change. Preflight the complete migration path and
plugin compatibility first; apply all data transformations and version markers
in one SQL transaction under exclusive ownership before any runtime work starts.
Missing paths, downgrade attempts or migration failures leave logical data and
version markers unchanged. Version 1 has no historical durable format to import:
memory-only state cannot be recovered from an earlier process. Plugin migration
API design requires a later ADR; a failing compatibility check is not permission
to invent such an API during implementation.

After successful preflight, capture detached fixtures from the current startup
configuration once. Initialize only genuinely new instances, atomically with
their version metadata. Existing instances retain their resources, credentials,
queues and outbox; startup fixtures never overwrite them. Reset uses the
captured fixtures from this startup without rerunning user code. Changed fixture
options therefore take effect on explicit reset, not on ordinary restart. `up`
reports a `STATE_RESTORED` notice for restored instances in both ordinary and
JSON readiness output, with an environment-specific reset command and its
destructive effect. The notice is unconditional on restore: no fixture
comparison or persisted fixture fingerprint is introduced.

Durable environment reset pauses/drains admission and workers as today, fences
all active handles, and replaces all configured instances and generations in one
database transaction. Dormant instances remain untouched. Persisted reset is
all-or-nothing across active instances. Resume only after commit; failure must
leave the environment fenced and dispose it rather than resume a partially reset
host. Reopen recovers the old or new complete state. These coordinator
operations extend internal seams only; the memory adapter and public Store
surface remain compatible.

### Recovery and proof

SQLite recovery runs before decoding state. After whole-environment preflight,
reuse the existing dispatcher and `recoverAttempts` semantics: pending events
materialize once by their existing idempotency key, queued deliveries resume,
completed ones stay completed, and in-flight attempts become `INTERRUPTED` with
unknown outcome and failed deliveries requiring explicit redelivery. Persist
that recovery transition before workers send again. Retain exact body bytes,
provider delivery IDs, attempts, deadlines and credentials. Recalculate timers
from persisted wall-clock deadlines, not from process-relative timer IDs.

Verification must use independent processes and fresh database opens, not shared
maps or retained handles. Synchronize crash tests through explicit barriers:
before SQL commit, after a committed write, and after a receiver observes a
request but before completion is recorded. Prove old-or-new entity/outbox state,
retained successful commits, no duplicate logical deliveries, unknown in-flight
outcomes, and explicit redelivery. Also exercise atomic reset, abandoned async
callbacks, close fencing, busy second starts, stale discovery, corrupt/unknown
formats, version mismatches before plugin callbacks, and slot/instance
isolation.

Every part passes `deno task check` and its own relevant tests. Subprocess tests
need explicit, narrowly scoped run permissions in the test harness. Distribution
verification installs the npm archives and demonstrates durable restart and
cross-runtime data reopening without Deno on the Node consumer path. All
receivers bind loopback and all fixtures stay local; no provider accounts or
public-network test requests.

## Consequences and delivery slices

This resolves engine selection without a dependency, at the cost of a higher
Node patch/minor floor and an explicit codec. Whole-instance snapshots and
synchronous SQLite commits are acceptable for small local fixtures, not a
large-dataset performance claim. Exclusive ownership also excludes external live
database inspection. Backups require a stopped environment with its SQLite files
intact; deleting a WAL file is never a recovery procedure. Process-kill tests do
not establish durability against every hardware or filesystem failure.

Implementation proceeds in three independently verifiable slices:

1. Durable coordinator/adapter, graph codec and format validation in `state/`
   and `runtime/`, with adapter conformance, rollback, reopen and exclusion
   tests. Update the Node target and prove the built-in driver in distribution
   tooling. Production startup may remain memory-only in this slice.
2. Wire durable project hosts through `sdk/start.ts`, `control/server.ts` and
   `runtime/discovery.ts`; implement identity, whole-environment preflight,
   atomic reset and ownership cleanup. Test restart, fixtures, stale records and
   mismatches; preserve private SDK isolation. Update runtime/design docs to
   link this decision and describe the implemented behavior.
3. Prove crash recovery through subprocess CLI/SDK and local receiver scenarios;
   extend `scripts/verify-dist.ts` and delivery verification documentation. Fix
   integration defects exposed by that proof without weakening the contract.

When the engine was selected, a local probe only confirmed SQLite BLOB access on
Deno 2.9.7 and Node 24.13.0. Minimum-runtime behavior, lock acquisition on
reopen, full codec fidelity and crash boundaries are left to implementation
verification, not results claimed by this decision. If those checks disprove the
selected common API, the concrete incompatibility requires a new decision rather
than silently introducing another engine, dependency or weaker value contract.

## Implementation status

The first slice implements the internal coordinator, graph codec, shared adapter
conformance and format validation. Installed npm archive verification passed on
Node 22.13.0, 24.13.0 and 26.7.0, each paired with Deno 2.9.7, including
fresh-process cross-runtime reopening and competing owners. See
[durable state](../durable-state.md) and
[distribution verification](../distribution.md). The second slice connects
project hosts to the coordinator with whole-environment preflight, stable state
identity, atomic active-instance reset and ordered ownership cleanup. Lifecycle
integration tests cover fresh host reopening, stale discovery, lock exclusion
and failure fencing. The third slice implements delivery crash barriers and
installed consumer lifecycle proof on Node 22.13.0, 24.13.0 and 26.7.0 with Deno
2.9.7. See [delivery verification](../events-and-delivery.md) for the checked
and unchecked boundaries. The original engine-selection probe is not evidence
for those boundaries.
