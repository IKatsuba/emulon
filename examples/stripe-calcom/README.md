# Stripe and Cal.com from installed npm archives

This example exercises one project host with both plugins through the CLI,
connected SDK, official `stripe@18.0.0` client and Cal.com API v2 `fetch` calls.
It creates three customers and three bookings, verifies six webhook bodies with
independent HMAC computations (plus Stripe's official verifier), compares
CLI/SDK manifests to installed package metadata, and starts a separate private
environment. After private disposal it binds both former ports again to prove
listener release.

Only loopback listeners with dynamically allocated ports are used. The scenario
covers Stripe customers, fixed UTC Cal.com slots and bookings; it does not
simulate payments or calendar synchronization or establish live-provider
equivalence. Run against a fresh project because the example expects exactly
three deliveries per service. Slots use June 1, 2099 and must remain in the
future.

## Reproduce the complete offline matrix

From the repository, with Deno, Node and npm available:

```sh
deno task build:npm
deno task verify:dist
```

The build prepares every plugin archive and the complete test-only Stripe npm
dependency graph before verification. Dependency preparation may require cached
packages or registry access; the verification phase needs no public network.
Stripe remains a consumer test dependency and is absent from plugin
dependencies.

`verify:dist` copies this exact `main.mjs` into fresh installations outside the
workspace. For each runtime it installs core and dependency archives offline,
serves the two plugin archives from a loopback registry, and runs `init`,
`add stripe calcom`, and `up`. The local registry implements installation only;
no request is forwarded elsewhere. Node's PATH contains Node/npm but no Deno.
Deno runs with `--cached-only` and loopback-only network permission. Both run
the same example and stop the project with `down`; installed declarations are
checked with TypeScript and additionally with `deno check` for Deno.

## Run the consumer example yourself

In a separate npm project, install the built `emulon`, `@emulon/stripe`,
`@emulon/calcom` archives and `stripe@18.0.0` with their dependencies, then copy
`main.mjs` into that project. Initialize and add the plugins (configure a local
registry or offline cache if reproducing without public access):

```sh
npx emulon init
npx emulon add stripe calcom
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

The receiver uses Node-compatible HTTP/crypto APIs supported by both runtimes;
these are consumer code, not plugin runtime dependencies. Example credentials
are local only. The script prints an acceptance summary without printing issued
keys or destination signatures. The existing plugin tests separately cover retry
and manual redelivery policies; this combined example proves successful
delivery.
