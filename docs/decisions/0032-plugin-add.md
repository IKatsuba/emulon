# ADR 0032: Install plugins and conservatively extend configuration

Status: Accepted.

## Context

The design requires `emulon add <name>...` to install dependencies, update the
project lockfile, validate plugin metadata and preserve existing instances. The
configuration is executable TypeScript; rewriting arbitrary user programs is
unsafe. Full package names must remain unchanged.

## Options

- Infer the manager from the current CLI runtime, or from project lockfiles.
- Use regex insertion, reprint an entire AST, or insert text only at positions
  recognized by a parser.
- Add a small parser dependency or reuse the pinned TypeScript parser already
  used for distribution verification.

## Decision

Resolve unqualified names to `@emulon/<name>`, keep `community:<name>` as
`emulon-plugin-<name>`, and accept scoped package names and unscoped
`emulon-plugin-*` package names unchanged. Preserve optional versions/tags. This
replaces the proposed scoped-name prefix insertion in the original design table;
it does not change the confirmed official-name convention. Paths, URLs, flags
and shell syntax are not package names. Reject conflicting versions in one call.

Inspect only the requested project directory. Select npm for `package-lock.json`
or `npm-shrinkwrap.json`, pnpm for `pnpm-lock.yaml`, Yarn for `yarn.lock`, Bun
for `bun.lock`/`bun.lockb`, and Deno for `deno.lock`. Lockfiles from multiple
managers are an error before installation. Without a lockfile, prefer npm for
`package.json`, Deno for `deno.json`/`deno.jsonc`, otherwise npm. Do not guess a
workspace ancestor or override manager selection based on the running runtime.

Invoke the manager directly without a shell: npm `install --save-dev`, pnpm
`add --save-dev`, Yarn and Bun `add --dev`, Deno
`add --node-modules-dir=auto npm:<package>...`. The manager owns manifests,
lockfile changes and installation policy. Deno's local node_modules mode makes
installed npm metadata available to both runtimes. Install output is suppressed
because registry errors can include credentials; on failure emit
`PLUGIN_INSTALL_FAILED` naming the manager. Installed packages and lockfile
changes are retained if later validation fails; no rollback of
package-manager-owned files is promised.

Read installed package metadata relative to the project through the runtime
adapter. Require matching package identity, `emulon.apiVersion: 1`, and a
loadable default factory. Read metadata from node_modules without requiring a
package.json export. A temporary project-local ESM re-export module selects
native import conditions; remove that helper after loading, including on import
errors. Validate all requested packages before changing the configuration.
Loading plugins is trusted code, like loading configuration; `add` never calls
their setup or starts an environment.

Promote the existing exact `typescript@5.9.3` dependency to a core runtime
dependency for AST parsing, superseding ADR 0005's build-only restriction.
Plugins do not depend on TypeScript. Load the add implementation only when the
CLI selects `add`. Tests allow TypeScript's `TSC_*` and inspector environment
reads during parser initialization; no watcher is started.

Use the AST to recognize imports followed by exactly one default export of
`defineConfig({ services: { ... } })`, including an aliased `defineConfig`
import from `emulon`. The top-level object must contain only the one literal
services property. Every existing service must be a unique static property
invoking a default-imported factory directly. Preserve factory options and
multiple existing instances without reprinting their code. If any instance uses
the requested package, do not add another. Generate collision-free import
bindings and instance names; avoid reserved core command names and the literal
`__proto__` prototype setter by appending `Service` before resolving collisions.
Insert new imports and properties at AST boundaries, preserving every existing
byte.

Extra statements, spreads, computed keys, indirect configuration, duplicate
keys, syntax errors and unrecognized structures require manual configuration.
Missing configuration is an error suggesting `init`. Symlinks, non-regular files
and hard links are not edited. Before writing, recheck the file type and
original content; a concurrent change produces `CONFIG_CHANGED`. This is an
optimistic check, not an atomic transaction with an editor or package manager.

Manual configuration is a successful installation: text output prints exact
imports and services entries; JSON returns `configuration: "manual"` and an
`additions` array with `package`, `instance`, `import`, `service`. Automatic
results use `"updated"` or `"unchanged"`. All success objects include `manager`
and resolved `packages`. Errors use the existing CLI error envelope and nonzero
exit.

## Consequences

The conservative grammar deliberately asks for manual edits for some valid
TypeScript programs. Installation cannot discard instances or rewrite user code.
The compiler increases core installation size, but avoids another parser and
keeps existing source formatting intact.

Pure tests cover manager selection, argument construction, metadata, insertion,
identity preservation, collisions and fallback. Installed verification runs a
loopback npm registry serving only freshly built GitHub/Resend archives. A clean
fixture installs core and transitive archives, runs init/add, checks dependency
and lockfile changes, repeat add, up/down, actual GitHub/Resend CLI commands
against the connected SDK, and unchanged unsafe configuration with exact manual
instructions. Both Node without Deno on PATH and Deno run this scenario. A later
check extends this proof to installed pnpm, Yarn Classic, Bun and Deno package
managers in separate clean projects with isolated dependency caches and a
loopback registry serving the complete archive graph. Missing executables are
reported explicitly. Workspace/PnP support is not established by these checks.
