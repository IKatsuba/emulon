# 0014: Hono HTTP layer

## Context

The HTTP layer moves to Hono before the GitHub slice. This ADR records that
migration and both of its dependencies. Manual routing forced plugins to parse
paths again, while the custom Node bridge had already needed URL origin and
multiple-cookie fixes.

## Options

- Extend the manual router and Node request/response bridge.
- Expose Hono directly and use its maintained Node adapter.

## Decision

Use `hono@4.13.8` and `@hono/node-server@2.0.12`, pinned in the Deno import map
and lockfile. Core has runtime dependencies; plugins declare `hono` as a peer
alongside `emulon`. The build packs both dependencies for offline consumer
verification, with no workspace resolution.

`ctx.http.surface(name, { maxBodyBytes })` synchronously creates and returns a
plain Hono instance. Names must be unique and nonempty. Plugins register routes
with `.get()`, `.post()` and other Hono methods, accessing path parameters with
`c.req.param()`. `await ctx.http.listen(name)` starts the registered surface
once and returns its loopback URL. Separating creation and listening lets the
plugin finish registration before accepting requests. The host owns cleanup,
including setup rollback. No wrapper is placed around the returned Hono.

Before returning a surface the host installs:

1. A redacted `onError` response (500) and explicit `notFound` response
   (`404 Unsupported route`).
2. Lifecycle middleware rejecting paused or closed contexts with 503 and
   tracking admitted requests through middleware and handler completion.
3. Body middleware counting actual streamed bytes, returning 413 above the
   configured limit (1 MiB by default), and supplying the buffered request body
   to downstream handlers.

Pause waits for admitted requests, including body reads; resume admits new
requests unless closed. Stop closes admission and listeners, aborts network
connections, and waits for admitted middleware and handlers to finish before
releasing ownership (ADR 0016). Tracking covers handler completion, not
consumption of a streaming response. Plugins are trusted in-process code and
must not replace host error handlers or otherwise bypass these facilities.

Deno uses the native server with `app.fetch`; Node uses `@hono/node-server`
inside the runtime adapter. Both bind `127.0.0.1` on port 0. The old manual Node
bridge and route matcher are removed. Control API routing also uses Hono,
retaining its authentication middleware and command error envelope.

## Consequences

Routing follows Hono semantics, including decoded parameters and implicit HEAD
handling for GET routes; exact routes should be registered before overlapping
parameter routes. The control event-follow handler returns NDJSON headers for
HEAD without allocating a subscription: Hono discards HEAD response bodies
without cancelling their streams. GET following retains cancellation on client
disconnect. The previous custom encoded-separator rejection and manual
exact-route prioritization are no longer routing contracts. Resend looks up
decoded IDs in its instance store, whose email resources use UUIDs, and does not
parse paths. Provider operations, command parity and webhook behavior remain
unchanged.

Tests cover body bounds, middleware ordering, pause/drain/resume, retained
surfaces after stop, redacted errors, path parameters and listener ownership.
Existing URL-port and multiple Set-Cookie regressions run for both adapters and
from installed archives under Node and Deno.

References: [Hono Node adapter](https://hono.dev/docs/getting-started/nodejs),
[Hono routing](https://hono.dev/docs/api/routing).
