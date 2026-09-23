# ADR 0003: Native configuration loading and configuration descriptors

## Context

Emulon needs a CLI entry point and a typed SDK entry before environment
lifecycle work. Project configuration is trusted TypeScript and should load
without a transpiler dependency. Development uses Deno; distribution targets
Node 22 and newer.

## Options

- Native import of an absolute file URL, using the runtime's TypeScript support.
- Bundling or transpiling project configuration with an additional dependency.

## Decision

Use native `import()` of the absolute file URL of `emulon.config.ts` in the
specified directory, defaulting to the working directory. Do not search
ancestors: this prevents accidentally selecting another project's configuration.
Relative imports resolve from the configuration file. Package imports use the
host's normal resolution. Configurations are trusted executable project code,
including any side effects. Native module caching applies; reload is not
offered.

Keep filesystem, path and process access in `src/runtime/`. Use the
Node-compatible standard modules available in both supported runtimes; add no
dependencies. TypeScript must use syntax supported by the host's native
execution. Node versions that do not enable native TypeScript by default need
their native type-stripping flag; the distribution checks must verify the
supported Node release matrix.

Add `Emulon.load(config)` and `Emulon.load(directory?)` as configuration-only
SDK entry points. The result exposes `services` registrations without running
setup. Passing a `defineConfig` value preserves its literal instance names and
plugin types. Loading a file returns a validated, dynamically keyed descriptor:
runtime file contents cannot establish compile-time literal types. No generic
type claim is accepted for a dynamically imported file. No `start`, `connect`,
command execution, listeners or control API are implemented here.

The CLI entry is `src/cli/main.ts`. The npm build maps `bin.emulon` to its
emitted JavaScript entry and adds a Node shebang and executable mode. The build
adds the header after emit because dnt can prepend disposable-lib references.
Implement `--version`, `--help`, and `init`; help only lists implemented
commands. `--json` emits one JSON object on stdout on success, or
`{ "error": { "code", "message" } }` on stderr on failure, with exit status 1.
Unknown arguments use `CLI_INVALID_ARGUMENTS`. Exclusive file creation makes
`init` refuse existing files, including symbolic links, with `CONFIG_EXISTS`;
other write errors use `CONFIG_WRITE_FAILED`.

Validate imported default exports with the same rules as `defineConfig`.
Configuration failures use `CONFIG_NOT_FOUND`, `CONFIG_READ_FAILED`,
`CONFIG_IMPORT_FAILED`, or `CONFIG_INVALID`. Do not expose exception messages
from trusted project code or invalid values because they may contain secrets.

## Consequences

Applications can inspect typed configuration without acquiring runtime
resources. Dynamic loading cannot infer static names; callers needing those
types import and pass their configuration. The native module cache means edited
configuration requires a new process. Import-time exceptions, including
`defineConfig` validation thrown inside the imported module, use
`CONFIG_IMPORT_FAILED`.

Archive installation, bin resolution, dependency resolution from installed
packages, and the Node matrix belong to distribution verification; see
[ADR 0005](0005-typescript-build-dependency.md). Package manager integration
(`emulon add`) is now specified in [ADR 0032](0032-plugin-add.md).

A later change introduced temporary in-process CLI dispatch, which the loopback
control API supersedes: the executable now attaches to the running environment
through [ADR 0007](0007-control-api-and-discovery.md). Instance/command help is
generated from the host registry; see the [command contract](../commands.md).
