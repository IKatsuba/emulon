import github from '../src/mod.ts';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { CommandError } from '../../emulon/src/commands/registry.ts';
import { parity } from '../../resend/tests/helpers/parity.ts';
import {
  appRecordSchema,
  grantSchema,
  installationSchema,
} from '../src/model/schema.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

const options = {
  fixtures: {
    users: [{ login: 'igor' }, { login: 'other' }],
    repositories: [{ owner: 'igor', name: 'demo', private: true }, {
      owner: 'other',
      name: 'demo',
    }],
  },
};

Deno.test('GitHub CLI and SDK share app, installation, suspension state and errors', async () => {
  const directory = await Deno.makeTempDir();
  let store!: PluginContext['store'];
  let setups = 0;
  const { definition } = readRegistration(github());
  const observed = definePlugin({
    ...definition,
    setup(ctx, options) {
      setups++;

      store = ctx.store;

      return definition.setup(ctx, options);
    },
  });
  const config = { services: { github: observed(options) } };

  try {
    await using host = await serveEnvironment(config, { directory });
    await using env = await Emulon.connect({ config, directory });
    const gh = env.services.github;
    const cli = (args: string[]) =>
      runProjectCLI(['github', ...args, '--json'], undefined, directory);
    const snapshot = () =>
      store.transaction(async (tx) => ({
        apps: await tx.list('apps'),
        installations: await tx.list('installations'),
        grants: await tx.list('grants'),
        events: await tx.outbox(),
      }));
    const createdCLI = await cli(['apps', 'create', '--slug', 'review-bot']);

    assert(
      createdCLI.code === 0 && !createdCLI.stderr,
      'CLI app creation failed',
    );

    const app = JSON.parse(createdCLI.stdout);
    const storedApp = await store.transaction(async (tx) =>
      appRecordSchema.parse(await tx.get('apps', app.id))
    );

    assert(
      app.privateKey === storedApp.privateKey &&
        app.clientSecret === storedApp.clientSecret &&
        !Object.hasOwn(app, 'publicKey') && !Object.hasOwn(app, 'webhook'),
      'App result does not match protected state',
    );

    const sdkApp = await gh.apps.create({ slug: 'sdk-bot' });

    parity('apps.create', 'result shape', {
      ...app,
      id: 'ID',
      slug: 'SLUG',
      clientId: 'CLIENT',
      privateKey: 'KEY',
      clientSecret: 'SECRET',
    }, {
      ...sdkApp,
      id: 'ID',
      slug: 'SLUG',
      clientId: 'CLIENT',
      privateKey: 'KEY',
      clientSecret: 'SECRET',
    });
    assert(
      app.privateKey !== sdkApp.privateKey &&
        app.clientId !== sdkApp.clientId &&
        app.clientSecret !== sdkApp.clientSecret,
      'Apps share credentials',
    );

    const installation = await gh.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/demo'],
    });
    const cliInstallation = await cli([
      'installations',
      'create',
      '--app-id',
      sdkApp.id,
      '--account',
      'igor',
      '--repositories',
      '["igor/demo"]',
    ]);

    assert(cliInstallation.code === 0, 'CLI installation creation failed');
    parity('installations.create', 'result', {
      ...installation,
      id: 'ID',
      appId: 'APP',
    }, { ...JSON.parse(cliInstallation.stdout), id: 'ID', appId: 'APP' });

    const grant = await store.transaction(async (tx) =>
      grantSchema.parse(await tx.get('grants', installation.id))
    );

    assert(
      grant.repositoryIds.length === 1 &&
        grant.installationId === installation.id,
      'Missing installation grant',
    );

    for (const suspended of [true, false]) {
      const operation = suspended ? 'suspend' : 'unsuspend';
      const result = await cli(['installations', operation, installation.id]);

      assert(result.code === 0, 'CLI suspension command failed');

      const sdk = await gh.installations[operation]({ id: installation.id });

      parity(operation, 'result', JSON.parse(result.stdout), sdk);

      const read = await store.transaction(async (tx) =>
        installationSchema.parse(await tx.get('installations', installation.id))
      );

      parity(operation, 'persisted state', read, {
        ...installation,
        suspended,
      });
    }

    for (
      const operation of [
        {
          args: ['apps', 'create', '--slug', 'review-bot'],
          sdk: () => gh.apps.create({ slug: 'review-bot' }),
        },
        {
          args: ['installations', 'suspend', 'bad'],
          sdk: () => gh.installations.suspend({ id: 'bad' }),
        },
        {
          args: ['installations', 'unsuspend', '999'],
          sdk: () => gh.installations.unsuspend({ id: '999' }),
        },
        {
          args: [
            'installations',
            'create',
            '--app-id',
            app.id,
            '--account',
            'other',
            '--repositories',
            '["igor/demo"]',
          ],
          sdk: () =>
            gh.installations.create({
              appId: app.id,
              account: 'other',
              repositories: ['igor/demo'],
            }),
        },
        {
          args: [
            'installations',
            'create',
            '--app-id',
            app.id,
            '--account',
            'igor',
            '--repositories',
            '["igor/demo"]',
          ],
          sdk: () =>
            gh.installations.create({
              appId: app.id,
              account: 'igor',
              repositories: ['igor/demo'],
            }),
        },
      ]
    ) {
      const before = await snapshot();
      const failed = await cli(operation.args);

      assert(
        failed.code === 1 && !failed.stdout,
        'CLI accepted invalid mutation',
      );

      let sdkError;

      try {
        await operation.sdk();
      } catch (error) {
        assert(error instanceof CommandError, 'Unexpected SDK error');

        sdkError = error.toJSON();
      }

      assert(sdkError, 'SDK accepted invalid mutation');
      parity(
        operation.args.join(' '),
        'error',
        JSON.parse(failed.stderr).error,
        sdkError,
      );
      parity('rejection', 'state', await snapshot(), before);
    }

    assert(
      setups === 1 && (await snapshot()).events.length === 0,
      'Commands restarted plugin or published unsupported events',
    );
    parity(
      'connection',
      'endpoints',
      env.endpoints.github,
      host.identity.endpoints.github,
    );

    for (const endpoint of Object.values(env.endpoints.github)) {
      const response = await fetch(endpoint + '/unsupported');

      assert(response.status === 404, 'Unknown route did not return 404');
      parity('unsupported route', 'body', await response.json(), {
        message: 'Not Found',
      });
    }

    const status = await runProjectCLI(
      ['status', '--json'],
      undefined,
      directory,
    );

    assert(
      !status.stdout.includes(app.privateKey) &&
        !status.stdout.includes(app.clientId),
      'Status leaked app credentials',
    );
    await env.reset();

    const after = await snapshot();

    assert(
      !after.apps.length && !after.installations.length && !after.grants.length,
      'Reset retained generated state',
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("parallel GitHub environments and instances cannot see each other's state", async () => {
  const registration = github(options);
  await using left = await Emulon.start({
    services: { github: registration, other: registration },
  });
  await using right = await Emulon.start({
    services: { github: registration },
  });
  const app = await left.services.github.apps.create({ slug: 'review-bot' });

  for (const service of [left.services.other, right.services.github]) {
    let refused = false;

    try {
      await service.installations.create({
        appId: app.id,
        account: 'igor',
        repositories: ['igor/demo'],
      });
    } catch {
      refused = true;
    }

    assert(refused, 'Another instance accepted the app');

    const own = await service.apps.create({ slug: 'review-bot' });

    assert(
      own.id !== app.id && own.privateKey !== app.privateKey,
      'Shared app identity',
    );
  }

  const endpoints = [
    ...Object.values(left.endpoints.github),
    ...Object.values(left.endpoints.other),
    ...Object.values(right.endpoints.github),
  ];

  assert(new Set(endpoints).size === 6, 'Instances share listeners');
});
