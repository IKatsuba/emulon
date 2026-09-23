import { z } from 'zod';
import {
  defineCommand,
  definePlugin,
  DomainError,
  Emulon,
  type PluginContext,
} from 'emulon';
import { runCLI } from '../src/cli/run.ts';
import { ConfigError } from '../src/sdk/load.ts';
import {
  commandEntries,
  CommandError,
  environmentRegistry,
} from '../src/commands/registry.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function failure(action: () => unknown, code: string) {
  try {
    await action();
  } catch (error) {
    if (error instanceof CommandError && error.code === code) {
      return error.toJSON();
    }

    throw error;
  }

  throw new Error(`Expected ${code}`);
}

const states = new WeakMap<PluginContext, { count: number }>();
const send = defineCommand({
  description: 'Send a fixture email',
  input: z.object({
    to: z.string().email(),
    count: z.number().int().positive().default(1),
    tags: z.array(z.string()).default([]),
    urgent: z.boolean().default(false),
  }),
  output: z.object({
    to: z.string(),
    count: z.number(),
    tags: z.array(z.string()),
    urgent: z.boolean(),
  }),
  cli: {
    path: ['emails', 'send'],
    flags: { recipient: 'to', count: 'count', tags: 'tags', urgent: 'urgent' },
  },
  execute(ctx, input) {
    states.get(ctx)!.count++;

    return input;
  },
});
const plugin = definePlugin({
  name: 'mail-fixture',
  apiVersion: 1,
  capabilities: [],
  commands: {
    'emails.send': send,
    'emails.count': defineCommand({
      description: 'Read invocation count',
      input: z.object({}),
      output: z.number(),
      cli: { path: ['emails', 'count'], flags: {} },
      execute: (ctx) => states.get(ctx)!.count,
    }),
    bad: defineCommand({
      description: 'Return invalid output',
      input: z.object({}),
      output: z.string(),
      cli: { path: ['bad'], flags: {} },
      execute: () => 1 as unknown as string,
    }),
    crash: defineCommand({
      description: 'Throw a private error',
      input: z.object({}),
      output: z.string(),
      cli: { path: ['crash'], flags: {} },
      execute() {
        throw new Error('secret-token');
      },
    }),
  },
  setup(ctx) {
    states.set(ctx, { count: 0 });

    return Promise.resolve({
      endpoints: {},
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
  },
});

Deno.test('CLI and SDK share validation, results and per-instance command state', async () => {
  await using env = await Emulon.start({
    services: { mail: plugin(), other: plugin() },
  });
  const expected = await env.services.mail.emails.send({
    to: 'a@example.test',
    count: 2,
    tags: ['local'],
    urgent: true,
  });
  const result = await runCLI(
    [
      'mail',
      'emails',
      'send',
      '--recipient',
      'a@example.test',
      '--count=2',
      '--tags',
      '["local"]',
      '--urgent',
      '--json',
    ],
    undefined,
    env,
  );

  equal(result.code, 0);
  equal(JSON.parse(result.stdout), expected);
  equal(await env.services.mail.emails.count({}), 2);
  equal(await env.services.other.emails.count({}), 0);

  const typed: string = expected.to;

  equal(typed, 'a@example.test');

  // deno-lint-ignore no-constant-condition
  if (false) {
    // @ts-expect-error Input fields retain schema types.
    await env.services.mail.emails.send({ to: 1 });

    // @ts-expect-error Output fields retain schema types.
    const invalid: number = expected.to;

    void invalid;
    // @ts-expect-error No hidden SDK methods exist.
    env.services.mail.hidden();
  }

  const sdk = await failure(
    () => env.services.mail.emails.send({ to: 'secret-token' }),
    'VALIDATION_ERROR',
  );
  const cli = await runCLI(
    ['mail', 'emails', 'send', '--recipient', 'secret-token', '--json'],
    undefined,
    env,
  );

  equal(cli.code, 1);
  equal(JSON.parse(cli.stderr).error, sdk);
  equal(sdk.fields, [{ path: ['to'], code: 'invalid_format' }]);
  equal(cli.stderr.includes('secret-token'), false);
  equal(await env.services.mail.emails.count({}), 2);
});

Deno.test('unknown names fail without mutation and help comes from declarations', async () => {
  await using env = await Emulon.start({ services: { mail: plugin() } });

  for (
    const [args, code, available] of [
      [['missing', 'emails', 'send'], 'UNKNOWN_INSTANCE', ['mail']],
      [['mail', 'missing'], 'UNKNOWN_COMMAND', [
        'bad',
        'crash',
        'emails.count',
        'emails.send',
      ]],
    ] as const
  ) {
    const result = await runCLI([...args, '--json'], undefined, env);

    equal(result.code, 1);
    equal(JSON.parse(result.stderr).error.code, code);
    equal(JSON.parse(result.stderr).error.available, available);
  }

  equal(await env.services.mail.emails.count({}), 0);

  const help = await runCLI(
    ['mail', 'emails', 'send', '--help', '--json'],
    undefined,
    env,
  );

  equal(JSON.parse(help.stdout).commands[0].flags.recipient, 'to');
  equal(JSON.parse(help.stdout).commands.length, 1);

  const instanceHelp = await runCLI(['mail', '--help'], undefined, env);

  equal(instanceHelp.stdout.includes('emulon mail emails send'), true);
  equal(instanceHelp.stdout.includes('--recipient'), true);
  await failure(() => env.services.mail.bad({}), 'OUTPUT_VALIDATION_ERROR');

  const crash = await runCLI(['mail', 'crash', '--json'], undefined, env);

  equal(crash.stderr.includes('secret-token'), false);
  equal(JSON.parse(crash.stderr).error.code, 'COMMAND_FAILED');
  await env.dispose();
  await failure(() => env.services.mail.emails.count({}), 'ENVIRONMENT_CLOSED');
});

Deno.test('JSON boundary and malformed CLI arguments reject before execution', async () => {
  await using env = await Emulon.start({ services: { mail: plugin() } });

  for (
    const input of [{ to: 'a@example.test', count: NaN }, {
      to: 'a@example.test',
      unknown: undefined,
    }, new Date()]
  ) {
    await failure(
      () =>
        environmentRegistry(env).invoke({
          instance: 'mail',
          command: 'emails.send',
          input,
        }),
      'VALIDATION_ERROR',
    );
  }

  for (
    const args of [['--recipient'], ['--wrong', 'x'], [
      '--recipient',
      'a@example.test',
      '--recipient',
      'b@example.test',
    ]]
  ) {
    const result = await runCLI(
      ['mail', 'emails', 'send', ...args, '--json'],
      undefined,
      env,
    );

    equal(JSON.parse(result.stderr).error.code, 'CLI_INVALID_ARGUMENTS');
  }

  equal(await env.services.mail.emails.count({}), 0);
});

Deno.test('registry rejects non-JSON schemas and colliding command paths', () => {
  for (
    const action of [
      () =>
        defineCommand({
          ...send,
          input: z.date(),
          execute: () => ({ to: '', count: 1, tags: [], urgent: false }),
        }),
      () => defineCommand({ ...send, output: z.bigint(), execute: () => 1n }),
      () =>
        defineCommand({
          ...send,
          cli: { path: ['send'], flags: { help: 'to' } },
        }),
      () => commandEntries({ first: send, second: send }),
      () =>
        commandEntries({
          emails: send,
          'emails.send': {
            ...send,
            cli: { path: ['send'], flags: send.cli.flags },
          },
        }),
    ]
  ) {
    let threw = false;

    try {
      action();
    } catch {
      threw = true;
    }

    equal(threw, true);
  }
});

Deno.test('project CLI never starts a command environment without discovery', async () => {
  const { runProjectCLI } = await import('../src/cli/project.ts');
  const directory = await Deno.makeTempDir();

  try {
    const result = await runProjectCLI(['mail', 'emails', 'send', '--json'], {
      services: { mail: plugin() },
    }, directory);

    equal(result.code, 1);
    equal(JSON.parse(result.stderr).error.code, 'ENVIRONMENT_NOT_FOUND');
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('string unions preserve literal CLI values and shared validation', async () => {
  const fixture = definePlugin({
    name: 'strings',
    apiVersion: 1,
    capabilities: [],
    commands: {
      echo: defineCommand({
        description: 'Echo a literal string',
        input: z.object({
          value: z.union([z.literal('123'), z.literal('null')]),
        }),
        output: z.string(),
        cli: { path: ['echo'], flags: { value: 'value' } },
        execute: (_ctx, input) => input.value,
      }),
    },
    setup: () =>
      Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
  });
  await using env = await Emulon.start({ services: { mail: fixture() } });

  for (const value of ['123', 'null'] as const) {
    const result = await runCLI(
      ['mail', 'echo', '--value', value, '--json'],
      undefined,
      env,
    );

    equal(result.code, 0);
    equal(JSON.parse(result.stdout), await env.services.mail.echo({ value }));
  }

  const sdk = await failure(() =>
    environmentRegistry(env).invoke({
      instance: 'mail',
      command: 'echo',
      input: { value: 'invalid' },
    }), 'VALIDATION_ERROR');
  const cli = await runCLI(
    ['mail', 'echo', '--value', 'invalid', '--json'],
    undefined,
    env,
  );

  equal(cli.code, 1);
  equal(JSON.parse(cli.stderr).error, sdk);
  equal(sdk.fields[0]?.path, ['value']);
});

Deno.test('unrepresentable CLI inputs are rejected at declaration and before setup', async () => {
  for (
    const [input, flags] of [
      [z.string(), {}],
      [z.object({ required: z.string() }), {}],
      [z.object({ optional: z.string().optional() }), {}],
      [z.object({ value: z.string().nullable() }), { value: 'value' }],
      [z.object({ value: z.union([z.string(), z.number()]) }), {
        value: 'value',
      }],
      [z.object({ value: z.string() }).passthrough(), { value: 'value' }],
    ] as const
  ) {
    const declaration = {
      description: 'Unsupported input',
      input,
      output: z.boolean(),
      cli: { path: ['unsupported'], flags },
      execute: () => true,
    };
    let rejected = false;

    try {
      defineCommand(declaration);
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }

      rejected = true;
    }

    equal(rejected, true);

    let setups = 0;
    const commands = {
      unsupported: {
        ...declaration,
        input: z.object({}),
        cli: { path: ['unsupported'], flags: {} },
      },
    };
    const fixture = definePlugin({
      name: 'invalid-declaration',
      apiVersion: 1,
      capabilities: [],
      commands,
      setup() {
        setups++;

        return Promise.resolve({
          endpoints: {},
          ready: () => Promise.resolve(),
          stop: () => Promise.resolve(),
        });
      },
    });

    Object.assign(commands.unsupported, declaration);

    rejected = false;

    try {
      await using _env = await Emulon.start({ services: { mail: fixture() } });
    } catch (error) {
      if (!(error instanceof ConfigError) || error.code !== 'CONFIG_INVALID') {
        throw error;
      }

      rejected = true;
    }

    equal(rejected, true);
    equal(setups, 0);
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => release = resolve);

  return { promise, release };
}

Deno.test('dispose rejects commands waiting on input validation before execution', async () => {
  const entered = gate();
  const validation = gate();
  let executions = 0;
  let stopped = false;
  const fixture = definePlugin({
    name: 'validation-gate',
    apiVersion: 1,
    capabilities: [],
    commands: {
      run: defineCommand({
        description: 'Wait in validation',
        input: z.object({}).refine(async () => {
          entered.release();
          await validation.promise;

          return true;
        }),
        output: z.boolean(),
        cli: { path: ['run'], flags: {} },
        execute() {
          executions++;

          return true;
        },
      }),
    },
    setup: () =>
      Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => {
          stopped = true;

          return Promise.resolve();
        },
      }),
  });
  await using env = await Emulon.start({ services: { mail: fixture() } });
  const pending = failure(
    () => env.services.mail.run({}),
    'ENVIRONMENT_CLOSED',
  );

  await entered.promise;
  await env.dispose();
  equal(stopped, true);
  validation.release();
  await pending;
  equal(executions, 0);
});

Deno.test('dispose drains execution and output validation including failures', async () => {
  for (
    const outcome of ['success', 'execute-failure', 'output-failure'] as const
  ) {
    const entered = gate();
    const execution = gate();
    const outputEntered = gate();
    const outputValidation = gate();
    const events: string[] = [];
    const fixture = definePlugin({
      name: 'execution-gate',
      apiVersion: 1,
      capabilities: [],
      commands: {
        run: defineCommand({
          description: 'Wait in execution and output validation',
          input: z.object({}),
          output: z.boolean().refine(async () => {
            outputEntered.release();
            await outputValidation.promise;
            events.push('output');

            return outcome !== 'output-failure';
          }),
          cli: { path: ['run'], flags: {} },
          async execute() {
            entered.release();
            await execution.promise;
            events.push('execute');

            if (outcome === 'execute-failure') {
              throw new Error('fixture failure');
            }

            return true;
          },
        }),
      },
      setup: () =>
        Promise.resolve({
          endpoints: {},
          ready: () => Promise.resolve(),
          stop: () => {
            events.push('stop');

            return Promise.resolve();
          },
        }),
    });
    await using env = await Emulon.start({ services: { mail: fixture() } });
    const pending = outcome === 'success' ? env.services.mail.run({}) : failure(
      () => env.services.mail.run({}),
      outcome === 'execute-failure'
        ? 'COMMAND_FAILED'
        : 'OUTPUT_VALIDATION_ERROR',
    );

    await entered.promise;

    const disposed = env.dispose();

    equal(env.dispose(), disposed);
    await failure(() => env.services.mail.run({}), 'ENVIRONMENT_CLOSED');
    equal(events, []);
    execution.release();

    if (outcome !== 'execute-failure') {
      await outputEntered.promise;
      equal(events, ['execute']);
      outputValidation.release();
    }

    await pending;
    await disposed;
    equal(
      events,
      outcome === 'execute-failure'
        ? ['execute', 'stop']
        : ['execute', 'output', 'stop'],
    );
  }
});

Deno.test('only explicit domain failures expose safe code and message', async () => {
  for (
    const thrown of [
      Object.assign(
        new DomainError('RESOURCE_MISSING', 'Configure a fixture.'),
        {
          secret: 'secret-token',
          cause: new Error('secret-token'),
        },
      ),
      new Error('secret-token'),
      { code: 'RESOURCE_MISSING', message: 'secret-token' },
      new CommandError('RESOURCE_MISSING', 'secret-token'),
    ]
  ) {
    const fixture = definePlugin({
      name: 'errors',
      apiVersion: 1,
      capabilities: [],
      commands: {
        fail: defineCommand({
          description: 'Fail safely',
          input: z.object({}),
          output: z.boolean(),
          cli: { path: ['fail'], flags: {} },
          execute() {
            throw thrown;
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
    await using env = await Emulon.start({ services: { fixture: fixture() } });
    const expected = {
      code: thrown instanceof DomainError
        ? 'RESOURCE_MISSING'
        : 'COMMAND_FAILED',
      message: thrown instanceof DomainError
        ? 'Configure a fixture.'
        : 'Command execution failed.',
      fields: [],
      available: [],
    };

    equal(
      await failure(() => env.services.fixture.fail(), expected.code),
      expected,
    );

    const json = await runCLI(['fixture', 'fail', '--json'], undefined, env);

    equal(json.code, 1);
    equal(JSON.parse(json.stderr), { error: expected });

    const plain = await runCLI(['fixture', 'fail'], undefined, env);

    equal(plain.code, 1);
    equal(plain.stderr, `${expected.code}: ${expected.message}`);
  }
});
