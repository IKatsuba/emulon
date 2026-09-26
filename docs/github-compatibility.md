# GitHub App compatibility and client setup

The machine-readable manifest is
[packages/github/src/compatibility.ts](../packages/github/src/compatibility.ts).
It is validated and exposed through `compatibility get --json`,
`env.services.github.compatibility.get({})`, and npm `emulon.compatibility`
metadata. This covers GitHub App installation authentication, issues, webhooks
and the user authorization slice, not complete GitHub compatibility.

## Supported surface

| Operation                                             | Credential                                    | Result                                                |
| ----------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| GET /app                                              | RS256 App JWT                                 | Partial App projection                                |
| GET /app/installations                                | RS256 App JWT                                 | Owned installations; page/per_page                    |
| POST /app/installations/:installationId/access_tokens | RS256 App JWT                                 | One-hour token, narrowed repositories and permissions |
| GET /user                                             | User or installation token                    | Fixture User, or local extension: App Bot             |
| POST /repos/:owner/:repo/issues                       | User or installation token with issues: write | Issue and atomic issues.opened event                  |
| web: POST /login/oauth/access_token                   | Client ID, secret and authorization code      | Non-expiring user token                               |

API version 2022-11-28 is supported and is the default when omitted. Other
versions return 400. Unknown routes return 404 JSON without proxying. The
separate web endpoint supports `GET /login/oauth/authorize` and an explicitly
local consent form. See [local consent](decisions/0022-github-local-consent.md).

Capabilities are HTTP, reset, authorization, events and webhooks. issues.opened
delivers an issues event with action opened, a delivery UUID and optional
HMAC-SHA256 over the exact bytes. One instance-level destination is supported;
app registration webhooks do not route deliveries. Failures have no automatic
retry. Manual redelivery retains payload bytes and gets a new provider delivery
ID. See [webhook semantics](decisions/0020-github-webhooks.md).

## Configure the actual client

Changing an environment variable alone does not reconfigure Octokit. Pass
baseUrl: env.endpoints.github.api and auth: appJwt explicitly to its
constructor. Call appClient.rest.apps.createInstallationAccessToken with the
numeric installation_id. Create another Octokit with the same baseUrl and auth:
issued.data.token, then call its rest.issues.create method with owner, repo and
title. Disable retry and throttle for deterministic negative tests.

The runnable [client setup](../examples/github-app/client.ts) and
[application](../examples/github-app/main.ts) show the complete recipe:
provision credentials, sign the JWT, use Octokit, receive and verify a signed
webhook, wait for delivery success, inspect attempts, redeliver the same issue
webhook, wait again and dispose all listeners. The output includes attempt
history before and after redelivery and explicit receiver signature verification
for the repeated delivery.

Run **deno task example:github-app** from the repository root. Its client
additionally restricts requests to the exact loopback origin and rejects
redirects. Its receiver uses an internal repository runtime adapter; it does not
imply a new exported Emulon API. Output contains both issues, the fixture user
and verified webhooks, never the private key, JWT, token or webhook secret.

## User client: configure both surfaces

Use `env.endpoints.github.web` for the authorization URL and token exchange; use
`env.endpoints.github.api` for authenticated REST requests. They have separate
ports, dynamic unless the instance fixes them with `ports: { api, web }`. Never
infer one endpoint from the other or leave a client at its public GitHub
default.

```ts
const authorization = new URL(
  '/login/oauth/authorize',
  env.endpoints.github.web,
);
authorization.searchParams.set('client_id', app.clientId);
authorization.searchParams.set('redirect_uri', callback);
authorization.searchParams.set('state', state);
// After local consent, validate the callback state before exchanging its code.
const webClient = localClient(env.endpoints.github.web!);
const response = await webClient.request('POST /login/oauth/access_token', {
  headers: { accept: 'application/json' },
  client_id: app.clientId,
  client_secret: app.clientSecret,
  redirect_uri: callback,
  code,
});
// OAuth failures use HTTP 200 and therefore do not throw RequestError.
if (response.data.error) {
  throw new Error(response.data.error);
}
const userClient = localClient(
  env.endpoints.github.api!,
  response.data.access_token,
);
const user = await userClient.rest.users.getAuthenticated();
```

`localClient` is the example's Octokit constructor helper, not an Emulon API.
The runnable [authorization helper](../examples/github-app/authorization.ts)
drives the local HTML form using fixture selections and validates the returned
callback and state without launching a browser. Consent is distinct from
installation: the example provisions the installation first through management.
User issue access intersects the code's immutable ceiling, current user grant,
app permissions and installation grant. Reapproval may reduce existing access
but cannot broaden the token's original ceiling.

App JWTs have a maximum ten-minute validity; installation tokens expire after
one hour. User tokens support **non-expiring mode only**: no `expires_in` or
`refresh_token` is returned. Refresh/expiring user-token lifecycle support is
not implemented. Reset invalidates user tokens.

## Verification and limits

**deno task check** runs the official-client contract tests and the example.
Network permissions allow only 127.0.0.1; all listener ports are dynamic.
Initial dependency acquisition is separate from test execution.

Design point 3 covers the five API routes above in the installation slice via
Octokit 5.0.5 REST methods. Point 4 covers wrong JWT signatures, expiry at the
one-hour boundary, cross-installation repository denial, foreign-app
installation denial, repository/permission narrowing, rejected scope expansion
and suspension at both issuance and resource access. Assertions inspect
Octokit's RequestError.status, parsed response body and error message. Failures
leave the event count unchanged.

**Local consent:** `authorization_cases.ts` covers browser consent,
callback/state return, headless CLI/SDK consent, expiry, binding, concurrent
internal code consumption, reset and durable restart.

**User tokens:** `user_cases.ts` covers code exchange and concurrent replay
through the public web endpoint, user identity, permission intersection and
reset. `GET /user` and issue creation also accept user tokens. The web endpoint
`POST /login/oauth/access_token` issues non-expiring tokens only; refresh
requests return `unsupported_grant_type`. Any `repository_id` exchange parameter
returns the local HTTP 400 `invalid_request` unsupported-feature response
without issuing a token or consuming the code; JSON and form regression tests
cover this boundary. OAuth Apps, PATs, device flow and complete browser
installation remain unsupported. See
[ADR 0024](decisions/0024-github-user-tokens.md). Official user-client
verification and the complete example are described below.

The manifest enumerates exact local error bodies and limitations: normalized
documentation URLs, partial projections, local JWT/suspension diagnostic text,
no pagination Link headers, no rate-limit simulation and the explicit
installation-token GET /user extension. These tests do not establish exact
live-provider text or full GitHub equivalence. Distribution verification uses no
Octokit and rejects provider-test dependencies in package manifests.

A manual browser check also opened the actual form in Chromium, selected a
repository and permission, and reached a dynamic loopback callback with its code
and original state. A screenshot of the form was inspected. The check caught and
corrected the interaction between Referrer-Policy, Origin and CSP form
redirects; the HTTP suite guards the required headers.

**Official user client:** Octokit also covers user identity and issue creation,
both directions of repository intersection, repositories installed only for a
foreign app, live permission reduction, immutable token ceilings after
reapproval, suspension, reset invalidation, expired codes and reused codes.
Authorization code replay is also covered through the official client. OAuth
errors assert the complete parsed HTTP 200 body; API failures assert
`RequestError` status, message and body. Rejected issue requests create no
events.

An expired **user token** cannot be obtained in ADR 0024's non-expiring mode.
The contract instead asserts that access survives a year of controlled clock
advancement and that the exchange has no expiry/refresh fields. This is not a
claim to verify expiring user tokens.
