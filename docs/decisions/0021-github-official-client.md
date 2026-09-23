# ADR 0021: Octokit for GitHub contract tests and the runnable example

Status: Accepted.

## Context

The GitHub App slice must be exercised through the provider's official client,
including its error handling. Ordinary verification cannot contact GitHub, and
published Emulon packages must not depend on test clients.

## Options

- Use the official all-batteries-included Octokit client.
- Continue testing only raw HTTP (insufficient for design verification point 3).

## Decision

Pin npm:octokit@5.0.5 in the root Deno imports and commit its resolution in
deno.lock. Import it only from tests and examples/github-app, never package
runtime entry points. Keep distribution verification free of Octokit; assert
that no published dependency field includes it or any @octokit/* package.

Configure Octokit with baseUrl equal to the environment's api endpoint and an
App JWT or issued installation token. Disable automatic retries and throttling
for deterministic negative assertions. The fetch adapter delegates unchanged
requests to real web fetch after checking the exact local origin, and disallows
redirects. It does not simulate provider responses. Deno test permissions
additionally restrict network access to 127.0.0.1.

Use a test-only clock wrapper to exercise token expiry at its exact boundary.
JWTs are signed with Web Crypto; the client performs the real token request. The
example uses the existing internal runtime listener adapter for its local
receiver, avoiding a new public server API. Its HMAC verifier is independent of
the plugin signer and has positive and tampering tests.

## Consequences

The official client parses successes and raises RequestError for distinct
401/403/404/422 responses. This verifies the declared local subset, not live
GitHub equivalence. The existing diagnostic error limitations and installation
GET /user extension remain explicit. The user-authorization slice
([ADR 0024](0024-github-user-tokens.md)) is covered the same way: a separate
unauthenticated Octokit client uses the web endpoint for exchange; an
authenticated client uses the API endpoint for user requests. Reused codes are
checked as parsed HTTP 200 OAuth error bodies, while REST authorization failures
raise RequestError.

The example runs under deno task check and is also directly runnable. No Octokit
dependency is added to published packages or offline consumer fixtures.

Reference: [Octokit configuration](https://github.com/octokit/octokit.js),
including baseUrl, request.fetch, retry and throttle options.
