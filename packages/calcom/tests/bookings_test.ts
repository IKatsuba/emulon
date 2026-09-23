import calcom from '@emulon/calcom';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { availableSlots } from '../src/model/scheduling.ts';
import { isFree, overlaps } from '../src/model/intervals.ts';
import { attendee, fixture, organizer, query } from './bookings_cases.ts';
import { assert, equal, rejects } from './assert.ts';

Deno.test('Cal.com half-open intervals and clock boundaries', () => {
  const interval = { start: 10, end: 20 };

  for (
    const other of [
      { start: 9, end: 11 },
      { start: 19, end: 21 },
      { start: 11, end: 19 },
      { start: 9, end: 21 },
      interval,
    ]
  ) {
    assert(overlaps(interval, other));
    assert(overlaps(other, interval));
    assert(!isFree(interval, [other]));
  }

  for (const other of [{ start: 0, end: 10 }, { start: 20, end: 30 }]) {
    assert(isFree(interval, [other]));
  }

  const now = Date.parse(fixture.slots[0]!);

  equal(
    availableSlots(fixture.slots, query, now, 30, [{
      start: now + 15 * 60000,
      end: now + 45 * 60000,
    }]),
    {
      '2099-06-01': [{ start: '2099-06-01T11:00:00.000Z' }],
    },
  );
});

Deno.test('Cal.com CLI, connected SDK and HTTP bookings survive durable restart', async () => {
  const directory = await Deno.makeTempDir();
  const config = {
    services: {
      cal: calcom({
        fixtures: { organizer, eventTypes: [{ ...fixture, id: 1 }] },
      }),
    },
  };
  let host = await serveEnvironment(config, { directory });
  const cli = async (args: string[]) => {
    const result = await runProjectCLI(
      ['cal', ...args, '--json'],
      undefined,
      directory,
    );

    assert(result.code === 0, result.stderr);

    return JSON.parse(result.stdout);
  };

  try {
    const { apiKey } = await cli(['keys', 'create']);
    const created = await cli([
      'bookings',
      'create',
      '--event-type-id',
      '1',
      '--start',
      fixture.slots[0]!,
      '--attendee',
      JSON.stringify(attendee),
    ]);

    {
      await using connected = await Emulon.connect({ config, directory });

      equal(
        await connected.services.cal.bookings.get({ uid: created.uid }),
        created,
      );

      const sdk = await connected.services.cal.bookings.create({
        eventTypeId: 1,
        start: created.end,
        attendee,
      });

      equal(await cli(['bookings', 'get', '--uid', sdk.uid]), sdk);

      const response = await fetch(
        connected.endpoints.cal.api + '/v2/bookings/' + created.uid,
        {
          headers: {
            authorization: `Bearer ${apiKey}`,
            'cal-api-version': '2026-02-25',
          },
        },
      );

      equal(response.status, 200);
      equal((await response.json()).data, created);
      equal((await connected.events.list()).length, 2);
    }

    await host.dispose();

    host = await serveEnvironment(config, { directory });

    await using connected = await Emulon.connect({ config, directory });

    equal(
      await connected.services.cal.bookings.get({ uid: created.uid }),
      created,
    );
    equal((await connected.events.list()).length, 2);
    equal(await connected.services.cal.slots.list(query), {
      '2099-06-01': [{ start: '2099-06-01T11:00:00.000Z' }],
    });

    const conflict = await fetch(connected.endpoints.cal.api + '/v2/bookings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'cal-api-version': '2026-02-25',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        eventTypeId: 1,
        start: fixture.slots[1],
        attendee,
      }),
    });

    equal(conflict.status, 409);
    equal((await conflict.json()).error.code, 'slot_conflict');

    const bad = await runProjectCLI(
      [
        'cal',
        'bookings',
        'create',
        '--event-type-id',
        '1',
        '--start',
        fixture.slots[3]!,
        '--attendee',
        JSON.stringify({ ...attendee, language: 'es' }),
        '--json',
      ],
      undefined,
      directory,
    );

    assert(bad.code !== 0);
    equal((await connected.events.list()).length, 2);
    await connected.reset();
    await rejects(() =>
      connected.services.cal.bookings.get({ uid: created.uid })
    );
    equal(await connected.events.list(), []);
    equal(
      (await connected.services.cal.slots.list(query))['2099-06-01']!.length,
      4,
    );
  } finally {
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});
