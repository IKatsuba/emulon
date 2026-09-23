import { cases as webhookCases } from './webhook_cases.ts';
import { assert, equal, rejects } from './assert.ts';
import { bookingCases } from './bookings_cases.ts';
import calcom from '@emulon/calcom';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import {
  availableSlots,
  createInput,
  fixtures,
  queryInput,
  utcInstant,
} from '../src/model/scheduling.ts';
import { matchesKey } from '../src/auth/keys.ts';
import { compatibility } from '../src/compatibility.ts';
import {
  caseRegistry,
  verifyCoverage,
} from '../../emulon/tests/helpers/compatibility.ts';

const input = {
  title: 'Consultation',
  slug: 'consultation',
  lengthInMinutes: 30,
  slots: [
    '2099-06-02T10:00:00Z',
    '2099-06-01T10:00:00Z',
    '2000-01-01T00:00:00Z',
  ],
};
const query = { eventTypeId: 1, start: '2099-06-01', end: '2099-06-02' };
const expected = {
  '2099-06-01': [{ start: '2099-06-01T10:00:00.000Z' }],
  '2099-06-02': [{ start: '2099-06-02T10:00:00.000Z' }],
};

Deno.test('Cal.com pure calendar, bounds, uniqueness and credential rules', async () => {
  for (
    const value of [
      '2099-02-29T10:00:00Z',
      '2099-02-30T10:00:00Z',
      '2099-06-01T24:00:00Z',
      '2099-06-01T10:00:00+01:00',
      '2099-06-01',
      'invalid',
    ]
  ) {
    assert(Number.isNaN(utcInstant(value)));
  }

  assert(Number.isFinite(utcInstant('2096-02-29T10:00:00.1Z')));

  for (const lengthInMinutes of [0, -1, 1.5, Infinity]) {
    assert(!createInput.safeParse({ ...input, lengthInMinutes }).success);
  }

  assert(!createInput.safeParse({ ...input, extra: true }).success);
  assert(
    !createInput.safeParse({
      ...input,
      slots: ['2099-06-01T10:00:00Z', '2099-06-01T10:00:00.000Z'],
    }).success,
  );
  equal(
    availableSlots(input.slots, query, Date.parse('2099-06-01T10:00:00Z')),
    { '2099-06-02': expected['2099-06-02'] },
  );
  equal(
    availableSlots(input.slots, {
      ...query,
      start: '2099-06-01T10:00:00Z',
      end: '2099-06-01T10:00:00Z',
    }, 0),
    { '2099-06-01': expected['2099-06-01'] },
  );
  equal(
    availableSlots(['2099-06-01T23:59:59.999Z', '2099-06-02T00:00:00Z'], {
      ...query,
      end: '2099-06-01',
    }, 0),
    { '2099-06-01': [{ start: '2099-06-01T23:59:59.999Z' }] },
  );
  assert(!queryInput.safeParse({ ...query, start: '2099-06-03' }).success);
  assert(!queryInput.safeParse({ ...query, end: '2099-02-30' }).success);
  assert(matchesKey('Bearer cal_local', 'cal_local'));
  assert(!matchesKey('Bearer cal_live_local', 'cal_live_local'));
  assert(!matchesKey('Bearer cal_local', 'cal_other'));
  await rejects(() =>
    fixtures({
      fixtures: { eventTypes: [{ ...input, id: 1 }, { ...input, id: 1 }] },
    })
  );

  const seeded = fixtures({
    fixtures: { eventTypes: [input, { ...input, id: 1 }] },
  });

  equal(seeded.slice(0, 2).map((row) => row.id), ['2', '1']);
});

const { cases, register } = caseRegistry(
  'packages/calcom/tests/scheduling_test.ts',
);

register(
  'calcom.http.1',
  ['eventTypes.get', 'slots.list'],
  [],
  false,
  'documented HTTP fields, versions, isolation and reset',
  async () => {
    const config = {
      services: {
        cal: calcom(),
        other: calcom({ fixtures: { eventTypes: [{ ...input, id: 42 }] } }),
      },
    };
    await using env = await Emulon.start(config);
    await using separate = await Emulon.start({ services: { cal: calcom() } });
    const type = await env.services.cal.eventTypes.create(input);

    equal(type, {
      title: input.title,
      slug: input.slug,
      lengthInMinutes: 30,
      id: 1,
    });

    const { apiKey } = await env.services.cal.keys.create({});

    assert(/^cal_[a-f0-9]{64}$/.test(apiKey));

    const request = async (
      path: string,
      version: string | null,
      key = apiKey,
      base = env.endpoints.cal.api!,
    ) => {
      const result = await fetch(base + path, {
        headers: {
          authorization: 'Bearer ' + key,
          ...(version === null ? {} : { 'cal-api-version': version }),
        },
      });
      const body = await result.json();

      assert(!JSON.stringify(body).includes(apiKey));

      return { status: result.status, body };
    };

    const path = '/v2/slots?eventTypeId=1&start=2099-06-01&end=2099-06-02';

    equal(await request('/v2/event-types/1', '2026-06-12'), {
      status: 200,
      body: { status: 'success', data: type },
    });
    equal(await request(path, '2024-09-04'), {
      status: 200,
      body: { status: 'success', data: expected },
    });
    equal(await env.services.cal.slots.list(query), expected);
    equal(await env.services.cal.eventTypes.list({}), [type]);

    for (const version of [null, '', '2024-09-04', '2026-06-13']) {
      assert(
        (await request('/v2/event-types/1', version)).status === 400,
      );
    }

    for (const version of [null, '', '2026-06-12', '2024-09-05']) {
      assert(
        (await request(path, version)).status === 400,
      );
    }

    for (
      const key of [
        '',
        'cal_unknown',
        'cal_live_unknown',
        (await env.services.other.keys.create({})).apiKey,
        (await separate.services.cal.keys.create({})).apiKey,
      ]
    ) {
      assert((await request(path, '2024-09-04', key)).status === 401);
    }

    assert(
      (await request(path, '2024-09-04', apiKey, separate.endpoints.cal.api!))
        .status === 401,
    );

    for (
      const suffix of [
        '&timeZone=Europe/Madrid',
        '&format=range',
        '&duration=60',
        '&eventTypeSlug=x',
        '&username=x',
        '&teamSlug=x',
        '&unknown=x',
        '&start=2099-06-01',
        '&eventTypeId=1',
      ]
    ) {
      assert(
        (await request(path + suffix, '2024-09-04')).status === 400,
        suffix,
      );
    }

    for (
      const params of [
        '',
        'eventTypeId=1',
        'eventTypeId=1&start=2099-06-01',
        'eventTypeId=1&start=2099-02-30&end=2099-06-02',
        'eventTypeId=1&start=2099-06-03&end=2099-06-02',
        'eventTypeId=1e0&start=2099-06-01&end=2099-06-02',
        'eventTypeId=1&start=2099-06-01T10:00:00%2B01:00&end=2099-06-02',
      ]
    ) {
      assert(
        (await request('/v2/slots?' + params, '2024-09-04')).status === 400,
        params,
      );
    }

    equal(
      (await request(path + '&timeZone=UTC', '2024-09-04')).body.data,
      expected,
    );
    assert(
      (await request('/v2/event-types/1?unknown=x', '2026-06-12')).status ===
        400,
    );
    assert((await request('/v2/event-types/bad', '2026-06-12')).status === 400);
    assert((await request('/v2/event-types/42', '2026-06-12')).status === 404);
    assert(
      (await request(
        path.replace('eventTypeId=1', 'eventTypeId=42'),
        '2024-09-04',
      )).status === 404,
    );
    assert((await request('/v2/bookings', '2026-02-25')).status === 404);
    await rejects(() => env.services.other.eventTypes.get({ id: 1 }));
    await env.reset();
    assert((await request(path, '2024-09-04')).status === 401);
    equal(await env.services.cal.eventTypes.list({}), []);
    equal((await env.services.other.eventTypes.list({})).map((v) => v.id), [
      42,
    ]);
    assert(
      (await request(
        '/v2/event-types/1',
        '2026-06-12',
        (await env.services.cal.keys.create({})).apiKey,
      )).status === 404,
    );
    equal(await env.services.cal.compatibility.get({}), compatibility);
  },
);
cases.push(...bookingCases, ...webhookCases);
verifyCoverage(compatibility, cases);

for (const test of cases) {
  Deno.test(`${test.id}: ${test.name}`, test.run);
}

Deno.test('Cal.com CLI and connected SDK share durable types, slots and keys', async () => {
  const directory = await Deno.makeTempDir();
  const config = { services: { cal: calcom() } };
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
    const first = await cli([
      'event-types',
      'create',
      '--title',
      input.title,
      '--slug',
      input.slug,
      '--length-in-minutes',
      '30',
      '--slots',
      JSON.stringify(input.slots),
    ]);
    const key = await cli(['keys', 'create']);

    {
      await using connected = await Emulon.connect({ config, directory });

      equal(
        await connected.services.cal.eventTypes.get({ id: first.id }),
        first,
      );

      const second = await connected.services.cal.eventTypes.create({
        ...input,
        title: 'SDK',
      });

      equal(
        await cli(['event-types', 'get', '--id', String(second.id)]),
        second,
      );
      equal(await cli(['event-types', 'list']), [first, second]);
      equal(
        await cli([
          'slots',
          'list',
          '--event-type-id',
          String(first.id),
          '--start',
          query.start,
          '--end',
          query.end,
        ]),
        expected,
      );
      equal(
        await cli(['compatibility', 'get']),
        await connected.services.cal.compatibility.get({}),
      );
    }

    await host.dispose();

    host = await serveEnvironment(config, { directory });

    await using connected = await Emulon.connect({ config, directory });
    const response = await fetch(
      connected.endpoints.cal.api + '/v2/event-types/' + first.id,
      {
        headers: {
          authorization: 'Bearer ' + key.apiKey,
          'cal-api-version': '2026-06-12',
        },
      },
    );

    assert(response.status === 200);
    equal((await response.json()).data, first);
    equal(
      await connected.services.cal.slots.list({
        ...query,
        eventTypeId: first.id,
      }),
      expected,
    );

    const slots = await fetch(
      connected.endpoints.cal.api + '/v2/slots?eventTypeId=' + first.id +
        '&start=2099-06-01&end=2099-06-02',
      {
        headers: {
          authorization: 'Bearer ' + key.apiKey,
          'cal-api-version': '2024-09-04',
        },
      },
    );

    equal((await slots.json()).data, expected);

    const invalid = await runProjectCLI(
      [
        'cal',
        'slots',
        'list',
        '--event-type-id',
        '1',
        '--start',
        query.start,
        '--end',
        query.end,
        '--time-zone',
        'Europe/Madrid',
        '--json',
      ],
      undefined,
      directory,
    );

    assert(invalid.code !== 0);
    await connected.reset();
    equal(await cli(['event-types', 'list']), []);
  } finally {
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});
