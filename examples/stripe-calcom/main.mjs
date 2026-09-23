import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';
import { promisify } from 'node:util';
import { Emulon } from 'emulon';
import stripe from '@emulon/stripe';
import calcom from '@emulon/calcom';
import Stripe from 'stripe';

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

const secret = 'local-example_секрет_£';
const received = [];
const receiver = createServer(async (request, response) => {
  try {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    const kind = request.url.slice(1);

    if (kind === 'stripe') {
      const signature = request.headers['stripe-signature'];
      const fields = Object.fromEntries(
        signature.split(',').map((v) => v.split('=')),
      );

      assert.match(fields.t, /^\d+$/);
      assert.equal(
        fields.v1,
        createHmac('sha256', secret).update(fields.t + '.').update(body).digest(
          'hex',
        ),
      );
      await Stripe.webhooks.constructEventAsync(
        body.toString('utf8'),
        signature,
        secret,
        300,
        Stripe.createSubtleCryptoProvider(),
      );
    } else {
      assert.equal(kind, 'calcom');
      assert.equal(request.headers['x-cal-webhook-version'], '2021-10-20');
      assert.equal(
        request.headers['x-cal-signature-256'],
        createHmac('sha256', secret).update(body).digest('hex'),
      );
    }

    received.push({ kind, body: JSON.parse(body.toString('utf8')) });
    response.writeHead(204).end();
  } catch (error) {
    received.push({ error: String(error) });
    response.writeHead(400).end();
  }
});

await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

const destination = (kind) => ({
  id: 'example',
  url: `http://127.0.0.1:${receiver.address().port}/${kind}`,
  secret,
  enabled: true,
  types: [kind === 'stripe' ? 'customer.created' : 'BOOKING_CREATED'],
});
const config = { services: { stripe: stripe(), calcom: calcom() } };
let connected;
let started;

async function closed(endpoints) {
  for (const service of Object.values(endpoints)) {
    for (const endpoint of Object.values(service)) {
      const probe = createServer();

      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(Number(new URL(endpoint).port), '127.0.0.1', resolve);
      });

      await new Promise((resolve, reject) =>
        probe.close((e) => e ? reject(e) : resolve())
      );
    }
  }
}

try {
  connected = await Emulon.connect({ config });

  await connected.services.stripe.webhooks.configure(destination('stripe'));
  await connected.services.calcom.webhooks.configure(destination('calcom'));

  for (const kind of ['stripe', 'calcom']) {
    const metadata = JSON.parse(
      await readFile(`node_modules/@emulon/${kind}/package.json`, 'utf8'),
    );

    assert.deepEqual(
      await cli(kind, 'compatibility', 'get'),
      metadata.emulon.compatibility,
    );
    assert.deepEqual(
      await connected.services[kind].compatibility.get({}),
      metadata.emulon.compatibility,
    );
  }

  const cliCustomer = await cli(
    'stripe',
    'customers',
    'create',
    '--name',
    'CLI Ada',
  );

  assert.deepEqual(
    await connected.services.stripe.customers.get({ id: cliCustomer.id }),
    cliCustomer,
  );

  const sdkCustomer = await connected.services.stripe.customers.create({
    name: 'SDK Ada',
  });

  assert.deepEqual(
    await cli('stripe', 'customers', 'get', '--id', sdkCustomer.id),
    sdkCustomer,
  );

  const { apiKey } = await connected.services.stripe.keys.create({});
  const endpoint = new URL(connected.endpoints.stripe.api);
  const client = new Stripe(apiKey, {
    host: endpoint.hostname,
    port: Number(endpoint.port),
    protocol: 'http',
    apiVersion: '2025-03-31.basil',
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    telemetry: false,
  });

  assert.deepEqual(
    await client.customers.retrieve(cliCustomer.id),
    cliCustomer,
  );

  const official = await client.customers.create({ name: 'Official Ada' }, {
    idempotencyKey: 'example',
  });

  assert.equal(
    (await client.customers.create({ name: 'Official Ada' }, {
      idempotencyKey: 'example',
    })).id,
    official.id,
  );
  assert.deepEqual(
    await connected.services.stripe.customers.get({ id: official.id }),
    official,
  );

  const slots = [
    '2099-06-01T10:00:00Z',
    '2099-06-01T11:00:00Z',
    '2099-06-01T12:00:00Z',
  ];
  const type = await cli(
    'calcom',
    'event-types',
    'create',
    '--title',
    'CLI consultation',
    '--slug',
    'cli',
    '--length-in-minutes',
    '30',
    '--slots',
    JSON.stringify(slots),
  );

  assert.deepEqual(
    await connected.services.calcom.eventTypes.get({ id: type.id }),
    type,
  );

  const sdkType = await connected.services.calcom.eventTypes.create({
    title: 'SDK consultation',
    slug: 'sdk',
    lengthInMinutes: 30,
    slots,
  });

  assert.deepEqual(
    await cli('calcom', 'event-types', 'get', '--id', String(sdkType.id)),
    sdkType,
  );

  const attendee = { name: 'Ada', email: 'ada@example.test', timeZone: 'UTC' };
  const cliBooking = await cli(
    'calcom',
    'bookings',
    'create',
    '--event-type-id',
    String(type.id),
    '--start',
    slots[0],
    '--attendee',
    JSON.stringify(attendee),
  );

  assert.deepEqual(
    await connected.services.calcom.bookings.get({ uid: cliBooking.uid }),
    cliBooking,
  );

  const sdkBooking = await connected.services.calcom.bookings.create({
    eventTypeId: sdkType.id,
    start: slots[1],
    attendee,
  });

  assert.deepEqual(
    await cli('calcom', 'bookings', 'get', '--uid', sdkBooking.uid),
    sdkBooking,
  );

  const calKey = await connected.services.calcom.keys.create({});
  const cal = async (path, version, body) => {
    const response = await fetch(connected.endpoints.calcom.api + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${calKey.apiKey}`,
        'cal-api-version': version,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    assert.equal(response.status, body ? 201 : 200);

    const result = await response.json();

    assert.equal(result.status, 'success');

    return result.data;
  };

  assert.deepEqual(await cal(`/v2/event-types/${type.id}`, '2026-06-12'), type);
  assert.deepEqual(
    await cal(
      `/v2/slots?eventTypeId=${type.id}&start=2099-06-01&end=2099-06-01`,
      '2024-09-04',
    ),
    { '2099-06-01': [{ start: '2099-06-01T12:00:00.000Z' }] },
  );

  const httpBooking = await cal('/v2/bookings', '2026-02-25', {
    eventTypeId: type.id,
    start: slots[2],
    attendee,
  });

  assert.deepEqual(
    await cal(`/v2/bookings/${cliBooking.uid}`, '2026-02-25'),
    cliBooking,
  );
  assert.deepEqual(
    await connected.services.calcom.bookings.get({ uid: httpBooking.uid }),
    httpBooking,
  );

  for (const kind of ['stripe', 'calcom']) {
    const deliveries = await connected.services[kind].webhooks.list({});

    assert.equal(deliveries.length, 3);

    for (const { id } of deliveries) {
      await connected.services[kind].webhooks.wait({
        id,
        status: 'succeeded',
        timeout: '5s',
      });
    }
  }

  assert.equal(received.length, 6);
  assert.ok(received.every((entry) => !entry.error), JSON.stringify(received));
  assert.deepEqual(
    received.filter((r) => r.kind === 'stripe').map((r) =>
      r.body.data.object.id
    ).sort(),
    [cliCustomer.id, sdkCustomer.id, official.id].sort(),
  );
  assert.deepEqual(
    received.filter((r) => r.kind === 'calcom').map((r) => r.body.payload.uid)
      .sort(),
    [cliBooking.uid, sdkBooking.uid, httpBooking.uid].sort(),
  );
  await connected.dispose();

  connected = undefined;
  // A private environment must own and release both listeners independently.
  started = await Emulon.start(config);

  const privateCustomer = await started.services.stripe.customers.create({
    name: 'Private',
  });
  const privateType = await started.services.calcom.eventTypes.create({
    title: 'Private',
    slug: 'private',
    lengthInMinutes: 30,
    slots,
  });
  const endpoints = started.endpoints;

  assert.notEqual(endpoints.stripe.api, endpoint.origin);

  const stripeKey = await started.services.stripe.keys.create({});
  const privateCalKey = await started.services.calcom.keys.create({});
  const stripeRead = await fetch(
    endpoints.stripe.api + '/v1/customers/' + privateCustomer.id,
    { headers: { authorization: `Bearer ${stripeKey.apiKey}` } },
  );

  assert.equal(stripeRead.status, 200);
  assert.deepEqual(await stripeRead.json(), privateCustomer);

  const calRead = await fetch(
    endpoints.calcom.api + '/v2/event-types/' + privateType.id,
    {
      headers: {
        authorization: `Bearer ${privateCalKey.apiKey}`,
        'cal-api-version': '2026-06-12',
      },
    },
  );

  assert.equal(calRead.status, 200);
  assert.deepEqual((await calRead.json()).data, privateType);
  await started.dispose();

  started = undefined;

  await closed(endpoints);
  console.log(
    'CLI/connected SDK, stripe@18.0.0, Cal.com HTTP, six independently signed deliveries, manifest parity and private listener release passed',
  );
} finally {
  await connected?.dispose();
  await started?.dispose();
  await new Promise((resolve, reject) =>
    receiver.close((e) => e ? reject(e) : resolve())
  );
}
