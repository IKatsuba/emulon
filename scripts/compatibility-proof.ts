import { compatibility as github } from '../packages/github/src/compatibility.ts';
import { compatibility as mail } from '../packages/resend/src/compatibility.ts';

/** Executed from the isolated installation under both supported runtimes. */
export function compatibilityProof(prefix: string): string {
  return `
import { readFile, mkdir } from "node:fs/promises";
import { Emulon, defineCompatibility } from "${prefix}emulon";
import github from "${prefix}@emulon/github";
import resend from "${prefix}@emulon/resend";
import { serveEnvironment } from "./node_modules/emulon/esm/control/server.js";
import { runProjectCLI } from "./node_modules/emulon/esm/cli/project.js";
const expected = ${JSON.stringify({ github, mail })};
const directory = "./compatibility-project";
await mkdir(directory);
const config = { services: { github: github(), mail: resend() } };
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
  for (const [instance, packageName] of [["github", "github"], ["mail", "resend"]]) {
    const pkg = JSON.parse(await readFile("./node_modules/@emulon/" + packageName + "/package.json", "utf8"));
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
  for (const instance of ["github", "mail"]) equal(await connected.services[instance].compatibility.get({}), expected[instance], "reset");
} finally {
  await connected?.dispose();
  await host.dispose();
  await started.dispose();
}
console.log("GitHub/Resend source = npm metadata = CLI = started/connected SDK; reset and credential isolation");
`;
}
