# Local Resend reference

```ts
import resend from '@emulon/resend';
import { Emulon } from 'emulon';
import { Resend } from 'resend';

await using env = await Emulon.start({ services: { mail: resend() } });
const { apiKey } = await env.services.mail.keys.create();
const client = new Resend(apiKey, { baseUrl: env.endpoints.mail.api });
const { data, error } = await client.emails.send({
  from: 'Acme <sender@example.test>',
  to: ['recipient@example.test'],
  subject: 'Hello',
  html: '<p>Local only</p>',
});
if (error || !data) {
  throw new Error('Local email send failed');
}
console.log(await client.emails.get(data.id));
console.log(await env.services.mail.emails.list());
console.log(await env.services.mail.emails.get({ id: data.id }));
await env.reset();
```

The official client is tested at `resend@6.28.1` using its `baseUrl` option.
Install it separately in the consuming application. No email is actually sent.
Each environment owns isolated loopback listeners on dynamic ports; disposal
closes them. Keys are securely generated per instance and reset invalidates
them.

For a project running `emulon up`, the same registry exposes:

```sh
emulon mail keys create --json
emulon mail emails list --json
emulon mail emails get --id <email-uuid> --json
emulon mail emails clear --json
emulon reset --json
```

`keys create` explicitly returns a secret for configuring the provider client.
`emails clear` deletes emails, retaining keys and event history. `reset`
restores all environment fixtures and removes generated credentials and events.
SDK `emails.clear()` and `env.reset()` have the corresponding semantics.

Fixtures use `resend({ fixtures: { emails: [{ from, to, subject, text }] } })`.
An optional UUID `id` fixes an email's identity; generated fixture IDs and
creation times remain stable across reset. Fixtures do not publish events.

Supported provider operations are `POST /emails` and `GET /emails/:id`, with
bearer authentication. Sending accepts `from`, `to`, `subject`, `html`, `text`,
`cc`, `bcc`, and `reply_to`; at least one body representation is required.
HTML-only messages retain null text rather than generating a text alternative.
Reading includes the original bodies and `last_event: "sent"`. Send atomically
records `email.sent` in the outbox; eligible subscriptions now receive queued
deliveries, which the worker sends with Svix signatures.

Domains, audiences, attachments, templates, scheduling, tags, custom headers,
idempotency keys and explicit API versions are unsupported. Unknown routes
return `404 Unsupported route`; unsupported send fields return JSON with status
501. `GET /health` remains an unauthenticated lifecycle probe. The npm
manifest's `emulon.compatibility`, generated from
[src/compatibility.ts](src/compatibility.ts), describes this unversioned API
subset and its limitations. See
[ADR 0008](../../docs/decisions/0008-resend-reference-surface.md).

## Events

Publish a synthetic event without creating or changing an email:

```sh
emulon mail events publish email.sent --data ./event.json
emulon events --type email.sent
emulon events --follow
```

The JSON file contains `email_id` (UUID), `from`, `to` (array), and `subject`.
Inline JSON objects are also accepted by `--data`. The same typed command is
`env.services.mail.events.publish({ type: "email.sent", data })`. Use
`await env.events.list({ type: "email.sent" })` to read history or
`await env.events.follow({ type: "email.sent" })` to subscribe before triggering
an action. Cancel the returned stream when finished.

Synthetic records have origin `published`; provider sends have origin `service`.
Private history is in memory; project history persists across restarts. Reset
clears history and rejects overlapping reads. Follow emits future commits only,
fails on reset (subscribe again afterwards), and ends on environment disposal.
Subscribed events produce signed webhook deliveries. See
[ADR 0009](../../docs/decisions/0009-event-publication-and-stream.md).

## Webhook queue

Configure initial destinations with
`resend({ destinations: [{ id: "app",
url: "http://127.0.0.1:3000/hooks", secret: "whsec_bG9jYWwtc2VjcmV0",
types: ["email.sent"], enabled: true }] })`,
or use the same command from CLI/SDK:

```sh
emulon mail webhooks configure --id app --url http://127.0.0.1:3000/hooks --secret whsec_bG9jYWwtc2VjcmV0 --types '["email.sent"]' --enabled true
emulon mail webhooks destinations
emulon mail webhooks list
```

`env.services.mail.webhooks.configure({...})` replaces a destination by ID.
Disabling cancels queued deliveries; enabling does not backfill old events or
revive cancellations. Secret rotation preserves queued IDs and updates the
secret for future sending. Lists omit secrets. Reset restores configuration
destinations captured at startup. Private SDK starts use memory; project hosts
retain resources, keys, destinations and outbox across restart through
[ADR 0016](../../docs/decisions/0016-durable-state.md). Independent process-kill
delivery verification is described in
[delivery verification](../../docs/events-and-delivery.md). See
[ADR 0010](../../docs/decisions/0010-subscriptions-and-dispatch.md).

The worker signs the exact UTF-8 body with Web Crypto and accepts 2xx responses.
It uses a five-second timeout and no automatic retries; failures appear as
`failed` in `webhooks list`. Provider and management mutations wait for due
deliveries to finish; read-only commands observe committed state immediately.
Secrets are base64 keys with an optional `whsec_` prefix. Claimed sends keep the
destination credentials captured at claim time. See
[ADR 0011](../../docs/decisions/0011-delivery-worker-and-svix.md).

## Direct sending, inspection and redelivery

```sh
emulon mail webhooks send email.sent --data ./event.json --destination app
emulon mail webhooks list
emulon mail webhooks inspect <delivery-id>
emulon mail webhooks wait <delivery-id> --status succeeded --timeout 10s
emulon mail webhooks redeliver <delivery-id>
```

`destination` is an enabled configured destination ID. Direct sending records an
event with origin `direct`, without changing email state or sending to other
subscriptions. The payload is the same validated shape as `events publish`.

```ts
const delivery = await env.services.mail.webhooks.send({
  type: 'email.sent',
  data,
  destination: 'app',
});
console.log(await env.services.mail.webhooks.inspect({ id: delivery.id }));
await env.services.mail.webhooks.redeliver({ id: delivery.id });
await env.services.mail.webhooks.wait({
  id: delivery.id,
  status: 'succeeded',
  timeout: '10s',
});
```

Send and redeliver return the queued transaction record; list, inspect and wait
observe subsequent status. Redelivery retains the exact original body and
`svix-id`, creates a new attempt, and recalculates the timestamp and signature
using the current destination secret. A queued or in-flight delivery cannot be
redelivered concurrently. Disabled destinations must be enabled first.

Inspection includes the delivery and all attempts, with safe header metadata;
secrets, authorization/signature headers and receiver response bodies are
omitted. Request bytes contain application event data and must not include
application credentials. Wait subscribes to committed changes without polling.
Timeouts use positive integer `ms`, `s` or `m` durations and return
`WAIT_TIMEOUT` with current status (nonzero CLI exit). Reset drains outstanding
waits; environment disposal closes their state. See
[ADR 0012](../../docs/decisions/0012-webhook-commands.md).

Delivery fault scenarios and their verification are documented in
[events and delivery](../../docs/events-and-delivery.md).

Query this declaration with `emulon mail compatibility get --json` or
`env.services.mail.compatibility.get({})`; see the shared
[compatibility contract](../../docs/compatibility.md).
