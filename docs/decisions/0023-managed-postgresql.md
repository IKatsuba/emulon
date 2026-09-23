# ADR 0023: Managed local PostgreSQL

Status: Not adopted.

PostgreSQL was removed from scope and this proposal was not implemented; it is
kept for reference.

## Context

An earlier version of the design called for a real local PostgreSQL engine,
visible prerequisites, owned resources, CLI/SDK parity and a dedicated
real-engine verification item. Development uses Deno; npm consumers must work on
Node without Deno. Tests cannot download engines or contact public services.

The current `PluginContext` has HTTP, clock and store facilities, but no process
facility. `sdk/start.ts` freezes endpoints after startup, hides arbitrary setup
exceptions, and resets only stores. `control/server.ts` publishes discovery only
after readiness. ADRs 0007 and 0016 distinguish ephemeral discovery credentials
from persistent project state and require atomic reset of active instances.
PostgreSQL must extend those seams rather than implement a separate lifecycle.

## Options

| Backend                               | Assessment                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Installed local PostgreSQL binaries   | Selected: no download policy, registry, daemon or native npm addon; installation is an explicit prerequisite.               |
| Automatically downloaded distribution | Rejected for this slice: adds artifact provenance, platform packaging, cache, upgrade and offline provisioning contracts.   |
| Container                             | Deferred: adds a daemon and image provisioning, volume and container ownership, especially on macOS. No fallback to Docker. |

## Decision

### Engine, platforms and dependencies

Use PostgreSQL **17.x**, installed by the developer or image maintainer before
running Emulon. Support exactly `postgres({ version: "17", binaryDirectory? })`;
`version` defaults to `"17"`. Other majors fail validation. An explicit
`binaryDirectory` must be absolute. Otherwise resolve `postgres` through PATH,
then use its directory for all tools. Require executable `postgres`, `initdb`
and `psql` from that same installation, with matching 17.x versions. Do not
search for or attach to an existing server, use a system database, run an
installer, invoke a package manager or download anything during import, startup,
reset or tests. Missing shared libraries are prerequisite failures too.

The first release targets macOS arm64 and Linux x86_64 with a local filesystem
and POSIX permissions/locking. The verification matrix is macOS 15 arm64 and
Ubuntu 24.04 x86_64, with Deno >= 2.9 and the Node targets of ADR 0016. These
are required checks, not evidence already collected. Windows (including native
Windows PostgreSQL), macOS x86_64, Linux arm64, other operating systems, network
filesystems and synchronized live storage are unsupported in this slice. Reject
unsupported OS/architecture before spawning tools. No claim is made for an
untested matrix cell; real-engine verification is incomplete without both OS
checks.

No new npm or JSR dependency is required. Use the installed `psql` client for
bootstrap and readiness, avoiding a new SQL driver just for a probe. The
PostgreSQL installation and its shared libraries are external prerequisites, not
bundled dependencies. `@emulon/postgres` publishes portable JavaScript and types
with an `emulon` peer dependency and a Zod v4 runtime dependency for command
schemas, using the existing workspace Zod import. Do not require Hono for this
non-HTTP plugin. Core ships process/filesystem/TCP adapters built with Node
built-ins supported by both runtimes, only under `packages/emulon/src/runtime/`.
No Deno executable, engine archive, native addon, installer or postinstall
script enters npm output. Build tooling remains Deno/dnt under ADRs 0004
and 0005.

### Prerequisites before startup

Add optional declarative `prerequisites` metadata to `PluginDefinition` and
expose the same immutable metadata on its callable factory. For PostgreSQL it
lists the supported major and platforms, required tools, non-root execution,
private writable local storage and loopback access. Publish it in the package
README/compatibility document with the configuration example and a link to
[PostgreSQL installation choices](https://www.postgresql.org/download/). The
factory metadata is readable without running setup or allocating resources.

Extend existing `emulon <instance> --help` to work from configuration
declarations when there is no running environment, displaying commands and
prerequisites; this path must not start plugins. With a host, show the same
metadata through authenticated help. Loading config is still trusted code
execution, not a sandbox. This introduces no new top-level CLI command or
SDK-only operation.

Before fixtures, setup or delivery recovery, the host checks all configured
managed-backend requirements: platform, non-root user, binary resolution,
bounded version probes and storage access. Preserve state/discovery ownership
checks from ADR 0016. Version probes have a five-second timeout each and execute
without a shell. Preflight may inspect tools and acquire existing host
ownership; it must not initialize clusters or modify instance data. Distinguish
declared requirements from a successful availability check.

Expose sanitized host-created errors through both CLI and SDK, retaining
instance name, stable code and remediation. Codes are
`BACKEND_UNSUPPORTED_PLATFORM`, `BACKEND_PREREQUISITE_MISSING`,
`BACKEND_VERSION_UNSUPPORTED`, `BACKEND_STORAGE_INVALID`, `BACKEND_IN_USE`,
`BACKEND_START_FAILED`, `BACKEND_READINESS_TIMEOUT` and `BACKEND_STOP_FAILED`.
For example:
`Service "db" requires PostgreSQL 17 postgres, initdb and psql.
Install PostgreSQL 17 and set binaryDirectory or PATH.`
CLI returns nonzero and structured JSON when requested. Do not expose raw tool
output or arbitrary plugin exceptions; current generic setup wrapping must
preserve only this host-validated error shape.

### Ownership and persistent data

One PostgreSQL cluster per `(storage environment UUID, instance key)`. Never
accept a user data-directory option. The runtime maps instance keys to safe
opaque path segments; do not interpolate unchecked names into paths.

Project clusters live under
`.emulon/state/<environment>/backends/<instance-key>/generations/<generation>/`.
The core SQLite coordinator stores versioned backend metadata with the instance:
plugin identity/version, engine major, opaque owned directory identifier,
selected generation, database name and credentials. This metadata commits with
the instance state; it is not added to discovery. The generation directory has a
matching ownership manifest. Reopen validates both before starting anything;
missing/mismatched manifests or engine majors fail without reinitializing data.
Removed instances remain dormant; renamed instances get new ownership.

Private `Emulon.start()` uses a fresh owner-only temporary root and in-memory
metadata, deleting its owned root after confirmed shutdown. Project `down`
retains cluster files and credentials, just as it retains SQLite state; it stops
processes, closes ports, removes ephemeral password files and discovery, then
releases state ownership. Repeated disposal shares one cleanup promise. Startup
rollback stops every allocated process, even if setup never returned, and never
deletes previously committed data. Uncommitted new generation directories can be
removed only after their processes are known stopped.

Use 0700 directories and 0600 metadata/password files. Reject symlinks and
unsafe permissions at ownership boundaries. Delete only manifest-validated owned
directories beneath the canonical root. Keep fsync enabled. No broad process
matching, killing from a persisted PID, deletion of another cluster or automatic
removal of PostgreSQL lock files is allowed.

Discovery remains `{ version: 1, id, url, token }` with fresh identity per run.
It neither stores database passwords nor authorizes ownership of a cluster. A
killed host can leave an orphan PostgreSQL process. The next start must fail
`BACKEND_IN_USE` if PostgreSQL reports an existing owner; it must not adopt or
kill that process. Document manual identification and shutdown by the operator
before stale discovery removal/restart. Normal stop is guaranteed; orphan-free
cleanup after SIGKILL is not claimed. PostgreSQL handles recovery of a stopped
cluster; Emulon never bypasses its locking protocol.

### Process, port, credentials and readiness

Introduce a host-managed process/backend facility in `PluginContext`; plugins
use portable specifications and owned handles, never `node:*` or `Deno.*`. The
host owns child registration before awaiting spawn/readiness, bounded execution,
exit observation, private files, dynamic port selection and cleanup. The adapter
sanitizes subprocess environment variables: ignore inherited `PG*` settings,
user psql startup files and arbitrary shell initialization. Use absolute
executable paths and argument arrays. Any necessary OS loader variables must be
explicitly allowed and documented, not copied wholesale.

Initialize with UTF-8, locale C, a random bootstrap administrator and SCRAM
password authentication. Supply the bootstrap password through a private
`initdb --pwfile` file and remove it after use. The app receives a distinct,
random login/password with ownership of database `emulon`, without superuser,
role creation, replication or database creation privileges. Credentials use
secure randomness (at least 256 password bits), independent of seeded IDs. The
database is empty initially; arbitrary SQL fixtures/extensions are deferred.
Applications apply migrations through their normal PostgreSQL client.

Run `postgres` as a foreground owned child. Bind only `127.0.0.1`, disable Unix
sockets, and require SCRAM on TCP. There is no TLS claim for this loopback-only
slice. Select an ephemeral candidate by reserving `127.0.0.1:0`, release it just
before spawn, and retry at most five times on a confirmed bind collision within
the startup deadline. PostgreSQL does not inherit that reservation: do not claim
race-free allocation. Never attach to the process that won the port. On restart
a new port is allowed; clients obtain a fresh connection command.

Readiness means a successful authenticated `psql -X --no-password` execution
with `ON_ERROR_STOP=1`, returning `SELECT 1`, the expected current database and
current user using the application credentials. Also check the owned child is
still alive. An open port or a log line is insufficient. Pass passwords through
an owner-only `PGPASSFILE`, never argv or printed connection strings; remove
probe files afterwards. Give initialization/startup a 60-second real-time
deadline per instance and each SQL probe a three-second limit, with cancellable
100 ms retry intervals. PostgreSQL initialization may fail earlier; do not mask
permanent configuration/authentication errors as readiness timeouts.

Only after every instance is ready may `up` publish discovery and return its
startup result. `endpoints.db.sql` is a password-free loopback PostgreSQL
address. Add the declared command `connection` to this plugin:
`emulon db connection
--json` and `env.services.db.connection({})` return the
same validated `{ url, host, port, database, username, password, ready: true }`.
This dedicated authenticated credential command is the only normal credential
exposure; `up` tells callers how to request it, while `status`, help, logs,
discovery and endpoint maps remain redacted. This ADR authorizes that public
command.

Observe unexpected child exit after startup, mark environment health failed with
instance and `BACKEND_EXITED`, fence mutations and stop owned backend peers.
Keep the authenticated control listener for redacted `status` and `down`;
connection requests and reset fail until restart. Add the corresponding health
field to identity/status and a read-only `Environment.health` view for private
SDK users. A connected client's view refreshes through the authenticated control
path; it must not keep reporting a startup snapshot as current health. No
automatic restart conceals lost availability. Normal shutdown sends SIGINT
(PostgreSQL fast shutdown), waits ten seconds, then SIGQUIT and waits five more.
If exit is still unconfirmed, report cleanup failure and retain data/ownership
evidence; do not delete files or declare successful down.

### Reset without violating durable atomicity

Do not implement reset as DROP DATABASE or deleting the live data directory.
Extend host lifecycle with prepare/commit/abort handling for managed
generations. Pause/drain commands, HTTP and workers first; stop all active
PostgreSQL clusters with fast shutdown, disconnecting application SQL sessions
and rolling back uncommitted SQL. New TCP sessions cannot enter a stopped
cluster. Serialize reset and disposal, and fence old backend handles as well as
store scopes.

Prepare a fresh empty generation for each active PostgreSQL instance, with new
credentials, and prove readiness on temporary loopback ports that are never
published; stop the prepared engine before commit. Commit all active store
fixtures/generations and backend generation pointers/credentials in the existing
single SQLite reset transaction. Dormant instances are untouched. Start the
selected new generations, prove readiness, then resume admission. Keep the
instance's TCP port across a successful reset; if it cannot be rebound, fail and
dispose the fenced environment. Existing password-free endpoints remain valid;
callers must request new credentials.

A failure before the SQLite commit leaves every old generation selected; one
after commit leaves every new generation selected. In either case dispose the
fenced host, never resume a partial reset. Reopen selects only committed
metadata. Old/unselected directories can be collected after verified shutdown
and ownership checks; leftovers from an interrupted reset must never be served
or deleted while a process still owns them. Persist preparation ownership before
spawning so crash recovery can identify leftovers without trusting raw PIDs.
Private environments use the same staged reset protocol with one in-memory
selection switch. Empty database plus rotated credentials is the first slice's
fixture state. No cross-engine SQL transaction or undo of external application
effects is promised; this protocol preserves atomic selection of reset state.

## Proposed implementation plan

The work splits into two parts; part 2 depends on part 1.

### Part 1: Plugin and managed-backend lifecycle

Scope: `packages/postgres/`,
`packages/emulon/src/plugins/{types,define,validation}.ts`, new portable backend
rules and runtime adapters, `sdk/start.ts`, `sdk/emulon.ts`,
`runtime/sqlite-state.ts`, control protocol/server/client, CLI declaration help,
workspace configuration, `scripts/build-npm.ts`, distribution verifier and docs.

Done means the selected options, prerequisite metadata/preflight, safe errors,
process ownership, persistence, staged reset, health and connection command all
work together. Update `docs/design.md` to link this decision and document the
public additions. Tests use injected process/filesystem/clock seams for missing
tools, mismatched versions, unsupported platform, root, partial setup, port
collision, bounded readiness, exit, stop failure, disposal/reset races, secret
redaction, unsafe paths and generation selection on both sides of commit. Build
the plugin archive and prove imports/types without a Deno executable on the Node
consumer path. `deno task check` passes with no PostgreSQL installation; none of
these fake tests may count as real-engine verification.

### Part 2: Real-engine verification

Add `scripts/verify-postgres.ts` and `deno task verify:postgres`, plus an
English report of the verified environment. Require preinstalled tools via an
explicit absolute binary directory and fail with setup instructions if absent;
never skip to a green result, install packages or pull an image. Provisioning
belongs to developer/CI image setup outside the test run. Dependencies and npm
archives are prepared before verification; consumer fixtures install offline
with lifecycle scripts disabled. Restrict traffic to loopback and include a
Node-only consumer execution without Deno available in its executable search.

Record OS/architecture, exact PostgreSQL and runtime versions, revision and
commands. Check both platform cells above, the minimum Node 22.13.0, supported
LTS/current targets and Deno 2.9+; label unavailable cells unverified and do not
claim support for them. Use the same SQL corpus through installed `psql` against
real engines; no new test driver is required.

Prove independently:

1. Two parallel private environments and two instances in one environment have
   distinct directories, ports and passwords. Create/write/read a table via the
   returned credentials; it is absent in the peer. Cross-instance passwords
   fail.
2. CLI and attached SDK return the same explicit connection details. Successful
   `up` permits immediate authenticated SQL; status/help/logs never leak
   secrets.
3. Two project slots are isolated. Down/up retains committed SQL data and
   credentials, changes discovery identity, and reconnects using the current
   port. A second host cannot take a slot or an already running cluster.
4. Reset drops application tables, rotates credentials, disconnects old
   sessions, keeps the port, and leaves the sibling/dormant ownership boundaries
   intact. Barrier-driven process-kill tests before and after the SQLite reset
   commit recover entirely old or entirely new selections, including a mixed
   HTTP/SQL environment. Explicitly stop verified orphan children in the
   harness.
5. A later instance failing startup rolls back earlier processes and releases
   ports. Missing/broken tools, incompatible major, occupied candidate ports,
   readiness timeout and unexpected engine exit produce the specified errors and
   health. A deliberately unrelated local server is never adopted or killed.
6. Down/private disposal confirm exit and closed ports; private data disappears,
   project data remains, and repeated cleanup is safe. Stale discovery and
   surviving-child recovery follow the documented manual procedure. Test stop
   failure deterministically with a fake seam, not by damaging a real cluster.

Run `deno task check` as well as this dedicated offline engine suite and
relevant archive checks. Real-engine support is claimed only after this boundary
is independently reproduced.

## Consequences and remaining limits

This deliberately trades zero-install convenience for an explicit, offline
backend prerequisite. Implementing a real backend includes core lifecycle work,
not just a factory wrapping a subprocess. Staged generations cost extra disk
space and initialization time on reset. Orphans after host SIGKILL require
operator intervention. There is no support claim for containers, downloads,
external databases, Windows, extra PostgreSQL majors, SQL fixture APIs,
extensions, snapshots, virtual database time, replication, TLS or `exec`
integration in this slice.

The architectural choice is settled here; actual tool/runtime compatibility,
reset recovery and cleanup timing are still unproven until part 2. If that proof
requires a new dependency or different lifecycle guarantee, amend this ADR
rather than silently relaxing verification.

## Primary references

- [PostgreSQL 17 initdb](https://www.postgresql.org/docs/17/app-initdb.html):
  authentication, private initialization and password-file input.
- [PostgreSQL 17 server](https://www.postgresql.org/docs/17/app-postgres.html):
  foreground execution, data directory, listen address, port and Unix sockets.
- [PostgreSQL 17 psql](https://www.postgresql.org/docs/17/app-psql.html):
  noninteractive SQL, ignoring startup files and stopping on SQL errors.
- [Password files](https://www.postgresql.org/docs/17/libpq-pgpass.html):
  PGPASSFILE and owner-only permissions.
- [Server shutdown](https://www.postgresql.org/docs/17/server-shutdown.html):
  fast/immediate shutdown signal semantics and recovery consequences.
