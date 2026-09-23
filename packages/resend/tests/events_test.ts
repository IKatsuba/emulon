import { Emulon } from 'emulon';
import resend from '../src/mod.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { CommandError } from '../../emulon/src/commands/registry.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => [key, canonical(item)]),
    );
  }

  return value;
}

function equal(actual: unknown, expected: unknown) {
  actual = canonical(actual);
  expected = canonical(expected);

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test('events cross CLI and SDK without mutating business state', async () => {
  const directory = await Deno.makeTempDir();
  const config = { services: { mail: resend(), other: resend() } };
  const host = await serveEnvironment(config, { directory });
  const env = await Emulon.connect({ directory, config });

  try {
    const payload = {
      // deno-lint-ignore camelcase
      email_id: crypto.randomUUID(),
      from: 'sender@example.com',
      to: ['to@example.com'],
      subject: 'Synthetic',
    };

    await Deno.writeTextFile(
      directory + '/event.json',
      JSON.stringify(payload),
    );

    const stream = await env.events.follow({ type: 'email.sent' });
    let reader = stream.getReader();

    try {
      const cli = await runProjectCLI(
        [
          '--json',
          'mail',
          'events',
          'publish',
          'email.sent',
          '--data',
          'event.json',
        ],
        config,
        directory,
      );

      equal(cli.code, 0);

      const first = JSON.parse(cli.stdout);

      equal(first.origin, 'published');
      equal((await reader.read()).value, first);

      const second = await env.services.mail.events.publish({
        type: 'email.sent',
        data: payload,
      });

      equal((await reader.read()).value, second);
      equal(await env.services.mail.emails.list({}), []);
      equal(await env.services.mail.emails.get({ id: payload.email_id }), null);
      equal(await env.services.other.emails.list({}), []);

      const invalid = await runProjectCLI(
        ['--json', 'mail', 'events', 'publish', 'email.sent', '--data', '{}'],
        config,
        directory,
      );

      equal(invalid.code, 1);
      equal((await env.events.list()).length, 2);

      const key = await env.services.mail.keys.create({});
      const response = await fetch(env.endpoints.mail.api + '/emails', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: payload.from,
          to: payload.to,
          subject: 'Real action',
          text: 'Hello',
        }),
      });

      equal(response.status, 200);
      await response.json();

      const action = (await reader.read()).value!;

      equal(action.origin, 'service');
      equal(action.instanceId, 'mail');
      equal((await env.services.mail.emails.list({})).length, 1);

      const list = await runProjectCLI(
        ['events', '--type', 'email.sent', '--json'],
        config,
        directory,
      );

      equal(JSON.parse(list.stdout).map((e: { origin: string }) => e.origin), [
        'published',
        'published',
        'service',
      ]);
      equal(await env.events.list({ type: 'absent' }), []);

      const interrupted = reader.read().then(
        () => false,
        (error) =>
          error instanceof CommandError &&
          error.code === 'ENVIRONMENT_RESETTING',
      );

      await env.reset();
      equal(await interrupted, true);
      reader.releaseLock();

      reader = (await env.events.follow({ type: 'email.sent' })).getReader();

      equal(await env.events.list(), []);

      const after = await env.services.mail.events.publish({
        type: 'email.sent',
        data: payload,
      });

      equal((await reader.read()).value, after);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  } finally {
    await env.dispose();
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

for (const end of ['stop', 'reset'] as const) {
  Deno.test(`CLI follow prints events and reports ${end} explicitly`, async () => {
    const directory = await Deno.makeTempDir();
    const config = { services: { mail: resend() } };
    const host = await serveEnvironment(config, { directory });
    const env = await Emulon.connect({ directory, config });

    try {
      let subscribed!: () => void;
      const ready = new Promise<void>((resolve) => subscribed = resolve);
      const outputs: string[] = [];
      const following = runProjectCLI(
        ['events', '--follow'],
        config,
        directory,
        (line) => outputs.push(line),
        subscribed,
      );

      await ready;

      const payload = {
        // deno-lint-ignore camelcase
        email_id: crypto.randomUUID(),
        from: 'a@b.com',
        to: ['b@c.com'],
        subject: 'Stream',
      };
      const event = await env.services.mail.events.publish({
        type: 'email.sent',
        data: payload,
      });

      if (end === 'reset') {
        await env.reset();
      } else {
        await host.dispose();
      }

      const result = await following;

      equal(result.code, end === 'reset' ? 1 : 0);

      if (end === 'reset') {
        equal(result.stderr.includes('ENVIRONMENT_RESETTING'), true);
      }

      equal(
        outputs.map((line) => JSON.parse(line).id).includes(event.id),
        true,
      );
    } finally {
      await env.dispose();
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  });
}
