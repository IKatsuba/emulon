import { destinationFixture, Emulon, setDestination } from 'emulon';
import resendPlugin from '../src/mod.ts';
import { definePlugin } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { startWithAdapter } from '../../emulon/src/sdk/start.ts';
import {
  memoryAdapter,
  type StateAdapter,
  type StateHandle,
} from '../../emulon/src/state/store.ts';
import { dispatch, eligible } from '../../emulon/src/deliveries/queue.ts';
import { subscriptionPolicy } from '../src/webhooks.ts';

const { transport: _transport, ...queueDefinition } =
  readRegistration(resendPlugin()).definition;
const resend = definePlugin(queueDefinition);

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const destination = {
  id: 'one',
  url: 'http://127.0.0.1:1/hook',
  secret: 'secret-first',
  types: ['email.sent'],
  enabled: true,
};
const data = {
  // deno-lint-ignore camelcase
  email_id: '00000000-0000-4000-8000-000000000000',
  from: 'a@b.com',
  to: ['c@d.com'],
  subject: 'Queued',
};

Deno.test('control API queues per subscription; CLI configuration, rotation and disablement are explicit', async () => {
  const directory = await Deno.makeTempDir();
  const config = {
    services: {
      mail: resend({ destinations: [destination] }),
      other: resend(),
    },
  };
  const host = await serveEnvironment(config, { directory });
  const env = await Emulon.connect({ directory, config });

  try {
    const cli = await runProjectCLI(
      [
        'mail',
        'webhooks',
        'configure',
        '--id',
        'two',
        '--url',
        destination.url,
        '--secret',
        'secret-second',
        '--types',
        '["email.sent"]',
        '--enabled',
        'true',
        '--json',
      ],
      config,
      directory,
    );

    if (cli.code !== 0) {
      throw new Error(cli.stderr);
    }

    equal(cli.stdout.includes('secret-second'), false);

    const event = await env.services.mail.events.publish({
      type: 'email.sent',
      data,
    });
    let records = await env.services.mail.webhooks.list();

    equal(records.map((r) => [r.eventId, r.destinationId, r.status]), [[
      event.id,
      'one',
      'queued',
    ], [event.id, 'two', 'queued']]);
    equal(await env.services.other.webhooks.list(), []);
    await env.services.mail.webhooks.configure({
      ...destination,
      secret: 'secret-rotated',
    });
    equal(await env.services.mail.webhooks.list(), records);
    equal(
      JSON.stringify(await env.services.mail.webhooks.destinations()).includes(
        'secret',
      ),
      false,
    );
    await env.services.mail.webhooks.configure({
      ...destination,
      enabled: false,
    });

    records = await env.services.mail.webhooks.list();

    equal(records.map((r) => r.status), ['cancelled', 'queued']);
    await env.services.mail.events.publish({ type: 'email.sent', data });
    equal((await env.services.mail.webhooks.list()).length, 3);
    await env.services.mail.webhooks.configure(destination);
    equal((await env.services.mail.webhooks.list()).length, 3);
    await env.reset();
    equal(await env.services.mail.webhooks.list(), []);
    equal((await env.services.mail.webhooks.destinations()).map((d) => d.id), [
      'one',
    ]);
  } finally {
    await env.dispose();
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('reopening retained state recovers an unprocessed outbox exactly once', async () => {
  let handle: StateHandle | undefined;
  const adapter: StateAdapter = {
    async open(input) {
      equal(input.environmentId, 'retained-test');

      handle ??= await memoryAdapter().open(input);

      return { ...handle, close() {} };
    },
  };
  const config = {
    services: { mail: resend({ destinations: [destination] }) },
  };
  const first = await startWithAdapter(config, adapter, 'retained-test');

  await first.dispose();

  const state = handle!;
  const event = await state.store.transaction((tx) =>
    tx.record({
      type: 'email.sent',
      occurredAt: '2026-09-21T00:00:00.000Z',
      origin: 'published',
      payload: data,
    })
  );

  equal(
    await state.store.transaction((tx) => tx.list('emulon.deliveries')),
    [],
  );

  const second = await startWithAdapter(config, adapter, 'retained-test');
  let records;

  try {
    records = await second.services.mail.webhooks.list();

    equal(records.length, 1);
    equal(records[0]!.eventId, event.id);
    await second.services.mail.webhooks.configure({
      ...destination,
      secret: 'rotated',
    });

    const stored = await state.store.transaction((tx) =>
      tx.get('emulon.destinations', 'one')
    );

    equal((stored as { secret: string }).secret, 'rotated');
    await state.store.transaction((tx) => dispatch(tx, subscriptionPolicy));
    equal(await second.services.mail.webhooks.list(), records);
    equal(
      eligible(event, { ...destination, types: ['other'] }, subscriptionPolicy),
      false,
    );
    equal(
      eligible(event, { ...destination, enabled: false }, subscriptionPolicy),
      false,
    );
    equal(
      eligible({ ...event, type: 'other' }, {
        ...destination,
        types: ['other'],
      }, subscriptionPolicy),
      false,
    );
  } finally {
    await second.dispose();
  }

  const third = await startWithAdapter(config, adapter, 'retained-test');

  try {
    equal(await third.services.mail.webhooks.list(), records);
  } finally {
    await third.dispose();
    state.close();
  }
});

Deno.test('dispatch rollback and lost marker preserve the event/subscription key', async () => {
  const state = await memoryAdapter().open({
    environmentId: 'test',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [destination, { ...destination, id: 'two' }].map((value) => ({
      collection: 'emulon.destinations',
      id: value.id,
      value,
    })),
  });

  try {
    const event = await state.store.transaction((tx) =>
      tx.record({
        type: 'email.sent',
        origin: 'service',
        occurredAt: '2026-09-21T00:00:00.000Z',
        payload: data,
      })
    );

    try {
      await state.store.transaction(async (tx) => {
        await dispatch(tx, subscriptionPolicy);

        throw new Error('rollback');
      });
    } catch { /* Deliberate transaction failure. */ }

    equal(
      await state.store.transaction((tx) => tx.list('emulon.deliveries')),
      [],
    );
    await Promise.all([
      state.store.transaction((tx) => dispatch(tx, subscriptionPolicy)),
      state.store.transaction((tx) => dispatch(tx, subscriptionPolicy)),
    ]);
    equal(
      (await state.store.transaction((tx) => tx.list('emulon.deliveries')))
        .length,
      2,
    );
    await state.store.transaction(async (tx) => {
      await tx.delete('emulon.dispatched', event.id);
      await dispatch(tx, subscriptionPolicy);
    });

    equal(
      (await state.store.transaction((tx) => tx.list('emulon.deliveries')))
        .length,
      2,
    );
  } finally {
    state.close();
  }
});

Deno.test('destination validation and processing-time selection do not backfill history', async () => {
  for (
    const input of [
      { ...destination, url: 'ftp://127.0.0.1/hook' },
      { ...destination, url: 'http://user:password@127.0.0.1/hook' },
      { ...destination, secret: '' },
      { ...destination, types: ['unsupported'] },
    ]
  ) {
    let rejected = false;

    try {
      destinationFixture(input, subscriptionPolicy);
    } catch {
      rejected = true;
    }

    equal(rejected, true);
  }

  const state = await memoryAdapter().open({
    environmentId: 'test',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [],
  });

  try {
    await state.store.transaction(async (tx) => {
      await tx.record({
        type: 'email.sent',
        origin: 'service',
        occurredAt: '2026-09-21T00:00:00.000Z',
        payload: data,
      });
      await dispatch(tx, subscriptionPolicy);
    });

    await setDestination(state.store, destination, subscriptionPolicy);
    await state.store.transaction((tx) => dispatch(tx, subscriptionPolicy));
    equal(
      await state.store.transaction((tx) => tx.list('emulon.deliveries')),
      [],
    );
  } finally {
    state.close();
  }
});
