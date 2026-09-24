import {
  type CompatibilityManifest,
  defineCompatibility,
  definePlugin,
  Emulon,
} from 'emulon';
import { compatibility as githubManifest } from '../../github/src/compatibility.ts';
import { compatibility as resendManifest } from '../../resend/src/compatibility.ts';
import github from '../../github/src/mod.ts';
import resend from '../../resend/src/mod.ts';
import { readRegistration } from '../src/plugins/define.ts';
import { compatibilityCommand } from '../src/plugins/compatibility.ts';
import { runProjectCLI } from '../src/cli/project.ts';
import { serveEnvironment } from '../src/control/server.ts';

const resendSuites = (resendManifest as Extract<
  CompatibilityManifest,
  { schemaVersion: 1 }
>).verification.suites;

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Compatibility mismatch');
  }
}

function rejects(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    if (error.message.includes('secret-canary')) {
      throw new Error('Invalid metadata leaked');
    }

    return;
  }

  throw new Error('Invalid compatibility accepted');
}

Deno.test('compatibility schema rejects incomplete, duplicate and unreferenced claims without leaking rejected data', () => {
  for (const field of Object.keys(resendManifest)) {
    if (field === 'details') {
      continue;
    }

    const incomplete = { ...resendManifest } as Record<string, unknown>;

    delete incomplete[field];
    rejects(() => defineCompatibility(incomplete));
  }

  for (
    const patch of [
      { schemaVersion: 2 },
      { webhooks: { ...resendManifest.webhooks, cases: [] } },
      { capabilities: [...resendManifest.capabilities, 'http'] },
      {
        verification: {
          ...resendManifest.verification,
          suites: [
            ...resendSuites,
            resendSuites[0],
          ],
        },
      },
      {
        verification: {
          ...resendManifest.verification,
          suites: [...resendSuites, {
            path: 'orphan.ts',
            cases: ['orphan'],
          }],
        },
      },
      {
        operations: [
          ...resendManifest.operations,
          resendManifest.operations[0],
        ],
      },
      { operations: [{ ...resendManifest.operations[0], cases: [] }] },
      {
        operations: [{
          ...resendManifest.operations[0],
          cases: ['secret-canary'],
        }],
      },
      { operations: [{ ...resendManifest.operations[0], version: 'unknown' }] },
      { operations: [{ ...resendManifest.operations[0], auth: ['unknown'] }] },
      {
        operations: [{ ...resendManifest.operations[0], events: ['unknown'] }],
      },
      { verification: { ...resendManifest.verification, client: 'resend@^6' } },
      {
        verification: {
          ...resendManifest.verification,
          liveProviderCompared: true,
        },
      },
      { details: { bad: () => 'secret-canary' } },
    ]
  ) {
    rejects(() => defineCompatibility({ ...resendManifest, ...patch }));
  }

  const copy = structuredClone(resendManifest);
  const frozen = defineCompatibility(copy);

  equal(frozen, resendManifest);

  if (
    !Object.isFrozen(frozen.operations[0]!.cases) ||
    !Object.isFrozen(frozen.details)
  ) {
    throw new Error('Mutable metadata');
  }

  equal(defineCompatibility(githubManifest).details, githubManifest.details);
});

Deno.test('plugin manifest validates identity, capabilities and both command collision forms before setup', () => {
  const { definition } = readRegistration(resend());
  const commands = { ...definition.commands };

  delete (commands as Record<string, unknown>)['compatibility.get'];

  for (
    const patch of [
      { name: 'another' },
      { capabilities: [] },
      {
        commands: {
          ...commands,
          'compatibility.get': { ...compatibilityCommand(resendManifest) },
        },
      },
      {
        commands: {
          ...commands,
          collision: { ...compatibilityCommand(resendManifest) },
        },
      },
    ]
  ) {
    rejects(() => definePlugin({ ...definition, commands, ...patch }));
  }

  const plain = { ...definition, commands };

  delete plain.compatibility;
  equal(
    Object.keys(readRegistration(definePlugin(plain)()).definition.commands),
    Object.keys(commands),
  );
});

Deno.test('CLI, started and connected SDK read static host claims across reset, independent of client metadata and secrets', async () => {
  const directory = await Deno.makeTempDir();
  const config = { services: { github: github(), mail: resend() } };

  try {
    await using started = await Emulon.start(config);
    await using _host = await serveEnvironment(config, { directory });
    // A different local declaration must not replace the host's command result.
    const { definition } = readRegistration(resend());
    const remoteMail = definePlugin({
      ...definition,
      compatibility: defineCompatibility({
        ...resendManifest,
        details: { clientOnly: true },
      }),
    });
    await using connected = await Emulon.connect({
      config: { services: { github: github(), mail: remoteMail() } },
      directory,
    });
    const secret = await connected.services.mail.keys.create();
    const app = await connected.services.github.apps.create({
      slug: 'private-options-canary',
    });

    for (
      const [instance, manifest] of [['mail', resendManifest], [
        'github',
        githubManifest,
      ]] as const
    ) {
      equal(await started.services[instance].compatibility.get({}), manifest);
      equal(await connected.services[instance].compatibility.get({}), manifest);

      const cli = await runProjectCLI(
        [instance, 'compatibility', 'get', '--json'],
        undefined,
        directory,
      );

      equal(cli.code, 0);
      equal(JSON.parse(cli.stdout), manifest);

      const pretty = await runProjectCLI(
        [instance, 'compatibility', 'get'],
        undefined,
        directory,
      );

      equal(JSON.parse(pretty.stdout), manifest);

      for (
        const value of [
          secret.apiKey,
          app.clientSecret,
          app.privateKey,
          'private-options-canary',
        ]
      ) {
        if (cli.stdout.includes(value)) {
          throw new Error('Compatibility leaks credentials or options');
        }
      }
    }

    await connected.reset();
    equal(await connected.services.mail.compatibility.get({}), resendManifest);
    equal(
      await connected.services.github.compatibility.get({}),
      githubManifest,
    );
    equal(
      (await runProjectCLI(
        ['unknown', 'compatibility', 'get', '--json'],
        undefined,
        directory,
      )).code,
      1,
    );
    equal(
      (await runProjectCLI(
        ['mail', 'compatibility', 'get', '--unexpected', '--json'],
        undefined,
        directory,
      )).code,
      1,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
