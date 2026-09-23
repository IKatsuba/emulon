# ADR 0019: GitHub issue creation and current installation access

Status: Accepted.

## Context

The first GitHub business operation needs installation authorization on every
request and an atomic issue/event commit. GitHub App authentication
([ADR 0018](0018-github-app-authentication.md)) already provides opaque tokens,
current grant intersection and provider error responses. This slice uses pure
access rules, repository-local numbering, local web URLs and the existing
transactional adapter without new dependencies.

## Options

- Trust the issuance-time token scope, or intersect it with current installation
  and grant state inside the resource transaction.
- Write issues and events separately, or commit both through the existing state
  transaction.

## Decision

Use `authenticateInstallation` to resolve the credential's installation and
intersect its token scope with both current installation and grant records. Keep
explicit installation-ID matching available for callers that already know an
installation. The pure `requireIssueWrite` function conceals absent or
inaccessible repositories with 404 before checking `issues: write` (403).
Suspension is checked on every request (403); unknown and expired tokens
are 401. The same app can have several installations: a token for one does not
inherit another installation's repositories.

`POST /repos/:owner/:repo/issues` accepts a nonempty string title and optional
string body. Repository names are case-insensitive. Unsupported input fields
return 422 instead of pretending to implement labels, milestones or assignees.
The response is a provider-shaped partial issue projection with numeric IDs,
repository-local numbers, timestamps, author and local API/web URLs. The web URL
is an address on the local web surface; rendering that page is not implemented.

Store each issue, increment its repository's counter, and append `issues.opened`
in one transaction. Authorization runs in that same transaction. The event has
origin `service`, action `opened`, issue, repository and sender projections, and
an installation ID for provider calls. Event IDs and issue IDs are distinct. The
persisted outbox and event stream contain exactly one record per successful
operation; a failed transaction changes neither the counter nor the issue nor
the event. No recipient selection or delivery worker is added here; webhook
transport is [ADR 0020](0020-github-webhooks.md).

Expose the design's `issues.create({ repository, title, body? })` and CLI
`issues create --repo ... --title ... [--body ...]` through one declared
command. As required by the design's authorization boundary, these management
calls use control authorization, without a provider token field or implicit
token selection. They share the issue transaction with HTTP, but use the local
`emulon` Bot principal with ID 0. Provider authorization is exercised separately
from CLI/SDK parity. Creating an issue by CLI/SDK therefore does not act under
an installation token, and the design's management authority is unchanged.

The slice also provides `GET /user` for the installation principal. Return the
app Bot (`<slug>[bot]`, numeric app ID, type `Bot`) after current token
validation. This is a local compatibility extension: GitHub's authenticated-user
documentation lists user access tokens and fine-grained PATs, not installation
access tokens. Do not interpret this route as browser user authorization or a
claim that a real installation token can call GitHub's `/user`. The simplified
bot ID is local, not a separately provisioned GitHub user ID.

Keep schema version 1: issue and counter collections are additive. Reset removes
them, tokens and events. Live endpoint addresses are bound per HTTP context at
startup, not persisted as plugin configuration; each newly created issue uses
the current endpoints. Previously persisted issue URLs remain creation-time
addresses after a restart.

## Consequences and verification

Loopback tests issue tokens through the App JWT route, create issues over HTTP,
CLI and SDK, compare results/state/outbox and read both event list and follow.
They check current suspension and grant reductions, cross-installation access,
missing repositories, insufficient permissions, invalid input, reset and
concurrent repository numbering. A failure injected after outbox append proves
rollback of all three writes. Pure access checks have independent tests.

Compatibility references read for this slice:

- [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue):
  installation tokens, write permission, response shape and 201 status.
- [Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user):
  supported user token types; the installation-principal extension above is
  deliberately identified as local.

No tests use a real provider or the public network. Exact errors remain the
bounded local contracts documented by ADR 0018 and the compatibility manifest;
full provider equivalence and an official-client suite are not claimed here.

Follow-up: [ADR 0021](0021-github-official-client.md) adds the official Octokit
suite for this subset. Full provider equivalence remains outside its claims.
