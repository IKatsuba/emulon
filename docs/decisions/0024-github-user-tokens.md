# ADR 0024: GitHub App user access tokens

## Context

This decision completes the authorization code flow started by local consent
([ADR 0022](0022-github-local-consent.md)). It reuses the installation slice's
opaque token format and storage, with a distinct user principal. OAuth Apps,
PATs and device flow are outside this slice.

## Options and decision

Support non-expiring GitHub App user tokens only. Expiring tokens and refresh
rotation would require another lifecycle and are deferred. Explicit refresh or
device grant requests return `unsupported_grant_type`; no token is issued.

Add `clientSecret` to the dedicated `apps.create` secret result, beside
`privateKey`. Generate 256 random bits and persist it with the protected app
record. Ordinary app projections omit both secrets. Old app records without a
secret still support installation authentication but cannot exchange codes;
create a new app to use this flow. No public credential retrieval API is added.

On the web surface, `POST /login/oauth/access_token` accepts JSON or URL-encoded
fields: `client_id`, `client_secret`, `code`, and optional `redirect_uri`.
Omitted redirect uses the code's bound callback. An explicit redirect must match
exactly. Optional `grant_type=authorization_code` is accepted. Respond with JSON
when Accept contains `json`, otherwise URL-encoded data. XML is unsupported.
Success returns `access_token`, `token_type=bearer`, and empty `scope`; there
are no expiry or refresh fields. All responses disable caching.

Repository narrowing through `repository_id` is not implemented. Reject any
presence of this parameter (including an empty value) with HTTP 400
`invalid_request` and description
`The repository_id parameter is not supported.` before credentials or code
lookup. Use the negotiated JSON/form response without an `error_uri`. This is an
explicit local unsupported-feature response, not a claim that GitHub rejects
this parameter. Rejecting it rather than silently issuing broader access
preserves the caller's requested security boundary; no token is inserted and the
code remains usable without the parameter.

Client credentials are checked before code lookup for supported requests. Wrong
credentials return `incorrect_client_credentials`; wrong redirect returns
`redirect_uri_mismatch`; unknown, foreign-client, expired and consumed codes
return `bad_verification_code`. These OAuth errors use HTTP 200, including the
explicit unsupported grant error. Malformed bodies return HTTP 400
`invalid_request`. Code consumption and token insertion share one transaction,
including under concurrent exchange. Failed validation does not consume the
code.

The error categories and descriptions follow GitHub's
[token request error documentation](https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors).
That document describes OAuth Apps; reuse for GitHub Apps and HTTP status
choices are this emulator's compatibility contract, without a live-provider
comparison. The non-expiring mode follows the optional expiry configuration
described in
[GitHub App user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

## Model and access

Store both kinds in `tokens`, using the same random ID, plaintext protected
storage and constant-time same-length comparison as installation tokens. New
installation rows have `kind=installation`; legacy rows without kind retain
installation meaning. User rows have `kind=user`, a `ghu_` prefix, 256 random
bits, app/user/grant IDs, and the immutable code's repository/permission
ceiling. User rows never pass installation authentication. The schema version
remains 1: legacy records remain valid and no migration is needed.

`GET /user` returns the fixture User for user tokens and retains the explicit
App Bot extension for installation tokens. User issue authors and event senders
are Users. User events omit an installation principal. Management behavior is
unchanged.

Each user resource request intersects the token ceiling, current user grant,
current app permissions, and the current installation and installation grant for
that repository. Suspension rejects access. Missing repositories return 404;
missing write permission returns 403. Consent selections represent fixture user
rights, including cross-owner access; provider membership management is not
implemented. Reapproval can narrow existing tokens but cannot broaden their
original ceiling. Removing the user grant invalidates the token, including
`GET /user`. Reset removes all generated credentials. Durable storage retains
them across restart.

## Consequences and verification

No new dependency or exported command is needed. Tests cover public exchange,
replay races, expiry boundary, failed credentials/callback without consumption,
JSON/form encoding, user identity, both directions of resource denial, live
permission narrowing, suspension, principal separation, isolation, reset,
durable restart and secret-free status. The installation-token tests remain
regression coverage; official user-client verification and the complete example
are described in [ADR 0021](0021-github-official-client.md). That contract
verifies non-expiring user tokens; expiring user-token issuance and refresh
remain deferred.
