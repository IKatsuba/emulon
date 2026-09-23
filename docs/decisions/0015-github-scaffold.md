# ADR 0015: GitHub scaffold, credentials and management commands

Status: Accepted.

## Context

The first GitHub package needs isolated identities, app registrations,
installations and repository grants before provider authentication is
implemented. The design gives command examples but does not specify their
complete schemas. The existing command registry requires object inputs for
CLI/SDK parity.

## Options

- Use a crypto/JWT dependency or use WebCrypto for RSA key generation.
- Store provider resource IDs as numbers or decimal strings in control commands.
- Extend the registry with scalar SDK inputs or retain its object-input
  contract.
- Claim future GitHub routes now or advertise only implemented behavior.

## Decision

Use WebCrypto RSASSA-PKCS1-v1_5 with SHA-256, a 2048-bit modulus and
exponent 65537. Generate keys at app creation; encode the private key as PKCS#8
PEM and public key as SPKI PEM. Add no dependency. Generate decimal resource IDs
from 52 secure random bits plus one; these fit safe provider JSON integers but
remain strings in control commands. Generate client IDs as `Iv1.` followed by 16
random hexadecimal digits. All random bytes come from `crypto.getRandomValues`.
No access tokens are issued in this slice; their provider prefixes belong to the
token implementation.

Declare these commands through Zod and the shared registry:

| Command                   | Input                                                                                | Output                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `apps.create`             | `slug`, optional `permissions`, `events`, `callbackUrls`, `webhook: { url, secret }` | `id`, normalized `slug`, `clientId`, `permissions`, `events`, `callbackUrls`, `privateKey` |
| `installations.create`    | `appId`, `account`, `repositories: string[]`                                         | `id`, `appId`, `account`, `repositories`, `permissions`, `suspended`                       |
| `installations.suspend`   | `{ id }`                                                                             | Updated installation                                                                       |
| `installations.unsuspend` | `{ id }`                                                                             | Updated installation                                                                       |

The CLI uses `--app-id`, `--callback-urls`, and otherwise matching field names.
Arrays and objects use JSON flag values. Suspension IDs are positional in the
CLI. The design's illustrative scalar SDK suspension call is updated to the
existing object contract. No additional inspection command is introduced; later
provider routes will read the same store. Tests inspect the host store directly.

App creation is an explicit authenticated credential-provisioning command; its
result contains the private key. Store both keys in the protected app record and
omit the public key and webhook secret from its result. Status never projects
app records. Defaults are metadata read permission, no events and no callbacks.
Permissions and event names are scaffold data, not a compatibility claim.

User fixtures create matching User accounts. Repository fixtures require a known
fixture owner. Normalize logins, app slugs and repository names to lowercase;
reject case-insensitive duplicates and unknown owners before factory
registration so configuration errors remain actionable despite startup error
redaction. Organization fixtures and app fixtures remain unsupported in this
slice and are rejected rather than ignored. Empty repository selections are
allowed and grant no repository access. Installations require an existing
app/account, reject foreign or missing repositories and duplicate app/account
pairs, and atomically persist the installation and its repository-ID grant.
Suspension is an idempotent state transition; grants remain available for later
request-time checks.

Use schema version 1 with collections `users`, `accounts`, `repositories`,
`apps`, `installations`, and `grants`. Accounts use login keys, repositories use
full-name keys, apps/installations use resource-ID keys and grants use
installation-ID keys. The host owns isolation and reset. Async key generation
uses a generation-scoped store to prevent commits across reset. Generated apps
and grants disappear on reset; user/repository fixtures remain.

Advertise `http` and `reset`. Both `api` and `web` start owned listeners and
return 404 JSON for unknown routes. The compatibility manifest declares empty
provider API versions, routes, authentication modes and event types until those
behaviors exist. Auth, events and webhook capabilities must not be advertised
prematurely.

## Consequences

The package can provision independent local GitHub state through either control
client without a real provider or new dependencies. Private key output must be
handled as a credential by callers. PKCS#8 is accepted by WebCrypto; callers
that require GitHub's downloaded PKCS#1 encoding must convert it themselves.

JWT verification, token issuance, issue creation, webhook delivery, browser user
authorization and provider version compatibility are subsequent slices. The
scaffold does not claim official-client compatibility yet. The npm build
includes the new package; its only public entry point is the default plugin
factory.

Follow-up: [ADR 0018](0018-github-app-authentication.md) implements App JWT
verification and installation-token issuance, and declares the supported REST
version subset. Official-client contract verification is recorded in ADR 0021.

Follow-up: [ADR 0019](0019-github-issues.md) adds issue creation, current token
resource checks and atomic issue events. Webhook delivery remains a later slice.

Follow-up: [ADR 0020](0020-github-webhooks.md) implements signed issue delivery;
[ADR 0021](0021-github-official-client.md) adds the official-client contract
suite and executable example. [ADR 0022](0022-github-local-consent.md) adds the
browser consent and authorization-code half of user authorization; user token
exchange follows in [ADR 0024](0024-github-user-tokens.md).

## Subsequent implementation

[ADR 0024](0024-github-user-tokens.md) completes code exchange and user token
access. Earlier references to these features as deferred describe the boundary
of this original slice.
