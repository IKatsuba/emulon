# 0028: One compatibility manifest for every official plugin

## Context

Provider versions and coverage still need a common declaration. GitHub and
Resend already carry different `emulon.compatibility` objects in their
`deno.json`; the npm builder copies them, but running clients cannot query them.
This ADR supersedes the manifest layout in ADR 0008, preserving its actual
compatibility limits and GitHub's later authorization disclosures.

## Options

- Maintain prose, npm metadata and runtime descriptions separately: easy drift.
- Discover routes at runtime: cannot infer supported fields, auth or
  differences.
- Keep one validated declaration and expose it through the command registry.

## Decision

Choose the third option. Each official plugin owns `src/compatibility.ts`, a
JSON-compatible constant validated with the shared Zod schema in
`packages/emulon/src/plugins/compatibility.ts`. Add the optional
`PluginDefinition.compatibility` field and export the `CompatibilityManifest`
type and `defineCompatibility` validator from `emulon`. Contract `apiVersion: 1`
does not mean provider API version. Third-party definitions without the new
field remain valid; all official packages must provide it.

The version-1 manifest has these required fields:

| Field            | Meaning                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | Literal `1`, version of this metadata format                                                                                                                         |
| `plugin`         | Exact package name                                                                                                                                                   |
| `provider`       | Provider name and API family                                                                                                                                         |
| `operations`     | Entries with stable `id`, HTTP `method`, `path`, `surface`, `version`, `auth`, supported input fields, output projection, emitted event types and test case IDs      |
| `versions`       | Named policies: accepted values, header name or unversioned policy, behavior for missing and unknown values                                                          |
| `authentication` | Supported flows, key formats, ownership and unsupported flows; no credentials                                                                                        |
| `events`         | Event key, provider event name, payload version/projection and tests                                                                                                 |
| `webhooks`       | Signing header/algorithm/input, ID and body reuse, success statuses, timeout, retries, redelivery and recovery differences                                           |
| `capabilities`   | Implemented plugin capabilities, equal to the definition                                                                                                             |
| `limitations`    | Explicit unsupported features and intentional deviations with stable IDs                                                                                             |
| `verification`   | `official-client` or `documented-http`, exact client pin when applicable, local suite paths and case IDs, source URLs, retrieval date, `liveProviderCompared: false` |

Keep every existing GitHub limitation and error projection, including
non-expiring user tokens, unsupported refresh and installation-token GET /user
as a local extension. Put provider-specific error tables and other details in an
optional `details` JSON object; normalization must not discard disclosures.
Resend keeps its send-field allowlist, unversioned API, explicit version-header
rejection, no idempotency and manual-only Svix delivery. Baselines are GitHub
`2022-11-28` with `octokit@5.0.5`, and unversioned Resend with `resend@6.28.1`.
The existing seven GitHub route entries and two Resend entries define the
initial inventory; split combined surfaces where necessary. `/health` is an
explicit host probe, not a claimed provider operation. This migration adds no
provider operations or authentication modes.

`defineCompatibility(manifest)` validates and returns immutable metadata.
`definePlugin` adds the declared read-only command `compatibility.get({})` for
definitions with a manifest; CLI path is `compatibility get`, with no input
flags. A collision with a plugin's own command of that name fails validation.
The factory return type must retain this command in inferred SDK types.

```sh
emulon mail compatibility get --json
emulon github compatibility get --json
```

```ts
const manifest = await env.services.mail.compatibility.get({});
```

Both started and connected SDK clients obtain the host's declaration through the
normal registry. This is not a local client's potentially different copy.
Unknown instances use existing errors. Non-JSON CLI output follows the existing
pretty-JSON command convention. These public additions are authorized here;
there is no separate core CLI command, filesystem reader or public subpath.

The build reads the same constant and writes it into generated npm
`package.json` under `emulon.compatibility`. Remove the old handwritten copies
from plugin `deno.json` when migrating. Building must not call plugin setup or
open listeners. Source docs link to the declaration instead of repeating it.

## Verification and consequences

Schema tests reject missing coverage, unknown schema versions, duplicate IDs,
invalid version references and capability/name mismatch. Each plugin maintains
an executable case registry keyed by the manifest's test IDs: equality checks
reject orphan claims and orphan contract cases, and the test runner executes
every referenced case. Assertions cover request fields, response projection,
auth, version rejection, event and signature behavior; a path existing is not
proof. Include a mutation probe that adds an untested operation and fails.

For GitHub and Resend, preserve existing negative cases as well as happy paths.
Compare the normalized object through CLI, started SDK, connected SDK and
installed npm metadata under Node and Deno. Reset does not alter static claims;
credentials and options must never appear in them. Unimplemented future-stage
operations must not appear as supported in an intermediate release. No new
dependency is needed beyond the approved Zod package.
