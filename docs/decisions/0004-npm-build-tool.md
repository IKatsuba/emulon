# ADR 0004: Build npm archives with dnt

## Context

Distribution needs independent npm archives for `emulon` and `@emulon/resend`,
including JavaScript, declarations, an executable CLI and plugin metadata. The
built-in `deno pack` was tried first, and the tool was selected by clean Node
installation.

## Options

- `deno pack`, the built-in archive builder.
- `@deno/dnt`, followed by `npm pack` on generated output.

## Decision

Use `jsr:@deno/dnt@^0.43.2`, declared in the root import map and locked in
`deno.lock`. Add `npm:@types/node@^22.20.4` as a build-only dependency to check
the runtime adapter against Node declarations. Neither dependency is shipped.

On Deno 2.9.7, the first experiment was:

```sh
deno pack -c packages/emulon/deno.json -o /tmp/emulon-probe.tgz
```

It exited with
`Invalid package name 'emulon'. Package name must be in the format
'@scope/name'`.
It produced no archive to install. Renaming the primary package would contradict
a confirmed product decision. We selected the dnt fallback instead of adding
temporary package renaming to the built-in builder.

`deno task build:npm` builds ESM with adjacent declarations into ignored
`dist/npm/`, then uses `npm pack --ignore-scripts` to create the archives there.
The existing CLI uses top-level await; no CommonJS distribution is promised.
Explicit `types` and `import` export conditions describe the public root. The
bin retains its Node shebang and is marked executable before packing.

Build core first. Map the plugin's `emulon` import to a peer dependency, and
install the freshly built core archive as a build-only dependency for the
plugin's declaration checking. Remove build dependencies and scripts from the
published manifests. Only emitted ESM files and declarations are packaged; the
plugin retains `emulon.apiVersion` and its configured peer range.

No Deno shims are enabled: the current runtime adapter uses Node built-ins. The
build requires Deno, Node and npm; npm installs build dependencies but never
publishes. Lifecycle scripts and npm audit/funding requests are disabled during
the build. Tests remain separate and do not access the public network.

## Verification

Verified with Deno 2.9.7, Node 24.13.0 and npm 11.6.2. The core archive
contained 22 files; the plugin contained only its manifest, ESM package marker,
JavaScript entry and declaration entry. Inspected every archive file: no `jsr:`,
`npm:`, `file:`, `workspace:`, absolute workspace path or `Deno.*` reference
remained. The core bin had a Node shebang and executable mode. Both root type
targets existed, and dnt type-checked both emitted packages, including the
plugin against the packed core declarations.

When this tool was selected, neither package had runtime dependencies beyond the
plugin's core peer. `npm ls --all` in the clean fixture showed exactly two
packages with one deduplicated core. Thus there were no additional transitive
runtime dependencies or consumer registry configuration to validate at that
revision. This finding must be revisited when runtime imports are added; a
successful transpilation alone does not prove portability.

Repeat the installation smoke check from the repository root (the cache and
fixture are fresh; npm is offline and its registry points at unused loopback):

```sh
deno task build:npm
archive_dir="$PWD/dist/npm"
fixture_dir=$(mktemp -d)
cd "$fixture_dir"
printf '{"private":true,"type":"module"}\n' > package.json
touch empty.npmrc
npm install --offline --ignore-scripts --no-audit --no-fund \
  --cache "$fixture_dir/cache" --userconfig "$fixture_dir/empty.npmrc" \
  --registry http://127.0.0.1:1 \
  "$archive_dir/emulon-0.1.0.tgz" "$archive_dir/emulon-resend-0.1.0.tgz"
npm ls --all
./node_modules/.bin/emulon --json --version
./node_modules/.bin/emulon --json init
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { Emulon, defineConfig } from "emulon";
import resend from "@emulon/resend";
const mail = resend();
const env = await Emulon.load(defineConfig({ services: { mail } }));
assert.equal(env.services.mail, mail);
assert.deepEqual((await Emulon.load()).services, {});
console.log("Installed SDK, plugin and native config loading passed");
JS
```

Observed CLI output was `{"version":"0.1.0"}` and
`{"created":"emulon.config.ts"}`; the SDK check passed. No provider requests
were made. This is the tool-selection smoke check, not the full Node/Deno
consumer matrix; [ADR 0005](0005-typescript-build-dependency.md) adds that
matrix, including consumer type checks.

## Consequences

Distribution needs a separate build tool and build-time Node declarations, while
the source workspace remains Deno-managed without a source `package.json`. Build
output is disposable and replaced on each invocation. Releases must pass the
installation checks again when changing dependencies, runtime adapters or
package entry points. Supporting CommonJS would require a separate decision and
verification rather than silently adding another output format.

Follow-up: commands now import Zod at runtime (ADR 0002). Distribution
verification installs its resolved archive offline alongside the core and
plugin; the original no-runtime-dependencies finding above applies only to the
revision at which this tool was selected.
