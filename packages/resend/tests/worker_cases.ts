import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { inspectAttempts } from 'emulon';
import resend from '../src/mod.ts';
import { startWithAdapter } from '../../emulon/src/sdk/start.ts';
import {
  memoryAdapter,
  type StateHandle,
} from '../../emulon/src/state/store.ts';
import { listen } from '../../emulon/src/runtime/http.ts';

export const { cases, register } = caseRegistry(
  'packages/resend/tests/worker_cases.ts',
);

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const secret = `whsec_${btoa('local-signing-secret')}`;

register(
  'resend.worker.1',
  [],
  [],
  true,
  'Resend action sends exact signed bytes and retains bounded failed attempts without leaking credentials',
  async () => {
    let status = 200;
    const received: { body: Uint8Array; headers: Headers }[] = [];
    const receiver = await listen(async (request) => {
      received.push({
        body: new Uint8Array(await request.arrayBuffer()),
        headers: request.headers,
      });

      return new Response(secret.repeat(300), { status });
    });

    let state: StateHandle;
    const env = await startWithAdapter({
      services: {
        mail: resend({
          destinations: [{
            id: 'one',
            url: receiver.url,
            secret,
            types: ['email.sent'],
            enabled: true,
          }],
        }),
      },
    }, {
      async open(input) {
        return state = await memoryAdapter().open(input);
      },
    });

    try {
      const { apiKey } = await env.services.mail.keys.create();

      for (const expected of ['succeeded', 'failed']) {
        const response = await fetch(`${env.endpoints.mail.api}/emails`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: 'a@b.test',
            to: 'c@d.test',
            subject: 'Привет 🌍',
            text: 'test',
          }),
        });

        equal(response.status, 200);
        await response.text();

        const deliveries = await env.services.mail.webhooks.list();
        const delivery = deliveries.at(-1)!;

        equal(delivery.status, expected);

        const [attempt] = await inspectAttempts(state!.store, delivery.id);

        equal(attempt!.responseStatus, status);
        equal(attempt!.errorCode, status === 200 ? undefined : 'HTTP_STATUS');
        equal(Boolean(attempt!.completedAt), true);

        const request = received.at(-1)!;

        equal(attempt!.requestBytes, Array.from(request.body));

        const prefix = new TextEncoder().encode(
          `${request.headers.get('svix-id')}.${
            request.headers.get('svix-timestamp')
          }.`,
        );
        const signed = new Uint8Array(prefix.length + request.body.length);

        signed.set(prefix);
        signed.set(request.body, prefix.length);

        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode('local-signing-secret'),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        const signature = Uint8Array.from(
          atob(request.headers.get('svix-signature')!.slice(3)),
          (c) => c.charCodeAt(0),
        );

        equal(await crypto.subtle.verify('HMAC', key, signature, signed), true);

        const inspection = JSON.stringify({
          attempt,
          destinations: await env.services.mail.webhooks.destinations(),
        });

        equal(inspection.includes(secret), false);
        equal(inspection.includes('svix-signature'), false);
        equal(inspection.includes(apiKey), false);

        const stored = await state!.store.transaction((tx) =>
          tx.get('emulon.attempts', attempt!.id)
        ) as { responseBytes: number[]; responseTruncated: boolean };

        equal(stored.responseBytes.length, 4096);
        equal(stored.responseTruncated, true);

        status = 503;
      }

      equal(received.length, 2);
    } finally {
      await env.dispose();
      await receiver.stop();
    }
  },
);
