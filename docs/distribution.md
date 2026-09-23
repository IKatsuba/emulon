# Distribution verification

Prerequisites: Deno >= 2.9, Node >= 22.13.0 and npm on PATH. Build dependencies
may need network access on the first build. Verification itself uses only the
local archives, empty caches and offline package resolution.

The mandatory gate, from the repository root:

```sh
deno task check
```

It runs source type checking, lint, formatting and tests, then builds all five
npm packages and verifies the freshly built archives under Node and Deno. Any
step failure stops the gate. See
[ADR 0027](decisions/0027-distribution-gate.md). For focused distribution work,
run `deno task build:npm` followed by `deno task verify:dist`; these remain
independently available. Standalone verification uses the existing archives, so
rebuild after source changes.

The verifier creates separate temporary Node and Deno projects outside the
workspace and removes them afterwards. It reports each check and fails with the
runtime, failed check and subprocess output:

- Offline installation of the core, Resend, GitHub, Stripe and Cal.com plugins,
  Zod, Hono, Node adapter, pinned compiler and test-only Stripe client
  dependency archives.
- ESM imports of all five packages (Deno imports use `npm:`).
- CLI version and configuration generation through the installed bin.
- Loading the generated configuration and a configuration using the plugin.
- Convention resolution from `resend` to the installed `@emulon/resend`.
- Strict `tsc --noEmit` and `deno check` checks of the installed declarations,
  including expected errors for unknown instance names, invalid plugin options,
  and command input/output types. Started and connected Stripe, Resend and
  GitHub clients reject invalid webhook IDs, nested event payloads, event names,
  wait parameters and extra fields on empty commands. Resend also checks email,
  key and delivery-fault inputs. Valid calls are checked alongside the errors.

No workspace import map or implementation source files are available to the
consumers; copied acceptance fixtures import only installed modules. Deno allows
only loopback network access; npm runs offline with isolated configuration. Zod
is the schema runtime dependency of core and all four plugins (ADR 0002); the
build packs it from the resolved Deno cache for offline installation.

Run verification on each supported Node release when validating the release
matrix; one local run only proves the versions it reports. Node's native type
stripping flag is supplied for early Node 22 releases, as allowed by ADR 0003.
The consumer also checks HTTP lifecycle, repeated disposal, restart, partial
startup rollback, request URLs and redirects retaining the listener port, and
separate response cookies (including an Expires attribute containing a comma).
The installed Resend plugin also sends and reads through local HTTP, shares
state with the typed SDK, and invalidates state and keys on reset. The full
official client contract is tested separately by `deno task check`; its `resend`
test dependency must not appear in any published package manifest.

The installed GitHub scaffold creates an RSA app key and installation, suspends
the installation and checks both unsupported HTTP surfaces. Its published types
retain command inputs and outputs. This is a management smoke test; GitHub
provider routes and official-client contracts run separately in the loopback
suite described in [GitHub compatibility](github-compatibility.md).

The internal durable adapter is included for verification without a public
package export. The verifier opens the same database in fresh Node and Deno
processes, checks graph aliases, binary backing buffers, bigint, environment
identity and entity/outbox persistence, and runs competing Node/Deno openers
against a live owner. Installed CLI checks reject experimental runtime warnings,
including on host startup, without warning-suppression environment variables.
The sole verifier exception is Node 22's Type Stripping notice from the explicit
`--experimental-strip-types` flag required by ADR 0003; it is still emitted by
Node before application code and is not suppressed by Emulon. SQLite notices are
never exempted. Deno's non-experimental `Deno.serve` migration notice is also
outside this assertion. The runtime adapter suppresses only the SQLite
experimental notice during its synchronous builtin load and restores the warning
emitter immediately; other warnings remain visible. Generated configs after
`add` must pass `deno fmt --check --no-config`, and source tests compare
formatter output after incremental additions too. Project hosts use durable
state by default; private SDK starts remain memory-only. Installed consumer
lifecycle and process-kill delivery proof are described below; see also
[durable runtime](durable-state.md).

To select the exact minimum runtime, prepend a Node 22.13.0 `bin` directory to
PATH when running `deno task verify:dist`. Repeat with the supported LTS/current
runtimes. The verifier does not download runtimes or contact public providers.

The archives have been verified on macOS arm64 with Node 22.13.0, 24.13.0 and
26.7.0, each paired with Deno 2.9.7, including the SQLite cross-runtime reopen
and competing-process checks. This records the versions actually exercised, not
an inference about untested releases.

## Crash recovery and installed host verification

The verifier gives children a temporary PATH containing only symlinks to the
selected local `node`, `npm`, `npx` and `/bin/sh`. It explicitly asserts that
spawning `deno` from the Node consumer fails with ENOENT. Deno checks use the
orchestrator's absolute executable path. No runtime is downloaded; supply local
binaries and build archives before running verification. npm installs offline
with empty caches and lifecycle scripts disabled.

The Node consumer runs the independent-process crash proof entirely on Node. The
Deno consumer alternates Node and Deno child processes over one slot, including
committed snapshots, atomic reset, destination credentials, pending outbox,
delivery/attempt records and persisted interrupted-attempt recovery. Both
exercise the real durable project host and a loopback receiver. See
[delivery verification](events-and-delivery.md#independent-process-crash-recovery)
for the exact barriers and assertions. Fixtures patch SQLite methods only in the
child process to stop at SQL boundaries; no public test API is introduced.

The separate codec probe checks cycles, object/Map/Set aliases, shared backing
buffers and offsets, bigint, dates including invalid dates, RegExp, Error cause,
sparse arrays with undefined, non-finite numbers, negative zero and an own
`__proto__` property. It writes in Node, reopens in Deno and Node, retaining
UUID and outbox. The CLI/connected SDK counter also survives `down`/`up` and
SIGINT; SIGKILL leaves stale discovery, which must be explicitly removed. The
crash proof demonstrates reopen after that removal.

Reproduce the matrix with preinstalled binaries (substitute your local paths):

```sh
deno task build:npm
PATH=/tmp/node-v22.13.0-darwin-arm64/bin:$PATH deno task verify:dist
PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH deno task verify:dist
PATH=$HOME/.nvm/versions/node/v26.7.0/bin:$PATH deno task verify:dist
deno task check
```

Verified on macOS arm64:

| Node version                  | Deno version | Offline install, crash proof, cross-runtime reopen, CLI/SDK, declarations |
| ----------------------------- | ------------ | ------------------------------------------------------------------------- |
| 22.13.0 (minimum)             | 2.9.7        | PASS                                                                      |
| 24.13.0 (LTS matrix entry)    | 2.9.7        | PASS                                                                      |
| 26.7.0 (current matrix entry) | 2.9.7        | PASS                                                                      |

Installed CLI checks reject SQLite experimental warnings on every Node release,
as described above. Each process must meet its asserted exit and barrier
outcome. The verifier prints actual runtime versions, not inferred compatibility
for every Node >= 22.13.0 release.

Unchecked: real providers, public-network behavior, other OS/CPU/filesystem
combinations, synchronized/network storage, Windows ACLs, machine power loss and
storage hardware failure. These process-kill results establish neither
exactly-once webhook execution nor power-loss durability.

## Plugin installation

Both runtime fixtures run `init`, `add github resend`, repeated `add`, `up` and
`down` in a fresh project. Only core and transitive archives are installed
before `add`; a loopback registry serves the actual built plugin archives. The
check asserts saved dependencies and lockfile entries, both running services,
actual GitHub `webhooks list` and Resend `emails list` parity with the connected
SDK, and byte-for-byte preservation of an unsafe configuration with text and
JSON manual instructions. No public registry or provider is contacted.

The pinned compiler is now a core runtime dependency for AST parsing in `add`;
plugins must not ship it. See [ADR 0032](decisions/0032-plugin-add.md) for
manager selection, the conservative edit grammar, failure behavior and
package-manager boundaries. npm archive installation remains offline; only the
`add` acceptance fixture enables registry requests to its loopback server.

The installed compatibility proof compares the GitHub and Resend declarations
with npm metadata, CLI and started/connected SDK results under both runtimes.
The build imports static [compatibility declarations](compatibility.md) without
calling plugin setup or opening provider listeners.

The installed Stripe slice creates and reads customers through HTTP and the
typed SDK. CLI idempotency replay survives graceful shutdown and SIGKILL under
both runtimes. The official stripe@18.0.0 client is packed separately for
offline consumer testing and excluded from published product dependencies. The
combined example below also verifies signed Stripe delivery.

## Cal.com fixed availability slice

The build also publishes `@emulon/calcom`. Offline installed Node and Deno
consumers execute event-type creation through CLI and SDK, read the documented
HTTP projections and UTC slots, restart durable state, reset credentials, and
compare the manifest across npm metadata, CLI and started/connected SDK. They
also create bookings through CLI, read them through SDK/HTTP, and verify
organizer-wide occupancy and event persistence after a second durable restart. A
loopback receiver independently checks Unicode body signatures; a failed 500
attempt is inspected and manually redelivered through CLI/SDK with identical
bytes and no extra booking/event. Declaration checks enforce numeric
IDs/durations and typed booking create/get inputs and results, including
UTC-only attendees. See [the package guide](../packages/calcom/README.md) and
[installed contract proof](../scripts/calcom-proof.ts). No Cal.com client or
React dependency is shipped.

## Combined Stripe and Cal.com example

The [runnable example](../examples/stripe-calcom/README.md) is copied unchanged
into a fresh installed project for each runtime. `init/add stripe calcom/up`
loads both services, CLI and connected SDK create/read customers, event types
and bookings, and the official Stripe client plus Cal.com HTTP exercise the
supported provider projections. The receiver independently verifies both
exact-byte HMAC signatures and correlates three deliveries per service with the
created resources. CLI/SDK manifests match installed package metadata. A
separate `Emulon.start()` starts both services and disposal releases both ports,
proved by rebinding them. Combined started/connected client inputs and outputs
are checked from installed declarations with positive and negative TypeScript
and Deno probes.

All test-only dependency archives, including Stripe's transitive npm graph, are
prepared by the build before verification. The Node consumer has no Deno in
PATH; Deno uses cached-only resolution and loopback network permissions. Only
local provider surfaces and the archive registry are exercised, with no live
accounts.

## Package manager installation

`verify:dist` also runs `init`, `add github resend`, repeated `add`, `up` and
`down` with each locally available pnpm, Yarn, Bun and Deno executable. Each
manager installs core itself into a separate fresh project, then installs both
plugins from a loopback registry of the built archives and their complete
runtime dependency graph. Dependency caches and project configuration are
isolated. Registry access is enabled only for this local fixture; an offline
flag that prohibits even loopback downloads would prevent testing installation
from a registry. Corepack network downloads, latest-version lookup and automatic
pinning are disabled; its existing manager cache is reused, not dependency
caches. No manager is downloaded by the verifier.

The assertions cover the selected manager, saved dependencies (Deno import map),
changed native lockfile with both plugins, absence of another manager's
lockfile, byte-identical config after repeat add, both running services and real
CLI/SDK command parity. A separate locally packed incompatible plugin proves
metadata rejection before module evaluation and without changing configuration.
This is an intentional failure after installation; its dependency and lockfile
entries may remain as specified in ADR 0032.

Missing executables produce a named `SKIP manager ...` line. An available
manager that fails installation fails verification. Corepack shims require an
already cached manager. The checks use Node to run the installed CLI
independently of which manager owns dependencies; the existing separate Deno
runtime fixture continues to prove CLI execution under Deno. Workspaces, Yarn
PnP and other manager versions are outside this proof.
