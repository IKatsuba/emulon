# ADR 0007: Loopback control API and project discovery

## Context

The CLI initially started a temporary environment per command. This decision
replaces it with one foreground host, reached over loopback HTTP with an
environment bearer credential, dynamic ports, and owner-only discovery under the
project directory. CLI and SDK must operate on the same registry and state,
independently of provider HTTP surfaces.

## Options

- Keep starting a temporary environment per command: loses shared state.
- Use Unix sockets: requires a separate portability and transport contract.
- Use a dedicated loopback HTTP listener and authenticated discovery: selected.

## Decision

`emulon up` loads project configuration, starts all instances, binds a separate
control listener to `127.0.0.1:0`, then publishes discovery. It runs in the
foreground. Failed publication rolls back every owned listener and instance.
`emulon down`, SIGINT, and SIGTERM dispose the owned environment and remove its
record. SIGKILL leaves a stale record; no process is signalled using a stored
PID.

The global `--environment <name>` (also `--environment=name`) selects a
discovery slot, default `default`. It applies to up, down, status, help on
instances, and service commands. Names contain 1–64 ASCII letters, digits,
underscores or hyphens, beginning with a letter or digit. This flag is reserved
in command metadata, alongside help and json. Two slots run separate
environments; an existing slot is never silently overwritten, even if stale.

Records live at `<project>/.emulon/<name>.json`; the project defaults to the
current working directory, with no ancestor search. `.emulon/` is ignored by
Git. The directory has mode 0700 and records are exclusively created with
mode 0600. The format is `{ version: 1, id, url, token }`: a random UUID, a
literal `http://127.0.0.1:<port>` origin, and a cryptographically random 256-bit
hex token. The record is the local capability and must not be shared or logged.
Symlink record files, loose record permissions, invalid versions and
non-loopback URLs are rejected before networking. Discovery requires POSIX
permission semantics; Windows ACL support is not claimed.

Clients authenticate `GET /identity` using both `Authorization: Bearer <token>`
and `X-Emulon-Environment: <id>`, then verify the returned identity. All control
routes require these headers; cookies and provider tokens confer no authority.
Requests carrying Origin are rejected, and no CORS permission is granted.
Control credentials and routes are separate from browser/provider authorization.
The authenticated identity response also carries provider endpoint maps.

Service invocations use `POST /command` with `{ instance, command, input }` and
the existing registry's JSON validation, errors and executor. `POST /cli`
accepts an argument array, running the existing parser/help against that same
registry; it never loads configuration or calls setup in the client process.
`POST /reset` uses the existing environment reset lifecycle. `POST /down` drains
the owned environment and removes discovery before acknowledging; listener
shutdown follows the acknowledgement. Internal transport routes are not package
exports.

`Emulon.connect()` loads the current project's configuration declarations and
attaches without setup. `Emulon.connect({ config, directory?, environment? })`
preserves concrete service/command types; `{ directory?, environment? }` without
config returns dynamically keyed types, as with `Emulon.load(directory)`.
Callers use the same configuration as the running environment; server validation
is authoritative if they differ. Connected clients expose the same services,
endpoints, reset, dispose and async-dispose shape as started environments.
Disposing an attached client aborts its pending transport requests and rejects
future calls, without stopping the host. Already accepted server mutations are
not undone. `Emulon.start(config)` remains a private, undiscovered environment.

Identity checks time out after 3 seconds. Other requests time out after 30
seconds and are never retried automatically: a lost reply can follow a
successful mutation. Identity failures yield `ENVIRONMENT_STALE` with
instructions to stop the old process, remove the selected record, and run up
again. Missing records instruct the caller to run up. Transport failures after
identity validation use `CONTROL_CONNECTION_LOST` and report that the outcome
may be unknown. Redirects are forbidden. Ordinary up/status output contains
instance names and endpoint origins only, stripping URL credentials, paths,
queries and fragments.

## Consequences

CLI calls and connected SDK clients share one environment across processes.
Parallel environments are explicit and their state, ports and tokens are
independent. Local fixtures test credentials, identity mismatch, stale records,
shared transactional state, ownership and cleanup without external providers.

No dependency is added. Filesystem and signal handling use the existing runtime
adapter boundary; business rules remain portable. Discovery is ephemeral, not
state persistence. Crash recovery requires explicit stale-record removal.
File/blob command inputs, persistent storage, Resend operations and outbox
delivery remain outside this decision.
