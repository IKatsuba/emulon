# ADR 0020: GitHub issue webhook transport

Status: Accepted.

## Context

Issue creation ([ADR 0019](0019-github-issues.md)) records provider-shaped
`issues.opened` payloads atomically with issues. This slice connects that outbox
to the existing dispatcher and delivery worker, with plugin-owned mapping,
transport and subscriptions, no dependency, and no new core commands. Unlike
Resend, the requested GitHub contract needs a new provider delivery identifier
on manual redelivery and permits unsigned sends.

## Options

- Duplicate the dispatcher and attempts in GitHub, or extend the existing
  transport policy minimally and reuse the persisted delivery lifecycle.
- Resolve synthetic payload entities from state, or validate supplied
  projections without any resource lookup or mutation.
- Use a crypto dependency, or the existing WebCrypto approach used by Resend and
  GitHub authentication. There is currently no separate runtime crypto adapter;
  WebCrypto is web-standard and works on both supported runtimes.

## Decision

Reuse the delivery infrastructure and WebCrypto HMAC-SHA256. No runtime-specific
API or new dependency is introduced. A pure plugin function maps `issues.opened`
to event `issues` and body `action: "opened"`. Validate issue, repository,
sender and optional installation projections; preserve additional provider
fields. Do not manufacture missing resources. Service delivery consumes the
existing outbox record and never appends a second event.

Add `webhooks: { url, secret? }` to GitHub factory options. Seed one enabled
instance-level destination named `github`, subscribed to `issues.opened` under
processing-time selection. This is an explicit configuration shape for this
slice, separate from the future per-app fixture example in the design. Existing
app registration webhook settings remain stored metadata; automatic
installation/app recipient selection is not implemented by this slice. No
installation-specific send flag is claimed. The existing ADR 0012 explicit
`--destination github` form is supported, with typed SDK parity.

Declare `events.publish` and `webhooks.send/list/inspect/redeliver/wait` in the
GitHub command registry using the existing helpers. Their schemas reject unknown
events, missing projections and conflicting actions before committing anything.
Send records a direct event and selects only its explicit configured
destination; publication uses subscriptions. Neither operation creates issues or
repositories.

Add optional `DeliveryTransport.providerId: "delivery" | "attempt"`. The default
retains the original ID, preserving Resend. GitHub selects `attempt`: each
attempt gets a fresh secure UUID in `X-GitHub-Delivery`, while core retains the
first serialized bytes. Redelivery keeps the logical delivery and outbox event,
as in ADR 0012. This identifier policy is a local contract.

Use `Content-Type: application/json`, `X-GitHub-Event: issues`, and, when
configured, `X-Hub-Signature-256: sha256=<lowercase hex HMAC>` over exactly the
sent bytes. The core destination schema now accepts an empty secret as the
unsigned marker; GitHub omits the signature in that case.
`SubscriptionPolicy.allowUnsigned` explicitly enables empty secrets for GitHub;
destination creation and replacement reject empty secrets for every other policy
by default. Explicit GitHub secrets must be nonempty. Resend preserves its
nonempty-secret checks at configuration and fixture inputs. URL validation
remains shared. No signature or secret enters ordinary inspection.

Use a ten-second timeout, accept 2xx, and return no retry delay for all
attempts. Reset restores configured destinations. Existing durable fixtures are
not silently replaced when configuration changes: reset is needed for an
existing store. Schema version 1 remains sufficient because destination and
attempt collections are additive and prior rows remain readable.

## Consequences and verification

Tests check the published GitHub HMAC test vector, independent signature
verification over received Unicode bytes, altered-body rejection, pure mapping,
unsigned delivery, unsafe destination rejection, failed delivery with no
schedule, manual CLI redelivery with changed provider ID and unchanged bytes,
secret redaction, CLI publication and explicit send without business mutations,
SDK publication, reset and restoration. Existing Resend tests check ID
retention. All receivers use loopback with dynamic ports; tests never contact
GitHub.

Protocol references:

- [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub failed delivery handling](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
