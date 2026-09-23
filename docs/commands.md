# Command registry

Plugins declare a flat registry keyed by SDK paths, such as `emails.send`.
`defineCommand` takes a description, Zod v4 input/output schemas, CLI metadata,
and an executor receiving the same instance context as `setup`. SDK clients
contain only declared commands. An input uses the schema's input type; execution
receives its parsed output type; callers receive the output schema's parsed
type.

```ts
import { defineCommand } from 'emulon';
import { z } from 'zod';

const send = defineCommand({
  description: 'Send an email',
  input: z.object({ to: z.string().email() }),
  output: z.object({ to: z.string() }),
  cli: { path: ['emails', 'send'], flags: { recipient: 'to' } },
  execute(_ctx, input) {
    return input;
  },
});
// Use commands: { "emails.send": send } in definePlugin.
```

`env.services.mail.emails.send({ to: "a@example.test" })` and
`emulon mail emails send --recipient a@example.test --json` dispatch through the
same registry handler. CLI flag keys map to input property names. Strings are
literal, including unions whose alternatives are all strings; numbers, booleans,
arrays and objects use JSON values. A bare boolean flag means true;
`--flag=false` means false. Defaults come from Zod. Unknown or repeated flags
and missing values fail with `CLI_INVALID_ARGUMENTS`. Instance and command help
are generated from declarations and JSON Schema in the running environment.
Global `--environment <name>` selects the environment and is reserved alongside
`--help` and `--json`.

Schemas must support Zod's JSON Schema conversion on both input and output
sides. Inputs must be objects with declared fields, each mapped to a CLI flag
(including optional fields) or the single string field named by
`cli.positional`. The positional value follows the command path. Scalar inputs,
root unions/intersections and open-ended input properties are unsupported. Flag
schemas mixing strings with other types, including nullable strings, are
rejected because literal strings and JSON tokens would be ambiguous. Referenced
and intersected flag schemas are also unsupported; nested objects and arrays use
explicit JSON values. These checks run at declaration and again before any
plugin setup.

Runtime values must be JSON data: no undefined values, non-finite numbers,
cycles, class instances, dates, functions, or binary streams. Unsupported
schemas fail at declaration/registration time. Input/output parsing and a JSON
copy run in the shared handler so neither frontend exposes references into
plugin state.

Errors have `code`, `message`, `fields` (paths and Zod issue codes), and
`available` (names for lookup failures). `VALIDATION_ERROR` covers input;
`OUTPUT_VALIDATION_ERROR` covers plugin results. `UNKNOWN_INSTANCE` and
`UNKNOWN_COMMAND` are resolved before execution in the running registry.
`DomainError(code, message)` from `emulon` lets an executor explicitly declare a
safe domain failure. Only its code and message are copied into the error
envelope; stack traces and extra properties are discarded. Use static messages
and never include credentials, raw inputs, or underlying exception text. For
example, GitHub issue creation reports `REPOSITORY_NOT_FOUND` and explains how
to configure `github fixtures.repositories`. `COMMAND_FAILED` hides all other
executor exception text (apart from the core's fixed delivery errors).
Diagnostics omit input values and custom schema messages to avoid exposing
credentials. Output validation happens after execution and does not roll back
mutations.

Disposal immediately rejects new invocations with `ENVIRONMENT_CLOSED`.
Invocations still validating input cannot enter execution after disposal begins;
they fail with `ENVIRONMENT_CLOSED` if validation succeeds, or their validation
error if it fails. Disposal does not wait for pending input validation.
Execution already in progress, including output validation, drains before
listeners and plugins stop, even when commands fail. Plugin executors and output
refinements must terminate for disposal to finish.

Run `emulon up` in one terminal, then service commands in another. The
executable CLI discovers the selected project's running environment and sends
commands to its authenticated control API. It never starts another copy of
service state. Use `emulon status` for instance addresses and `emulon down` to
stop the host. `--environment <name>` selects a parallel environment for all
these calls.

The SDK can attach with `await Emulon.connect({ config })`, preserving the same
service/command types as `Emulon.start(config)`. Optional `directory` and
`environment` select the project and discovery slot. With no config, `connect()`
loads the project's declarations and returns dynamically keyed types. Disposing
an attached client disconnects only that client; disposing a started environment
stops its resources. See [ADR 0007](decisions/0007-control-api-and-discovery.md)
for protocol, credentials, timeouts and stale-record recovery.

Transactional in-memory storage and SDK reset are provided by
[ADR 0017](decisions/0017-state-store.md). Reset pauses admission, drains
executing commands and rejects input validation spanning generations. Event
reads spanning reset fail with `ENVIRONMENT_RESETTING`; follow streams are
interrupted and must be reopened after reset. See
[ADR 0026](decisions/0026-reset-observation-barrier.md). File/blob inputs are
not supported yet. Project CLI hosts now retain command state across restarts
via [ADR 0016](decisions/0016-durable-state.md); private SDK starts remain in
memory. The Resend reference plugin now supplies `emails.list`, `emails.get`,
`emails.clear` and explicit `keys.create` commands. Empty-input SDK commands
accept an omitted argument. `emulon reset` calls the same host lifecycle as
`env.reset()`. See [Resend](../packages/resend/README.md).
