import calcom from '@emulon/calcom';
import { Emulon } from 'emulon';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { assert, equal, rejects } from './assert.ts';

export const attendee = {
  name: 'Ада',
  email: 'ada@example.test',
  timeZone: 'UTC' as const,
  language: 'en' as const,
};
export const organizer = {
  name: 'Organizer',
  email: 'host@example.test',
  username: 'host',
};
export const fixture = {
  title: 'Consultation',
  slug: 'consultation',
  lengthInMinutes: 30,
  slots: [
    '2099-06-01T10:00:00Z',
    '2099-06-01T10:15:00Z',
    '2099-06-01T10:30:00Z',
    '2099-06-01T11:00:00Z',
    '2000-01-01T00:00:00Z',
  ],
};
export const query = { eventTypeId: 1, start: '2099-06-01', end: '2099-06-01' };
const { cases, register } = caseRegistry(
  'packages/calcom/tests/bookings_cases.ts',
);
export const bookingCases = cases;

register(
  'calcom.bookings.1',
  ['bookings.create', 'bookings.get'],
  ['BOOKING_CREATED'],
  false,
  'atomic organizer-wide booking, HTTP/SDK projections and reset',
  async () => {
    const config = {
      services: {
        cal: calcom({
          fixtures: {
            organizer,
            eventTypes: [{ ...fixture, id: 1 }, { ...fixture, id: 2 }],
          },
        }),
        other: calcom(),
      },
    };
    await using env = await Emulon.start(config);
    let key = (await env.services.cal.keys.create({})).apiKey;
    const request = async (
      path: string,
      body?: unknown,
      version: string | null = '2026-02-25',
      apiKey = key,
    ) => {
      const res = await fetch(env.endpoints.cal.api + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(version === null ? {} : { 'cal-api-version': version }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      return { status: res.status, body: await res.json() };
    };

    const input = { eventTypeId: 1, start: fixture.slots[0]!, attendee };

    for (const version of [null, '', '2024-09-04', '2026-02-26']) {
      equal((await request('/v2/bookings', input, version)).status, 400);
      equal(
        (await request('/v2/bookings/missing', undefined, version)).status,
        400,
      );
    }

    for (
      const apiKey of [
        '',
        'cal_unknown',
        'cal_live_bad',
        (await env.services.other.keys.create({})).apiKey,
      ]
    ) {
      equal(
        (await request('/v2/bookings', input, '2026-02-25', apiKey)).status,
        401,
      );
      equal(
        (await request('/v2/bookings/missing', undefined, '2026-02-25', apiKey))
          .status,
        401,
      );
    }

    for (
      const bad of [
        null,
        [],
        {},
        { ...input, extra: true },
        { ...input, eventTypeId: '1' },
        { ...input, eventTypeId: -1 },
        { ...input, start: '2099-02-30T10:00:00Z' },
        { ...input, start: '2099-06-01T10:00:00+00:00' },
        { ...input, start: '2099-06-01T12:00:00Z' },
        { ...input, start: '2000-01-01T00:00:00Z' },
        ...[
          { ...attendee, name: '' },
          { ...attendee, email: 'bad' },
          { ...attendee, timeZone: 'Europe/Madrid' },
          { ...attendee, language: 'es' },
          { ...attendee, phoneNumber: '123' },
          { name: 'Ada', email: attendee.email },
        ].map((attendee) => ({ ...input, attendee })),
      ]
    ) {
      equal((await request('/v2/bookings', bad)).status, 400);
    }

    const malformed = await fetch(env.endpoints.cal.api + '/v2/bookings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'cal-api-version': '2026-02-25',
      },
      body: '{',
    });

    equal(malformed.status, 400);
    await malformed.text();
    equal((await request('/v2/bookings?extra=true', input)).status, 400);
    equal((await request('/v2/bookings/missing?extra=true')).status, 400);
    equal(
      (await request('/v2/bookings', { ...input, eventTypeId: 999 })).status,
      404,
    );
    equal((await request('/v2/bookings/missing')).status, 404);
    equal(await env.events.list(), []);
    await rejects(() =>
      env.services.cal.bookings.create({
        ...input,
        start: '2000-01-01T00:00:00Z',
      })
    );

    for (const competingType of [1, 2]) {
      const results = await Promise.all([
        request('/v2/bookings', input),
        request('/v2/bookings', {
          ...input,
          eventTypeId: competingType,
          start: '2099-06-01T10:15:00Z',
        }),
      ]);

      equal(results.map((r) => r.status).sort(), [201, 409]);
      equal(
        results.find((r) => r.status === 409)!.body.error.code,
        'slot_conflict',
      );

      const booking = results.find((r) => r.status === 201)!.body.data;
      const start = booking.start;
      const end = new Date(Date.parse(start) + 30 * 60000).toISOString();

      equal(booking, {
        id: 1,
        uid: booking.uid,
        status: 'accepted',
        start,
        end,
        duration: 30,
        eventTypeId: booking.eventTypeId,
        title: fixture.title,
        hosts: [organizer],
        attendees: [attendee],
      });
      equal(await env.services.cal.bookings.get({ uid: booking.uid }), booking);
      equal((await request(`/v2/bookings/${booking.uid}`)).body, {
        status: 'success',
        data: booking,
      });

      const events = await env.events.list({ type: 'BOOKING_CREATED' });

      equal(events.length, 1);
      equal(events[0]!.origin, 'service');
      equal(events[0]!.payload, {
        uid: booking.uid,
        eventTypeId: booking.eventTypeId,
        title: fixture.title,
        startTime: start,
        endTime: end,
        organizer,
        attendees: [attendee],
      });

      for (const eventTypeId of [1, 2]) {
        const slots = await env.services.cal.slots.list({
          ...query,
          eventTypeId,
        });

        assert(!Object.values(slots).flat().some((s) => s.start === start));
        assert(
          !Object.values(slots).flat().some((s) =>
            s.start === '2099-06-01T10:15:00.000Z'
          ),
        );
      }

      equal(
        (await request('/v2/bookings', {
          ...input,
          start,
          eventTypeId: booking.eventTypeId,
        })).status,
        409,
      );
      equal((await env.events.list()).length, 1);

      const sdk = await env.services.cal.bookings.create({
        ...input,
        start: '2099-06-01T11:00:00Z',
      });

      equal((await request(`/v2/bookings/${sdk.uid}`)).body.data, sdk);
      await env.reset();
      equal((await request(`/v2/bookings/${booking.uid}`)).status, 401);

      key = (await env.services.cal.keys.create({})).apiKey;

      equal((await request(`/v2/bookings/${booking.uid}`)).status, 404);
      equal(await env.events.list(), []);
      equal(
        (await env.services.cal.slots.list(query))['2099-06-01']!.length,
        4,
      );
    }

    const first = await env.services.cal.bookings.create(input);
    const adjacent = await env.services.cal.bookings.create({
      ...input,
      eventTypeId: 2,
      start: first.end,
    });

    equal(adjacent.start, first.end);
    equal((await env.events.list()).length, 2);
  },
);
