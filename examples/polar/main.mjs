import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';
import { promisify } from 'node:util';
import { Emulon } from 'emulon';
import { Polar } from '@polar-sh/sdk';
import { validateEvent } from '@polar-sh/sdk/webhooks.js';

const [executable, prefix] = process.argv[2]
  ? JSON.parse(process.argv[2])
  : [process.execPath, ['node_modules/emulon/esm/cli/main.js']];
const execute = promisify(execFile);

async function cli(...args) {
  const { stdout } = await execute(executable, [...prefix, ...args, '--json'], {
    timeout: 15000,
  });

  return JSON.parse(stdout);
}

/**
 * The legacy custom-secret mode signs with the whole secret as UTF-8 bytes,
 * including the `whsec_` prefix. A multi-byte secret that is not valid base64
 * proves the bytes are never decoded.
 */
const secret = 'whsec_локальный_£';
const received = [];
const receiver = createServer(async (request, response) => {
  try {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    const id = request.headers['webhook-id'];
    const timestamp = request.headers['webhook-timestamp'];

    assert.match(timestamp, /^\d+$/);
    assert.equal(request.headers['webhook-api-version'], '2026-04');

    // An independent Standard Webhooks computation over id.timestamp.body.
    const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(Buffer.from(`${id}.${timestamp}.`, 'utf8'))
      .update(body)
      .digest('base64');
    const [, signature] = request.headers['webhook-signature'].split(',');

    assert.equal(signature.length, expected.length);
    assert.ok(
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
      'Independent signature mismatch',
    );

    // The pinned official verifier reads the same bytes and headers.
    const event = validateEvent(body, request.headers, secret);

    assert.equal(event.type, 'customer.created');
    received.push({ id, event, body });
    response.writeHead(204).end();
  } catch (error) {
    received.push({ error: String(error) });
    response.writeHead(400).end();
  }
});

await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

/** The client appends `/v1` itself and must only ever see a loopback origin. */
function official(api, apiKey) {
  return new Polar({
    accessToken: apiKey,
    serverURL: api,
    retryConfig: { strategy: 'none' },
  });
}

/** The conversions the official client applies, written out field by field. */
function normalize(customer) {
  return {
    id: customer.id,
    created_at: customer.createdAt.toISOString(),
    modified_at: customer.modifiedAt?.toISOString() ?? null,
    metadata: customer.metadata,
    external_id: customer.externalId ?? null,
    email: customer.email,
    email_verified: customer.emailVerified,
    type: customer.type,
    name: customer.name,
    billing_name: customer.billingName,
    billing_address: customer.billingAddress,
    tax_id: customer.taxId,
    locale: customer.locale ?? null,
    organization_id: customer.organizationId,
    default_payment_method_id: customer.defaultPaymentMethodId ?? null,
    deleted_at: customer.deletedAt?.toISOString() ?? null,
    avatar_url: customer.avatarUrl,
  };
}

/** 0.49.0 drops `first_user_event_at`, which the pinned 2026-04 schema keeps. */
function wireWithoutDropped(customer) {
  const { first_user_event_at: dropped, ...rest } = customer;

  assert.equal(dropped, null);

  return rest;
}

let connected;
let started;

try {
  connected = await Emulon.connect({ config: await Emulon.load() });

  const service = connected.services.billing;
  const api = connected.endpoints.billing.api;

  await service.webhooks.configure({
    id: 'app',
    url: `http://127.0.0.1:${receiver.address().port}`,
    secret,
    types: ['customer.created'],
    enabled: true,
  });

  // One manifest: npm metadata, CLI and the connected SDK.
  const metadata = JSON.parse(
    await readFile('node_modules/@emulon/polar/package.json', 'utf8'),
  );

  assert.deepEqual(
    await cli('billing', 'compatibility', 'get'),
    metadata.emulon.compatibility,
  );
  assert.deepEqual(
    await service.compatibility.get({}),
    metadata.emulon.compatibility,
  );
  assert.equal(
    metadata.emulon.compatibility.verification.client,
    '@polar-sh/sdk@0.49.0',
  );
  assert.equal(
    metadata.emulon.compatibility.verification.liveProviderCompared,
    false,
  );

  const { apiKey } = await cli('billing', 'keys', 'create');

  assert.ok(apiKey.startsWith('polar_oat_'));

  const client = official(api, apiKey);
  const fromCLI = await cli(
    'billing',
    'customers',
    'create',
    '--email',
    'cli@example.test',
    '--name',
    'CLI Ада 🐻',
    '--external-id',
    'usr_cli',
  );

  assert.deepEqual(
    await service.customers.get({ id: fromCLI.id }),
    fromCLI,
  );
  assert.deepEqual(
    normalize(await client.customers.get({ id: fromCLI.id })),
    wireWithoutDropped(fromCLI),
  );

  const fromSDK = await service.customers.create({
    email: 'sdk@example.test',
  });

  assert.deepEqual(
    await cli('billing', 'customers', 'get', '--id', fromSDK.id),
    fromSDK,
  );
  assert.equal(fromSDK.name, null);
  assert.equal(fromSDK.email_verified, false);

  const fromOfficial = await client.customers.create({
    email: 'official@example.test',
    name: 'Official',
    externalId: 'usr_official',
  });
  const wire = await cli(
    'billing',
    'customers',
    'get',
    '--id',
    fromOfficial.id,
  );

  assert.deepEqual(normalize(fromOfficial), wireWithoutDropped(wire));
  assert.equal(wire.organization_id, fromCLI.organization_id);

  // A missing Polar-Version header selects the pinned slice; anything else is
  // refused, and the selected version comes back on supported responses.
  const read = await fetch(`${api}/v1/customers/${wire.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(read.status, 200);
  assert.equal(read.headers.get('polar-version'), '2026-04');
  assert.deepEqual(await read.json(), wire);

  const unsupported = await fetch(`${api}/v1/customers/${wire.id}`, {
    headers: { authorization: `Bearer ${apiKey}`, 'polar-version': '2026-05' },
  });

  assert.equal(unsupported.status, 404);
  assert.equal((await unsupported.json()).error, 'UnsupportedOperation');

  const duplicate = await fetch(`${api}/v1/customers/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'polar-version': '2026-04',
    },
    body: JSON.stringify({ email: 'cli@example.test' }),
  });

  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error, 'CustomerAlreadyExists');

  // Every created customer produced one event and one signed delivery.
  const deliveries = await service.webhooks.list({});

  assert.equal(deliveries.length, 3);

  for (const { id } of deliveries) {
    await service.webhooks.wait({ id, status: 'succeeded', timeout: '10s' });
  }

  assert.ok(received.every((entry) => !entry.error), JSON.stringify(received));
  assert.equal(received.length, 3);
  assert.deepEqual(
    received.map((entry) => entry.event.data.email).sort(),
    ['cli@example.test', 'official@example.test', 'sdk@example.test'],
  );
  assert.ok(
    received.some((entry) => entry.body.toString('utf8').includes('Ада 🐻')),
    'The Unicode name did not survive the delivered bytes',
  );

  for (const entry of received) {
    const envelope = JSON.parse(entry.body.toString('utf8'));

    // The verifier returns camelCase and Date values and drops api_version;
    // the delivered bytes keep the provider projection.
    assert.equal(entry.event.data.organizationId, fromCLI.organization_id);
    assert.equal(
      entry.event.timestamp.toISOString(),
      envelope.timestamp,
    );
    assert.deepEqual(
      normalize(entry.event.data),
      wireWithoutDropped(envelope.data),
    );
    assert.equal(envelope.api_version, '2026-04');
    assert.equal(envelope.data.organization_id, fromCLI.organization_id);
  }

  // Nothing a caller can read carries the secret or the issued token.
  const inspected = await service.webhooks.inspect({ id: deliveries[0].id });
  const boundary = JSON.stringify([
    inspected,
    await service.webhooks.destinations({}),
    await cli('billing', 'webhooks', 'destinations'),
    await cli('billing', 'webhooks', 'inspect', deliveries[0].id),
    await cli('billing', 'webhooks', 'list'),
  ]);

  assert.ok(!boundary.includes(secret), 'A caller result exposed the secret');
  assert.ok(!boundary.includes(apiKey), 'A caller result exposed the token');
  assert.equal(inspected.attempts.length, 1);

  // Manual redelivery reuses the frozen bytes and the delivery-scoped ID.
  const before = received.length;

  await service.webhooks.redeliver({ id: deliveries[0].id });
  await service.webhooks.wait({
    id: deliveries[0].id,
    status: 'succeeded',
    timeout: '10s',
  });
  assert.equal(received.length, before + 1);
  assert.equal(received[before].id, received[0].id);
  assert.deepEqual(received[before].body, received[0].body);
  await connected.dispose();

  connected = undefined;
  // A private environment owns its own state and releases its own listener.
  started = await Emulon.start(await Emulon.load());

  const privateCustomer = await started.services.billing.customers.create({
    email: 'cli@example.test',
  });
  const privateKey = await started.services.billing.keys.create({});
  const endpoint = started.endpoints.billing.api;

  assert.notEqual(endpoint, api);
  assert.notEqual(privateCustomer.id, fromCLI.id);
  assert.deepEqual(
    normalize(
      await official(endpoint, privateKey.apiKey).customers.get({
        id: privateCustomer.id,
      }),
    ),
    wireWithoutDropped(privateCustomer),
  );

  const foreign = await fetch(`${endpoint}/v1/customers/${fromCLI.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(foreign.status, 401);
  await foreign.json();
  await started.dispose();

  started = undefined;

  const probe = createServer();

  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(Number(new URL(endpoint).port), '127.0.0.1', resolve);
  });

  await new Promise((resolve, reject) =>
    probe.close((error) => error ? reject(error) : resolve())
  );
  console.log(
    'CLI, connected SDK, @polar-sh/sdk@0.49.0, four independently verified signed deliveries, manifest parity and private listener release passed',
  );
} finally {
  await connected?.dispose();
  await started?.dispose();
  await new Promise((resolve, reject) =>
    receiver.close((error) => error ? reject(error) : resolve())
  );
}
