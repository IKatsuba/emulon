import { type DeliveryInspection, type DeliveryRecord, Emulon } from 'emulon';
import resend from '@emulon/resend';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { CommandError } from '../../emulon/src/commands/registry.ts';
import { listen } from '../../emulon/src/runtime/http.ts';
import { normalize, parity } from './helpers/parity.ts';

const data = {
  // deno-lint-ignore camelcase
  email_id: '11111111-1111-4111-8111-111111111111',
  from: 'a@example.test',
  to: ['b@example.test'],
  subject: 'Direct 🌍',
};

Deno.test('webhook CLI/SDK parity: direct send, inspect, timeout, wait and second attempt', async () => {
  const directory = await Deno.makeTempDir();

  await Deno.writeTextFile(`${directory}/event.json`, JSON.stringify(data));

  const secret = `whsec_${btoa('initial-secret')}`;
  const rotated = `whsec_${btoa('rotated-secret')}`;
  let status = 503;
  const requests: {
    body: string;
    id: string | null;
    signature: string | null;
  }[] = [];
  const receiver = await listen(async (request) => {
    requests.push({
      body: await request.text(),
      id: request.headers.get('svix-id'),
      signature: request.headers.get('svix-signature'),
    });

    return new Response(secret, { status });
  });

  const destination = {
    id: 'app',
    url: receiver.url,
    secret,
    types: ['email.sent'],
    enabled: true,
  };
  const config = {
    services: {
      mail: resend({
        destinations: [destination, { ...destination, id: 'other' }],
      }),
    },
  };

  try {
    await using _host = await serveEnvironment(config, { directory });
    await using env = await Emulon.connect({ config, directory });
    const observations = [];

    for (const path of ['CLI', 'SDK']) {
      await env.reset();

      status = 503;
      requests.length = 0;

      const cli = async (args: string[]) => {
        const result = await runProjectCLI(
          ['mail', 'webhooks', ...args, '--json'],
          undefined,
          directory,
        );

        if (result.code) {
          const error = JSON.parse(result.stderr).error;

          throw new CommandError(
            error.code,
            error.message,
            error.fields,
            error.available,
          );
        }

        parity('webhooks', 'stderr', result.stderr, '');

        return JSON.parse(result.stdout);
      };

      const capture = async (call: () => Promise<unknown>) => {
        try {
          await call();

          throw new Error('Expected command rejection');
        } catch (error) {
          if (!(error instanceof CommandError)) {
            throw error;
          }

          return error.toJSON();
        }
      };

      const sent: DeliveryRecord = path === 'CLI'
        ? await cli([
          'send',
          'email.sent',
          '--data',
          'event.json',
          '--destination',
          'app',
        ])
        : await env.services.mail.webhooks.send({
          type: 'email.sent',
          data,
          destination: 'app',
        });

      parity('send', 'only explicit destination', requests.length, 1);
      parity(
        'send',
        'no email mutation',
        await env.services.mail.emails.list(),
        [],
      );

      const events = await env.events.list();

      parity('send', 'event origin', events.map((e) => e.origin), ['direct']);
      parity('send', 'event payload', events[0]!.payload, data);

      const list: DeliveryRecord[] = path === 'CLI'
        ? await cli(['list'])
        : await env.services.mail.webhooks.list();

      parity('list', 'failed delivery', list, [{ ...sent, status: 'failed' }]);

      const inspect = async (): Promise<DeliveryInspection> =>
        path === 'CLI'
          ? await cli(['inspect', sent.id])
          : await env.services.mail.webhooks.inspect({ id: sent.id });
      const failed = await inspect();
      const timeout = await capture(() =>
        path === 'CLI'
          ? cli(['wait', sent.id, '--status', 'succeeded', '--timeout', '20ms'])
          : env.services.mail.webhooks.wait({
            id: sent.id,
            status: 'succeeded',
            timeout: '20ms',
          })
      );

      parity('wait', 'timeout', timeout.code, 'WAIT_TIMEOUT');
      parity(
        'wait',
        'current state',
        timeout.message,
        'Webhook wait timed out; current status: failed.',
      );

      status = 200;

      await env.services.mail.webhooks.configure({
        ...destination,
        secret: rotated,
      });

      const waiting = path === 'CLI'
        ? cli(['wait', sent.id, '--status', 'succeeded', '--timeout', '10s'])
        : env.services.mail.webhooks.wait({
          id: sent.id,
          status: 'succeeded',
          timeout: '10s',
        });
      const redelivered = path === 'CLI'
        ? await cli(['redeliver', sent.id])
        : await env.services.mail.webhooks.redeliver({ id: sent.id });
      const succeeded = await waiting;
      const inspected = await inspect();

      parity('redeliver', 'attempt count', inspected.attempts.length, 2);
      parity('redeliver', 'received count', requests.length, 2);
      parity(
        'redeliver',
        'body preserved',
        requests[0]!.body,
        requests[1]!.body,
      );
      parity(
        'redeliver',
        'provider ID preserved',
        requests[0]!.id,
        requests[1]!.id,
      );
      parity(
        'redeliver',
        'signature recalculated with rotated secret',
        requests[0]!.signature === requests[1]!.signature,
        false,
      );
      parity('wait', 'success', succeeded.status, 'succeeded');
      parity('redeliver', 'no extra events', await env.events.list(), events);

      const text = JSON.stringify(inspected);

      for (
        const forbidden of [
          secret,
          rotated,
          'authorization',
          'svix-signature',
          'responseBytes',
        ]
      ) {
        parity(
          'inspect',
          `redaction ${forbidden.startsWith('whsec_') ? 'secret' : forbidden}`,
          text.includes(forbidden),
          false,
        );
      }

      const missing = await capture(() =>
        path === 'CLI'
          ? cli(['inspect', 'missing'])
          : env.services.mail.webhooks.inspect({ id: 'missing' })
      );
      const symbols = new Map([[sent.id, '<delivery>'], [
        events[0]!.id,
        '<event>',
      ], [events[0]!.occurredAt, '<time>']]);

      inspected.attempts.forEach((attempt, index) => {
        symbols.set(attempt.id, `<attempt-${index}>`);
        symbols.set(attempt.providerDeliveryId, '<provider-id>');
        symbols.set(attempt.startedAt, '<time>');
        symbols.set(attempt.completedAt!, '<time>');
        symbols.set(attempt.headers['svix-timestamp']!, '<signature-time>');
      });

      // Exact body equality was checked above; normalize only its event timestamp.
      for (const view of [failed, inspected]) {
        for (const attempt of view.attempts) {
          const body = JSON.parse(
            new TextDecoder().decode(new Uint8Array(attempt.requestBytes)),
          );

          parity('inspect', 'body data', body.data, data);
          parity(
            'inspect',
            'body timestamp',
            body.created_at,
            events[0]!.occurredAt,
          );
          parity('inspect', 'body type', body.type, 'email.sent');

          body.created_at = '<event-time>';
          attempt.requestBytes = Array.from(
            new TextEncoder().encode(JSON.stringify(body)),
          );
        }
      }

      observations.push(
        normalize({
          sent,
          list,
          failed,
          timeout,
          redelivered,
          succeeded,
          inspected,
          missing,
          events,
        }, symbols),
      );
    }

    parity(
      'webhooks',
      'results, errors and events',
      observations[0],
      observations[1],
    );
  } finally {
    await receiver.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
