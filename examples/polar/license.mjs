// Polar request and response fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';
import { Emulon } from 'emulon';
import { Polar } from '@polar-sh/sdk';
import { ResourceNotFound } from '@polar-sh/sdk/models/errors/resourcenotfound.js';

const [executable, prefix] = process.argv[2]
  ? JSON.parse(process.argv[2])
  : [process.execPath, ['node_modules/emulon/esm/cli/main.js']];
const execute = promisify(execFile);

/**
 * A dedicated environment keeps the example repeatable and leaves the
 * project's `default` state alone.
 */
const environment = 'polar-license-example';

async function cli(...args) {
  const { stdout } = await execute(
    executable,
    [...prefix, ...args, '--environment', environment, '--json'],
    { timeout: 15000 },
  );

  return JSON.parse(stdout);
}

/** Starts the project host in the foreground and waits for its readiness. */
async function up() {
  const child = spawn(
    executable,
    [...prefix, 'up', '--environment', environment, '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';

  child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emulon up readiness timeout\n${stderr}`)),
      20000,
    );

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`emulon up exited with ${code}\n${stderr}`));
    });

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;

      try {
        const output = JSON.parse(stdout);

        clearTimeout(timer);
        resolve(output);
      } catch { /* Read the remaining JSON. */ }
    });
  }).catch((error) => {
    child.kill('SIGKILL');

    throw error;
  });

  child.removeAllListeners('exit');

  return {
    api: ready.endpoints.billing.api,
    exited: new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
      } else {
        child.once('exit', resolve);
      }
    }),
    kill: () => child.kill('SIGKILL'),
  };
}

/** What a desktop client sends: no token, no conditions, no metadata. */
async function portal(api, operation, body) {
  const response = await fetch(
    `${api}/v1/customer-portal/license-keys/${operation}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
  };
}

const host = await up();
let connected;

try {
  // A restored environment keeps earlier keys; start the cycle from nothing.
  await cli('reset');

  connected = await Emulon.connect({
    config: await Emulon.load(),
    environment,
  });

  const service = connected.services.billing;
  const { api } = host;

  // One manifest: npm metadata, CLI and the connected SDK.
  const metadata = JSON.parse(
    await readFile('node_modules/@emulon/polar/package.json', 'utf8'),
  );
  const manifest = metadata.emulon.compatibility;

  assert.deepEqual(await cli('billing', 'compatibility', 'get'), manifest);
  assert.deepEqual(await service.compatibility.get({}), manifest);
  assert.deepEqual(
    manifest.operations
      .filter(({ id }) => id.startsWith('customerPortal.'))
      .map(({ id, auth }) => [id, auth]),
    ['activate', 'validate', 'deactivate'].map((name) => [
      `customerPortal.licenseKeys.${name}`,
      ['none'],
    ]),
  );
  console.log(
    `manifest: npm metadata, CLI and connected SDK agree (${manifest.verification.client})`,
  );

  const customer = await cli(
    'billing',
    'customers',
    'create',
    '--email',
    'ada@example.test',
    '--name',
    'Ada',
  );
  const benefit = await cli(
    'billing',
    'benefits',
    'create',
    '--description',
    'Desktop Pro',
    '--limit-activations',
    '2',
    '--enable-customer-admin',
  );
  const organizationId = benefit.organization_id;
  const fromCLI = await cli(
    'billing',
    'license-keys',
    'grant',
    '--benefit-id',
    benefit.id,
    '--customer-id',
    customer.id,
  );
  const fromSDK = await service.licenseKeys.grant({
    benefitId: benefit.id,
    customerId: customer.id,
  });

  assert.deepEqual(await service.licenseKeys.get({ id: fromCLI.id }), {
    ...fromCLI,
    activations: [],
  });
  assert.deepEqual(
    await cli('billing', 'license-keys', 'get', '--id', fromSDK.id),
    { ...fromSDK, activations: [] },
  );
  console.log(
    `grant: CLI issued ${fromCLI.display_key}, connected SDK issued ${fromSDK.display_key}, 2 activations each`,
  );

  // The raw desktop-shaped cycle over the CLI-issued key.
  const activated = await portal(api, 'activate', {
    key: fromCLI.key,
    organization_id: organizationId,
    label: 'Ada’s MacBook',
  });

  assert.equal(activated.status, 200);
  assert.equal(activated.body.license_key.id, fromCLI.id);
  console.log(`fetch: activate ${fromCLI.display_key} → ${activated.status}`);

  const withActivation = {
    key: fromCLI.key,
    organization_id: organizationId,
    activation_id: activated.body.id,
  };
  const validated = await portal(api, 'validate', withActivation);

  assert.equal(validated.status, 200);
  assert.equal(validated.body.status, 'granted');
  assert.equal(validated.body.activation.id, activated.body.id);
  console.log(
    `fetch: validate → ${validated.status} ${validated.body.status}, validations ${validated.body.validations}`,
  );

  const deactivated = await portal(api, 'deactivate', withActivation);

  assert.equal(deactivated.status, 204);
  console.log(`fetch: deactivate → ${deactivated.status}`);

  const gone = await portal(api, 'validate', withActivation);

  assert.equal(gone.status, 404);
  assert.deepEqual(gone.body, {
    error: 'ResourceNotFound',
    detail: 'Not found',
  });
  console.log(
    `fetch: validate → ${gone.status} ${gone.body.error}: ${gone.body.detail}`,
  );

  // The pinned official client over the SDK-issued key, without a token.
  const client = new Polar({
    serverURL: api,
    retryConfig: { strategy: 'none' },
  });
  const activation = await client.customerPortal.licenseKeys.activate({
    key: fromSDK.key,
    organizationId,
    label: 'studio',
  });

  assert.equal(activation.licenseKey.id, fromSDK.id);
  console.log(`@polar-sh/sdk: activate ${fromSDK.display_key} → ok`);

  const official = await client.customerPortal.licenseKeys.validate({
    key: fromSDK.key,
    organizationId,
    activationId: activation.id,
  });

  assert.equal(official.status, 'granted');
  assert.equal(official.activation?.id, activation.id);
  console.log(
    `@polar-sh/sdk: validate → ${official.status}, validations ${official.validations}`,
  );
  await client.customerPortal.licenseKeys.deactivate({
    key: fromSDK.key,
    organizationId,
    activationId: activation.id,
  });
  console.log('@polar-sh/sdk: deactivate → ok');

  const refused = await client.customerPortal.licenseKeys.validate({
    key: fromSDK.key,
    organizationId,
    activationId: activation.id,
  }).catch((error) => error);

  assert.ok(refused instanceof ResourceNotFound, String(refused));
  assert.equal(refused.detail, 'Not found');
  console.log(
    `@polar-sh/sdk: validate → ${refused.error}: ${refused.detail}`,
  );

  // Both keys are free again, and diagnostics show only the display key.
  const inspected = [
    await cli('billing', 'license-keys', 'inspect', '--id', fromCLI.id),
    await service.licenseKeys.inspect({ id: fromSDK.id }),
  ];

  for (const state of inspected) {
    assert.deepEqual(state.activation_ids, []);
    assert.equal(state.validations, 1);
  }

  const boundary = JSON.stringify(inspected);

  assert.ok(!boundary.includes(fromCLI.key), 'Inspection exposed a key');
  assert.ok(!boundary.includes(fromSDK.key), 'Inspection exposed a key');
  console.log('inspect: no live activations, keys shown only as display keys');
} finally {
  await connected?.dispose();
  // A failed `down` must not leave the foreground host behind.
  await cli('down').catch(() => host.kill());
}

assert.equal(await host.exited, 0, 'emulon up did not shut down cleanly');
