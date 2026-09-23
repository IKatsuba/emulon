# Webhooks

`mod.ts` validates and maps `issues.opened` into the provider payload, signs
exact body bytes with WebCrypto HMAC-SHA256, and declares manual retry policy.
Instance configuration seeds the `github` destination. The existing dispatcher
reads the transactional state outbox; publication never creates business
resources. See [ADR 0020](../../../../docs/decisions/0020-github-webhooks.md)
for scope.
