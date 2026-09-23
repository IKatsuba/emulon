# 0008: Resend reference surface

## Context

The first Resend slice covers send/read compatibility, local credentials,
fixtures, inspection, cleanup and an outbox without delivery. This records
concrete names for that scope; it does not change confirmed product decisions or
settle deferred storage and delivery choices. The official `resend` client is
only an exactly pinned development dependency for tests, so it is recorded here
rather than in a separate dependency ADR.

## Options

- Put state and credential helpers on arbitrary SDK objects.
- Declare inspection, cleanup and credential issuance in the shared registry;
  reuse the environment lifecycle for complete reset.

## Decision

Use the registry. `emails.list({})`, `emails.get({ id })`, `emails.clear({})`
and `keys.create({})` map to the same CLI paths, with `--id` for reads. Empty
input objects may be omitted in both started and connected SDK clients. Reads
return an email or null; list returns an array. Clear returns `{ deleted }` and
retains event history and keys. Only the explicitly requested `keys.create`
response exposes its generated `{ apiKey }`; status and inspection never do.

`resend({ fixtures: { emails: [...] } })` accepts send inputs with an optional
UUID `id`. Fixtures create state without events. Environment reset restores the
startup snapshot, empties the outbox and removes all issued keys. `emulon reset`
uses the same existing `/reset` lifecycle operation as `env.reset()`; lifecycle
commands remain host-owned, outside service command registries. Clear is not a
substitute for reset.

Provider endpoints use bearer keys, UUID resource IDs, a single atomic
email/event transaction and generation-scoped stores. All randomness comes from
Web Crypto. State uses schema version 1 and plugin version 0.1.0. Events are
`email.sent` with origin `service`; no dispatcher or actual email delivery runs.

[ADR 0014](0014-hono-http-layer.md) replaces the original manual route matcher
with Hono. Resend registers separate `.post("/emails", ...)` and
`.get("/emails/:id", ...)` handlers and reads IDs with `c.req.param("id")`.
Authentication and version checks are shared route middleware. Unknown routes
retain the explicit host `404 Unsupported route` response; `/health` remains a
lifecycle probe.

The compatibility manifest ships in npm package metadata under
`emulon.compatibility`, alongside contract version and capabilities. Resend's
unversioned API is the only claimed version. Explicit `Resend-Version` and
`X-API-Version` headers receive unsupported responses. The implemented send
fields are from, to, subject, html, text, cc, bcc and reply_to. Unknown fields
and idempotency keys fail explicitly. No automatic text rendering is claimed.

The official `resend@6.28.1` constructor accepts `{ baseUrl }`. Tests pass the
loopback endpoint directly, never patch fetch or contact a provider. The root
import map and lockfile pin this test dependency; production modules never
import it, and the npm builder strips dev dependencies. Tests set an explicit
user agent and allow only `NODE_ENV` environment access because the official
client reads that variable when reporting error responses. Network access
remains limited to loopback.

## Consequences

This is a bounded compatibility claim, not full Resend equivalence. Invalid keys
use the provider's 403 `validation_error`; missing keys use 401
`missing_api_key`. Unsupported operations and email fields cannot silently reach
a remote provider. The pure input and token rules and host HTTP middleware have
independent tests; contract tests exercise the official client, control CLI, SDK
and outbox failure.

Protocol references:
[send email](https://resend.com/docs/api-reference/emails/send-email),
[retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email),
[errors](https://resend.com/docs/api-reference/errors),
[official SDK](https://github.com/resend/resend-node).

## Subsequent queue implementation

[ADR 0010](0010-subscriptions-and-dispatch.md) adds subscription state and a
transactional dispatcher, superseding the no-dispatcher boundary above. Resend
uses schema version 2. Sending and durable process recovery remain deferred.
