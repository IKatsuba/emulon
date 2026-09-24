# emulon

Emulon provides local third-party services (GitHub, Stripe, Resend, Cal.com,
Polar, ...) for application development and testing, driven by one CLI and one
typed SDK over the same command contract. `docs/design.md` is the
specification: read it before changing anything, and treat a disagreement
between code and design as a question, not as permission to pick one.

These rules apply to every contribution, by people and by coding agents alike.
`CONTRIBUTING.md` describes the workflow.

## Rules

- **Deno for development, npm for distribution.** Dependencies are declared in
  `deno.json` imports (`jsr:` / `npm:`); there is no `package.json` in the
  source tree and no other package manager. The published npm packages must
  run on Node without Deno installed, so runtime-specific APIs (`Deno.*`,
  `node:*`) live only behind the runtime adapters in
  `packages/emulon/src/runtime/`. Everything else uses web-standard APIs.
- **Versions are exact everywhere.** `deno.json` imports, npm dependencies and
  plugin peer dependencies name one version, never a range (`^`, `~`, `*`, a
  bare major). Plugins peer on the exact `emulon` and Hono versions they are
  released with, so an install never mixes two copies.
- **Layout follows `docs/design.md`, "Proposed implementation layout".**
  `packages/emulon` is the CLI, SDK and plugin API; `packages/<service>` are
  the official `@emulon/<service>` plugins.
- **`deno task check` must pass.** It runs type checking, lint, formatting,
  tests, npm archive builds and offline installed consumer verification under
  Node and Deno. Deno, Node and npm must be on PATH; the first build may fetch
  dependencies. See `docs/distribution.md`.
- **Everything is in English**: identifiers, comments, doc comments, test
  names, error messages, CLI output, documentation, commit messages and pull
  requests. A comment answers why, not what.
- **Docs describe the project, not its history.** No issue-tracker ids,
  internal task numbers, review or QA status, or names of who decided what in
  code, docs, ADRs or commit messages. Link to an ADR or a document instead.
- **Significant decisions are ADRs.** A new dependency, a public API change or
  an architectural choice is recorded in `docs/decisions/NNNN-title.md`
  (context, options, decision, consequences) and committed with the change
  that needs it. Prefer `jsr:@std/*` and small, well-maintained packages.
- **The public API is what the design shows.** A public export or CLI command
  the design does not describe needs an ADR, not a silent addition.
- **Rules live in tested modules.** Validation, signature computation, token
  checks, permission intersection, retry schedules, delivery state machines
  and plugin-name resolution are pure functions with tests.
- **Secrets never leak.** Tokens, keys and authorization headers are redacted
  from logs, status output and inspection; use secure randomness for anything
  an attacker could guess.
- **Tests never reach a real provider or the public network.** Local servers
  on loopback with dynamically allocated ports, fixtures and fake clocks.
  Anything that needs a live account is checked by hand and described in the
  pull request.
- **Commits are small and self-describing.** Short imperative subject, a body
  that explains why when it is not obvious, and no trailers.
