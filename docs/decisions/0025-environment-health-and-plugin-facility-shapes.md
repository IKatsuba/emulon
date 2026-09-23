# ADR 0025: Environment health and plugin facility shapes

Status: Not adopted.

This proposal depended on managed PostgreSQL
([ADR 0023](0023-managed-postgresql.md)), which was removed from scope; it was
not implemented and is kept for reference.

## Context

ADR 0023 requires a read-only `Environment.health` view, declarative
`prerequisites` metadata and a host-managed process/files/TCP facility in
`PluginContext`, without giving their signatures. Public additions the design
does not describe need an ADR, so these shapes are settled here rather than
introduced silently in code.

The concrete question is health observation. One `Environment<Config>` type
serves both `Emulon.start()` and `Emulon.connect()`. ADR 0023 requires a
connected view to refresh through the authenticated control path instead of
reporting the startup snapshot, and a plain synchronous property cannot start
and await that request.

## Options and decision

| Health shape                        | Assessment                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Method returning a promise          | Selected: matches `reset()`/`dispose()` on the same interface, and I/O on a call reads as I/O.              |
| Promise-valued property             | Rejected: a property that performs an authenticated request on every access hides the call from the reader. |
| Synchronous snapshot plus a refresh | Rejected: two ways to read one fact, and the snapshot is the stale value ADR 0023 forbids.                  |
| Subscription or poller              | Rejected: adds a freshness interval and cancellation contract ADR 0023 does not ask for.                    |

Add to `Environment<Config>`:

```ts
export interface EnvironmentHealthFailure {
  readonly instance: string;
  readonly code: "BACKEND_EXITED";
}

export interface EnvironmentHealth {
  readonly status: "ready" | "failed";
  readonly failures: readonly EnvironmentHealthFailure[];
}

health(): Promise<EnvironmentHealth>;
```

`status` is `"failed"` exactly when `failures` is non-empty, so more than one
instance can report a lost backend without a later breaking change. `failures`
is empty and frozen when ready. The union stays closed at `BACKEND_EXITED`;
another failure cause needs its own decision.

Every call re-evaluates. A private environment resolves the current host view
without I/O. A connected environment performs a fresh authenticated control
request; a transport or authentication failure rejects rather than returning an
obsolete healthy value, and a disposed handle rejects. `status` serializes this
same value and stays redacted. No timer, subscription, health event or new CLI
command is introduced.

The structural types for the prerequisite metadata and the process/files/TCP
facility are left to the implementation; they need no further ADR. They are
bound by ADR 0023 and by these constraints: prerequisite metadata is plain
JSON-serializable data, readable from both `PluginDefinition` and the callable
factory without running setup, and sufficient for `emulon <instance> --help` to
render from configuration alone; the facility exposes portable specifications
and owned handles only, with no `node:*` or `Deno.*` type in the public surface.
Both are documented as public additions in `docs/design.md`, beside the ADR 0023
reference.

## Consequences and verification

No new dependency, CLI command or confirmed product decision changes. Tests
cover a ready view, a view after `BACKEND_EXITED`, a connected view refreshing
after the private side fails, rejection on a broken control path instead of a
stale healthy answer, rejection after disposal, and redaction of the serialized
health in `status`. Prerequisite metadata is verified through `--help` without a
running environment, as ADR 0023 already requires.
