// npm reads its configuration from npm_config_* environment variables.
// deno-lint-ignore-file camelcase
import { calcomProof } from './calcom-proof.ts';
import {
  compatibilityProof,
  installVersionedPackage,
} from './compatibility-proof.ts';
import ts from 'typescript';
import { managerProof } from './manager-proof.ts';
import { polarAcceptance, polarProof } from './polar-proof.ts';
import { addProof } from './add-proof.ts';
import { durableProof } from './durable-proof.ts';
import { withoutTypeStrippingNotice } from './runtime-warnings.ts';

const root = new URL('../', import.meta.url);
const archives = [];

for (
  const service of ['emulon', 'resend', 'github', 'stripe', 'calcom', 'polar']
) {
  const config = JSON.parse(
    await Deno.readTextFile(new URL(`packages/${service}/deno.json`, root)),
  );

  archives.push(
    `${config.name.replace('@', '').replace('/', '-')}-${config.version}.tgz`,
  );
}

archives.push(
  ...JSON.parse(
    await Deno.readTextFile(
      new URL('dist/npm/verification-dependencies.json', root),
    ),
  ),
);

const temporary = await Deno.realPath(
  await Deno.makeTempDir({ prefix: 'emulon-dist-' }),
);
const decoder = new TextDecoder();

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function inspectPackage(
  directory: string,
  workspacePath: string,
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;

    assert(!entry.isSymlink, `Installed package contains a symlink: ${path}`);

    if (entry.isDirectory) {
      await inspectPackage(path, workspacePath);
    } else if (/\.(js|ts|json)$/.test(entry.name)) {
      const source = await Deno.readTextFile(path);

      assert(
        !source.includes(workspacePath) && !source.includes(root.pathname),
        `Installed package references the workspace: ${path}`,
      );
    }
  }
}

try {
  const realRoot = await Deno.realPath(root);
  const realTemporary = await Deno.realPath(temporary);

  assert(
    !realTemporary.startsWith(realRoot + '/'),
    'Distribution fixtures must be outside the workspace',
  );

  for (const archive of archives) {
    try {
      await Deno.copyFile(
        new URL(`dist/npm/${archive}`, root),
        `${temporary}/${archive}`,
      );
    } catch (cause) {
      throw new Error(
        `Missing archive ${archive}; run deno task build:npm first`,
        {
          cause,
        },
      );
    }
  }

  const nodeBin = `${temporary}/node-bin`;

  await Deno.mkdir(nodeBin);
  await Deno.symlink('/bin/sh', `${nodeBin}/sh`);

  for (const name of ['node', 'npm', 'npx']) {
    let found = false;

    for (const directory of (Deno.env.get('PATH') ?? '').split(':')) {
      try {
        const path = await Deno.realPath(`${directory}/${name}`);

        await Deno.symlink(path, `${nodeBin}/${name}`);

        found = true;

        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    assert(found, `Missing local executable ${name}`);
  }

  await managerProof({ temporary, archives, nodeBin });

  for (const runtime of ['Node', 'Deno']) {
    const cwd = `${temporary}/${runtime.toLowerCase()}`;

    await Deno.mkdir(cwd);
    await Deno.writeTextFile(
      `${cwd}/package.json`,
      JSON.stringify({ private: true, type: 'module' }),
    );
    await Deno.writeTextFile(`${cwd}/empty.npmrc`, '');
    await Deno.writeTextFile(`${cwd}/global.npmrc`, '');

    const env = {
      PATH: nodeBin,
      HOME: cwd,
      TMPDIR: temporary,
      DENO_DIR: `${cwd}/deno-cache`,
      DENO_NO_UPDATE_CHECK: '1',
      NODE_OPTIONS: '--experimental-strip-types',
      npm_config_cache: `${cwd}/npm-cache`,
      npm_config_userconfig: `${cwd}/empty.npmrc`,
      npm_config_globalconfig: `${cwd}/global.npmrc`,
      npm_config_registry: 'http://127.0.0.1:1',
      npm_config_offline: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      // Early Node 22 releases require the native stripping flag.
    };
    const run = async (label: string, command: string, args: string[]) => {
      const result = await new Deno.Command(command, {
        args,
        cwd,
        env,
        clearEnv: true,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const stdout = decoder.decode(result.stdout).trim();
      const stderr = decoder.decode(result.stderr).trim();

      assert(
        result.success,
        `${runtime}: ${label} failed (exit ${result.code})\n${stdout}\n${stderr}`,
      );
      console.log(`PASS ${runtime}: ${label}${stdout ? ` — ${stdout}` : ''}`);

      return stdout;
    };

    await run(
      'runtime version',
      runtime === 'Node' ? 'node' : Deno.execPath(),
      ['--version'],
    );

    if (runtime === 'Node') {
      await run('Deno absent from consumer PATH', 'node', [
        '--input-type=module',
        '-e',
        'import { spawnSync } from "node:child_process"; if (spawnSync("deno", ["--version"]).error?.code !== "ENOENT") throw new Error("Deno is accessible");',
      ]);
    }

    await run('offline archive installation', 'npm', [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...archives.map((name) => `../${name}`),
    ]);

    if (runtime === 'Node') {
      const warnings = await new Deno.Command('node', {
        args: [
          '--input-type=module',
          '-e',
          `
const original = process.emitWarning;
await import("emulon");
if (process.emitWarning !== original) throw new Error("Warning emitter not restored");
process.emitWarning("unrelated experiment", "ExperimentalWarning");
process.emitWarning("unrelated deprecation", "DeprecationWarning");
process.emitWarning("SQLite is an experimental feature and might change at any time", "UserWarning");
`,
        ],
        cwd,
        env,
        clearEnv: true,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const stderr = decoder.decode(warnings.stderr);

      assert(
        warnings.success &&
          !stderr.includes('ExperimentalWarning: SQLite') &&
          stderr.includes('ExperimentalWarning: unrelated experiment') &&
          stderr.includes('DeprecationWarning: unrelated deprecation') &&
          stderr.includes('UserWarning: SQLite'),
        'SQLite notice suppression changed unrelated warnings: ' + stderr,
      );
      console.log(
        'PASS Node: SQLite notice suppressed; unrelated warnings preserved',
      );
    }

    for (
      const name of [
        'emulon',
        '@emulon/resend',
        '@emulon/github',
        '@emulon/stripe',
        '@emulon/calcom',
        '@emulon/polar',
        'hono',
        '@hono/node-server',
      ]
    ) {
      const directory = `${cwd}/node_modules/${name}`;

      await inspectPackage(directory, realRoot);

      const manifest = JSON.parse(
        await Deno.readTextFile(`${directory}/package.json`),
      );

      if (name === 'emulon') {
        assert(
          manifest.engines?.node === '>=22.13.0' &&
            !manifest.exports['./internal-state'],
          'Incorrect runtime floor or public storage export',
        );
        assert(
          manifest.dependencies?.hono &&
            manifest.dependencies?.['@hono/node-server'],
          'Core HTTP runtime dependencies are missing',
        );
      }

      if (name.startsWith('@emulon/')) {
        assert(
          manifest.peerDependencies?.hono && !manifest.dependencies?.hono,
          'Plugin must share Hono through a peer dependency',
        );
      }

      if (name !== 'emulon' && !name.startsWith('@emulon/')) {
        continue;
      }

      for (
        const field of ['dependencies', 'peerDependencies', 'devDependencies']
      ) {
        assert(
          (name === 'emulon' || !manifest[field]?.typescript) &&
            !manifest[field]?.resend && !manifest[field]?.stripe &&
            !manifest[field]?.standardwebhooks &&
            !Object.keys(manifest[field] ?? {}).some((name) =>
              name === 'octokit' || name.startsWith('@octokit/') ||
              name.startsWith('@polar-sh/') || name.startsWith('@stablelib/')
            ),
          `${name} ships an unexpected compiler or provider-test dependency`,
        );
      }
    }

    console.log(
      `PASS ${runtime}: no workspace references or provider-test dependencies in packages`,
    );

    const denoArgs = [
      'run',
      '--no-config',
      '--no-lock',
      '--node-modules-dir=manual',
      '--cached-only',
      '--allow-net=127.0.0.1',
      '--allow-read',
      '--allow-write',
      '--allow-env',
    ];
    const fixture = await Deno.readTextFile(
      new URL(
        '../packages/emulon/tests/fixtures/durable-process.ts',
        import.meta.url,
      ),
    );
    const installedFixture = fixture
      .replaceAll('../../src/', './node_modules/emulon/esm/')
      .replace(
        '../../../resend/src/mod.ts',
        './node_modules/@emulon/resend/esm/mod.js',
      )
      // Quote-agnostic: the fixture follows whatever quote style fmt enforces.
      .replace(/\.ts(['"])/g, '.js$1');

    await Deno.writeTextFile(
      `${cwd}/durable-process.mjs`,
      ts.transpileModule(installedFixture, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    );
    await durableProof({
      command: runtime === 'Node' ? 'node' : Deno.execPath(),
      args: runtime === 'Node'
        ? ['durable-process.mjs']
        : [...denoArgs, 'durable-process.mjs'],
      cwd,
      env,
      ...(runtime === 'Deno'
        ? { alternate: { command: 'node', args: ['durable-process.mjs'] } }
        : {}),
    });
    console.log(
      `PASS ${runtime}: durable proof (${
        runtime === 'Deno'
          ? 'alternating Deno/Node processes'
          : 'Node-only processes'
      })`,
    );
    await Deno.writeTextFile(
      `${cwd}/durable.mjs`,
      `
import { sqliteCoordinator } from "./node_modules/emulon/esm/runtime/sqlite-state.js";
const path = ${JSON.stringify(temporary + '/durable/state.sqlite')};
const c = sqliteCoordinator(path);
const version = { pluginVersion: "1", schemaVersion: 1 };
c.prepare([{ instanceId: "mail", plugin: "probe", version }]);
const h = await c.open({ environmentId: c.environmentId, instanceId: "mail", version, fixtures: [] });
const previous = await h.store.transaction(tx => tx.get("c", "graph"));
if (previous) {
  if (previous.uuid !== c.environmentId || previous.self !== previous || previous.bytes.buffer !== previous.view.buffer || previous.bytes[0] !== 42 || previous.bytes.byteOffset !== 2 || previous.bytes.byteLength !== 4 || previous.view.byteOffset !== 1 || previous.view.byteLength !== 8 || previous.big !== 42n || previous.map.get(previous) !== previous.bytes) throw new Error("Durable graph lost identity or values");
  if (previous.set.values().next().value !== previous || previous.date.getTime() !== 123 || !Number.isNaN(previous.invalidDate.getTime()) || previous.regexp.source !== "a+b" || previous.regexp.flags !== "gi" || previous.error.cause !== previous || previous.sparse.length !== 4 || 0 in previous.sparse || !(2 in previous.sparse) || previous.sparse[2] !== undefined || !Object.is(previous.negativeZero, -0) || previous.infinity !== Infinity || !Number.isNaN(previous.nan) || Object.getOwnPropertyDescriptor(previous, "__proto__").value !== "own-data") throw new Error("Durable graph scalar/container fidelity lost");
  if ((await h.store.transaction(tx => tx.outbox())).length !== 1) throw new Error("Outbox lost");
  // Re-encode in each runtime so the following process checks both directions.
  await h.store.transaction(tx => tx.put({ collection: "c", id: "graph", value: previous }));
} else {
  const buffer = new ArrayBuffer(16);
  const value = { uuid: c.environmentId, bytes: new Uint8Array(buffer, 2, 4), view: new DataView(buffer, 1, 8), big: 42n, map: new Map() };
  value.self = value; value.bytes[0] = 42; value.map.set(value, value.bytes);
  value.set = new Set([value, value.bytes]); value.date = new Date(123); value.invalidDate = new Date(NaN); value.regexp = /a+b/gi;
  value.error = new Error("graph-error", { cause: value }); value.sparse = new Array(4); value.sparse[2] = undefined;
  value.negativeZero = -0; value.infinity = Infinity; value.nan = NaN;
  Object.defineProperty(value, "__proto__", { value: "own-data", enumerable: true });
  await h.store.transaction(async tx => {
    await tx.put({ collection: "c", id: "graph", value });
    await tx.record({ type: "probe", origin: "service", occurredAt: "now", payload: value });
  });
}
try { sqliteCoordinator(path); throw new Error("Ownership not held"); } catch (e) { if (!e.message.includes("STATE_IN_USE")) throw e; }
c.close();
console.log(previous ? "reopened graph and atomic outbox" : "committed graph and atomic outbox");
`,
    );

    for (
      const executor
        of (runtime === 'Node' ? ['Node', 'Node'] : ['Deno', 'Node', 'Deno'])
    ) {
      await run(
        `durable SQLite ${executor} fresh process`,
        executor === 'Node' ? 'node' : Deno.execPath(),
        executor === 'Node' ? ['durable.mjs'] : [...denoArgs, 'durable.mjs'],
      );
    }

    await Deno.writeTextFile(
      `${cwd}/hold-state.mjs`,
      `
import process from "node:process";
import { sqliteCoordinator } from "./node_modules/emulon/esm/runtime/sqlite-state.js";
const c = sqliteCoordinator(${
        JSON.stringify(temporary + '/durable/state.sqlite')
      });
console.log("OWNED");
await new Promise(resolve => process.stdin.once("data", resolve));
process.stdin.pause();
c.close();
`,
    );
    await Deno.writeTextFile(
      `${cwd}/contend-state.mjs`,
      `
import { sqliteCoordinator } from "./node_modules/emulon/esm/runtime/sqlite-state.js";
try { sqliteCoordinator(${
        JSON.stringify(temporary + '/durable/state.sqlite')
      }); throw new Error("Competing owner acquired database"); }
catch (e) { if (!e.message.includes("STATE_IN_USE")) throw e; }
console.log("STATE_IN_USE before instance preparation");
`,
    );

    const owner = new Deno.Command(
      runtime === 'Node' ? 'node' : Deno.execPath(),
      {
        args: runtime === 'Node'
          ? ['hold-state.mjs']
          : [...denoArgs, 'hold-state.mjs'],
        cwd,
        env,
        clearEnv: true,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'inherit',
      },
    ).spawn();

    try {
      const reader = owner.stdout.getReader();
      let ready = '';

      while (!ready.includes('\n')) {
        const part = await reader.read();

        assert(!part.done, 'SQLite owner exited before acquiring lock');

        ready += decoder.decode(part.value);
      }

      reader.releaseLock();
      assert(ready.trim() === 'OWNED', 'SQLite owner did not acquire lock');

      for (const executor of ['Node', 'Deno']) {
        await run(
          `SQLite competing ${executor} process`,
          executor === 'Node' ? 'node' : Deno.execPath(),
          executor === 'Node'
            ? ['contend-state.mjs']
            : [...denoArgs, 'contend-state.mjs'],
        );
      }
    } finally {
      const writer = owner.stdin.getWriter();

      await writer.write(new TextEncoder().encode('close\n'));
      await writer.close();
      assert((await owner.status).success, 'SQLite owner close failed');
      await owner.stdout.cancel();
    }

    const cli = runtime === 'Node'
      ? ['npx', ['--offline', '--no-install', 'emulon']] as const
      : [Deno.execPath(), [...denoArgs, 'npm:emulon']] as const;
    const version = await run('CLI --version', cli[0], [
      ...cli[1],
      '--json',
      '--version',
    ]);
    const installed = JSON.parse(
      await Deno.readTextFile(`${cwd}/node_modules/emulon/package.json`),
    );

    assert(
      JSON.parse(version).version === installed.version,
      'Wrong CLI version',
    );

    const init = await run('CLI init', cli[0], [...cli[1], '--json', 'init']);

    assert(
      JSON.parse(init).created === 'emulon.config.ts',
      'Wrong init result',
    );

    await addProof({ cwd, env, runtime, denoArgs, archives });
    await addProof({ cwd, env, runtime, denoArgs, archives, combined: true });

    const prefix = runtime === 'Deno' ? 'npm:' : '';

    await installVersionedPackage(cwd);
    await Deno.writeTextFile(
      `${cwd}/compatibility.mjs`,
      compatibilityProof(prefix),
    );
    await run(
      'installed compatibility manifest',
      runtime === 'Node' ? 'node' : Deno.execPath(),
      runtime === 'Node'
        ? ['compatibility.mjs']
        : [...denoArgs, 'compatibility.mjs'],
    );
    await Deno.writeTextFile(`${cwd}/polar.mjs`, polarProof(prefix));
    await run(
      'installed Polar resource smoke',
      runtime === 'Node' ? 'node' : Deno.execPath(),
      runtime === 'Node' ? ['polar.mjs'] : [...denoArgs, 'polar.mjs'],
    );
    await polarAcceptance({
      cwd,
      archiveDirectory: temporary,
      env,
      runtime,
      denoArgs,
      archives,
    });
    await Deno.writeTextFile(`${cwd}/calcom.mjs`, calcomProof(prefix));
    await run(
      'installed Cal.com contract',
      runtime === 'Node' ? 'node' : Deno.execPath(),
      runtime === 'Node' ? ['calcom.mjs'] : [...denoArgs, 'calcom.mjs'],
    );

    const source = `
import { Emulon, defineConfig, definePlugin } from "${prefix}emulon";
import resend from "${prefix}@emulon/resend";
import github from "${prefix}@emulon/github";
import stripe from "${prefix}@emulon/stripe";
function assert(value, message) { if (!value) throw new Error(message); }
const stripeEnv = await Emulon.start({ services: { stripe: stripe() } });
try {
  const customer = await stripeEnv.services.stripe.customers.create({ name: "Installed", idempotencyKey: "installed" });
  assert((await stripeEnv.services.stripe.customers.create({ name: "Installed", idempotencyKey: "installed" })).id === customer.id, "Stripe replay failed");
  const { apiKey } = await stripeEnv.services.stripe.keys.create({});
  const read = await fetch(stripeEnv.endpoints.stripe.api + "/v1/customers/" + customer.id, { headers: { authorization: "Bearer " + apiKey } });
  assert(read.status === 200 && (await read.json()).name === "Installed", "Stripe HTTP read failed");
  const created = await fetch(stripeEnv.endpoints.stripe.api + "/v1/customers", { method: "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/x-www-form-urlencoded" }, body: "name=HTTP" });
  assert(created.status === 200, "Stripe HTTP create failed");
  assert((await stripeEnv.services.stripe.customers.get({ id: (await created.json()).id })).name === "HTTP", "Stripe SDK read failed");
  const manifest = await stripeEnv.services.stripe.compatibility.get({});
  assert(manifest.capabilities.includes("webhooks"), "Stripe webhooks missing");
} finally { await stripeEnv.dispose(); }
const versionedStripe = await Emulon.start({ services: { stripe: stripe({ apiVersions: ["2026-04-22.dahlia", "2025-03-31.basil"] }) } });
try {
  const { apiKey } = await versionedStripe.services.stripe.keys.create({});
  const call = async (path, version, body) => {
    const response = await fetch(versionedStripe.endpoints.stripe.api + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + apiKey, "content-type": "application/x-www-form-urlencoded", "stripe-version": version }, body });
    return { status: response.status, version: response.headers.get("stripe-version"), value: await response.json() };
  };
  const coupon = await call("/v1/coupons", "2025-03-31.basil", "percent_off=10");
  const basil = await call("/v1/promotion_codes", "2025-03-31.basil", "coupon=" + coupon.value.id);
  assert(basil.status === 200 && basil.version === "2025-03-31.basil" && basil.value.coupon.id === coupon.value.id && basil.value.promotion === undefined, "Stripe basil promotion code failed");
  const dahlia = await call("/v1/promotion_codes/" + basil.value.id, "2026-04-22.dahlia");
  assert(dahlia.value.promotion.coupon === coupon.value.id && dahlia.value.coupon === undefined, "Stripe dahlia read of a basil code failed");
  assert((await call("/v1/promotion_codes", "2026-04-22.dahlia", "coupon=" + coupon.value.id)).status === 400, "Stripe dahlia accepted the basil shape");
  assert((await call("/v1/promotion_codes", "2025-03-31.basil", "promotion[type]=coupon&promotion[coupon]=" + coupon.value.id)).status === 400, "Stripe basil accepted the dahlia shape");
} finally { await versionedStripe.dispose(); }
const githubEnv = await Emulon.start({ services: { github: github({ fixtures: { users: [{ login: "igor" }], repositories: [{ owner: "igor", name: "demo" }] } }) } });
try {
  const app = await githubEnv.services.github.apps.create({ slug: "review-bot" });
  assert(app.privateKey.startsWith("-----BEGIN PRIVATE KEY-----"), "GitHub key missing");
  const installation = await githubEnv.services.github.installations.create({ appId: app.id, account: "igor", repositories: ["igor/demo"] });
  assert((await githubEnv.services.github.installations.suspend({ id: installation.id })).suspended, "GitHub suspension failed");
  for (const endpoint of Object.values(githubEnv.endpoints.github)) {
    const response = await fetch(endpoint + "/unknown");
    assert(response.status === 404, "GitHub unknown route accepted");
    await response.json();
  }
} finally { await githubEnv.dispose(); }
const mail = resend();
const loaded = await Emulon.load(defineConfig({ services: { mail } }));
assert(loaded.services.mail === mail, "Registration identity lost");
const generated = await Emulon.load();
assert(Object.keys(generated.services).length === 0, "Generated config failed");
const config = { services: { mail: resend() } };
const env = await Emulon.start(config);
const url = env.endpoints.mail.api;
const response = await fetch(url + "/health");
assert(response.status === 200 && (await response.json()).status === "ok", "HTTP probe failed");
const { apiKey } = await env.services.mail.keys.create();
const sent = await fetch(url + "/emails", {
  method: "POST", headers: { authorization: "Bearer " + apiKey },
  body: JSON.stringify({ from: "sender@example.test", to: "to@example.test", subject: "Local", text: "Node and Deno" })
});
assert(sent.status === 200, "Provider send failed");
const { id } = await sent.json();
const read = await fetch(url + "/emails/" + id, { headers: { authorization: "Bearer " + apiKey } });
assert(read.status === 200 && (await read.json()).text === "Node and Deno", "Provider read failed");
assert((await env.services.mail.emails.list())[0].id === id, "Provider and SDK state differ");
await env.reset();
assert((await env.services.mail.emails.list()).length === 0, "Provider state survives reset");
const denied = await fetch(url + "/emails/" + id, { headers: { authorization: "Bearer " + apiKey } });
assert(denied.status === 403, "Provider key survives reset");
await denied.json();
await Promise.all([env.dispose(), env[Symbol.asyncDispose]()]);
async function closed(url) {
  try { const response = await fetch(url); await response.body?.cancel(); }
  catch { return; }
  throw new Error("Listener remains open");
}
await closed(url);
const again = await Emulon.start(config);
await again.dispose();
const echo = definePlugin({
  name: "echo", apiVersion: 1, capabilities: ["http"], commands: {},
  async setup(ctx) {
    ctx.http.surface("api", { maxBodyBytes: 4 }).post("/echo", async (c) => {
      const request = c.req.raw;
      return new Response(await request.text());
    });
    const api = await ctx.http.listen("api");
    return { endpoints: { api }, async ready() {}, async stop() {} };
  }
});
const bounded = await Emulon.start({ services: { echo: echo() } });
try {
  for (const [body, status] of [["four", 200], ["large", 413]]) {
    const response = await fetch(bounded.endpoints.echo.api + "/echo", { method: "POST", body });
    assert(response.status === status, "Body bound failed: " + response.status);
    await response.text();
  }
} finally { await bounded.dispose(); }
const cookies = ["a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT", "b=2; Path=/; HttpOnly"];
let receivedURL;
const redirect = definePlugin({
  name: "redirect", apiVersion: 1, capabilities: ["http"], commands: {},
  async setup(ctx) {
    ctx.http.surface("api").get("/start", (c) => {
      const request = c.req.raw;
      receivedURL = request.url;
      const headers = new Headers({ location: new URL("/next", request.url).href });
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(null, { status: 302, headers });
    });
    const api = await ctx.http.listen("api");
    return { endpoints: { api }, async ready() {}, async stop() {} };
  }
});
const redirects = await Emulon.start({ services: { redirect: redirect() } });
try {
  const api = redirects.endpoints.redirect.api;
  const response = await fetch(api + "/start?value=a%20b", { redirect: "manual" });
  await response.body?.cancel();
  assert(receivedURL === api + "/start?value=a%20b", "Request URL lost origin, path or query");
  assert(response.status === 302 && response.headers.get("location") === api + "/next", "Redirect lost listener origin");
  assert(JSON.stringify(response.headers.getSetCookie()) === JSON.stringify(cookies), "Response cookies lost or combined");
} finally { await redirects.dispose(); }
const urls = [];
const fixture = definePlugin({
  name: "fixture", apiVersion: 1, capabilities: ["http"], commands: {},
  async setup(ctx, fail) {
    ctx.http.surface("api");
    const api = await ctx.http.listen("api");
    urls.push(api);
    return { endpoints: { api }, async ready() { if (fail) throw new Error("secret"); }, async stop() {} };
  }
});
let failed = false;
try { await Emulon.start({ services: { good: fixture(false), broken: fixture(true) } }); }
catch (error) { failed = error.message.includes('"broken"') && !error.message.includes("secret"); }
assert(failed, "Readiness failure must name instance");
for (const endpoint of urls) await closed(endpoint);
console.log("imports, SDK, config, convention, Resend send/read/reset, HTTP lifecycle, redirects, cookies, rollback");
`;

    await Deno.writeTextFile(`${cwd}/consumer.mjs`, source);
    await run(
      'installed consumer',
      runtime === 'Node' ? 'node' : Deno.execPath(),
      runtime === 'Node' ? ['consumer.mjs'] : [...denoArgs, 'consumer.mjs'],
    );
    await Deno.mkdir(`${cwd}/configured`);
    await Deno.writeTextFile(
      `${cwd}/configured/emulon.config.ts`,
      'import { defineConfig } from "emulon";\n' +
        'import resend from "@emulon/resend";\n' +
        'export default defineConfig({ services: { mail: resend() } });\n',
    );
    await Deno.writeTextFile(
      `${cwd}/configured.mjs`,
      `import { Emulon } from "${prefix}emulon";
const config = await Emulon.load("./configured");
if (!config.services.mail) throw new Error("Configured plugin missing");
console.log("plugin configuration loaded");`,
    );
    await run(
      'configuration with installed plugin',
      runtime === 'Node' ? 'node' : Deno.execPath(),
      runtime === 'Node' ? ['configured.mjs'] : [...denoArgs, 'configured.mjs'],
    );
    await Deno.writeTextFile(
      `${cwd}/emulon.config.ts`,
      `
import { defineConfig, definePlugin, defineCommand } from "emulon";
import { z } from "zod";
import stripe from "@emulon/stripe";
import github from "@emulon/github";
const fixture = definePlugin({
  name: "command-fixture", apiVersion: 1, capabilities: [],
  commands: { crash: defineCommand({
    description: "Throw an unexpected private failure", input: z.object({}), output: z.boolean(),
    cli: { path: ["crash"], flags: {} },
    execute() { throw new Error("secret-unexpected-exception"); },
  }), "emails.send": defineCommand({
    description: "Send fixture email", input: z.object({ to: z.string().email() }),
    output: z.object({ to: z.string(), accepted: z.boolean(), count: z.number() }),
    cli: { path: ["emails", "send"], flags: { recipient: "to" } },
    execute(ctx, input) { return ctx.store.transaction(async (tx) => {
      const count = (await tx.get("counts", "sent") ?? 0) + 1;
      await tx.put({ collection: "counts", id: "sent", value: count });
      return { to: input.to, accepted: true, count };
    }); },
  }) },
  setup: async () => ({ endpoints: {}, ready: async () => {}, stop: async () => {} }),
});
export default defineConfig({ services: { mail: fixture(), stripe: stripe(), github: github() } });
`,
    );

    const foreground = async (restored = true, json = true) => {
      const child = new Deno.Command(
        runtime === 'Node' ? 'node' : Deno.execPath(),
        {
          args: runtime === 'Node'
            ? [
              'node_modules/emulon/esm/cli/main.js',
              'up',
              ...(json ? ['--json'] : []),
            ]
            : [...denoArgs, 'npm:emulon', 'up', ...(json ? ['--json'] : [])],
          cwd,
          env,
          clearEnv: true,
          stdout: 'piped',
          stderr: 'piped',
        },
      ).spawn();
      const reader = child.stdout.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const output = await Promise.race([
          (async () => {
            let text = '';

            while (true) {
              const chunk = await reader.read();

              if (chunk.done) {
                throw new Error('CLI up exited before readiness');
              }

              text += decoder.decode(chunk.value, { stream: true });

              try {
                return JSON.parse(text);
              } catch { /* Read the remaining JSON. */ }
            }
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('CLI up readiness timeout')),
              10000,
            );
          }),
        ]);

        assert(output.endpoints, 'CLI up did not report readiness');

        if (restored) {
          const notice = output.notices?.[0];

          assert(
            notice?.code === 'STATE_RESTORED' &&
              JSON.stringify(notice.instances) ===
                JSON.stringify(['mail', 'stripe', 'github']) &&
              notice.message.includes('fixtures were not reapplied') &&
              notice.message.includes('emulon reset --environment default') &&
              notice.message.includes(
                'replaces state for all active instances',
              ),
            'CLI up omitted actionable restored-state notice',
          );
          console.log(
            runtime + ' CLI restore notice: ' + JSON.stringify(notice),
          );
        } else {
          assert(!output.notices, 'Fresh state reported as restored');
        }

        return child;
      } catch (error) {
        try {
          child.kill('SIGKILL');
        } catch { /* The child may already have exited. */ }

        await child.status;

        throw error;
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
      }
    };

    const host = await foreground(false);
    let stripeCustomer;
    const replayStripe = async () => {
      const customer = JSON.parse(
        await run('CLI Stripe durable replay', cli[0], [
          ...cli[1],
          'stripe',
          'customers',
          'create',
          '--name',
          'Durable',
          '--idempotency-key',
          'durable',
          '--json',
        ]),
      );
      const events = JSON.parse(
        await run('Stripe durable outbox', cli[0], [
          ...cli[1],
          'events',
          '--type',
          'customer.created',
          '--json',
        ]),
      );

      assert(
        events.length === 1 && events[0].payload.data.object.id === customer.id,
        'Stripe replay duplicated or lost its event',
      );

      return customer;
    };

    try {
      const expectedDomain = {
        code: 'REPOSITORY_NOT_FOUND',
        message:
          'Repository not found. Configure it in github fixtures.repositories before creating an issue.',
        fields: [],
        available: [],
      };
      const expectedCrash = {
        code: 'COMMAND_FAILED',
        message: 'Command execution failed.',
        fields: [],
        available: [],
      };

      for (
        const [args, expected] of [
          [[
            'github',
            'issues',
            'create',
            '--repo',
            'secret-input/missing',
            '--title',
            'X',
          ], expectedDomain],
          [['mail', 'crash'], expectedCrash],
        ] as const
      ) {
        for (const json of [true, false]) {
          const result = await new Deno.Command(cli[0], {
            args: [...cli[1], ...args, ...(json ? ['--json'] : [])],
            cwd,
            env,
            clearEnv: true,
            stdout: 'piped',
            stderr: 'piped',
          }).output();
          const stderr = withoutTypeStrippingNotice(
            decoder.decode(result.stderr),
          ).trim();

          assert(
            result.code === 1 && result.stdout.length === 0,
            'CLI failure exit/output mismatch',
          );
          assert(
            json
              ? JSON.stringify(JSON.parse(stderr).error) ===
                JSON.stringify(expected)
              : stderr === expected.code + ': ' + expected.message,
            'Installed CLI error mismatch: ' + stderr,
          );
          console.log(runtime + ' CLI safe failure: ' + stderr);
        }
      }

      await Deno.writeTextFile(
        `${cwd}/command-errors.mjs`,
        `
import { Emulon } from "${prefix}emulon";
const config = await Emulon.load();
const expected = ${JSON.stringify([expectedDomain, expectedCrash])};
for (const client of [await Emulon.start(config), await Emulon.connect({ config })]) {
  try {
    const actions = [
      () => client.services.github.issues.create({ repository: "secret-input/missing", title: "X" }),
      () => client.services.mail.crash(),
    ];
    for (let index = 0; index < actions.length; index++) {
      let caught = false;
      try { await actions[index](); } catch (error) {
        caught = true;
        if (JSON.stringify(error.toJSON()) !== JSON.stringify(expected[index])) throw error;
        console.log(JSON.stringify(error.toJSON()));
      }
      if (!caught) throw new Error("SDK command unexpectedly succeeded");
    }
  } finally { await client.dispose(); }
}
`,
      );
      await run(
        'SDK safe domain and unexpected failures',
        runtime === 'Node' ? 'node' : Deno.execPath(),
        runtime === 'Node'
          ? ['command-errors.mjs']
          : [...denoArgs, 'command-errors.mjs'],
      );

      stripeCustomer = await replayStripe();

      const commandResult = await run('CLI declared command', cli[0], [
        ...cli[1],
        'mail',
        'emails',
        'send',
        '--recipient',
        'a@example.test',
        '--json',
      ]);

      await Deno.writeTextFile(
        `${cwd}/command.mjs`,
        `
import { Emulon } from "${prefix}emulon";
const config = await Emulon.load();
const env = await Emulon.connect({ config: { services: config.services } });
try { console.log(JSON.stringify(await env.services.mail.emails.send({ to: "a@example.test" }))); }
finally { await env.dispose(); }
`,
      );

      const sdkResult = await run(
        'SDK declared command',
        runtime === 'Node' ? 'node' : Deno.execPath(),
        runtime === 'Node' ? ['command.mjs'] : [...denoArgs, 'command.mjs'],
      );
      const cliValue = JSON.parse(commandResult);
      const sdkValue = JSON.parse(sdkResult);

      assert(
        cliValue.count === 1 && sdkValue.count === 2 &&
          cliValue.to === sdkValue.to && sdkValue.accepted,
        'CLI and connected SDK do not share command state',
      );
      await run('CLI status', cli[0], [...cli[1], 'status', '--json']);
      await run('CLI down', cli[0], [...cli[1], 'down', '--json']);
      assert((await host.status).success, 'CLI up failed during shutdown');
    } finally {
      try {
        host.kill('SIGKILL');
      } catch { /* Shutdown already completed. */ }

      await host.status;
      await host.stdout.cancel();
      await host.stderr.cancel();
    }

    const configPath = `${cwd}/emulon.config.ts`;

    await Deno.writeTextFile(
      configPath,
      (await Deno.readTextFile(configPath)).replace(
        'github: github()',
        'github: github({ fixtures: { users: [{ login: "igor" }], repositories: [{ owner: "igor", name: "demo" }] } })',
      ),
    );

    let expectedCount = 2;

    for (const signal of ['SIGINT', 'SIGKILL'] as const) {
      const child = await foreground();

      assert(
        (await replayStripe()).id === stripeCustomer.id,
        'Stripe replay lost after process restart',
      );

      const reopened = JSON.parse(
        await run(
          'SDK durable host restart',
          runtime === 'Node' ? 'node' : Deno.execPath(),
          runtime === 'Node' ? ['command.mjs'] : [...denoArgs, 'command.mjs'],
        ),
      );

      assert(
        reopened.count === ++expectedCount,
        'Connected SDK lost committed CLI/SDK state on reopen',
      );
      child.kill(signal);
      await child.status;
      await child.stdout.cancel();
      await child.stderr.cancel();

      const record = `${cwd}/.emulon/default.json`;

      if (signal === 'SIGINT') {
        let exists = true;

        try {
          await Deno.stat(record);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            exists = false;
          } else {
            throw error;
          }
        }

        assert(!exists, 'SIGINT left discovery behind');
      } else {
        const result = await new Deno.Command(cli[0], {
          args: [...cli[1], 'status', '--json'],
          cwd,
          env,
          clearEnv: true,
          stdout: 'piped',
          stderr: 'piped',
        }).output();

        assert(
          !result.success &&
            JSON.parse(
                decoder.decode(result.stderr).split('\n').find((line) =>
                  line.startsWith('{')
                ) ?? 'null',
              ).error.code ===
              'ENVIRONMENT_STALE',
          'Killed host was not detected as stale',
        );
        await Deno.remove(record);
      }

      console.log(`PASS ${runtime}: CLI ${signal} discovery lifecycle`);
    }

    const stripeRestart = await foreground(true, false);

    try {
      assert(
        (await replayStripe()).id === stripeCustomer.id,
        'Stripe replay lost after SIGKILL',
      );
      await run('CLI apply changed fixtures', cli[0], [
        ...cli[1],
        'reset',
        '--environment',
        'default',
        '--json',
      ]);

      const issue = JSON.parse(
        await run('CLI issue after fixture reset', cli[0], [
          ...cli[1],
          'github',
          'issues',
          'create',
          '--repo',
          'igor/demo',
          '--title',
          'After reset',
          '--json',
        ]),
      );

      assert(
        issue.title === 'After reset',
        'Reset did not apply changed GitHub fixtures',
      );
      await run('CLI down after Stripe crash replay', cli[0], [
        ...cli[1],
        'down',
        '--json',
      ]);
      assert(
        (await stripeRestart.status).success,
        'Stripe restart shutdown failed',
      );
    } finally {
      try {
        stripeRestart.kill('SIGKILL');
      } catch { /* Already stopped. */ }

      await stripeRestart.status;
      await stripeRestart.stdout.cancel();
      await stripeRestart.stderr.cancel();
    }

    await Deno.writeTextFile(
      `${cwd}/consumer.mts`,
      `import { Emulon, defineConfig, definePlugin, defineCommand } from "emulon";
import { z } from "zod";
import resend from "@emulon/resend";
import github from "@emulon/github";
import calcom from "@emulon/calcom";
const calEnv = await Emulon.start({ services: { cal: calcom() } });
const eventTypeId: number = (await calEnv.services.cal.eventTypes.create({ title: "Typed", slug: "typed", lengthInMinutes: 30, slots: [] })).id;
await calEnv.services.cal.slots.list({ eventTypeId, start: "2099-01-01", end: "2099-01-02" });
// @ts-expect-error numeric duration required
await calEnv.services.cal.eventTypes.create({ title: "Typed", slug: "typed", lengthInMinutes: "30", slots: [] });
const calBooking = await calEnv.services.cal.bookings.create({ eventTypeId, start: "2099-06-01T10:00:00Z", attendee: { name: "Ada", email: "ada@example.test", timeZone: "UTC" } });
const calUid: string = calBooking.uid;
await calEnv.services.cal.bookings.get({ uid: calUid });
// @ts-expect-error only UTC attendees are supported
calEnv.services.cal.bookings.create({ eventTypeId: 1, start: "2099-06-01T10:00:00Z", attendee: { name: "Ada", email: "ada@example.test", timeZone: "Europe/Madrid" } });
const calDelivery = await calEnv.services.cal.webhooks.send({ type: "BOOKING_CREATED", destination: "receiver", data: { uid: calUid, eventTypeId, title: "Typed", startTime: calBooking.start, endTime: calBooking.end, organizer: calBooking.hosts[0]!, attendees: calBooking.attendees } });
const calDeliveryId: string = calDelivery.id;
await calEnv.services.cal.webhooks.inspect({ id: calDeliveryId });
// @ts-expect-error unsupported Cal.com event
calEnv.services.cal.events.publish({ type: "BOOKING_CANCELLED", data: {} });
// @ts-expect-error a delivery ID is a string
calEnv.services.cal.webhooks.redeliver({ id: 123 });
await calEnv.dispose();
import stripe from "@emulon/stripe";
const combinedConfig = { services: { stripe: stripe(), calcom: calcom() } };
const combinedStarted = await Emulon.start(combinedConfig);
const combinedConnected = await Emulon.connect({ config: combinedConfig });
for (const client of [combinedStarted, combinedConnected]) {
  const customerId: string = (await client.services.stripe.customers.create({ name: "Typed" })).id;
  const typeId: number = (await client.services.calcom.eventTypes.create({ title: "Typed", slug: "typed", lengthInMinutes: 30, slots: [] })).id;
  const uid: string = (await client.services.calcom.bookings.create({ eventTypeId: typeId, start: "2099-06-01T10:00:00Z", attendee: { name: "Ada", email: "ada@example.test", timeZone: "UTC" } })).uid;
  await client.services.stripe.customers.get({ id: customerId });
  await client.services.calcom.bookings.get({ uid });
  // @ts-expect-error Combined client preserves Stripe input types.
  client.services.stripe.customers.create({ name: 42 });
  // @ts-expect-error Combined client preserves Cal.com input types.
  client.services.calcom.bookings.get({ uid: 42 });
  // @ts-expect-error Combined client preserves output types.
  const invalid: number = (await client.services.calcom.bookings.get({ uid })).uid;
  // @ts-expect-error Stripe customer IDs remain strings in combined clients.
  const invalidCustomer: number = (await client.services.stripe.customers.get({ id: customerId })).id;
  void invalid;
  void invalidCustomer;
}
await combinedConnected.dispose();
await combinedStarted.dispose();
const stripeEnv = await Emulon.start({ services: { stripe: stripe() } });
const customerName: string | null = (await stripeEnv.services.stripe.customers.create({ name: "Typed" })).name;
// @ts-expect-error Stripe customer input retains string types.
await stripeEnv.services.stripe.customers.create({ name: 42 });
// @ts-expect-error Stripe does not expose payments.
stripeEnv.services.stripe.payments;
void customerName;
await stripeEnv.dispose();
const gh = await Emulon.start({ services: { github: github() } });
const ghManifest: import("emulon").CompatibilityManifest = await gh.services.github.compatibility.get({});
void ghManifest;
const appId: string = (await gh.services.github.apps.create({ slug: "bot" })).id;
const suspended: boolean = (await gh.services.github.installations.suspend({ id: appId })).suspended;
// @ts-expect-error GitHub command inputs retain field types.
await gh.services.github.apps.create({ slug: 1 });
// @ts-expect-error GitHub suspension requires an object input.
await gh.services.github.installations.suspend(appId);
await gh.dispose();
void suspended;
const config = defineConfig({ services: { mail: resend() } });
const loaded = await Emulon.load(config);
const mail: ReturnType<typeof resend> = loaded.services.mail;
// @ts-expect-error Literal instance names must survive the published declarations.
loaded.services.missing;
// @ts-expect-error Plugin options must not become any.
resend({ unexpected: true });
const env = await Emulon.start(config);
const mailManifest: import("emulon").CompatibilityManifest = await env.services.mail.compatibility.get({});
const compatibilityClient = await Emulon.connect({ config });
const connectedManifest: import("emulon").CompatibilityManifest = await compatibilityClient.services.mail.compatibility.get({});
// @ts-expect-error Manifest result is not an arbitrary string.
const wrongManifest: string = connectedManifest;
void mailManifest;
void wrongManifest;
await compatibilityClient.dispose();
const endpoint: string = env.endpoints.mail.api;
// @ts-expect-error Started environments preserve instance names.
env.services.missing;
// @ts-expect-error Endpoint maps preserve instance names.
env.endpoints.missing;
await env.dispose();
void endpoint;
void mail;
const commandConfig = defineConfig({ services: { stripe: stripe(), mail: resend(), github: github() } });
const commandStarted = await Emulon.start(commandConfig);
const commandConnected = await Emulon.connect({ config: commandConfig });
const stripeData = { id: "evt_typed", object: "event" as const, api_version: "2026-04-22.dahlia" as const, created: 1, type: "customer.created" as const, livemode: false as const, pending_webhooks: 0, request: { id: null, idempotency_key: null }, data: { object: { id: "cus_typed", object: "customer" as const, created: 1, livemode: false as const, name: null, email: null, description: null, metadata: {} } } };
const mailData = { email_id: "00000000-0000-4000-8000-000000000001", from: "a@example.test", to: ["b@example.test"], subject: "Typed" };
const githubData = { issue: { id: 1, number: 1, title: "Typed" }, repository: { id: 1, name: "demo", full_name: "owner/demo", private: false }, sender: { id: 1, login: "owner", type: "User" as const } };
for (const client of [commandStarted, commandConnected]) {
  await client.services.stripe.webhooks.send({ type: "customer.created", data: stripeData, destination: "receiver" });
  await client.services.stripe.webhooks.inspect({ id: "delivery" });
  await client.services.stripe.webhooks.redeliver({ id: "delivery" });
  await client.services.stripe.webhooks.wait({ id: "delivery", status: "succeeded", timeout: "1s" });
  await client.services.stripe.webhooks.list({});
  await client.services.stripe.events.publish({ type: "customer.created", data: stripeData });
  await client.services.stripe.webhooks.configure({ id: "receiver", url: "http://127.0.0.1", secret: "secret", types: ["customer.created"], enabled: true });
  await client.services.stripe.webhooks.destinations({});
  // @ts-expect-error stripe webhooks.redeliver rejects invalid command input.
  client.services.stripe.webhooks.redeliver({ id: 123 });
  // @ts-expect-error stripe webhooks.inspect rejects invalid command input.
  client.services.stripe.webhooks.inspect({});
  // @ts-expect-error stripe webhooks.wait rejects invalid command input.
  client.services.stripe.webhooks.wait({ id: "delivery", status: "succeeded", timeout: 1000 });
  // @ts-expect-error stripe webhooks.wait rejects invalid command input.
  client.services.stripe.webhooks.wait({ id: "delivery", status: "unknown", timeout: "1s" });
  // @ts-expect-error stripe webhooks.list rejects invalid command input.
  client.services.stripe.webhooks.list({ extra: true });
  // @ts-expect-error stripe webhooks.send rejects invalid command input.
  client.services.stripe.webhooks.send({ type: "customer.created", data: stripeData });
  // @ts-expect-error stripe events.publish rejects invalid command input.
  client.services.stripe.events.publish({ type: "customer.created", data: { ...stripeData, pending_webhooks: "0" } });
  // @ts-expect-error stripe events.publish rejects invalid command input.
  client.services.stripe.events.publish({ type: "unsupported", data: stripeData });
  // @ts-expect-error stripe webhooks.configure rejects invalid command input.
  client.services.stripe.webhooks.configure({ id: "receiver", url: "http://127.0.0.1", secret: "secret", types: ["customer.created"], enabled: "true" });
  // @ts-expect-error stripe webhooks.destinations rejects invalid command input.
  client.services.stripe.webhooks.destinations({ id: "receiver" });
  await client.services.mail.webhooks.send({ type: "email.sent", data: mailData, destination: "receiver" });
  await client.services.mail.webhooks.inspect({ id: "delivery" });
  await client.services.mail.webhooks.redeliver({ id: "delivery" });
  await client.services.mail.webhooks.wait({ id: "delivery", status: "succeeded", timeout: "1s" });
  await client.services.mail.webhooks.list({});
  await client.services.mail.events.publish({ type: "email.sent", data: mailData });
  await client.services.mail.webhooks.configure({ id: "receiver", url: "http://127.0.0.1", secret: "secret", types: ["email.sent"], enabled: true });
  await client.services.mail.webhooks.destinations({});
  await client.services.mail.webhooks.faults({ delayMs: 0, loseResponse: false });
  await client.services.mail.emails.get({ id: "email" });
  await client.services.mail.emails.list({});
  await client.services.mail.emails.clear({});
  await client.services.mail.keys.create({});
  // @ts-expect-error mail webhooks.redeliver rejects invalid command input.
  client.services.mail.webhooks.redeliver({ id: 123 });
  // @ts-expect-error mail webhooks.inspect rejects invalid command input.
  client.services.mail.webhooks.inspect({});
  // @ts-expect-error mail webhooks.wait rejects invalid command input.
  client.services.mail.webhooks.wait({ id: "delivery", status: "succeeded", timeout: 1000 });
  // @ts-expect-error mail webhooks.wait rejects invalid command input.
  client.services.mail.webhooks.wait({ id: "delivery", status: "unknown", timeout: "1s" });
  // @ts-expect-error mail webhooks.list rejects invalid command input.
  client.services.mail.webhooks.list({ extra: true });
  // @ts-expect-error mail webhooks.send rejects invalid command input.
  client.services.mail.webhooks.send({ type: "email.sent", data: mailData });
  // @ts-expect-error mail events.publish rejects invalid command input.
  client.services.mail.events.publish({ type: "email.sent", data: { ...mailData, to: [123] } });
  // @ts-expect-error mail events.publish rejects invalid command input.
  client.services.mail.events.publish({ type: "unsupported", data: mailData });
  // @ts-expect-error mail webhooks.configure rejects invalid command input.
  client.services.mail.webhooks.configure({ id: "receiver", url: "http://127.0.0.1", secret: "secret", types: ["email.sent"], enabled: "true" });
  // @ts-expect-error mail webhooks.destinations rejects invalid command input.
  client.services.mail.webhooks.destinations({ id: "receiver" });
  // @ts-expect-error mail webhooks.faults rejects invalid command input.
  client.services.mail.webhooks.faults({ delayMs: "0", loseResponse: false });
  // @ts-expect-error mail emails.get rejects invalid command input.
  client.services.mail.emails.get({ id: 123 });
  // @ts-expect-error mail emails.list rejects invalid command input.
  client.services.mail.emails.list({ id: "email" });
  // @ts-expect-error mail emails.clear rejects invalid command input.
  client.services.mail.emails.clear({ id: "email" });
  // @ts-expect-error mail keys.create rejects invalid command input.
  client.services.mail.keys.create({ apiKey: "key" });
  await client.services.github.webhooks.send({ type: "issues.opened", data: githubData, destination: "receiver" });
  await client.services.github.webhooks.inspect({ id: "delivery" });
  await client.services.github.webhooks.redeliver({ id: "delivery" });
  await client.services.github.webhooks.wait({ id: "delivery", status: "succeeded", timeout: "1s" });
  await client.services.github.webhooks.list({});
  await client.services.github.events.publish({ type: "issues.opened", data: githubData });
  // @ts-expect-error github webhooks.redeliver rejects invalid command input.
  client.services.github.webhooks.redeliver({ id: 123 });
  // @ts-expect-error github webhooks.inspect rejects invalid command input.
  client.services.github.webhooks.inspect({});
  // @ts-expect-error github webhooks.wait rejects invalid command input.
  client.services.github.webhooks.wait({ id: "delivery", status: "succeeded", timeout: 1000 });
  // @ts-expect-error github webhooks.wait rejects invalid command input.
  client.services.github.webhooks.wait({ id: "delivery", status: "unknown", timeout: "1s" });
  // @ts-expect-error github webhooks.list rejects invalid command input.
  client.services.github.webhooks.list({ extra: true });
  // @ts-expect-error github webhooks.send rejects invalid command input.
  client.services.github.webhooks.send({ type: "issues.opened", data: githubData });
  // @ts-expect-error github events.publish rejects invalid command input.
  client.services.github.events.publish({ type: "issues.opened", data: { ...githubData, issue: { ...githubData.issue, id: "123" } } });
  // @ts-expect-error github events.publish rejects invalid command input.
  client.services.github.events.publish({ type: "unsupported", data: githubData });
}
await commandConnected.dispose();
await commandStarted.dispose();
const fixture = definePlugin({
  name: "typed", apiVersion: 1, capabilities: [],
  commands: { "emails.send": defineCommand({
    description: "Send", input: z.object({ to: z.string() }), output: z.object({ accepted: z.boolean() }),
    cli: { path: ["emails", "send"], flags: { recipient: "to" } },
    execute(_ctx, input) { const to: string = input.to; return { accepted: !!to }; },
  }) },
  setup: async () => ({ endpoints: {}, ready: async () => {}, stop: async () => {} }),
});
import polar from "@emulon/polar";
const polarConfig = defineConfig({ services: { billing: polar({ organizationId: "3fbd6d0a-2c57-4f06-8f02-4b1a2f2a9d11" }) } });
const polarStarted = await Emulon.start(polarConfig);
const polarConnected = await Emulon.connect({ config: polarConfig });
for (const client of [polarStarted, polarConnected]) {
  const billing = client.services.billing;
  const polarManifest: import("emulon").CompatibilityManifest = await billing.compatibility.get({});
  const polarKey: string = (await billing.keys.create({})).apiKey;
  const customer = await billing.customers.create({ email: "typed@example.test", name: "Typed", externalId: "usr_typed" });
  const customerId: string = customer.id;
  const emailVerified: boolean = (await billing.customers.get({ id: customerId })).email_verified;
  const externalId: string | null = customer.external_id;
  const envelope = { type: "customer.created" as const, timestamp: customer.created_at, api_version: "2026-04" as const, data: customer };
  await billing.events.publish({ type: "customer.created", data: envelope });
  await billing.webhooks.configure({ id: "receiver", url: "http://127.0.0.1", secret: "whsec_local", types: ["customer.created"], enabled: true });
  await billing.webhooks.destinations({});
  await billing.webhooks.send({ type: "customer.created", data: envelope, destination: "receiver" });
  await billing.webhooks.list({});
  await billing.webhooks.inspect({ id: "delivery" });
  await billing.webhooks.redeliver({ id: "delivery" });
  await billing.webhooks.wait({ id: "delivery", status: "succeeded", timeout: "1s" });
  // @ts-expect-error Polar customer emails are strings.
  billing.customers.create({ email: 42 });
  // @ts-expect-error Polar creation rejects unsupported provider fields.
  billing.customers.create({ email: "typed@example.test", metadata: { plan: "pro" } });
  // @ts-expect-error Polar creation takes camelCase management input.
  billing.customers.create({ email: "typed@example.test", external_id: "usr_typed" });
  // @ts-expect-error Polar reads need an identifier object.
  billing.customers.get(customerId);
  // @ts-expect-error Polar key issuance takes no credential.
  billing.keys.create({ apiKey: "polar_oat_local" });
  // @ts-expect-error Polar publishes only customer.created.
  billing.events.publish({ type: "customer.updated", data: envelope });
  // @ts-expect-error Polar envelopes carry the pinned API version.
  billing.events.publish({ type: "customer.created", data: { ...envelope, api_version: "2025-04" } });
  // @ts-expect-error Polar envelopes carry a whole customer projection.
  billing.events.publish({ type: "customer.created", data: { ...envelope, data: { ...customer, email_verified: "no" } } });
  // @ts-expect-error Polar direct sends name a destination.
  billing.webhooks.send({ type: "customer.created", data: envelope });
  // @ts-expect-error Polar destinations are configured with a boolean.
  billing.webhooks.configure({ id: "receiver", url: "http://127.0.0.1", secret: "whsec_local", types: ["customer.created"], enabled: "true" });
  // @ts-expect-error Polar destination listing takes no input fields.
  billing.webhooks.destinations({ id: "receiver" });
  // @ts-expect-error Polar waits take a duration string.
  billing.webhooks.wait({ id: "delivery", status: "succeeded", timeout: 1000 });
  // @ts-expect-error Polar deliveries are inspected by string ID.
  billing.webhooks.redeliver({ id: 123 });
  // @ts-expect-error Polar customer IDs remain strings.
  const wrongCustomer: number = (await billing.customers.get({ id: customerId })).id;
  // @ts-expect-error Polar emulates no products.
  billing.products;
  void polarManifest;
  void polarKey;
  void emailVerified;
  void externalId;
  void wrongCustomer;
}
// @ts-expect-error Polar options must not become any.
polar({ unexpected: true });
// @ts-expect-error Polar instance names survive the published declarations.
polarStarted.services.missing;
const polarEndpoint: string = polarStarted.endpoints.billing.api;
void polarEndpoint;
await polarConnected.dispose();
await polarStarted.dispose();
const typedEnv = await Emulon.start({ services: { mail: fixture() } });
const sent = await typedEnv.services.mail.emails.send({ to: "a@example.test" });
const attached = await Emulon.connect({ config: { services: { mail: fixture() } } });
const attachedResult: boolean = (await attached.services.mail.emails.send({ to: "a@example.test" })).accepted;
// @ts-expect-error Connected commands preserve input types.
await attached.services.mail.emails.send({ to: 1 });
await attached.dispose();
void attachedResult;
const accepted: boolean = sent.accepted;
// @ts-expect-error Published commands retain their input types.
await typedEnv.services.mail.emails.send({ to: 1 });
// @ts-expect-error Published commands retain their output types.
const invalid: string = sent.accepted;
await typedEnv.dispose();
void accepted;
void invalid;
`,
    );
    await run('declarations: tsc --noEmit', 'node', [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      'consumer.mts',
    ]);

    if (runtime === 'Deno') {
      await run('declarations: deno check', Deno.execPath(), [
        'check',
        '--no-config',
        '--no-lock',
        '--node-modules-dir=manual',
        '--cached-only',
        'consumer.mts',
      ]);
    }
  }

  console.log(
    'PASS distribution verification: Node and Deno (local archives only)',
  );
} finally {
  await Deno.remove(temporary, { recursive: true });
}
