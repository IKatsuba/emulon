import calcom from '@emulon/calcom';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { attendee, fixture, organizer, query } from './bookings_cases.ts';
import { assert, equal, rejects } from './assert.ts';

export const secret = 'literal_секрет_£';
export const payload = {
  uid: 'synthetic',
  eventTypeId: 1,
  title: '相談 🗓️',
  startTime: '2099-06-01T11:00:00.000Z',
  endTime: '2099-06-01T11:30:00.000Z',
  organizer,
  attendees: [attendee],
};

export function destination(url: string) {
  return {
    id: 'receiver',
    url,
    secret,
    types: ['BOOKING_CREATED'],
    enabled: true,
  };
}

// Verify captured bytes, independently of the plugin serializer and signer.
export async function verify(
  body: Uint8Array<ArrayBuffer>,
  signature: string,
  secret: string,
) {
  assert(/^[0-9a-f]{64}$/.test(signature));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const digest = Uint8Array.from(
    signature.match(/../g)!,
    (hex) => parseInt(hex, 16),
  );

  return crypto.subtle.verify('HMAC', key, digest, body);
}

export const { cases, register } = caseRegistry(
  'packages/calcom/tests/webhook_cases.ts',
);

register(
  'calcom.webhooks.1',
  [],
  [],
  true,
  'signed booking delivery, manual CLI/SDK recovery, isolation and pending reset',
  async () => {
    let status = 500;
    let currentSecret = secret;
    let entered = Promise.withResolvers<void>();
    let release: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    const captured: { body: Uint8Array<ArrayBuffer>; signature: string }[] = [];
    const receiver = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen() {},
    }, async (request) => {
      equal(request.method, 'POST');
      equal(request.headers.get('x-cal-webhook-version'), '2021-10-20');
      equal(request.headers.get('content-type'), 'application/json');

      const body = new Uint8Array(await request.arrayBuffer());
      const signature = request.headers.get('x-cal-signature-256')!;

      assert(await verify(body, signature, currentSecret));
      assert(!await verify(body, signature, 'wrong secret'));

      const tampered = body.slice();

      tampered[0] = 32;

      assert(!await verify(tampered, signature, currentSecret));
      captured.push({ body, signature });
      entered.resolve();
      await release?.promise;

      return new Response('receiver-secret-canary', { status });
    });

    const directory = await Deno.makeTempDir();
    const dest = destination(`http://127.0.0.1:${receiver.addr.port}`);
    const config = {
      services: {
        cal: calcom({
          destinations: [dest],
          fixtures: { organizer, eventTypes: [{ ...fixture, id: 1 }] },
        }),
        other: calcom({ fixtures: { eventTypes: [{ ...fixture, id: 1 }] } }),
      },
    };
    const host = await serveEnvironment(config, { directory });

    try {
      await using env = await Emulon.connect({ config, directory });
      const service = env.services.cal;
      const cli = async (args: string[]) => {
        const result = await runProjectCLI(
          ['cal', ...args, '--json'],
          undefined,
          directory,
        );

        assert(result.code === 0, result.stderr);

        return JSON.parse(result.stdout);
      };

      const booking = await service.bookings.create({
        eventTypeId: 1,
        start: fixture.slots[0]!,
        attendee,
      });
      const [delivery] = await service.webhooks.list({});

      assert(delivery);
      await cli([
        'webhooks',
        'wait',
        delivery.id,
        '--status',
        'failed',
        '--timeout',
        '5s',
      ]);

      const failed = await service.webhooks.inspect({ id: delivery.id });

      equal(failed.attempts.length, 1);
      equal(failed.attempts[0]!.responseStatus, 500);
      equal(failed.delivery.nextAttemptAt, undefined);

      const event = (await env.events.list())[0]!;
      const body = JSON.parse(new TextDecoder().decode(captured[0]!.body));

      equal(body, {
        triggerEvent: 'BOOKING_CREATED',
        createdAt: event.occurredAt,
        payload: {
          uid: booking.uid,
          eventTypeId: 1,
          title: fixture.title,
          startTime: booking.start,
          endTime: booking.end,
          organizer,
          attendees: [attendee],
        },
      });
      assert(new TextDecoder().decode(captured[0]!.body).includes('Ада'));
      await rejects(() => service.webhooks.configure({ ...dest, secret: '' }));
      await rejects(() =>
        service.webhooks.configure({ ...dest, types: ['BOOKING_CANCELLED'] })
      );

      currentSecret = 'rotated_секрет';

      const configured = await cli([
        'webhooks',
        'configure',
        '--id',
        dest.id,
        '--url',
        dest.url,
        '--secret',
        currentSecret,
        '--types',
        JSON.stringify(dest.types),
        '--enabled',
        'true',
      ]);

      assert(!JSON.stringify(configured).includes(currentSecret));

      status = 201;

      await cli(['webhooks', 'redeliver', delivery.id]);
      await service.webhooks.wait({
        id: delivery.id,
        status: 'succeeded',
        timeout: '5s',
      });
      equal(captured[1]!.body, captured[0]!.body);
      assert(captured[1]!.signature !== captured[0]!.signature);
      await service.webhooks.redeliver({ id: delivery.id });
      await cli([
        'webhooks',
        'wait',
        delivery.id,
        '--status',
        'succeeded',
        '--timeout',
        '5s',
      ]);

      const inspected = await cli(['webhooks', 'inspect', delivery.id]);

      equal(inspected.attempts.length, 3);

      for (
        const canary of [
          secret,
          currentSecret,
          'receiver-secret-canary',
          captured[0]!.signature,
          captured[1]!.signature,
        ]
      ) {
        assert(!JSON.stringify(inspected).includes(canary));
        assert(
          !JSON.stringify(await cli(['webhooks', 'destinations'])).includes(
            canary,
          ),
        );
      }

      equal(await env.events.list(), [event]);
      equal(await service.bookings.get({ uid: booking.uid }), booking);
      equal(await env.services.other.webhooks.list({}), []);
      await rejects(() =>
        env.services.other.webhooks.inspect({ id: delivery.id })
      );
      await rejects(() =>
        env.services.other.webhooks.redeliver({ id: delivery.id })
      );
      equal(
        (await env.services.other.slots.list(query))['2099-06-01']!.length,
        4,
      );

      const slots = await service.slots.list(query);
      const path = directory + '/payload.json';

      await Deno.writeTextFile(path, JSON.stringify(payload));
      await cli(['events', 'publish', 'BOOKING_CREATED', '--data', path]);
      await service.events.publish({ type: 'BOOKING_CREATED', data: payload });

      const direct = await cli([
        'webhooks',
        'send',
        'BOOKING_CREATED',
        '--data',
        path,
        '--destination',
        dest.id,
      ]);
      const sdkDirect = await service.webhooks.send({
        type: 'BOOKING_CREATED',
        data: payload,
        destination: dest.id,
      });

      for (const d of await service.webhooks.list({})) {
        await service.webhooks.wait({
          id: d.id,
          status: 'succeeded',
          timeout: '5s',
        });
      }

      equal((await cli(['webhooks', 'list'])).length, 5);
      equal((await env.events.list()).length, 5);
      assert(direct.id !== sdkDirect.id);
      equal(await service.slots.list(query), slots);
      await rejects(() => service.bookings.get({ uid: payload.uid }));
      equal(
        (await env.events.list()).filter((e) => e.origin === 'service').length,
        1,
      );
      await rejects(() =>
        service.events.publish({
          type: 'BOOKING_CREATED',
          data: { ...payload, unexpected: true } as never,
        })
      );

      entered = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();

      const pending = await service.webhooks.send({
        type: 'BOOKING_CREATED',
        data: payload,
        destination: dest.id,
      });

      await entered.promise;

      const waiting = service.webhooks.wait({
        id: pending.id,
        status: 'succeeded',
        timeout: '5s',
      }).then(() => false, () => true);

      await env.reset();
      release.resolve();
      assert(await waiting);
      equal(await service.webhooks.list({}), []);
      equal(await env.events.list(), []);
      equal((await service.slots.list(query))['2099-06-01']!.length, 4);
      await rejects(() => service.webhooks.inspect({ id: pending.id }));

      currentSecret = secret;

      const restored = await service.webhooks.send({
        type: 'BOOKING_CREATED',
        data: payload,
        destination: dest.id,
      });

      await service.webhooks.wait({
        id: restored.id,
        status: 'succeeded',
        timeout: '5s',
      });
    } finally {
      release?.resolve();
      await host.dispose();
      await receiver.shutdown();
      await Deno.remove(directory, { recursive: true });
    }
  },
);
