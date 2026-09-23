# Events and delivery verification

Three operations have different contracts:

| Operation                                    | Business state   | Event                               | Delivery                               |
| -------------------------------------------- | ---------------- | ----------------------------------- | -------------------------------------- |
| Service action (Resend `POST /emails`)       | Creates an email | `service`, atomic with the mutation | Selected subscriptions                 |
| `events.publish({ type, data })`             | Unchanged        | `published`, schema validated       | Selected subscriptions                 |
| `webhooks.send({ type, data, destination })` | Unchanged        | `direct`, schema validated          | Only the specified enabled destination |

CLI commands and typed SDK calls share the authenticated control API of the same
running environment. Direct send does not fan out through subscriptions.
Repeating publication with the same payload creates separate events; Emulon does
not dedupe business meaning. `webhooks.list`, `inspect`, `wait`, and `redeliver`
expose logical deliveries and their separate attempts. Redelivery retains
original bytes, regenerates signatures, and never republishes an event. Resend
retains its provider delivery ID; GitHub creates a new ID for each attempt (ADR
0020).

## Running scenarios

Configure a local receiver as a destination (`webhooks.configure`), then:

```sh
emulon mail webhooks faults --delay-ms 1000 --lose-response false
emulon mail events publish email.sent --data event.json
emulon mail webhooks faults --delay-ms 0 --lose-response false
emulon mail events publish email.sent --data event.json
emulon mail events publish email.sent --data event.json
```

The first delivery is delayed; later publications can arrive first. Repeated
payloads retain distinct event IDs. Wait using
`webhooks wait <id> --status
succeeded --timeout 10s`, rather than sleeping. SDK
configuration is
`env.services.mail.webhooks.faults({ delayMs: 1000, loseResponse: false })`.

For success followed by response loss, set `--delay-ms 0 --lose-response true`,
then send or publish. The real receiver processes the HTTP request; the worker
intentionally discards its response. Inspection shows a failed delivery and an
attempt with `outcome: "unknown"` and `TRANSPORT_ERROR`. This simulates
transport ambiguity; it does not physically break TCP. Unknown does not mean the
receiver failed or succeeded. Explicit redelivery clears this fault for that
delivery and may process the same event again. Applications must handle
duplicate delivery. Set both flags back to zero/false for new deliveries, or
reset the environment. Existing delivery schedules are snapshots. See
[ADR 0013](decisions/0013-delivery-fault-scenarios.md).

## What the check proves

`deno task check` includes `packages/resend/tests/compatibility_test.ts` and
prints a delivery report. All receivers bind dynamically allocated loopback
ports. It checks exact Unicode request bytes and independently verifies HMAC
signatures, failed-attempt retention, explicit redelivery, unknown receiver
outcome after response loss, duplicate events and attempts, delay and changed
order, CLI/SDK publication and direct-send non-mutation, and instance isolation.

Retained-state tests stop and restart the environment and worker over the same
in-memory state in one process. They check concurrent atomic state/outbox
commits, rollback, recovery of unprocessed events and queued deliveries, stable
logical IDs, and no repeat sending of completed deliveries. The fixture makes a
retained schedule due explicitly, without waiting a day. Other tests in the same
check cover actual provider actions, dispatcher rollback, lost dispatch markers,
concurrent claims, retries, shutdown, and reset.

To reproduce a failing signature verification without changing source:

```sh
deno test --allow-read --allow-write --allow-net=127.0.0.1 \
  packages/resend/tests/compatibility_test.ts -- --inject-signature-mismatch
```

This intentionally changes one byte in the verification input and exits nonzero
with `Delivery verification: signature does not match exact received bytes`. The
ordinary suite also asserts that checking a signature against a different body
fails with this diagnostic.

## Independent process crash recovery

Run the source proof on the local Deno binary:

```sh
deno test --allow-run=deno --allow-read --allow-write --allow-env=NODE_ENV \
  --allow-net=127.0.0.1 packages/emulon/tests/durable_process_test.ts
```

It is also included in `deno task check`. The run grant permits only the Deno
executable; children use cached dependencies and loopback networking. The shared
harness is `scripts/durable-proof.ts`, with
`packages/emulon/tests/fixtures/durable-process.ts` as its child fixture.
`verify:dist` copies and transpiles this fixture to import installed npm
modules, then runs the same assertions under Node and with alternating Node/Deno
children.

The barriers are explicit pipe messages or a receiver promise, never elapsed
sleeps. Deadlines only fail a stalled test. Each inspection opens a new process
and database connection; SIGKILL is followed by waiting for process exit:

- Kill immediately before SQL COMMIT, after the snapshot UPDATE: neither the
  entity nor its outbox event survives. Kill immediately after COMMIT, before
  the in-memory cache is installed: both survive.
- Reset two populated instances; kill after the first SQL UPDATE, then reopen to
  the complete old snapshots and generations. Kill after reset COMMIT and
  recover both empty fixture snapshots and incremented generations. This uses
  the coordinator called by host reset; host admission and failure fencing are
  separately checked in `durable_host_test.ts`.
- Seed one pending event and one already queued delivery with a past wall-clock
  deadline. A fresh project host materializes and sends both. Repeated reopen
  retains the logical delivery IDs and never sends completed deliveries again.
- The loopback receiver records the complete Unicode body and provider ID,
  signals receipt and withholds its HTTP response. Kill the sending host while
  inspection still reports in-flight. A fresh host records `INTERRUPTED`,
  `outcome: "unknown"` and a failed delivery without resending. Kill/reopen once
  more to prove that recovery transition itself was persisted.
- Explicit redelivery creates a distinct attempt, succeeds and sends identical
  bytes and provider ID. Inspection retains the interrupted attempt. It omits
  signing secrets, signature headers and the receiver's private response body.
- Removing discovery while its owner is alive still produces `STATE_IN_USE` in a
  competing host. Kill releases the OS lock. Reopen keeps the database UUID but
  rotates control id/token; the old credentials receive HTTP 401.

The source proof and installed-package matrix passed on macOS arm64 with Deno
2.9.7 and Node 22.13.0, 24.13.0 and 26.7.0. See
[distribution verification](distribution.md) for commands and scope. No
production integration defect was exposed by these scenarios.

## Boundaries

This is evidence for the local Resend slice, not full provider equivalence or a
claim of exactly-once delivery. No real account, public network, external SDK
retry policy, or real-provider comparison is involved. Delays use wall time;
virtual time is not implemented. Project hosts now reopen durable SQLite state
under [ADR 0016](decisions/0016-durable-state.md); format validation and host
lifecycle tests are described in [durable runtime](durable-state.md).
Independent process-kill recovery is covered by the scenarios above. Retained
in-flight requests are marked failed with an unknown outcome and need explicit
redelivery; they are not silently retried. Ordinary inspection omits secrets,
signatures and response bodies, but request payloads remain application-owned
inspectable data.
