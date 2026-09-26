import {
  defineCommand,
  defineConfig,
  definePlugin,
  DomainError,
  Emulon,
} from 'emulon';
import { z } from 'zod';
import { runProjectCLI } from '../src/cli/project.ts';
import { CommandError } from '../src/commands/registry.ts';
import { serveDeno } from '../src/runtime/deno-http.ts';
import { serveNode } from '../src/runtime/http.ts';
import { PortInUseError } from '../src/runtime/port-in-use.ts';
import {
  checkPortConflicts,
  readInstance,
  unmatchedSurfaces,
} from '../src/sdk/instances.ts';
import { ConfigError, validateConfig } from '../src/sdk/load.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function failure(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('Expected a failure');
}

/** Holds a loopback port so a test never depends on a hard-coded number. */
function occupy(): Deno.Listener & { addr: Deno.NetAddr } {
  return Deno.listen({ hostname: '127.0.0.1', port: 0 }) as
    & Deno.Listener
    & { addr: Deno.NetAddr };
}

function vacantPorts(count: number): number[] {
  const held = Array.from({ length: count }, occupy);
  const ports = held.map((listener) => listener.addr.port);

  for (const listener of held) {
    listener.close();
  }

  return ports;
}

async function canBind(port: number): Promise<boolean> {
  try {
    const probe = Deno.listen({ hostname: '127.0.0.1', port });

    probe.close();

    return true;
  } catch {
    // A just-closed listener can take a moment to release its port.
    await new Promise((resolve) => setTimeout(resolve, 20));

    return false;
  }
}

const stopped: string[] = [];
const surfaces = definePlugin({
  name: 'surfaces-fixture',
  apiVersion: 1,
  capabilities: ['http'],
  commands: {
    ping: defineCommand({
      description: 'Ping',
      input: z.object({}),
      output: z.string(),
      cli: { path: ['ping'], flags: {} },
      execute: () => 'pong',
    }),
  },
  async setup(
    ctx,
    options: { label: string; swallow?: boolean; ignore?: boolean },
  ) {
    const endpoints: Record<string, string> = {};

    for (const name of ['api', 'web']) {
      ctx.http.surface(name).get(
        '/',
        (c) => c.text(`${options.label}:${name}`),
      );

      try {
        endpoints[name] = await ctx.http.listen(name);
      } catch {
        // A plugin that hides the bind error must not hide the host verdict.
        if (options.ignore) {
          continue;
        }

        throw new Error(options.swallow ? 'plugin failure' : 'secret-marker');
      }
    }

    return {
      endpoints,
      ready: () => Promise.resolve(),
      stop() {
        stopped.push(options.label);

        return Promise.resolve();
      },
    };
  },
});

Deno.test('instance descriptors validate ports without echoing values', () => {
  const registration = surfaces({ label: 'a' });

  assert(readInstance('a', registration).ports.size === 0);
  assert(readInstance('a', { service: registration }).ports.size === 0);
  assert(
    readInstance('a', { service: registration, ports: { api: 0, web: 65535 } })
      .ports.get('web') === 65535,
  );

  for (
    const ports of [
      { api: -1 },
      { api: 65536 },
      { api: 1.5 },
      { api: '4000' },
      { api: Number.NaN },
      [],
      'secret-marker',
    ]
  ) {
    const error = (() => {
      try {
        readInstance('billing', { service: registration, ports });
      } catch (error) {
        return error;
      }
    })();

    assert(error instanceof DomainError && error.code === 'CONFIG_INVALID');
    assert(error.message.includes('"billing"'));
    assert(!error.message.includes('secret-marker'));
    assert(!error.message.includes('4000'));
  }

  const extra = (() => {
    try {
      readInstance('billing', { service: registration, port: 4000 });
    } catch (error) {
      return error;
    }
  })();

  assert(extra instanceof DomainError && extra.code === 'CONFIG_INVALID');

  for (const value of [{ service: 'secret-marker' }, { ports: {} }]) {
    try {
      readInstance('billing', value);

      throw new Error('Expected a failure');
    } catch (error) {
      assert(error instanceof TypeError);
    }
  }
});

Deno.test('duplicate fixed ports name both surfaces and ignore port 0', () => {
  const instance = (ports: Record<string, number>) => ({
    registration: surfaces({ label: 'a' }),
    ports: new Map(Object.entries(ports)),
  });

  checkPortConflicts([
    ['a', instance({ api: 0, web: 0 })],
    ['b', instance({ api: 0, web: 4001 })],
  ]);

  for (
    const [instances, owners] of [
      [[['a', instance({ api: 4001, web: 4001 })]], ['a.api', 'a.web']],
      [
        [['a', instance({ api: 4001 })], ['b', instance({ web: 4001 })]],
        ['a.api', 'b.web'],
      ],
    ] as const
  ) {
    try {
      checkPortConflicts(instances);

      throw new Error('Expected a failure');
    } catch (error) {
      assert(error instanceof DomainError && error.code === 'CONFIG_INVALID');
      assert(
        error.message ===
          `Port 4001 is configured for both "${owners[0]}" and "${owners[1]}".`,
        error.message,
      );
    }
  }

  const listened = new Set(['api']);

  assert(unmatchedSurfaces(new Map([['api', 1]]), listened).length === 0);
  assert(unmatchedSurfaces(new Map([['admin', 0]]), listened)[0] === 'admin');
});

Deno.test('configuration rejects duplicate ports before any setup', async () => {
  stopped.length = 0;

  const config = {
    services: {
      billing: {
        service: surfaces({ label: 'billing' }),
        ports: { api: 4001 },
      },
      code: { service: surfaces({ label: 'code' }), ports: { web: 4001 } },
    },
  };
  const expected =
    'Port 4001 is configured for both "billing.api" and "code.web".';
  const direct = await failure(() => defineConfig(config));

  assert(direct instanceof DomainError && direct.message === expected);

  for (
    const action of [
      () => validateConfig(config),
      () => Emulon.load(config),
      () => Emulon.start(config),
    ]
  ) {
    const error = await failure(action);

    assert(error instanceof ConfigError, String(error));
    assert(error.code === 'CONFIG_INVALID' && error.message === expected);
  }

  assert(stopped.length === 0);
});

Deno.test('a CONFIG_INVALID thrown by project code keeps its message hidden', async () => {
  const registration = surfaces({ label: 'billing' });
  const config = {
    services: {
      billing: {
        service: registration,
        get ports(): Record<string, number> {
          throw new DomainError('CONFIG_INVALID', 'secret-marker');
        },
      },
    },
  };

  for (
    const action of [
      () => validateConfig(config),
      () => Emulon.load(config),
      () => Emulon.start(config),
    ]
  ) {
    const error = await failure(action);

    assert(error instanceof ConfigError, String(error));
    assert(error.code === 'CONFIG_INVALID');
    assert(error.message === 'Invalid Emulon configuration.', error.message);
  }
});

for (const serve of [serveDeno, serveNode]) {
  Deno.test(`${serve.name} binds a requested loopback port and reports it in use`, async () => {
    const [port] = vacantPorts(1);
    const listener = await serve(() => new Response('ok'), port);

    try {
      const url = new URL(listener.url);

      // The URL comes from the bound socket address, not from the request.
      assert(url.hostname === '127.0.0.1' && url.port === String(port));
      assert(await (await fetch(listener.url)).text() === 'ok');

      const error = await failure(() => serve(() => new Response(), port));

      assert(error instanceof PortInUseError && error.port === port);
    } finally {
      await listener.stop();
    }

    const dynamic = await serve(() => new Response('ok'));

    try {
      assert(new URL(dynamic.url).hostname === '127.0.0.1');
      assert(new URL(dynamic.url).port !== '0');
    } finally {
      await dynamic.stop();
    }
  });
}

Deno.test('Emulon.start keeps fixed surface ports across restarts', async () => {
  const [api, web, other] = vacantPorts(3);
  const config = defineConfig({
    services: {
      code: {
        service: surfaces({ label: 'code' }),
        ports: { api: api!, web: web! },
      },
      billing: {
        service: surfaces({ label: 'billing' }),
        ports: { api: other! },
      },
      dynamic: surfaces({ label: 'dynamic' }),
    },
  });
  let previous: string | undefined;

  for (let round = 0; round < 2; round++) {
    await using environment = await Emulon.start(config);
    const pong: string = await environment.services.code.ping();

    assert(pong === 'pong');
    // @ts-expect-error Descriptors keep the typed client of their registration.
    environment.services.code.nope;
    assert(environment.endpoints.code.api === `http://127.0.0.1:${api}`);
    assert(environment.endpoints.code.web === `http://127.0.0.1:${web}`);
    assert(environment.endpoints.billing.api === `http://127.0.0.1:${other}`);
    assert(
      new URL(environment.endpoints.billing.web!).port !== String(other),
    );
    assert(
      await (await fetch(environment.endpoints.code.web!)).text() ===
        'code:web',
    );

    const endpoints = JSON.stringify(environment.endpoints.code) +
      environment.endpoints.billing.api;

    assert(previous === undefined || previous === endpoints);

    previous = endpoints;
  }
});

Deno.test('an occupied port fails startup with PORT_IN_USE and rolls back', async () => {
  const [first] = vacantPorts(1);
  const foreign = occupy();
  const port = foreign.addr.port;

  try {
    for (
      const handling of [{}, { swallow: true }, { ignore: true }] as const
    ) {
      stopped.length = 0;

      const error = await failure(() =>
        Emulon.start({
          services: {
            first: {
              service: surfaces({ label: 'first' }),
              ports: { api: first! },
            },
            code: {
              service: surfaces({ label: 'code', ...handling }),
              ports: { web: port },
            },
          },
        })
      );

      assert(error instanceof CommandError, String(error));
      assert(error.code === 'PORT_IN_USE');
      assert(
        error.message ===
          `Service instance "code" surface "web" cannot listen on port ${port} because it is already in use.`,
        error.message,
      );
      // A plugin that started without the surface is stopped as well.
      assert(
        stopped.join() === ('ignore' in handling ? 'code,first' : 'first'),
        stopped.join(),
      );

      let released = false;

      for (let attempt = 0; attempt < 50 && !released; attempt++) {
        released = await canBind(first!);
      }

      assert(released, 'Rollback kept an earlier listener open');
    }
  } finally {
    foreign.close();
  }
});

Deno.test('a port for a surface the plugin never listens to is CONFIG_INVALID', async () => {
  stopped.length = 0;

  const error = await failure(() =>
    Emulon.start({
      services: {
        code: {
          service: surfaces({ label: 'code' }),
          ports: { api: 0, admin: 0 },
        },
      },
    })
  );

  assert(error instanceof CommandError && error.code === 'CONFIG_INVALID');
  assert(
    error.message ===
      'Service instance "code" has no surface "admin" for its configured port.',
    error.message,
  );
  assert(stopped.join() === 'code');
});

Deno.test('emulon up reports PORT_IN_USE without publishing discovery', async () => {
  const directory = await Deno.makeTempDir();
  const foreign = occupy();
  const config = {
    services: {
      billing: {
        service: surfaces({ label: 'billing' }),
        ports: { api: foreign.addr.port },
      },
    },
  };

  try {
    const up = await runProjectCLI(['up', '--json'], config, directory);
    const error = JSON.parse(up.stderr).error;

    assert(up.code === 1 && error.code === 'PORT_IN_USE', up.stderr);
    assert(error.message.includes('"billing" surface "api"'));
    assert(error.message.includes(String(foreign.addr.port)));

    const status = await runProjectCLI(['status', '--json'], config, directory);

    assert(JSON.parse(status.stderr).error.code === 'ENVIRONMENT_NOT_FOUND');
  } finally {
    foreign.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('the loader shows host port verdicts raised during import', async () => {
  const directory = await Deno.makeTempDir();

  try {
    await Deno.writeTextFile(
      `${directory}/emulon.config.ts`,
      'import { defineConfig } from "emulon";\n' +
        'import resend from "@emulon/resend";\n' +
        'export default defineConfig({ services: {\n' +
        '  mail: { service: resend(), ports: { api: 4001 } },\n' +
        '  other: { service: resend(), ports: { api: 4001 } },\n' +
        '} });\n',
    );

    const error = await failure(() => Emulon.load(directory));

    assert(error instanceof ConfigError && error.code === 'CONFIG_INVALID');
    assert(
      error.message ===
        'Port 4001 is configured for both "mail.api" and "other.api".',
    );

    const up = await runProjectCLI(['up', '--json'], undefined, directory);

    assert(JSON.parse(up.stderr).error.message === error.message);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
