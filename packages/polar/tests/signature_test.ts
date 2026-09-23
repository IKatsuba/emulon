import { validateEvent } from '@polar-sh/sdk/webhooks.js';
import { safeHeaders } from '../../emulon/src/deliveries/worker.ts';
import {
  maxAttempts,
  payloadSchema,
  retryDelayMs,
  signature,
  transport,
} from '../src/webhooks/mod.ts';
import { apiVersion, makeCustomer } from '../src/model/customers.ts';
import { assert, equal, rejects } from './assert.ts';

const secret = 'whsec_литерал_£_🐻';
const id = 'msg_2Zq1mB0mYy3lF4bC';
const timestamp = 1700000000;

Deno.test('Polar signs the whole UTF-8 secret over exact id.timestamp.body bytes', async () => {
  const body = new TextEncoder().encode('{"hello":"wörld 🐻"}');

  // An independent HMAC-SHA256 vector; the secret prefix is part of the key.
  equal(
    await signature(secret, id, timestamp, body),
    'v1,bOqAEFFl0P03J/Mrmg65JHjhjUkfxqFmPV3lFQJvDwU=',
  );
  assert(body.length === 23, 'Vector body is not the expected byte string');

  // Stripping whsec_, as a decoded dashboard secret would, is a different key.
  equal(
    await signature(secret.slice(6), id, timestamp, body),
    'v1,orpMXng1YoozrqU/zkkAf6rUwMnU4+3dzuOVj80BJTY=',
  );

  for (
    const [otherSecret, otherId, otherTimestamp, otherBody] of [
      [secret + ' ', id, timestamp, body],
      [secret, id + 'x', timestamp, body],
      [secret, id, timestamp + 1, body],
      [secret, id, timestamp, new TextEncoder().encode('{"hello":"world 🐻"}')],
    ] as const
  ) {
    assert(
      await signature(otherSecret, otherId, otherTimestamp, otherBody) !==
        'v1,bOqAEFFl0P03J/Mrmg65JHjhjUkfxqFmPV3lFQJvDwU=',
      'Signature ignored part of its input',
    );
  }

  await rejects(() => signature('', id, timestamp, body));
});

Deno.test('Polar transport headers verify with the pinned SDK and reject tampering', async () => {
  const customer = makeCustomer(
    { email: 'ада@example.test', name: 'Ада 🐻', externalId: 'usr_£' },
    crypto.randomUUID(),
    crypto.randomUUID(),
    '2026-09-22T00:00:00.000Z',
  );
  const payload = payloadSchema.parse({
    type: 'customer.created',
    timestamp: customer.created_at,
    api_version: apiVersion,
    data: customer,
  });
  const body = transport.serialize({
    id: 'evt',
    instanceId: 'billing',
    type: 'customer.created',
    occurredAt: customer.created_at,
    origin: 'service',
    payload,
  });
  const now = Math.floor(Date.now() / 1000);
  const headers = await transport.headers({
    body,
    id,
    timestamp: now,
    secret,
  });

  equal(headers['content-type'], 'application/json');
  equal(headers['webhook-id'], id);
  equal(headers['webhook-timestamp'], String(now));
  equal(headers['webhook-api-version'], apiVersion);
  equal(
    headers['webhook-signature'],
    await signature(secret, id, now, body),
  );

  const text = new TextDecoder().decode(body);
  const event = validateEvent(text, headers, secret);

  assert(event.type === 'customer.created', 'Unexpected parsed event type');
  equal(event.data.email, 'ада@example.test');
  equal(event.data.name, 'Ада 🐻');
  equal(event.data.externalId, 'usr_£');

  for (
    const [received, key] of [
      [text, 'whsec_литерал_£'],
      [text, secret.slice(6)],
      [text.replace('Ада', 'Ada'), secret],
      [text + ' ', secret],
    ] as const
  ) {
    await rejects(() => Promise.resolve(validateEvent(received, headers, key)));
  }

  for (
    const missing of ['webhook-id', 'webhook-timestamp', 'webhook-signature']
  ) {
    const partial = { ...headers };

    delete partial[missing];
    await rejects(() => Promise.resolve(validateEvent(text, partial, secret)));
  }

  // Inspection keeps the framing headers and never the signature.
  equal(Object.keys(safeHeaders(headers)).sort(), [
    'content-type',
    'webhook-api-version',
    'webhook-id',
    'webhook-timestamp',
  ]);
  equal(
    safeHeaders({ 'svix-signature': 'v1,x', 'stripe-signature': 't=1,v1=x' }),
    {},
  );
});

Deno.test('Polar retry schedule has ten attempts and a terminal tenth failure', () => {
  equal(maxAttempts, 10);
  equal(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(retryDelayMs),
    [
      undefined,
      2000,
      4000,
      8000,
      16000,
      32000,
      64000,
      128000,
      256000,
      512000,
      undefined,
      undefined,
    ],
  );
  equal(transport.timeoutMs, 10000);

  for (const status of [200, 201, 204, 299]) {
    assert(transport.succeeds(status), `${status} should succeed`);
  }

  for (const status of [199, 301, 302, 400, 404, 429, 500, 503]) {
    assert(!transport.succeeds(status), `${status} should fail`);
  }
});
