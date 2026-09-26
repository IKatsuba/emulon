import { compatibility } from '../packages/polar/src/compatibility.ts';

/**
 * Resource smoke for the installed archive: no workspace imports, no official
 * client and no provider access. Signed delivery is declared here but proved
 * from an installed consumer by `polarAcceptance` below, which extends this
 * smoke to the full scenario.
 */
export function polarProof(prefix: string): string {
  return `
import { readFile } from "node:fs/promises";
import { Emulon, defineCompatibility } from "${prefix}emulon";
import polar from "${prefix}@emulon/polar";
const manifest = ${JSON.stringify(compatibility)};
const organizationId = "3fbd6d0a-2c57-4f06-8f02-4b1a2f2a9d11";
function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Polar mismatch: " + label + " " + JSON.stringify(actual));
}
const env = await Emulon.start({ services: { billing: polar({ organizationId }) } });
try {
  const pkg = JSON.parse(await readFile("./node_modules/@emulon/polar/package.json", "utf8"));
  equal(defineCompatibility(pkg.emulon.compatibility), manifest, "npm metadata");
  equal(await env.services.billing.compatibility.get({}), manifest, "installed command");
  assert(manifest.capabilities.includes("webhooks"), "Delivery capability missing");
  const { apiKey } = await env.services.billing.keys.create({});
  assert(apiKey.startsWith("polar_oat_"), "Unexpected token format");
  const api = env.endpoints.billing.api;
  const created = await fetch(api + "/v1/customers/", {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json", "polar-version": "2026-04" },
    body: JSON.stringify({ email: "installed@example.test", name: "Installed", external_id: "usr_installed" }),
  });
  assert(created.status === 201 && created.headers.get("polar-version") === "2026-04", "Installed create failed");
  const customer = await created.json();
  equal(customer.organization_id, organizationId, "organization");
  equal(customer.email_verified, false, "email_verified");
  equal(await env.services.billing.customers.get({ id: customer.id }), customer, "SDK read");
  const read = await fetch(api + "/v1/customers/" + customer.id, { headers: { authorization: "Bearer " + apiKey } });
  assert(read.status === 200, "Installed read failed");
  equal(await read.json(), customer, "HTTP read");
  const duplicate = await fetch(api + "/v1/customers/", {
    method: "POST",
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({ email: "installed@example.test" }),
  });
  assert(duplicate.status === 409, "Duplicate accepted");
  equal((await duplicate.json()).error, "CustomerAlreadyExists", "duplicate error");
  const versioned = await fetch(api + "/v1/customers/" + customer.id, { headers: { authorization: "Bearer " + apiKey, "polar-version": "2025-01" } });
  assert(versioned.status === 404, "Unsupported version accepted");
  await versioned.json();
  const events = await env.events.list({ type: "customer.created" });
  equal(events.length, 1, "event count");
  equal(events[0].payload.api_version, "2026-04", "event api_version");
  equal(events[0].payload.data.id, customer.id, "event customer");
  await env.reset();
  const invalidated = await fetch(api + "/v1/customers/" + customer.id, { headers: { authorization: "Bearer " + apiKey } });
  assert(invalidated.status === 401, "Reset kept the token");
  await invalidated.json();
  equal(await env.services.billing.compatibility.get({}), manifest, "manifest after reset");
} finally {
  await env.dispose();
}
console.log("Polar installed resource smoke, manifest parity, duplicate/version rejection and reset passed");
`;
}

/**
 * The full installed acceptance: a fresh project that installs the archives
 * offline, configures `polar()`, runs a foreground `emulon up`, and drives the
 * runnable example plus restart and reset through the installed CLI. Nothing
 * here reaches a registry or a provider.
 */
export async function polarAcceptance(options: {
  cwd: string;
  archiveDirectory: string;
  env: Record<string, string>;
  runtime: string;
  denoArgs: string[];
  archives: string[];
}): Promise<void> {
  const { runtime, env, denoArgs, archives } = options;
  const cwd = `${options.cwd}/polar-project`;
  const decoder = new TextDecoder();
  const node = runtime === 'Node';
  const assert = (value: unknown, message: string) => {
    if (!value) {
      throw new Error(`${runtime} Polar acceptance: ${message}`);
    }
  };

  // Command results carry issued tokens and customer data, so only the label
  // reaches the log unless a step explicitly reports its own summary.
  const run = async (
    label: string,
    command: string,
    args: string[],
    echo = false,
  ) => {
    const result = await new Deno.Command(command, {
      args,
      cwd,
      env,
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    const stdout = decoder.decode(result.stdout).trim();

    assert(
      result.success,
      `${label} failed (exit ${result.code})\n${stdout}\n${
        decoder.decode(result.stderr)
      }`,
    );
    console.log(
      `PASS ${runtime}: ${label}${echo && stdout ? ` — ${stdout}` : ''}`,
    );

    return stdout;
  };

  await Deno.mkdir(cwd);
  await Deno.writeTextFile(
    `${cwd}/package.json`,
    '{"private":true,"type":"module"}\n',
  );
  await run('Polar project offline installation', 'npm', [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...archives.map((name) => `${options.archiveDirectory}/${name}`),
  ]);

  // The installed CLI and plugin may hold separate emulon copies, and the
  // plugin's configuration verdict must still reach the caller.
  for (
    const organizationId of [
      '00000000-0000-4000-0000-000000000000',
      'c232ab00-9414-11ec-b3c8-9e6bdeced846',
    ]
  ) {
    await Deno.writeTextFile(
      `${cwd}/emulon.config.ts`,
      'import polar from "@emulon/polar";\n' +
        `export default { services: { billing: polar({ organizationId: "${organizationId}" }) } };\n`,
    );

    const refused = await new Deno.Command(
      node ? 'node' : Deno.execPath(),
      {
        args: node
          ? ['node_modules/emulon/esm/cli/main.js', 'up', '--json']
          : [...denoArgs, 'npm:emulon', 'up', '--json'],
        cwd,
        env,
        clearEnv: true,
        stdout: 'piped',
        stderr: 'piped',
      },
    ).output();
    const stderr = decoder.decode(refused.stderr);
    let error: { code?: unknown; message?: unknown } | undefined;

    try {
      error = JSON.parse(stderr).error;
    } catch { /* Reported below. */ }

    assert(
      refused.code === 1 && error?.code === 'CONFIG_INVALID' &&
        error.message ===
          'Invalid Polar organizationId: expected a version 4 UUID (RFC 4122 variant).',
      `unusable organizationId was not refused at configuration\n${stderr}`,
    );
    console.log(
      `PASS ${runtime}: Polar refuses organizationId ${organizationId}`,
    );
  }

  // What a reader of docs/polar.md writes by hand.
  await Deno.writeTextFile(
    `${cwd}/emulon.config.ts`,
    'import { defineConfig } from "emulon";\n' +
      'import polar from "@emulon/polar";\n' +
      'export default defineConfig({ services: { billing: polar() } });\n',
  );
  await Deno.copyFile(
    new URL('../examples/polar/main.mjs', import.meta.url),
    `${cwd}/main.mjs`,
  );
  await Deno.copyFile(
    new URL('../examples/polar/license.mjs', import.meta.url),
    `${cwd}/license.mjs`,
  );

  const cli = node
    ? ['npx', ['--offline', '--no-install', 'emulon']] as const
    : [Deno.execPath(), [...denoArgs, 'npm:emulon']] as const;
  const command = async (label: string, args: string[]) =>
    JSON.parse(await run(label, cli[0], [...cli[1], ...args, '--json']));
  const foreground = async (restored: boolean) => {
    const child = new Deno.Command(node ? 'node' : Deno.execPath(), {
      args: node
        ? ['node_modules/emulon/esm/cli/main.js', 'up', '--json']
        : [...denoArgs, 'npm:emulon', 'up', '--json'],
      cwd,
      env,
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const output = await Promise.race([
        (async () => {
          let text = '';

          while (true) {
            const chunk = await reader.read();

            assert(!chunk.done, 'up exited before readiness');

            text += decoder.decode(chunk.value, { stream: true });

            try {
              return JSON.parse(text);
            } catch { /* Read the remaining JSON. */ }
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Polar up readiness timeout')),
            20000,
          );
        }),
      ]);

      assert(output.endpoints?.billing?.api, 'up did not start the instance');
      assert(
        restored
          ? output.notices?.[0]?.code === 'STATE_RESTORED'
          : !output.notices,
        'Unexpected restored-state reporting',
      );

      return { child, api: output.endpoints.billing.api as string };
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

  const stop = async (child: Deno.ChildProcess) => {
    try {
      child.kill('SIGKILL');
    } catch { /* Shutdown already completed. */ }

    await child.status;
    await child.stdout.cancel();
    await child.stderr.cancel();
  };

  let host = await foreground(false);

  try {
    await run(
      'runnable Polar example over the foreground host',
      node ? 'node' : Deno.execPath(),
      node ? ['main.mjs', JSON.stringify(cli)] : [
        ...denoArgs,
        `--allow-run=${Deno.execPath()}`,
        'main.mjs',
        JSON.stringify(cli),
      ],
      true,
    );

    const { apiKey } = await command('installed Polar key issuance', [
      'billing',
      'keys',
      'create',
    ]);
    const customer = await command('installed Polar CLI create', [
      'billing',
      'customers',
      'create',
      '--email',
      'restart@example.test',
      '--name',
      'Restart Ада',
    ]);

    await command('installed Polar CLI down', ['down']);
    assert((await host.child.status).success, 'up failed during shutdown');

    // A restart reopens the same durable state behind the same instance.
    host = await foreground(true);

    const reopened = await command('installed Polar CLI read after restart', [
      'billing',
      'customers',
      'get',
      '--id',
      customer.id,
    ]);

    assert(
      JSON.stringify(reopened) === JSON.stringify(customer),
      'Restart changed the customer',
    );

    const survived = await fetch(`${host.api}/v1/customers/${customer.id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });

    assert(survived.status === 200, 'Restart invalidated the issued token');
    await survived.json();
    await command('installed Polar CLI reset', [
      'reset',
      '--environment',
      'default',
    ]);

    const invalidated = await fetch(`${host.api}/v1/customers/${customer.id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });

    assert(invalidated.status === 401, 'Reset kept the issued token');
    await invalidated.json();

    const reissued = await command('installed Polar key after reset', [
      'billing',
      'keys',
      'create',
    ]);
    const gone = await fetch(`${host.api}/v1/customers/${customer.id}`, {
      headers: { authorization: `Bearer ${reissued.apiKey}` },
    });

    assert(gone.status === 404, 'Reset kept the customer');
    assert(
      (await gone.json()).error === 'ResourceNotFound',
      'Unexpected error after reset',
    );
    assert(
      (await command('installed Polar deliveries after reset', [
        'billing',
        'webhooks',
        'list',
      ])).length === 0,
      'Reset kept deliveries',
    );
    await command('installed Polar CLI final down', ['down']);
    assert((await host.child.status).success, 'up failed during shutdown');
  } finally {
    await stop(host.child);
  }

  // The documented single command: the example starts and stops its own host
  // in a dedicated environment, so nothing else may be running for it.
  for (const attempt of ['first', 'repeated']) {
    await run(
      `${attempt} runnable Polar license lifecycle example`,
      node ? 'node' : Deno.execPath(),
      node ? ['license.mjs'] : [
        ...denoArgs,
        `--allow-run=${Deno.execPath()}`,
        'license.mjs',
        JSON.stringify([Deno.execPath(), [...denoArgs, 'npm:emulon']]),
      ],
      attempt === 'first',
    );
  }
}
