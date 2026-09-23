# ADR 0018: GitHub App authentication

Status: Accepted.

## Context

The GitHub scaffold creates RSA keys and installation grants. The GitHub App
authentication slice needs App JWT verification and installation access tokens
without public-network tests. The next slice consumes installation credentials
when creating issues.

## Options

- Add a JWT dependency or verify the narrowly supported RS256 format with
  WebCrypto.
- Encode installation grants in signed tokens or retain opaque random tokens in
  the instance store.

## Decision

Use WebCrypto RSASSA-PKCS1-v1_5 with SHA-256 and the app's SPKI public key.
Accept app IDs (string or numeric) and client IDs as issuers. Reject unsupported
algorithms, malformed claims, unsupported critical headers, invalid signatures,
future issuance, expired assertions and expiry more than 600 seconds ahead.
Claims are integer seconds; expiry is exclusive. Signature verification precedes
time diagnostics. A key from another app and a damaged signature have the same
failure: neither proves the claimed identity.

Generate installation tokens using 32 securely random bytes with a `ghs_`
prefix. Store them under unrelated random row IDs in the protected `tokens`
collection. Compare equal-length strings using a full XOR loop, following the
Resend key check (JavaScript does not guarantee machine-level constant time).
Never include credentials in errors or ordinary status. The explicit issuance
response is the only provider response containing the token.

Authenticate, inspect ownership and suspension, narrow grants, and persist the
issued token in one transaction. Requests can select repository names or numeric
IDs, but not both. Omitted permissions/repositories use all current grants;
empty selections stay empty. Grants can only narrow installation permissions and
repositories. Tokens expire after exactly 3,600,000 milliseconds. The internal
`authenticateInstallation` helper runs in the caller's transaction, checks
expiry and installation identity, and intersects with current installation and
grant state. Resource-specific permission checks belong to the issues slice
([ADR 0019](0019-github-issues.md)).

Expose the design's `PluginContext.clock.now(): number` as epoch milliseconds.
The host currently supplies wall time; tests replace this facility with a
controlled clock through a plugin wrapper. No virtual-time capability or public
clock-advance command is claimed by this slice. Scheduling and host-wide virtual
time remain future work. No plugin option, management command or package export
is added.

Keep state schema version 1: this is an additive collection with no changed
existing persisted record shapes. Reset removes credentials with all generated
state, and generation-scoped transactions prevent stale issuance commits.

## Consequences and compatibility evidence

The original manifest declared the three API routes (now migrated to
`packages/github/src/compatibility.ts` by ADR 0028), supported version, error
mapping and explicit deviations. Provider IDs are serialized as numbers; command
IDs remain strings. Unsupported web routes still return 404. JWTs never
authorize management operations.

Sources read on 2026-09-21:

- [GitHub JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app):
  algorithm, issuer and ten-minute expiry boundary.
- [GitHub Apps REST API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app):
  one-hour tokens, repository/permission narrowing and 201/401/403/404/422
  statuses.
- [REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api):
  parsing, permission and version errors and private-resource concealment.

The documentation does not specify exact bodies for each JWT failure or
suspended installation. The manifest explicitly labels these local diagnostic
contracts, not live-provider-verified equivalence. Expired and unknown
installation tokens both return 401 Bad credentials; a known token used for
another installation returns 404 Not Found. Distinct causes do not imply
distinct provider responses. Local tests lock status and body, exercise
app-created keys over loopback, advance the controlled clock, remove current
grants, and check instance/environment/reset isolation. No live account or
public network is used by tests.

Follow-up: [ADR 0019](0019-github-issues.md) adds installation-authenticated
issue creation and the local installation-principal route to the manifest.
