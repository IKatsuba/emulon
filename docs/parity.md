# Resend CLI and SDK parity

Run the repository gate with `deno task check`. Its Resend parity test prints
each checked operation as a named step. For a focused run:

```sh
deno test --allow-read --allow-write --allow-env=NODE_ENV --allow-net=127.0.0.1 packages/resend/tests/parity_test.ts
```

The test starts one environment with one Resend instance and attaches a typed
`Emulon.connect()` client. CLI calls use `runProjectCLI` with `--json`,
discovery, and the authenticated control API; they do not start another
environment. This checks the CLI implementation and its output/exit-code
contract in process, not the installed executable (see
[distribution verification](distribution.md)).

Each CLI/SDK pair starts from equivalent seeded state by resetting the **same**
host between paths. Setup issues a key and sends an email through the local
provider endpoint, so every pair begins with a nonempty `email.sent` outbox. A
test-only wrapper captures the actual Resend store during setup for read-only
state/outbox inspection. It preserves the plugin's commands, routes, and
lifecycle and adds no public API. The test asserts that plugin setup runs
exactly once.

The steps cover:

- `emails.list`, `emails.get` (present and absent), `emails.clear`,
  `keys.create`.
- Invalid `emails.get` input: exit status and full serialized error, including
  stable code, field paths/codes, message, and available commands.
- Unknown command: CLI selection versus the connected SDK's internal transport
  registry, since the typed SDK cannot express an undeclared method.
- Reset through both paths, followed by provider HTTP rejection of the
  previously issued key: exact HTTP status/body and no state or event mutation.
  The SDK's void reset result is represented as `{ reset: true }`, matching CLI
  success. Provider authentication is checked on the provider surface, not
  invented as a management-command error.

For every pair the test compares results/errors, stored emails and keys, and
full recorded events. It also checks expected state transitions and
retained/cleared history independently of parity. Only known seed
IDs/timestamps/credentials and newly issued key identities are mapped to
symbolic values; business fields, references, event metadata, ordering, and
error fields remain compared. New keys must have the expected format, differ
from the seed key, and match the new stored entry. No credentials appear in
mismatch diagnostics.

A mismatch reports the operation, boundary, JSON path, and kind of difference,
for example:

```text
Parity emails.get: outcome differs at $.result.subject: value (CLI vs SDK).
```

The negative-control test injects a changed CLI result after JSON decoding and
requires this exact diagnostic. To demonstrate a failing gate with a real CLI
serialization change, temporarily replace the `stdout` expression in
`packages/emulon/src/cli/commands.ts`:

```ts
stdout: JSON.stringify(result, null, json ? undefined : 2),
```

with:

```ts
stdout: JSON.stringify(name === "emails.clear" ? { deleted: 999 } : result),
```

Run the focused command (or `deno task check`). The `emails.clear` step must
fail with `Parity emails.clear: outcome differs at $.result.deleted`. Restore
the expression and rerun the gate. Do not commit this intentional mutation.

These checks prove parity for the current Resend command contract and recorded
outbox, not full Resend compatibility, other plugins, or npm packaging. All
traffic stays on dynamically allocated loopback ports; no provider account or
public network is used.

`packages/resend/tests/webhook_commands_test.ts` extends the same parity helper
and control-environment approach to direct send, list, inspect, failed delivery,
wait timeout, successful wait, and redelivery. Each CLI/SDK path resets the same
host. Two subscribed destinations prove direct send selects only the explicit
recipient. A loopback receiver first refuses, then succeeds after secret
rotation. The test compares results, safe errors and events; independently
checks no email mutation, two attempts, identical request bodies and provider
IDs, changed signatures, and omission of secrets and response bytes. Only
observed generated IDs/times and the serialized event timestamp are normalized.

The core delivery-command tests additionally count idle wait reads (one), verify
notification wakeup and listener cleanup, and check duration bounds and control
timeout budgeting. All of these tests run in `deno task check`.
