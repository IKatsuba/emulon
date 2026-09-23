# ADR 0022: GitHub local consent and authorization codes

Status: Accepted.

## Context

GitHub App user authorization needs a browser half. The existing GitHub plugin
already owns separate `api` and `web` listeners, fixture users and User
accounts, and installation grants. User authorization must not turn those
installation grants into user grants. Code exchange is a separate step
([ADR 0024](0024-github-user-tokens.md)).

## Options

- Reuse the host's Hono surfaces and transactional store.
- Add an independent web server, session framework or separate persistence.

## Decision

Use the same Hono assembly, middleware, reset fence and environment lifecycle as
`api`, with the independent `web` port already published in discovery. No new
dependencies or runtime-specific plugin APIs are introduced.

`GET /login/oauth/authorize` accepts `client_id`, optional `redirect_uri`, and
optional `state`. Callback matching is exact; omission selects the first
registered callback. This slice supports HTTP(S) callbacks without credentials
or fragments. Unsupported callback schemes are a declared limitation. `login`
can preselect a fixture identity. `allow_signup` and `prompt` do not change the
local picker; no signup or authenticated GitHub session is emulated. PKCE and
OAuth `scope` parameters are explicitly rejected rather than silently weakened.

The page identifies itself as local consent and lets the developer choose a
fixture user, repository subset and per-permission read/write level bounded by
the app registration. Empty selections grant no access. Repository selections
model the fixture user's local rights; they need not be owned by that user's
account or installed on the app. This is test setup, not proof of provider
membership. Code exchange and user token access must intersect these rights with
current app/installation rights before permitting resource access.

`POST /login/oauth/consent` is an explicitly local form endpoint. A random,
ten-minute, single-use form secret binds the original client, callback and state
in transactional state. Posting arbitrary client/state/callback fields cannot
replace that binding. Cross-origin submissions with an Origin header are
rejected; the secret protects submissions without Origin. Pages are uncacheable,
do not load scripts or external assets, prohibit framing and send no
cross-origin referrer. Form redirects allow only the web origin and the
validated callback origin in CSP. All dynamic markup is escaped.

Add the authenticated command `authorization.approve` (CLI
`authorization
approve`) with
`{ clientId, redirectUri?, state?, login, repositories,
permissions }`,
returning `{ code, redirectUrl, expiresAt }`. This is dedicated secret output
for headless fixture consent, not GitHub's device flow or a provider API. The
CLI and SDK share the schema and handler; the browser uses the same domain
operation. It does not make a callback HTTP request: the caller follows
`redirectUrl` or uses `code`.

Keep installation `grants` unchanged. Add `userGrants`, keyed by app/user pair,
`authorizationCodes`, and `authorizationSessions`. All live in the existing
instance transaction store and are cleared by reset. Codes and session secrets
use 256 bits of secure randomness; only their SHA-256 lookup hashes persist. An
authorization code records the exact client ID, callback, ten-minute expiry,
nullable consumption time, and immutable grant snapshot (including app/user IDs,
repository names and permissions). A later approval replaces the current user
grant, without broadening an already issued code. Ordinary status and inspection
do not expose these rows or secrets.

The internal `consumeAuthorizationCode` operation checks binding, expiry and
consumption, then marks the code consumed in the caller's transaction. Code
exchange must issue its token in that same transaction; failure rolls
consumption back. There is no public exchange or test-only code-consume command
in this slice.

The schema version stays 1: this is additive storage with no changed existing
record shape or required new rows at startup. Existing version-1 databases open
unchanged; new collections start empty and persist on first authorization.
Migration support is not introduced.

## Browser failure contract and evidence

- Unknown client ID: local 404 HTML page, no redirect to an untrusted callback.
- Callback mismatch: 302 to the first supported registered callback with
  `error=redirect_uri_mismatch`, description, documentation path and the
  original state. Missing/unsupported default callback: local 400 HTML page.
- Denied consent: 302 to the selected callback with `error=access_denied`,
  description, documentation path and the original state; no code or grant.
- Invalid, expired or reused local form: 400; cross-origin form: 403.

GitHub documents callback selection and state return for
[GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
The redirect error categories follow GitHub's
[authorization request errors](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors).
That error page describes OAuth Apps; applying those browser categories here is
an explicit compatibility choice, not a live GitHub App comparison. The
unknown-client page text and local form errors are local contracts. Ten-minute
code lifetime follows the documented
[web authorization code flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Consequences and verification

The browser works without a management credential and cannot invoke arbitrary
commands. Fixture identity selection is intentional local impersonation.
Organization membership, login sessions, PKCE, user tokens, refresh and token
exchange remain unsupported. Tests use dynamic loopback callbacks and an
internal controlled clock; they cover CLI/SDK output shape, persistence across
restart, exact expiry, failed binding, concurrent consumption, form denial,
isolation and reset. Public replay at the exchange endpoint is verified with
code exchange.

## Subsequent implementation

[ADR 0024](0024-github-user-tokens.md) completes code exchange and user token
access. Earlier references to these features as deferred describe the boundary
of this original slice.
