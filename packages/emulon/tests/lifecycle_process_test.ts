import github from '@emulon/github';
import resend from '@emulon/resend';
import { Emulon } from 'emulon';
import { readDiscovery } from '../src/runtime/discovery.ts';
import { sqliteCoordinator } from '../src/runtime/sqlite-state.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Process barrier timed out')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function spawn(directory: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--cached-only',
      '--allow-read',
      '--allow-write',
      '--allow-env=NODE_ENV',
      '--allow-net=127.0.0.1',
      new URL('./fixtures/lifecycle-process.ts', import.meta.url).pathname,
      directory,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();

  return {
    child,
    async ready() {
      let text = '';

      while (!text.includes('\n')) {
        const next = await bounded(reader.read());

        if (next.done) {
          throw new Error('Host exited: ' + await errors);
        }

        text += next.value;
      }

      return JSON.parse(text.split('\n')[0]!);
    },
    async finish() {
      const status = await bounded(child.status);

      await reader.cancel();

      return { status, errors: await errors };
    },
    async cleanup() {
      try {
        child.kill('SIGKILL');
      } catch { /* Already exited. */ }

      await bounded(child.status);
      await reader.cancel().catch(() => {});

      await errors;
    },
  };
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
  Deno.test(`CLI ${signal} releases owned ports and preserves durable state without displacing another slot`, async () => {
    const directory = await Deno.realPath(await Deno.makeTempDir());
    const config = { services: { github: github(), mail: resend() } };
    const children: ReturnType<typeof spawn>[] = [];
    const start = () => {
      const child = spawn(directory);

      children.push(child);

      return child;
    };

    try {
      const child = start();

      await child.ready();

      const record = await readDiscovery({ directory });
      const original = await Deno.readTextFile(
        directory + '/.emulon/default.json',
      );

      await Deno.writeTextFile(
        directory + '/.emulon/foreign.json',
        'foreign-slot',
      );
      await Deno.writeTextFile(directory + '/keep.txt', 'foreign-file');

      const env = await Emulon.connect({ config, directory });
      const endpoints = Object.values(env.endpoints).flatMap(Object.values);
      const key = await env.services.mail.keys.create();
      const event = await env.services.mail.events.publish({
        type: 'email.sent',
        data: {
          email_id: crypto.randomUUID(),
          from: 'a@example.test',
          to: ['b@example.test'],
          subject: 'Committed before exit',
        },
      });
      const before = await env.events.list();

      assert(before.length === 1 && before[0]!.id === event.id);
      await env.dispose();
      child.child.kill(signal);

      const ended = await child.finish();

      assert(
        signal === 'SIGKILL' ? !ended.status.success : ended.status.success,
        ended.errors,
      );

      for (const url of [...endpoints, record.url]) {
        const socket = Deno.listen({
          hostname: '127.0.0.1',
          port: Number(new URL(url).port),
        });

        socket.close();
      }

      // Opening through the real coordinator validates SQLite, the graph and the lock.
      const state = sqliteCoordinator(
        directory + '/.emulon/state/default/state.sqlite',
      );
      const uuid = state.environmentId;

      state.close();

      if (signal === 'SIGKILL') {
        assert(
          await Deno.readTextFile(directory + '/.emulon/default.json') ===
            original,
        );

        const contender = start();
        const failed = await contender.finish();

        assert(
          !failed.status.success &&
            failed.errors.includes('ENVIRONMENT_EXISTS') &&
            failed.errors.includes('remove stale discovery explicitly'),
          failed.errors,
        );
        assert(
          await Deno.readTextFile(directory + '/.emulon/default.json') ===
            original,
          'Stale slot overwritten',
        );
        await Deno.remove(directory + '/.emulon/default.json');
      }

      const files = Array.from(
        Deno.readDirSync(directory + '/.emulon'),
        (entry) => entry.name,
      ).sort();

      assert(
        JSON.stringify(files) === JSON.stringify(['foreign.json', 'state']),
        JSON.stringify(files),
      );

      const stateFiles = Array.from(
        Deno.readDirSync(directory + '/.emulon/state/default'),
        (entry) => entry.name,
      );

      assert(
        stateFiles.every((name) =>
          ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'].includes(
            name,
          )
        ),
        JSON.stringify(stateFiles),
      );
      assert(
        await Deno.readTextFile(directory + '/keep.txt') === 'foreign-file',
      );
      assert(
        await Deno.readTextFile(directory + '/.emulon/foreign.json') ===
          'foreign-slot',
      );

      const restarted = start();

      await restarted.ready();

      const next = await readDiscovery({ directory });

      assert(next.id !== record.id && next.token !== record.token);

      const connected = await Emulon.connect({ config, directory });

      assert(
        JSON.stringify(await connected.events.list()) ===
          JSON.stringify(before),
        'Committed event changed after process exit',
      );

      const response = await fetch(
        connected.endpoints.mail.api + '/emails/' +
          (event.payload as { email_id: string }).email_id,
        { headers: { Authorization: 'Bearer ' + key.apiKey } },
      );

      assert(response.status === 404, 'Saved key was lost');
      await response.text();
      await connected.dispose();
      restarted.child.kill('SIGTERM');
      assert((await restarted.finish()).status.success);

      const reopened = sqliteCoordinator(
        directory + '/.emulon/state/default/state.sqlite',
      );

      assert(reopened.environmentId === uuid);
      reopened.close();
    } finally {
      await Promise.all(children.map((child) => child.cleanup()));
      await Deno.remove(directory, { recursive: true });
    }
  });
}
