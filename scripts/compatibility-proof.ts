import { compatibility as github } from '../packages/github/src/compatibility.ts';
import { compatibility as mail } from '../packages/resend/src/compatibility.ts';
import { compatibility as versioned } from '../packages/emulon/tests/fixtures/versioned.ts';

/**
 * A two-version plugin package installed next to the official ones. Its npm
 * metadata is written from the source constant, as the official build does.
 */
function versionedPackage(): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: '@emulon-fixture/versioned',
      version: '0.0.0',
      type: 'module',
      exports: './mod.mjs',
      emulon: { compatibility: versioned },
    }),
    'mod.mjs': `
import { defineCompatibility, definePlugin } from "../../emulon/esm/mod.js";
export default definePlugin({
  name: "versioned",
  apiVersion: 1,
  capabilities: ["events", "webhooks"],
  compatibility: defineCompatibility(${JSON.stringify(versioned)}),
  commands: {},
  setup: () => Promise.resolve({ endpoints: {}, ready: () => Promise.resolve(), stop: () => Promise.resolve() }),
});
`,
  };
}

/** Install the version-2 fixture package into an isolated consumer. */
export async function installVersionedPackage(cwd: string): Promise<void> {
  const directory = `${cwd}/node_modules/@emulon-fixture/versioned`;

  await Deno.mkdir(directory, { recursive: true });

  for (const [name, content] of Object.entries(versionedPackage())) {
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
} finally {
  await connected?.dispose();
  await host.dispose();
  await started.dispose();
}
console.log("GitHub/Resend/version-2 fixture source = npm metadata = CLI = started/connected SDK; reset and credential isolation");
`;
}
