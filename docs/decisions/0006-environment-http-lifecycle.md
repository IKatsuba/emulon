# 0006: Private environment and HTTP lifecycle

## Context

The first environment lifecycle covers loopback listeners, dynamic ports,
in-memory resources only, rollback and disposal. The design names HTTP context
facilities but leaves their concrete TypeScript signatures open.

## Options

- Let plugins own servers: violates the host resource ownership contract.
- Supply host-managed named surfaces with web-standard handlers.

## Decision

Implement the second option. `Emulon.start(config)` returns `services`,
`endpoints`, `dispose()` and `Symbol.asyncDispose`. Both maps preserve
configured instance names. Endpoints are grouped by instance, then surface name.
Initially, services were empty client placeholders until the shared command
registry was implemented; registrations and plugin instances are not management
clients.

[ADR 0014](0014-hono-http-layer.md) supersedes the original route-array
contract: `ctx.http.surface(name, { maxBodyBytes })` returns Hono directly;
`ctx.http.listen(name)` starts it and returns a loopback URL. Host middleware
bounds actual body bytes (1 MiB by default), drains admitted requests on pause,
and returns 413, 503, redacted 500 and explicit unsupported-route 404 responses.

Each startup calls setup and readiness in configuration order. On failure,
resources unwind in reverse order, including surfaces from a setup that threw.
Shutdown closes provider admission and listeners, aborts connections, and drains
admitted handlers and commands already executing (including output validation)
before stopping plugins; it attempts every cleanup even when another fails.
Repeated disposal shares one promise. Setup/readiness failures name the
configured instance but omit plugin exception content, which may contain
secrets. Plugins remain trusted and must make their lifecycle hooks terminate.

Node uses `@hono/node-server`; Deno uses its native server adapter. Both bind
port 0 on 127.0.0.1. Shutdown aborts network connections rather than waiting
indefinitely for a client to finish sending. Neither adapter opens persistent
storage.

In the first lifecycle slice, Resend exposed only `GET /health` returning
`{"status":"ok"}` on its `api` surface. This is a lifecycle probe, not a Resend
provider operation.

## Consequences

The lifecycle can be exercised through published packages on both runtimes.
Control authorization, command dispatch, storage and provider operations remain
separate work. The current HTTP contract uses Hono routing and parameters; see
[ADR 0014](0014-hono-http-layer.md). Resend provider operations were added
later; see [ADR 0008](0008-resend-reference-surface.md).

Typed clients generated from the shared command registry later replaced those
placeholders; see the [command contract](../commands.md).
