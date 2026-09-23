import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { Emulon } from 'emulon';
import resend from '@emulon/resend';
import { Resend } from 'resend';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { startWithAdapter } from '../../emulon/src/sdk/start.ts';
import {
  memoryAdapter,
  type StateHandle,
} from '../../emulon/src/state/store.ts';
import { matchesKey } from '../src/auth/keys.ts';
import { makeEmail, sendEmail, sendInput } from '../src/model/emails.ts';

export const { cases, register } = caseRegistry(
  'packages/resend/tests/surface_cases.ts',
);

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(value: unknown): asserts value {
  if (!value) {
    throw new Error('Assertion failed');
  }
}

const input = {
  from: 'Acme <sender@example.test>',
  to: ['receiver@example.test'],
  subject: 'Hello',
  html: '<p>Local only</p>',
  text: 'Local only',
};

register(
  'resend.surface.1',
  ['emails.send', 'emails.get'],
  ['email.sent'],
  false,
  'official Resend client sends and reads the same state as control CLI and typed SDK',
  async () => {
    const directory = await Deno.makeTempDir();
    const config = { services: { mail: resend() } };

    try {
      await using host = await serveEnvironment(config, { directory });
      await using env = await Emulon.connect({ config, directory });
      const cli = (args: string[]) =>
        runProjectCLI(args.concat('--json'), undefined, directory);
      const key = await cli(['mail', 'keys', 'create']);

      equal(key.code, 0);

      const { apiKey } = JSON.parse(key.stdout);
      const client = new Resend(apiKey, {
        userAgent: 'emulon-contract-test',
        baseUrl: env.endpoints.mail.api!,
      });
      const sent = await client.emails.send(input);

      equal(sent.error, null);
      assert(sent.data?.id);

      const received = await client.emails.get(sent.data.id);

      equal(received.error, null);
      equal(received.data?.html, input.html);
      equal(received.data?.last_event, 'sent');

      const rows = await env.services.mail.emails.list();

      equal(rows.length, 1);
      equal(rows[0], received.data);

      const listed = await cli(['mail', 'emails', 'list']);

      equal(listed.code, 0);
      equal(JSON.parse(listed.stdout), rows);

      const read = await cli(['mail', 'emails', 'get', '--id', sent.data.id]);

      equal(
        JSON.parse(read.stdout),
        await env.services.mail.emails.get({ id: sent.data.id }),
      );

      const status = await cli(['status']);

      assert(!status.stdout.includes(apiKey));
      assert(!listed.stdout.includes(apiKey));

      const cleared = await cli(['mail', 'emails', 'clear']);

      equal(JSON.parse(cleared.stdout), { deleted: 1 });
      equal(await env.services.mail.emails.list(), []);
      equal((await client.emails.get(sent.data.id)).error?.name, 'not_found');
      equal((await client.emails.send(input)).error, null);
      equal((await cli(['reset'])).code, 0);
      equal(await env.services.mail.emails.list(), []);
      equal((await client.emails.send(input)).error?.name, 'validation_error');
      equal(host.identity.endpoints.mail!.api, env.endpoints.mail.api);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'resend.surface.2',
  ['emails.send', 'emails.get'],
  [],
  false,
  'provider auth, unsupported operations and validation reject without mutation',
  async () => {
    await using env = await Emulon.start({
      services: { mail: resend(), other: resend() },
    });
    const { apiKey } = await env.services.mail.keys.create();
    const other = await env.services.other.keys.create();
    const url = env.endpoints.mail.api!;

    for (
      const [token, status, name] of [[null, 401, 'missing_api_key'], [
        'wrong',
        403,
        'validation_error',
      ], [other.apiKey, 403, 'validation_error']] as const
    ) {
      const response = await fetch(url + '/emails', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(input),
      });

      equal(response.status, status);

      const error = await response.json();

      equal(error.name, name);
      equal(error.statusCode, status);
      assert(!JSON.stringify(error).includes(apiKey));
    }

    for (
      const [body, status] of [['{', 400], [
        JSON.stringify({ ...input, to: [] }),
        422,
      ], [JSON.stringify({ ...input, attachments: [] }), 501]] as const
    ) {
      const response = await fetch(url + '/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body,
      });

      equal(response.status, status);
      await response.json();
    }

    for (
      const header of ['resend-version', 'x-api-version', 'idempotency-key']
    ) {
      const response = await fetch(url + '/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, [header]: 'unsupported' },
        body: JSON.stringify(input),
      });

      equal(response.status, 501);
      await response.json();
    }

    for (const path of ['/domains', '/emails/id/attachments', '/emails/']) {
      const response = await fetch(url + path, {
        headers: { authorization: `Bearer ${apiKey}` },
      });

      equal(response.status, 404);
      equal(await response.text(), 'Unsupported route');
    }

    equal(await env.services.mail.emails.list(), []);

    const client = new Resend(apiKey, {
      userAgent: 'emulon-contract-test',
      baseUrl: url,
    });

    equal((await client.emails.send(input)).error, null);
    equal(await env.services.other.emails.list(), []);
  },
);

register(
  'resend.surface.3',
  ['emails.send', 'emails.get'],
  ['email.sent'],
  false,
  'fixtures restore on reset, issued keys expire and outbox commits atomically',
  async () => {
    const handles: StateHandle[] = [];
    const adapter = memoryAdapter();
    const id = '11111111-1111-4111-8111-111111111111';
    await using env = await startWithAdapter({
      services: { mail: resend({ fixtures: { emails: [{ ...input, id }] } }) },
    }, {
      async open(options) {
        const handle = await adapter.open(options);

        handles.push(handle);

        return handle;
      },
    });
    const store = handles[0]!.store;

    equal((await env.services.mail.emails.list())[0]?.id, id);
    equal(await store.transaction((tx) => tx.outbox()), []);

    const key = await env.services.mail.keys.create();
    const client = new Resend(key.apiKey, {
      userAgent: 'emulon-contract-test',
      baseUrl: env.endpoints.mail.api!,
    });
    const sent = await Promise.all(
      Array.from({ length: 5 }, () => client.emails.send(input)),
    );

    assert(sent.every((result) => result.data?.id));

    const events = await store.transaction((tx) => tx.outbox());

    equal(events.length, 5);
    equal(events.map((event) => event.type), Array(5).fill('email.sent'));
    assert(
      events.every((event) =>
        event.instanceId === 'mail' && event.origin === 'service'
      ),
    );
    equal((await env.services.mail.emails.list()).length, 6);
    await env.services.mail.emails.clear();
    equal((await store.transaction((tx) => tx.outbox())).length, 5);
    await env.reset();
    equal((await env.services.mail.emails.list()).map((row) => row.id), [id]);
    equal(await store.transaction((tx) => tx.outbox()), []);
    equal((await client.emails.send(input)).error?.name, 'validation_error');

    const next = await env.services.mail.keys.create();

    assert(next.apiKey !== key.apiKey);
    equal(
      (await new Resend(next.apiKey, {
        userAgent: 'emulon-contract-test',
        baseUrl: env.endpoints.mail.api!,
      }).emails
        .send(input)).error,
      null,
    );

    const before = await env.services.mail.emails.list();
    let failed = false;

    try {
      await sendEmail({
        ...store,
        transaction: (work) =>
          store.transaction((tx) =>
            work({
              ...tx,
              record: () => Promise.reject(new Error('outbox failure')),
            })
          ),
      }, input);
    } catch {
      failed = true;
    }

    assert(failed);
    equal(await env.services.mail.emails.list(), before);
  },
);

register(
  'resend.surface.4',
  ['emails.send'],
  [],
  false,
  'email normalization, input validation and token checks are pure',
  () => {
    assert(matchesKey('Bearer local', 'local'));

    for (
      const header of [
        null,
        'local',
        'Bearer other',
        'bearer local',
        'Bearer local ',
      ]
    ) {
      assert(!matchesKey(header, 'local'));
    }

    const value = sendInput.parse({
      from: input.from,
      to: 'r@example.test',
      subject: '',
      text: '',
    });
    const email = makeEmail(value, 'id', 'now');

    equal(email.to, ['r@example.test']);
    equal(email.html, null);
    equal(email.text, '');

    for (
      const bad of [
        { ...input, from: 'invalid' },
        { ...input, to: ['invalid'] },
        { from: input.from, to: input.to, subject: 'No body' },
        { ...input, from: 'x\n<sender@example.test>' },
      ]
    ) {
      assert(!sendInput.safeParse(bad).success);
    }
  },
);
