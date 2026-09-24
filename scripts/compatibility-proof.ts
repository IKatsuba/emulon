import ts from 'typescript';
import { compatibility as github } from '../packages/github/src/compatibility.ts';
import { compatibility as mail } from '../packages/resend/src/compatibility.ts';
import { compatibility as versioned } from '../packages/emulon/tests/fixtures/versioned.ts';

/**
 * The two-version fixture plugin installed next to the official ones, stripped
 * of types. Its npm metadata is written from the source constant, as the
 * official build does.
 */
async function versionedPackage(): Promise<Record<string, string>> {
  const source = await Deno.readTextFile(
    new URL('../packages/emulon/tests/fixtures/versioned.ts', import.meta.url),
  );

  return {
    'package.json': JSON.stringify({
      name: '@emulon-fixture/versioned',
      version: '0.0.0',
      type: 'module',
      exports: './mod.mjs',
      emulon: { compatibility: versioned },
    }),
    'mod.mjs': ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText,
  };
}

/** Install the version-2 fixture package into an isolated consumer. */
export async function installVersionedPackage(cwd: string): Promise<void> {
  const directory = `${cwd}/node_modules/@emulon-fixture/versioned`;

  await Deno.mkdir(directory, { recursive: true });

  for (const [name, content] of Object.entries(await versionedPackage())) {
    await Deno.writeTextFile(`${directory}/${name}`, content);
  }
}

/** Executed from the isolated installation under both supported runtimes. */
export function compatibilityProof(prefix: string): string {
  return `
import { readFile, mkdir } from "node:fs/promises";
import { Emulon, defineCompatibility } from "${prefix}emulon";
import github from "${prefix}@emulon/github";
import resend from "${prefix}@emulon/resend";
import versioned from "./node_modules/@emulon-fixture/versioned/mod.mjs";
import { serveEnvironment } from "./node_modules/emulon/esm/control/server.js";
import { runProjectCLI } from "./node_modules/emulon/esm/cli/project.js";
import { listen } from "./node_modules/emulon/esm/runtime/http.js";
import { createHmac } from "node:crypto";
const expected = ${JSON.stringify({ github, mail, versioned })};
const directory = "./compatibility-project";
await mkdir(directory);
const config = { services: { github: github(), mail: resend(), versioned: versioned() } };
const started = await Emulon.start(config);
const host = await serveEnvironment(config, { directory });
let connected;
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Compatibility mismatch: " + label);
}
try {
  connected = await Emulon.connect({ config, directory });
  const key = await connected.services.mail.keys.create();
  const app = await connected.services.github.apps.create({ slug: "private-options-canary" });
  for (const [instance, packageName] of [["github", "@emulon/github"], ["mail", "@emulon/resend"], ["versioned", "@emulon-fixture/versioned"]]) {
    const pkg = JSON.parse(await readFile("./node_modules/" + packageName + "/package.json", "utf8"));
    const manifest = defineCompatibility(pkg.emulon.compatibility);
    equal(manifest, expected[instance], "source/npm");
    equal(await started.services[instance].compatibility.get({}), manifest, "started/npm");
    equal(await connected.services[instance].compatibility.get({}), manifest, "connected/npm");
    const cli = await runProjectCLI([instance, "compatibility", "get", "--json"], undefined, directory);
    if (cli.code !== 0) throw new Error("Compatibility CLI failed");
    equal(JSON.parse(cli.stdout), manifest, "CLI/npm");
    for (const secret of [key.apiKey, app.clientSecret, app.privateKey, "private-options-canary"]) {
      if (cli.stdout.includes(secret)) throw new Error("Compatibility leaked instance data");
    }
  }
  await connected.reset();
  const v2 = await connected.services.versioned.compatibility.get({});
  equal(v2.verification.byVersion.map(entry => [entry.version, entry.client]), [["2025-01-01.alpha", "versioned@1.0.0"], ["2026-01-01.beta", "versioned@2.0.0"]], "version-2 pins");
  for (const instance of ["github", "mail", "versioned"]) equal(await connected.services[instance].compatibility.get({}), expected[instance], "reset");
  // The installed fixture behaves as its manifest claims, not only declares it.
  const received = [];
  const receiver = await listen(async (request) => {
    received.push({ signature: request.headers.get("versioned-signature"), body: await request.text() });
    return new Response(null, { status: 204 });
  });
  try {
    const service = connected.services.versioned;
    await service.webhooks.configure({ id: "hook", url: receiver.url, secret: "whsec", apiVersion: "2026-01-01.beta" });
    const cli = await runProjectCLI(["versioned", "items", "create", "a", "--api-version", "2025-01-01.alpha", "--json"], undefined, directory);
    if (cli.code !== 0) throw new Error("Version-2 fixture CLI failed");
    equal(JSON.parse(cli.stdout), { title: "a" }, "alpha response");
    const [event] = await connected.events.list();
    equal([event.type, event.payload], ["item.created", { title: "a" }], "alpha event view");
    await service.webhooks.wait({ id: JSON.stringify([event.id, "hook"]), status: "succeeded", timeout: "5s" });
    const body = JSON.stringify({ id: event.id, type: "item.created", apiVersion: "2026-01-01.beta", data: { item: { name: "a" } } });
    equal(received, [{ signature: createHmac("sha256", "whsec").update(body).digest("hex"), body }], "beta endpoint snapshot");
  } finally {
    await receiver.stop();
  }
} finally {
  await connected?.dispose();
  await host.dispose();
  await started.dispose();
}
console.log("GitHub/Resend/version-2 fixture source = npm metadata = CLI = started/connected SDK; reset and credential isolation; version-2 fixture events and signed endpoint snapshots");
`;
}
