# @emulon/github

Local GitHub App emulator with isolated `api` and `web` endpoints. The API
supports `GET /app`, `GET /app/installations`, and
`POST /app/installations/:installationId/access_tokens` under RS256 App JWTs.
Both surfaces return 404 JSON for unsupported routes. See
[src/compatibility.ts](src/compatibility.ts) for the validated compatibility
manifest and [ADR 0015](../../docs/decisions/0015-github-scaffold.md) for the
model contract.

```ts
import { Emulon } from 'emulon';
import github from '@emulon/github';

await using env = await Emulon.start({
  services: {
    github: github({
      fixtures: {
        users: [{ login: 'igor' }],
        repositories: [{ owner: 'igor', name: 'demo', private: true }],
      },
    }),
  },
});
const app = await env.services.github.apps.create({ slug: 'review-bot' });
const installation = await env.services.github.installations.create({
  appId: app.id,
  account: 'igor',
  repositories: ['igor/demo'],
});
await env.services.github.installations.suspend({ id: installation.id });
await env.services.github.installations.unsuspend({ id: installation.id });
```

Against an environment started with `emulon up`, the same commands are
available:

```sh
emulon github apps create --slug review-bot
emulon github installations create --app-id <app-id> --account igor --repositories '["igor/demo"]'
emulon github installations suspend <installation-id>
emulon github installations unsuspend <installation-id>
```

`apps create` explicitly returns the app's private key and `clientSecret`. Keep
that output private. IDs are decimal strings. Fixtures currently support users
and repositories only; duplicate names and unknown repository owners fail
immediately. Reset restores fixtures and deletes generated apps, installations
grants, installation and user tokens, user grants, consent forms and
authorization codes. User fixtures create User accounts; organization and app
fixtures are not supported yet.

Sign an RS256 JWT with the returned PKCS#8 `privateKey`, using `app.id` or
`app.clientId` as `iss`, integer `iat` seconds at or before now, and `exp` after
now and at most 600 seconds ahead. Send it as `Authorization: Bearer <JWT>` to
`env.endpoints.github.api`. Use `X-GitHub-Api-Version: 2022-11-28` or omit the
header. Posting `{}` to the token route grants the current installation scope;
`repositories` (short names), `repository_ids` (numbers), and `permissions` can
narrow it. Tokens expire in one hour. The web surface supports local consent
(see below). See
[ADR 0018](../../docs/decisions/0018-github-app-authentication.md) for error
compatibility limits and the clock boundary.

Create an issue with an installation token by posting a string `title` and
optional string `body` to `/repos/:owner/:repo/issues`. Every request checks
current suspension, repository grants and `issues: write`. A successful 201
response and its `issues.opened` event contain the same issue. Numbers increase
per repository; `html_url` points to the local web surface (page rendering is
not implemented). Reset removes issues, counters and events too.

Management creation shares the transaction and result contract:

```ts
await env.services.github.issues.create({
  repository: 'igor/demo',
  title: 'Bug',
});
```

```sh
emulon github issues create --repo igor/demo --title "Bug"
emulon events
```

CLI/SDK commands use control authorization and the local `emulon` Bot, not an
installation token. Provider issues use the app Bot for installation tokens and
the fixture User for user tokens. `GET /user` returns that Bot for a valid
installation token as an explicit local extension; this is not GitHub user
authorization. See [ADR 0019](../../docs/decisions/0019-github-issues.md) for
scope and compatibility limits. Signed issue webhooks are described below.

## Issue webhooks

Configure one instance-level subscription with
`github({ webhooks: { url: "http://127.0.0.1:3000/github", secret: "local-secret" } })`.
Omit `secret` for unsigned delivery. HTTP(S) destinations cannot contain URL
credentials or fragments. This subscribes destination `github` to
`issues.opened` from service actions and synthetic publication. Reset restores
this subscription. Existing durable stores retain their stored fixtures until
reset. App registration `webhook` settings and installation-specific routing are
not connected to this destination; this slice uses the explicit instance
configuration.

```sh
emulon github events publish issues.opened --data ./event.json
emulon github webhooks send issues.opened --data ./event.json --destination github
emulon github webhooks list
emulon github webhooks inspect '<delivery-id>'
emulon github webhooks redeliver '<delivery-id>'
emulon github webhooks wait '<delivery-id>' --status succeeded --timeout 10s
```

The SDK exposes the same commands, including
`env.services.github.webhooks.send({ type: "issues.opened", data, destination: "github" })`.
The event JSON must supply `issue` (`id`, `number`, `title`), `repository`
(`id`, `name`, `full_name`, `private`) and `sender` (`id`, `login`, `type`)
projections. Optional `installation` needs a numeric `id`. Additional provider
fields are preserved. `action` may be omitted or `"opened"`; other actions and
event types are rejected. Neither publish nor send creates the supplied
resources.

Requests carry the provider payload with `action: "opened"`,
`X-GitHub-Event:
issues`, a UUID `X-GitHub-Delivery`, and (with a secret)
`X-Hub-Signature-256`. Only 2xx responses succeed; requests time out after ten
seconds. Failed deliveries have no automatic retries. Redelivery retains exact
bytes and the logical delivery but creates another attempt with a new provider
ID. Inspect omits signatures, secrets and receiver response bodies. See
[ADR 0020](../../docs/decisions/0020-github-webhooks.md).

## Official client verification

The contract suite uses pinned Octokit 5.0.5 on dynamic loopback endpoints,
including provider error handling. The runnable
[github-app example](../../examples/github-app/README.md) is exercised by deno
task check. See
[compatibility and client setup](../../docs/github-compatibility.md) for the
completed installation and user-client scope, including the non-expiring
user-token limitation.

## Local browser consent

Create an app with `callbackUrls` and direct the application browser to
`env.endpoints.github.web + "/login/oauth/authorize?" + new URLSearchParams({
client_id: app.clientId, redirect_uri: callback, state })`.
Choose a fixture user, repository grants and permissions, then select Authorize.
The callback receives `code` and the exact decoded `state` value supplied by the
application. The application must validate state. Deny returns
`error=access_denied`. Unknown clients show a 404 page; mismatched callbacks
redirect with `error=redirect_uri_mismatch` to the first registered callback,
never the unregistered address. Omitted `redirect_uri` uses the first callback.

For headless tests, use the authenticated local extension:

```ts
const authorization = await env.services.github.authorization.approve({
  clientId: app.clientId,
  redirectUri: 'http://127.0.0.1:3000/callback',
  state: 'application-generated-state',
  login: 'igor',
  repositories: ['igor/demo'],
  permissions: { issues: 'read' },
});
// Follow authorization.redirectUrl to deliver the code to your callback.
```

```sh
emulon github authorization approve --client-id '<client-id>' --login igor --repositories '["igor/demo"]' --permissions '{"issues":"read"}' --state test-state --json
```

The app must declare the selected permission and register the callback first.
Selections simulate local fixture rights, including access to other users'
repositories. They do not create installations. Empty repository/permission
selections grant no access. The command returns `code`, `redirectUrl` and
`expiresAt` as explicit secret output. Codes are bound to client and callback,
expire after ten minutes and can be consumed once. Exchange the code on the web
surface at `POST /login/oauth/access_token` with `client_id`,
`client_secret: app.clientSecret`, `code` and optional matching `redirect_uri`.
JSON and form bodies are supported; request `Accept:
application/json` for JSON
responses (otherwise responses are form encoded). The returned `access_token`
works as a Bearer token on the API surface. `GET /user` returns the selected
User; issue creation requires both the current user grant and an active app
installation granting access to the repository. Tokens are non-expiring; refresh
is explicitly unsupported. Exchange requests containing `repository_id` return
HTTP 400 `invalid_request`: repository narrowing is unsupported, and no token is
issued or code consumed. See
[ADR 0024](../../docs/decisions/0024-github-user-tokens.md) for errors and
storage.

Local consent is not GitHub login, OAuth device flow, or provider membership
management. Only exact registered HTTP(S) callbacks without credentials or
fragments are supported. PKCE and OAuth scopes are explicitly rejected. See
[ADR 0022](../../docs/decisions/0022-github-local-consent.md) for storage, form
security and compatibility limits.
