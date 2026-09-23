# Querying plugin compatibility

The declarations in [GitHub](../packages/github/src/compatibility.ts),
[Resend](../packages/resend/src/compatibility.ts),
[Stripe](../packages/stripe/src/compatibility.ts),
[Cal.com](../packages/calcom/src/compatibility.ts) and
[Polar](../packages/polar/src/compatibility.ts) are the source for versioned,
validated compatibility metadata. They describe the tested subset, including
unsupported features and intentional provider differences. They contain no
instance configuration or issued credentials. `/health` is a host probe, not a
provider operation.

```sh
emulon github compatibility get --json
emulon mail compatibility get --json
```

```ts
const manifest = await env.services.mail.compatibility.get({});
```

The command takes no flags or input fields. Without `--json`, the CLI prints
pretty JSON. Started SDKs read the registered declaration; connected SDKs read
the host's declaration, even when their local plugin metadata differs. Reset
does not change the declaration. npm packages contain the same normalized object
at `package.json` → `emulon.compatibility`.

Plugin authors can pass `defineCompatibility(...)` as `compatibility` to
`definePlugin`. Validation clones and deeply freezes the declaration, checks
references and rejects unknown fields. The definition's package name and
capabilities must match. The host adds `compatibility.get` with its inferred SDK
result type; an authored command with that name or CLI path is rejected.
Third-party plugins may omit the declaration.

## Coverage and verification

GitHub and Resend use `tests/compatibility_test.ts` to import executable case
registries from `*_cases.ts`; Stripe registers and runs its provider contract in
`tests/customers_test.ts`, and Polar does the same for its customer, webhook and
parity registries. Cases retain the original assertions for provider requests,
response projections, errors, authorization, events and signatures. The runner
checks equality of declared and registered case IDs, suite paths, and the
operation/event/webhook coverage of each case, then executes every registered
case. A mutation test adds an operation using an existing case ID and proves
that coverage validation rejects it.

`deno task check` runs these suites, the schema/command tests, npm builds and
isolated offline Node/Deno installations. Installed consumers compare source,
npm metadata, CLI and started/connected SDK results, including reset and
credential isolation. Public declaration checks preserve the SDK command and
manifest result types. These checks use loopback receivers and no live provider.
See [ADR 0028](decisions/0028-compatibility-manifest.md) for the contract.
