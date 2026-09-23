import { z } from 'zod';
import { defineCommand, definePlugin, Emulon } from 'emulon';
import { runProjectCLI, selectEnvironment } from '../src/cli/project.ts';
import { serveEnvironment } from '../src/control/server.ts';
import {
  addresses,
  authorized,
  commandRequest,
  connection,
  environmentName,
  stale,
} from '../src/control/protocol.ts';
import { discover, request } from '../src/control/client.ts';
import { publishDiscovery, readDiscovery } from '../src/runtime/discovery.ts';
import { CommandError } from '../src/commands/registry.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejects(action: () => unknown, code: string) {
  try {
    await action();
  } catch (error) {
    if (error instanceof CommandError && error.code === code) {
      return;
    }

    throw error;
  }

  throw new Error(`Expected ${code}`);
}

let setups = 0;
const fixture = definePlugin({
  name: 'control-fixture',
  apiVersion: 1,
  capabilities: ['http'],
  commands: {
    add: defineCommand({
      description: 'Add to shared count',
      input: z.object({ amount: z.number().int() }),
      output: z.number(),
      cli: { path: ['add'], flags: { amount: 'amount' } },
      execute: (ctx, input) =>
        ctx.store.transaction(async (tx) => {
          const count =
            ((await tx.get('counts', 'only') as { count: number } | undefined)
              ?.count ?? 0) +
            input.amount;

          await tx.put({ collection: 'counts', id: 'only', value: { count } });

          return count;
        }),
    }),
  },
  async setup(ctx) {
    setups++;
    ctx.http.surface('api');

    const api = await ctx.http.listen('api');

    return {
      endpoints: { api },
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  },
});
const config = { services: { mail: fixture() } };

Deno.test('control CLI and typed SDK share state, isolate environments and detach ownership', async () => {
  const directory = await Deno.makeTempDir();

  try {
    await using first = await serveEnvironment(config, { directory });
    await using _other = await serveEnvironment(config, {
      directory,
      environment: 'other',
    });
    const before = setups;
    await using client = await Emulon.connect({ config, directory });
    const count: number = await client.services.mail.add({ amount: 2 });

    equal(count, 2);

    const cli = await runProjectCLI(
      ['mail', 'add', '--amount=3', '--json'],
      undefined,
      directory,
    );

    equal(cli, { code: 0, stdout: '5', stderr: '' });
    equal(await client.services.mail.add({ amount: 0 }), 5);
    equal(
      (await runProjectCLI(
        ['--environment', 'other', 'mail', 'add', '--amount', '1'],
        undefined,
        directory,
      )).stdout,
      '1',
    );
    equal(setups, before);
    equal(
      (await runProjectCLI(['mail', '--help'], undefined, directory)).code,
      0,
    );

    const invalid = await runProjectCLI(
      ['mail', 'add', '--amount=x', '--json'],
      undefined,
      directory,
    );

    equal(JSON.parse(invalid.stderr).error.code, 'VALIDATION_ERROR');
    await rejects(
      () => client.services.mail.add({ amount: NaN }),
      'VALIDATION_ERROR',
    );
    await rejects(
      () => client.services.mail.add({ amount: 1.5 }),
      'VALIDATION_ERROR',
    );

    const record = await readDiscovery({ directory });
    const status = await runProjectCLI(
      ['status', '--json'],
      undefined,
      directory,
    );

    equal(
      JSON.parse(status.stdout).endpoints.mail.api,
      client.endpoints.mail.api,
    );
    equal(status.stdout.includes(record.token), false);
    equal(
      (await Deno.stat(`${directory}/.emulon/default.json`)).mode! & 0o777,
      0o600,
    );
    equal((await Deno.stat(`${directory}/.emulon`)).mode! & 0o777, 0o700);
    await client.dispose();
    await rejects(
      () => client.services.mail.add({ amount: 1 }),
      'ENVIRONMENT_CLOSED',
    );
    equal(
      (await runProjectCLI(['mail', 'add', '--amount=0'], undefined, directory))
        .stdout,
      '5',
    );

    await using again = await Emulon.connect({ config, directory });

    await again.reset();
    equal(await again.services.mail.add({ amount: 0 }), 0);
    equal((await runProjectCLI(['down'], undefined, directory)).code, 0);
    await first.finished;
    await rejects(() => readDiscovery({ directory }), 'ENVIRONMENT_NOT_FOUND');
    equal(
      (await discover({ directory, environment: 'other' })).identity.id,
      _other.identity.id,
    );

    // deno-lint-ignore no-constant-condition
    if (false) {
      // @ts-expect-error Connected clients retain command input types.
      await client.services.mail.add({ amount: '1' });
      // @ts-expect-error Connected clients retain service names.
      client.services.missing;
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('control rejects browser sessions, wrong credentials and cross-environment credentials', async () => {
  const directory = await Deno.makeTempDir();

  try {
    await using host = await serveEnvironment(config, { directory });
    await using _other = await serveEnvironment(config, {
      directory,
      environment: 'other',
    });
    const record = await readDiscovery({ directory });
    const foreign = await readDiscovery({ directory, environment: 'other' });

    for (
      const headers of [
        {},
        { cookie: 'session=authorized' },
        {
          authorization: 'Bearer provider-token',
          'x-emulon-environment': record.id,
        },
        {
          authorization: `Bearer ${foreign.token}`,
          'x-emulon-environment': record.id,
        },
        {
          authorization: `Bearer ${record.token}`,
          'x-emulon-environment': foreign.id,
        },
        {
          authorization: `Bearer ${record.token}`,
          'x-emulon-environment': record.id,
          origin: 'http://localhost:3000',
        },
      ]
    ) {
      const response = await fetch(record.url + '/command', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instance: 'mail',
          command: 'add',
          input: { amount: 10 },
        }),
      });

      equal(response.status, 401);
      equal((await response.json()).error.code, 'UNAUTHORIZED');
    }

    equal(
      await request(record, '/command', {
        instance: 'mail',
        command: 'add',
        input: { amount: 0 },
      }),
      0,
    );
    equal(record.url === host.identity.endpoints.mail!.api, false);
    await rejects(
      () => serveEnvironment(config, { directory }),
      'ENVIRONMENT_EXISTS',
    );
    equal((await discover({ directory })).identity.id, host.identity.id);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('dead and mismatched discovery is authenticated and gives recovery instructions', async () => {
  const directory = await Deno.makeTempDir();

  try {
    const host = await serveEnvironment(config, { directory });
    const record = await readDiscovery({ directory });

    await host.dispose();
    await publishDiscovery({ directory }, record);

    const status = await runProjectCLI(
      ['status', '--json'],
      undefined,
      directory,
    );

    equal(status.code, 1);
    equal(JSON.parse(status.stderr).error.code, 'ENVIRONMENT_STALE');
    equal(status.stderr.includes('remove'), true);

    await using _other = await serveEnvironment(config, {
      directory,
      environment: 'other',
    });
    const live = await readDiscovery({ directory, environment: 'other' });

    await Deno.writeTextFile(
      `${directory}/.emulon/default.json`,
      JSON.stringify({ ...live, id: record.id }),
    );
    await rejects(() => discover({ directory }), 'ENVIRONMENT_STALE');
    await Deno.writeTextFile(
      `${directory}/.emulon/default.json`,
      JSON.stringify({ ...live, url: 'https://example.com' }),
    );
    await rejects(() => discover({ directory }), 'ENVIRONMENT_STALE');
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('unsuccessful JSON identity responses give stale recovery in CLI and SDK', async () => {
  const { listen } = await import('../src/runtime/http.ts');
  const directory = await Deno.makeTempDir();
  let body: unknown = {};
  const listener = await listen(() =>
    Promise.resolve(Response.json(body, { status: 404 }))
  );

  try {
    await publishDiscovery({ directory }, {
      version: 1,
      id: crypto.randomUUID(),
      token: 'a'.repeat(64),
      url: listener.url,
    });

    for (
      const response of [
        {},
        { error: { code: 'NOT_FOUND', message: 'Route not found' } },
      ]
    ) {
      body = response;

      const status = await runProjectCLI(
        ['status', '--json'],
        undefined,
        directory,
      );

      equal(status.code, 1);
      equal(JSON.parse(status.stderr).error, stale().toJSON());
      await rejects(
        () => Emulon.connect({ config, directory }),
        'ENVIRONMENT_STALE',
      );
    }
  } finally {
    await listener.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('foreground up reports readiness and down resolves its lifetime', async () => {
  const directory = await Deno.makeTempDir();
  let ready!: (value: string) => void;
  const started = new Promise<string>((resolve) => ready = resolve);
  const pending = runProjectCLI(
    ['up', '--environment=parallel', '--json'],
    config,
    directory,
    ready,
  );

  try {
    const output = JSON.parse(await started);

    equal(output.environment, 'parallel');

    const record = await readDiscovery({ directory, environment: 'parallel' });

    equal(JSON.stringify(output).includes(record.token), false);
    equal(
      (await runProjectCLI(
        ['down', '--environment=parallel'],
        undefined,
        directory,
      )).code,
      0,
    );
    equal((await pending).code, 0);
    await rejects(
      () => readDiscovery({ directory, environment: 'parallel' }),
      'ENVIRONMENT_NOT_FOUND',
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('environment selection and authentication rules are pure and reject unsafe targets', async () => {
  equal(selectEnvironment(['--environment=two', 'status']), {
    args: ['status'],
    environment: 'two',
  });

  for (const name of ['../x', '', '/tmp/x', 'a.b', 'a'.repeat(65)]) {
    await rejects(() => environmentName(name), 'INVALID_ENVIRONMENT');
  }

  for (
    const args of [['--environment'], ['--environment=x', '--environment=y']]
  ) {
    await rejects(() => selectEnvironment(args), 'CLI_INVALID_ARGUMENTS');
  }

  const record = connection({
    version: 1,
    id: crypto.randomUUID(),
    token: 'a'.repeat(64),
    url: 'http://127.0.0.1:1234',
  });

  equal(
    authorized(
      new Request(record.url, {
        headers: {
          authorization: `Bearer ${record.token}`,
          'x-emulon-environment': record.id,
        },
      }),
      record,
    ),
    true,
  );

  for (
    const url of [
      'http://127.0.0.1:99999',
      'http://localhost:1234',
      'http://127.0.0.1:1234/path',
      'https://example.com',
    ]
  ) {
    await rejects(() => connection({ ...record, url }), 'ENVIRONMENT_STALE');
  }
});

Deno.test('discovery rejects a responding impostor and bounds an unresponsive listener', async () => {
  const { listen } = await import('../src/runtime/http.ts');
  const directory = await Deno.makeTempDir();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let hanging = false;
  const listener = await listen(async () => {
    if (hanging) {
      await gate;
    }

    return Response.json({ id: crypto.randomUUID(), endpoints: {} });
  });

  try {
    await publishDiscovery({ directory }, {
      version: 1,
      id: crypto.randomUUID(),
      token: 'b'.repeat(64),
      url: listener.url,
    });
    await rejects(() => discover({ directory }), 'ENVIRONMENT_STALE');

    hanging = true;

    await rejects(() => discover({ directory }), 'ENVIRONMENT_STALE');
  } finally {
    release();
    await listener.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('disconnect aborts a pending client request without shutting down the host', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => enter = resolve);
  const gate = new Promise<void>((resolve) => release = resolve);
  const slow = definePlugin({
    name: 'slow',
    apiVersion: 1,
    capabilities: [],
    commands: {
      wait: defineCommand({
        description: 'Wait for a test gate',
        input: z.object({}),
        output: z.boolean(),
        cli: { path: ['wait'], flags: {} },
        async execute() {
          enter();
          await gate;

          return true;
        },
      }),
    },
    setup: () =>
      Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
  });
  const directory = await Deno.makeTempDir();
  const config = { services: { slow: slow() } };
  const host = await serveEnvironment(config, { directory });

  try {
    await using client = await Emulon.connect({ config, directory });
    const pending = rejects(
      () => client.services.slow.wait({}),
      'ENVIRONMENT_CLOSED',
    );

    await entered;
    await client.dispose();
    await pending;
    release();
    equal((await discover({ directory })).identity.id, host.identity.id);
  } finally {
    release();
    await host.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('control envelope validation and status redaction reject unsafe data', async () => {
  for (
    const value of [null, [], {}, { instance: 1, command: 'x', input: {} }, {
      instance: 'a',
      command: 'x',
    }]
  ) {
    await rejects(() => commandRequest(value), 'INVALID_REQUEST');
  }

  equal(commandRequest({ instance: 'a', command: 'x', input: {} }), {
    instance: 'a',
    command: 'x',
    input: {},
  });
  equal(
    addresses({
      db: {
        api: 'http://user:secret@127.0.0.1:1234/token?key=secret#secret',
        invalid: 'secret',
      },
    }),
    { db: { api: 'http://127.0.0.1:1234', invalid: '[unavailable]' } },
  );
});

Deno.test('down removes discovery and closes control even when plugin stop fails', async () => {
  const broken = definePlugin({
    name: 'broken-stop',
    apiVersion: 1,
    capabilities: [],
    commands: {},
    setup: () =>
      Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.reject(new Error('secret')),
      }),
  });
  const directory = await Deno.makeTempDir();
  const host = await serveEnvironment({ services: { broken: broken() } }, {
    directory,
  });
  const finished = host.finished.catch(() => {});

  try {
    const result = await runProjectCLI(
      ['down', '--json'],
      undefined,
      directory,
    );

    equal(result.code, 1);
    equal(result.stderr.includes('secret'), false);
    await finished;
    await rejects(() => readDiscovery({ directory }), 'ENVIRONMENT_NOT_FOUND');
  } finally {
    await host.dispose().catch(() => {});

    await Deno.remove(directory, { recursive: true });
  }
});
