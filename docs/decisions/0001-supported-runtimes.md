# 0001: Supported runtimes

Status: Accepted.

## Context

Emulon uses Deno for development and distributes npm packages that must work
without Deno installed. The project needs explicit runtime targets before the
npm build and configuration loader are selected.

## Options

- Require Deno for both development and consumption.
- Develop with Deno and publish portable packages for supported Node versions.

## Decision

Develop on Deno >= 2.9. Target Node >= 22.13.0 for npm distribution, checking
active LTS and current Node releases in distribution verification. Use
web-standard APIs outside `packages/emulon/src/runtime/`; isolate `Deno.*` and
`node:*` runtime operations behind adapters there. Deno's test registration API
is used only by the test harness, outside shipped source.

## Consequences

Library imports and configuration construction must not create runtime
resources. The npm build tool, executable packaging, configuration loading, and
clean Node installation checks are separate decisions (ADRs 0003, 0004 and
0005); this decision alone does not prove npm portability. The repository has no
source `package.json` or second package manager.

ADR 0016 refines the original Node >= 22 target to >= 22.13.0 for built-in
SQLite without an enablement flag. Node 22.0 through 22.12 are unsupported.
