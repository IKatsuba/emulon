# ADR 0027: Include npm distribution in the mandatory check

## Context

Deno accepted destructuring an event follow error from `Response.json()`, while
the TypeScript compiler used by dnt treated the result as unknown and rejected
the build. The mandatory `deno task check` passed even though no npm
distribution could be built. The gate must catch npm build failures.

## Options

- Add only `build:npm` to `check`: catches compiler and packaging failures but
  leaves installed consumer verification outside the mandatory gate.
- Introduce a separate mandatory distribution gate: preserves a shorter check
  but requires every contributor to remember another command.
- Include both archive building and installed verification in `check`.

## Decision

Choose the third option. Keep `deno task check` as the single mandatory command
before a change is handed on. After source type checking, lint, formatting and
tests, run `deno task build:npm` and then `deno task verify:dist`, sequentially
with failure propagation.

Build all three packages (emulon, Resend and GitHub), including dnt's TypeScript
checks and npm packing. Verify those fresh archives in isolated offline Node and
Deno consumers using the existing verifier. Do not accept stale archives as
evidence for a source change. Preserve both distribution tasks for focused work
and explicit runtime matrix checks.

Type the event follow error envelope with the existing
`ReturnType<CommandError["toJSON"]>` contract, matching the ordinary control
client. This fixes the compiler mismatch without changing runtime behavior or
introducing a public API, dependency or new protocol validation policy.

## Consequences

Every full check now requires Node and npm as well as Deno and takes longer.
Build dependency acquisition may require network access with a cold cache;
consumer verification remains offline and tests use local fixtures and loopback.
Generated distribution files remain ignored. A failed build stops the gate
before verification, and a failed installed consumer also fails the gate.

A local pass proves only the runtime versions printed by the verifier, not the
entire supported release matrix. Release matrix instructions remain in
[distribution verification](../distribution.md).

To reproduce the original regression, temporarily replace the typed
`response.json()` expression in `packages/emulon/src/events/client.ts` with
`const { error } = await response.json();` and run `deno task check`. The source
checks pass but the npm build must fail with TS2339. Restore the typed envelope
and rerun the same command; all stages must pass.
