# Polar from installed npm archives

This example drives one project host through the CLI, the connected typed SDK,
plain HTTP and the official `@polar-sh/sdk@0.49.0` client with a loopback
`serverURL`. It creates three customers — one per caller path — reads each one
back through the others, receives four signed `customer.created` deliveries
(three creations and one manual redelivery) on a loopback receiver, and verifies
every one twice: once with its own HMAC-SHA256 computation over the exact
`id.timestamp.body` bytes, and once with the pinned `validateEvent`. It compares
the manifest from the CLI, the connected SDK and installed npm metadata, checks
that no caller-visible result carries the issued token or the signing secret,
and finally starts a private environment that keeps its own state and releases
its listener.

Only loopback listeners with dynamically allocated ports are used. The scenario
covers Polar customers and their single event; it does not simulate products,
checkouts, orders or subscriptions, and it establishes no equivalence with a
live Polar account. Run it against a fresh project, because it expects exactly
three deliveries before the redelivery.

The secret is a multi-byte string that is not valid base64, which is what makes
the legacy custom-secret mode observable: the whole secret is the HMAC key and
is never stripped or decoded. See [the Polar guide](../../docs/polar.md) for the
conversions the official client applies, the version policy and the retry
differences.

## The license key lifecycle in one command

[`license.mjs`](license.mjs) needs no separate host. In the same kind of
project, with nothing running in its environment:

```sh
node license.mjs
```

It starts `emulon up` in a dedicated `polar-license-example` environment, resets
it, grants one license key through the CLI and one through the connected SDK,
and runs activate → validate → deactivate → validate with raw desktop-shaped
`fetch` on the first key and `@polar-sh/sdk@0.49.0` on the second. Both final
validations are refused with `ResourceNotFound: Not found`. It compares the
manifest from npm metadata, the CLI and the SDK, checks that inspection carries
no key, prints each step with the key's `display_key` only and stops the host.
Under Deno, pass the CLI prefix shown below and `--allow-run=deno`. See
[the guide](../../docs/polar.md#run-the-license-lifecycle).

## Reproduce the complete offline matrix

From the repository, with Deno, Node and npm available:

```sh
deno task build:npm
deno task verify:dist
```

The build prepares every plugin archive and the complete test-only
`@polar-sh/sdk` npm dependency graph before verification. Dependency preparation
may require cached packages or registry access; the verification phase needs no
public network, no registry and no provider. `verify:dist` copies this exact
`main.mjs` and `license.mjs` into a fresh project outside the workspace for each
runtime, installs the archives offline, writes an `emulon.config.ts` with
`billing: polar()`, runs a foreground `emulon up`, and then runs the example, a
restart over retained state and a `reset`. After `down` it runs `license.mjs`
twice, the second time over the restored environment. Node's PATH contains Node
and npm but no Deno; Deno runs with `--cached-only` and loopback-only network
permission. The official client and its `standardwebhooks` verifier are consumer
test dependencies and are absent from the published packages.

## Run it yourself

In a separate npm project, install the built `emulon` and `@emulon/polar`
archives together with `@polar-sh/sdk@0.49.0`, then copy `main.mjs` into it and
write `emulon.config.ts`:

```ts
import { defineConfig } from 'emulon';
import polar from '@emulon/polar';

export default defineConfig({ services: { billing: polar() } });
```

```sh
npx emulon up
```

In another terminal in that project:

```sh
node main.mjs
npx emulon down
```

For Deno, run `up` through `deno run` with the same permissions as the CLI
prefix below, and pass that prefix to the example so its subprocess CLI uses
Deno too:

```sh
deno run --no-config --no-lock --node-modules-dir=manual --cached-only \
  --allow-net=127.0.0.1 --allow-read --allow-write --allow-env --allow-run=deno \
  main.mjs '["deno",["run","--no-config","--no-lock","--node-modules-dir=manual","--cached-only","--allow-net=127.0.0.1","--allow-read","--allow-write","--allow-env","npm:emulon"]]'
```

The receiver uses Node-compatible HTTP and crypto APIs supported by both
runtimes; these are consumer code, not plugin runtime dependencies. Example
credentials are local only, and the script prints an acceptance summary without
printing issued keys, secrets or signatures. The plugin tests cover the retry
schedule, exhaustion and interrupted-send recovery separately; this example
proves successful delivery and one manual redelivery.
