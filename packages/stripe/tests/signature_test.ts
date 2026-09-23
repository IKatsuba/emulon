import Stripe from 'stripe';
import { retryDelayMs, transport } from '../src/webhooks/mod.ts';

Deno.test('Stripe exact-byte HMAC vector, wrong secret and tampered body', async () => {
  const body = new TextEncoder().encode('{"hello":"world"}');
  const headers = await transport.headers({
    body,
    id: 'unused',
    timestamp: 1700000000,
    secret: 'whsec_literal',
  });

  if (
    headers['stripe-signature'] !==
      't=1700000000,v1=2a4bc254f07b99aead1678750f5a21dc05afb81fdba86358c0f353f59c9d4cd2'
  ) {
    throw new Error('HMAC mismatch');
  }

  for (
    const [payload, secret] of [[body, 'wrong'], [
      new TextEncoder().encode('{"hello":"World"}'),
      'whsec_literal',
    ]] as const
  ) {
    let rejected = false;

    try {
      await Stripe.webhooks.constructEventAsync(
        new TextDecoder().decode(payload),
        headers['stripe-signature']!,
        secret,
        300,
        Stripe.createSubtleCryptoProvider(),
        1700000000000,
      );
    } catch {
      rejected = true;
    }

    if (!rejected) {
      throw new Error('Invalid signature accepted');
    }
  }

  if (
    JSON.stringify([0, 1, 2, 3, 4, 5].map(retryDelayMs)) !==
      '[null,60000,3600000,7200000,null,null]'
  ) {
    throw new Error('Retry schedule mismatch');
  }
});

Deno.test('Stripe started SDK reset and dispose cancel queued retries', async () => {
  const { default: stripe } = await import('@emulon/stripe');
  const { Emulon } = await import('emulon');
  let requests = 0;
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () => {
      requests++;

      return new Response(null, { status: 500 });
    },
  );
  const config = {
    services: {
      stripe: stripe({
        destinations: [{
          id: 'app',
          url: `http://127.0.0.1:${receiver.addr.port}`,
          secret: 'whsec_local',
          types: ['customer.created'],
          enabled: true,
        }],
      }),
    },
  };
  const env = await Emulon.start(config);

  try {
    await env.services.stripe.customers.create({ name: 'Before reset' });

    const deliveries = await env.services.stripe.webhooks.list({});

    if (
      deliveries.length !== 1 || deliveries[0]!.status !== 'queued' ||
      !deliveries[0]!.nextAttemptAt
    ) {
      throw new Error('Retry not queued');
    }

    await env.reset();

    if ((await env.services.stripe.webhooks.list({})).length !== 0) {
      throw new Error('Reset retained deliveries');
    }

    await env.services.stripe.customers.create({ name: 'Before dispose' });

    if (requests !== 2) {
      throw new Error('Unexpected deliveries');
    }
  } finally {
    await env[Symbol.asyncDispose]();
    await receiver.shutdown();
  }
});
