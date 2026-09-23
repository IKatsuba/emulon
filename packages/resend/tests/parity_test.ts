import { definePlugin, Emulon, type PluginContext } from 'emulon';
import resend from '@emulon/resend';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import {
  CommandError,
  environmentRegistry,
} from '../../emulon/src/commands/registry.ts';
import { normalize, parity } from './helpers/parity.ts';

type Outcome = { code: number; result?: unknown; error?: unknown };

const mail = {
  from: 'sender@example.test',
  to: ['receiver@example.test'],
  subject: 'Parity message',
  text: 'Local parity check',
};
const absent = '11111111-1111-4111-8111-111111111111';

function require(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function sdkOutcome(action: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { code: 0, result: await action() };
  } catch (error) {
    if (!(error instanceof CommandError)) {
      throw error;
    }

    return { code: 1, error: error.toJSON() };
  }
}

async function verifyParity(
  step: (name: string, action: () => Promise<void>) => Promise<unknown>,
  changeCLI: (operation: string, outcome: Outcome) => Outcome = (_, value) =>
    value,
) {
  const directory = await Deno.makeTempDir();
  let store!: PluginContext['store'];
  let setups = 0;
  const { definition } = readRegistration(resend());
  // Capture the real host store for inspection without adding a public command.
  const observed = definePlugin({
    ...definition,
    setup(ctx, options) {
      setups++;

      store = ctx.store;

      return definition.setup(ctx, options);
    },
  });
  const config = { services: { mail: observed() } };

  try {
    await using host = await serveEnvironment(config, { directory });
    await using env = await Emulon.connect({ config, directory });
    const snapshot = () =>
      store.transaction(async (tx) => ({
        state: { emails: await tx.list('emails'), keys: await tx.list('keys') },
        events: await tx.outbox(),
      }));
    const cli = async (args: string[]): Promise<Outcome> => {
      const response = await runProjectCLI(
        [...args, '--json'],
        undefined,
        directory,
      );

      require(
        response.code === 0 || response.code === 1,
        'Unexpected CLI exit code',
      );

      if (response.code === 0) {
        require(response.stderr === '', 'Successful CLI wrote to stderr');

        return { code: 0, result: JSON.parse(response.stdout) };
      }

      require(response.stdout === '', 'Failed CLI wrote to stdout');

      return { code: response.code, error: JSON.parse(response.stderr).error };
    };

    const send = async (key: string) => {
      const response = await fetch(env.endpoints.mail.api! + '/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(mail),
      });

      return { status: response.status, body: await response.json() };
    };

    const prepare = async () => {
      await env.reset();

      const { apiKey } = await env.services.mail.keys.create();
      const sent = await send(apiKey);

      require(sent.status === 200, 'Parity seed send failed');

      const email = await env.services.mail.emails.get({ id: sent.body.id });

      require(email, 'Parity seed email missing');

      const before = await snapshot();

      require(
        before.events.length === 1 && before.events[0]!.type === 'email.sent',
        'Parity requires a nonempty sent-event history',
      );

      const symbols = new Map([
        [apiKey, '<seed-key>'],
        [before.state.keys[0]!.id, '<seed-key-id>'],
        [email.id, '<seed-email-id>'],
        [email.created_at, '<seed-time>'],
        [before.events[0]!.id, '<seed-event-id>'],
      ]);

      return { apiKey, email, before, symbols };
    };

    type Seed = Awaited<ReturnType<typeof prepare>>;

    const cases: {
      name: string;
      args: (seed: Seed) => string[];
      sdk: (seed: Seed) => Promise<unknown>;
      error?: string;
    }[] = [
      {
        name: 'emails.list',
        args: () => ['mail', 'emails', 'list'],
        sdk: () => env.services.mail.emails.list(),
      },
      {
        name: 'emails.get',
        args: (s) => ['mail', 'emails', 'get', '--id', s.email.id],
        sdk: (s) => env.services.mail.emails.get({ id: s.email.id }),
      },
      {
        name: 'emails.get absent',
        args: () => ['mail', 'emails', 'get', '--id', absent],
        sdk: () => env.services.mail.emails.get({ id: absent }),
      },
      {
        name: 'emails.clear',
        args: () => ['mail', 'emails', 'clear'],
        sdk: () => env.services.mail.emails.clear(),
      },
      {
        name: 'keys.create',
        args: () => ['mail', 'keys', 'create'],
        sdk: () => env.services.mail.keys.create(),
      },
      {
        name: 'emails.get invalid input',
        args: () => ['mail', 'emails', 'get', '--id', 'invalid'],
        sdk: () => env.services.mail.emails.get({ id: 'invalid' }),
        error: 'VALIDATION_ERROR',
      },
      {
        name: 'unknown command',
        args: () => ['mail', 'missing'],
        // Typed clients cannot spell an unknown command; use their bound transport.
        sdk: () =>
          environmentRegistry(env).invoke({
            instance: 'mail',
            command: 'missing',
            input: {},
          }),
        error: 'UNKNOWN_COMMAND',
      },
      {
        name: 'reset / provider authentication refusal',
        args: () => ['reset'],
        sdk: async () => {
          await env.reset();

          return { reset: true };
        },
      },
    ];

    for (const operation of cases) {
      await step(operation.name, async () => {
        const observations = [];

        for (const path of ['CLI', 'SDK'] as const) {
          const seed = await prepare();
          const outcome = path === 'CLI'
            ? changeCLI(operation.name, await cli(operation.args(seed)))
            : await sdkOutcome(() => operation.sdk(seed));

          parity(
            operation.name,
            `${path} expected exit`,
            outcome.code,
            operation.error ? 1 : 0,
          );

          if (operation.error) {
            parity(
              operation.name,
              `${path} expected error code`,
              (outcome.error as { code: string }).code,
              operation.error,
            );
          }

          const after = await snapshot();

          if (operation.name === 'keys.create') {
            const token = (outcome.result as { apiKey: string }).apiKey;

            require(
              /^re_[0-9a-f]{64}$/.test(token),
              `Parity keys.create: ${path} key format`,
            );

            const created = after.state.keys.filter((row) =>
              row.id !== seed.before.state.keys[0]!.id
            );

            require(
              created.length === 1 && created[0]!.value === token &&
                token !== seed.apiKey,
              `Parity keys.create: ${path} returned key does not match new state`,
            );
            seed.symbols.set(token, '<new-key>');
            seed.symbols.set(created[0]!.id, '<new-key-id>');
          }

          const reset = operation.name.startsWith('reset /');
          const expectedState = reset
            ? { emails: [], keys: [] }
            : operation.name === 'emails.clear'
            ? { ...seed.before.state, emails: [] }
            : operation.name === 'keys.create'
            ? { ...seed.before.state, keys: after.state.keys }
            : seed.before.state;

          parity(
            operation.name,
            `${path} state transition`,
            after.state,
            expectedState,
          );
          parity(
            operation.name,
            `${path} event transition`,
            after.events,
            reset ? [] : seed.before.events,
          );

          let provider: unknown = null;

          if (reset) {
            provider = await send(seed.apiKey);

            parity(operation.name, `${path} provider error`, provider, {
              status: 403,
              body: {
                statusCode: 403,
                name: 'validation_error',
                message: 'API key is invalid',
              },
            });
            parity(
              operation.name,
              `${path} rejected send side effects`,
              await snapshot(),
              after,
            );
          }

          observations.push(
            normalize({ outcome, ...after, provider }, seed.symbols) as Record<
              string,
              unknown
            >,
          );
        }

        for (const boundary of ['outcome', 'state', 'events', 'provider']) {
          parity(
            operation.name,
            boundary,
            observations[0]![boundary],
            observations[1]![boundary],
          );
        }

        require(
          setups === 1,
          'Parity clients must use one host, not recreate plugin state',
        );
        parity(
          operation.name,
          'environment endpoint',
          env.endpoints.mail.api,
          host.identity.endpoints.mail!.api,
        );
      });
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test('Resend CLI/SDK parity over one control environment', async (t) => {
  await verifyParity((name, action) => t.step(name, action));
});

Deno.test('parity rejects an artificial CLI result field mismatch with an operation and path', async () => {
  let failure: unknown;

  try {
    await verifyParity(
      async (_, action) => await action(),
      (operation, outcome) =>
        operation === 'emails.get'
          ? {
            ...outcome,
            result: {
              ...(outcome.result as object),
              subject: 'Artificial CLI mismatch',
            },
          }
          : outcome,
    );
  } catch (error) {
    failure = error;
  }

  require(failure instanceof Error, 'Artificial CLI mismatch was not detected');
  parity(
    'negative control',
    'diagnostic',
    failure.message,
    'Parity emails.get: outcome differs at $.result.subject: value (CLI vs SDK).',
  );
});

Deno.test('parity diagnostics cover state, event, error fields, missing fields and array sizes', () => {
  for (
    const [boundary, cli, sdk, path] of [
      ['state', { emails: [1] }, { emails: [] }, '$.emails'],
      ['events', [{ type: 'wrong' }], [{ type: 'email.sent' }], '$[0].type'],
      ['error', { fields: [{ code: 'wrong' }] }, {
        fields: [{ code: 'invalid_format' }],
      }, '$.fields[0].code'],
      ['result', {}, { deleted: 1 }, '$.deleted (field presence)'],
    ] as const
  ) {
    let message = '';

    try {
      parity('probe', boundary, cli, sdk);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      message = error.message;
    }

    require(
      message.includes(`Parity probe: ${boundary} differs at ${path}:`),
      `Missing contextual diagnostic: ${boundary}`,
    );
  }

  parity('object order', 'result', { a: 1, b: 2 }, { b: 2, a: 1 });
});
