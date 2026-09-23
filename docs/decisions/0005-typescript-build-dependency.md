# ADR 0005: TypeScript as a build-only verification dependency

Status: Accepted. The build-only dependency restriction and internal resolver
probe are superseded by [ADR 0032](0032-plugin-add.md).

## Context

Distribution verification must run a real `tsc --noEmit` against installed
archives. Deno's own type checker and dnt's build checks do not prove that a
separate TypeScript consumer can use the published declarations. Verification
must not fetch a compiler or packages from a public registry.

## Options

- Package an exactly pinned TypeScript compiler from Deno's npm cache alongside
  the distribution archives.
- Run the pinned compiler through Deno's npm support against the fixture, if
  cache packaging proves unreliable.
- Rely only on build-time checks, which would omit consumer verification.

## Decision

Declare `npm:typescript@5.9.3` in the root `deno.json` imports. It was
originally a build-only dependency. ADR 0032 also uses it as a core runtime
dependency for safe configuration parsing; plugins still must not depend on the
compiler.

The build imports the compiler to materialize it in Deno's cache. After building
the packages, `build:npm` runs `deno info --json` for the pinned specifier and
reads its npm package's `localPath`. It uses
`npm pack --offline
--ignore-scripts` in that directory, avoiding assumptions
about cache layout. The resulting `typescript-5.9.3.tgz` sits alongside the
Emulon archives. Missing cache metadata or a failed pack is a build failure.

`verify:dist` copies the archives into a temporary directory outside the
workspace and installs them into separate Node and Deno consumer fixtures. Each
fixture has an empty npm cache, isolated configuration and a private ESM package
manifest. npm uses offline mode with a loopback registry placeholder; Deno uses
an empty cache, manual node_modules, cached-only resolution, no workspace config
and denied network permission. Consumer files contain no workspace source paths.
The compiler runs from the installed local archive under Node for both fixtures,
with strict checking and no skipped library checks.

Update the exact import pin and lockfile together, rebuild the compiler archive,
and run both distribution verification and the repository check before accepting
an update. Never replace the pin with a range.

## Consequences

Developers need Node, npm and Deno for distribution verification. The build can
populate dependency caches; verification consumes only local archives and
removes its fixtures on success or failure. New runtime dependencies must also
be made available offline before verification can pass.

The resolver stays internal and is now reached through `emulon add`. The
installed fixture exercises the public CLI against a loopback archive registry
rather than importing the resolver by an internal path. Installed declaration
tests cover valid SDK configuration, literal instance names and invalid plugin
options.

A run proves the Node and Deno versions printed by the verification command;
testing additional supported Node releases requires rerunning with those
releases on PATH. It does not claim that Resend's provider API is implemented.
