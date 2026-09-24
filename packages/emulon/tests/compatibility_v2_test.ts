import { defineCompatibility, definePlugin, Emulon } from 'emulon';
import { compatibility as calcom } from '../../calcom/src/compatibility.ts';
import { compatibility as github } from '../../github/src/compatibility.ts';
import { compatibility as polar } from '../../polar/src/compatibility.ts';
import { compatibility as resend } from '../../resend/src/compatibility.ts';
import { compatibility as stripe } from '../../stripe/src/compatibility.ts';
import { runProjectCLI } from '../src/cli/project.ts';
import { serveEnvironment } from '../src/control/server.ts';
import { readRegistration } from '../src/plugins/define.ts';
import versioned, {
  alpha,
  beta,
  compatibility,
  versionedManifest,
} from './fixtures/versioned.ts';
import { verifyCoverage } from './helpers/compatibility.ts';
import { cases as alphaCases } from './versioned_alpha_cases.ts';
import { cases as betaCases } from './versioned_beta_cases.ts';

type Raw = Record<string, unknown>;

function equal(actual: unknown, expected: unknown, label = 'value') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Mismatch (${label}): ${JSON.stringify(actual)} !== ${
        JSON.stringify(expected)
      }`,
    );
  }
}

function rejection(value: unknown): string {
  try {
    defineCompatibility(value);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    if (error.message.includes('secret-canary')) {
      throw new Error('Invalid metadata leaked');
    }

    return error.message;
  }

  throw new Error('Invalid compatibility accepted');
}

function variant(change: (manifest: Raw) => void): Raw {
  const copy = structuredClone(versionedManifest) as unknown as Raw;

  change(copy);

  return copy;
}

const cases = [...alphaCases, ...betaCases];

verifyCoverage(compatibility, cases);

for (const test of cases) {
  Deno.test(`${test.id}: ${test.name}`, test.run);
}

Deno.test('existing version-1 manifests remain valid unchanged', () => {
  for (const manifest of [calcom, github, polar, resend, stripe]) {
    equal(manifest.schemaVersion, 1, manifest.plugin);
    equal(defineCompatibility(structuredClone(manifest)), manifest);
  }
});

Deno.test('version-2 manifest keys claims by (id, version) and verifies each version', () => {
  equal(compatibility, versionedManifest);
  equal(compatibility.versions.map((entry) => entry.id), [alpha, beta]);
  equal(
    compatibility.schemaVersion === 2 &&
      compatibility.verification.byVersion.map((entry) => [
        entry.version,
        entry.client,
      ]),
    [[alpha, 'versioned@1.0.0'], [beta, 'versioned@2.0.0']],
  );

  if (!Object.isFrozen(compatibility.operations[1]!.cases)) {
    throw new Error('Mutable metadata');
  }
});

Deno.test('version-2 validation names the broken claim without echoing values', () => {
  for (
    const [change, message] of [
      [
        (m: Raw) => (m.operations as unknown[]).pop(),
        'versions[1]: Version does not cover the complete operations slice.',
      ],
      [
        (m: Raw) => (m.webhooks as unknown[]).pop(),
        'versions[1]: Version does not cover the complete webhooks slice.',
      ],
      [
        (m: Raw) => ((m.verification as Raw).byVersion as unknown[]).pop(),
        'versions[1]: Version has no verification record.',
      ],
      [
        (m: Raw) => {
          (m.operations as Raw[])[0]!.cases = ['secret-canary'];
        },
        'operations[0].cases[0]: Case reference is not an executed case of its version.',
      ],
      [
        (m: Raw) => {
          // A case executed only by the beta suite cannot verify an alpha claim.
          (m.events as Raw[])[0]!.cases = ['beta.items.1'];
        },
        'events[0].cases[0]: Case reference is not an executed case of its version.',
      ],
      [
        (m: Raw) => {
          const operations = m.operations as Raw[];

          operations.push({ ...operations[1]! });
        },
        'operations[2]: Duplicate operations (id, version) claim.',
      ],
      [
        (m: Raw) => {
          const events = m.events as Raw[];

          events.push({ ...events[0]! });
        },
        'events[2]: Duplicate events (id, version) claim.',
      ],
      [
        (m: Raw) => {
          (m.webhooks as Raw[])[1]!.version = alpha;
        },
        'webhooks[1]: Duplicate webhook version.',
      ],
      [
        (m: Raw) => {
          (m.events as Raw[])[1]!.version = '2027-01-01.gamma';
        },
        'events[1].version: Unknown version policy.',
      ],
      [
        (m: Raw) => {
          (m.operations as Raw[])[1]!.version = '2027-01-01.gamma';
        },
        'operations[1].version: Unknown version policy.',
      ],
      [
        (m: Raw) => {
          ((m.verification as Raw).byVersion as Raw[])[1]!.client =
            'versioned@^2';
        },
        'verification.byVersion[1].client: Official client requires an exact version pin.',
      ],
      [
        (m: Raw) => {
          ((m.verification as Raw).byVersion as Raw[])[1]!
            .liveProviderCompared = true;
        },
        'verification.byVersion[1].liveProviderCompared: Invalid value (invalid_value).',
      ],
      [
        (m: Raw) => {
          const byVersion = (m.verification as Raw).byVersion as Raw[];

          byVersion[1]!.suites = [{
            path: 'packages/emulon/tests/versioned_beta_cases.ts',
            cases: ['beta.items.1', 'beta.webhooks.1', 'beta.orphan'],
          }];
        },
        'verification.byVersion[1].suites[0].cases[2]: Suite case is not referenced by any claim of its version.',
      ],
      [
        (m: Raw) => {
          (m.operations as Raw[])[0]!.events = ['item.deleted'];
        },
        'operations[0].events[0]: Unknown event for the operation version.',
      ],
      [
        (m: Raw) => {
          (m.verification as Raw).client = 'secret-canary';
        },
        'verification: Unknown field.',
      ],
      [
        (m: Raw) => {
          m.webhooks = (m.webhooks as Raw[])[0];
        },
        'webhooks: Invalid value (invalid_type).',
      ],
    ] as const
  ) {
    const actual = rejection(variant(change));

    if (!actual.includes(message)) {
      throw new Error(`Expected "${message}" in "${actual}"`);
    }
  }
});

Deno.test('version-2 coverage rejects an untested claim that reuses a case of another version', () => {
  const mutant = structuredClone(compatibility);

  if (mutant.schemaVersion !== 2) {
    throw new Error('Expected version 2');
  }

  // No case exercises items.delete, even though the reused alpha case is real.
  const operations = [...mutant.operations, {
    ...mutant.operations[0]!,
    id: 'items.delete',
  }];
  let rejected = false;

  try {
    verifyCoverage({ ...mutant, operations }, cases);
  } catch {
    rejected = true;
  }

  if (!rejected) {
    throw new Error('Untested operation accepted');
  }
});

Deno.test('CLI, started and connected SDK return the same version-2 host manifest', async () => {
  const directory = await Deno.makeTempDir();
  const config = { services: { versioned: versioned() } };

  try {
    await using started = await Emulon.start(config);
    await using _host = await serveEnvironment(config, { directory });
    const { definition } = readRegistration(versioned());
    const local = definePlugin({
      ...definition,
      compatibility: defineCompatibility({
        ...versionedManifest,
        details: { clientOnly: true },
      }),
    });
    await using connected = await Emulon.connect({
      config: { services: { versioned: local() } },
      directory,
    });
    const cli = await runProjectCLI(
      ['versioned', 'compatibility', 'get', '--json'],
      undefined,
      directory,
    );

    equal(cli.code, 0, 'CLI exit');
    equal(JSON.parse(cli.stdout), compatibility, 'CLI');
    equal(
      await started.services.versioned.compatibility.get({}),
      compatibility,
      'started',
    );
    equal(
      await connected.services.versioned.compatibility.get({}),
      compatibility,
      'connected',
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
