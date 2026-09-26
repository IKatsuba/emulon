import polar from '@emulon/polar';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import type {
  Benefit,
  Inspection,
  LicenseKey,
  LicenseKeyWithActivations,
} from '../src/model/license_keys.ts';
import { properties, readExcerpt, validate } from './schema.ts';
import { organizationId } from './customers_cases.ts';
import { assert, equal } from './assert.ts';

const customerId = '0d4c9a52-7f5e-4f7d-9a38-1f4ce6f5a0b1';
const otherCustomerId = '6f0f0f86-3d2b-4d5e-8f8a-2a1b9c3d4e5f';
const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Everything the host prints while the case runs, to prove the key never appears. */
function captureConsole() {
  const lines: string[] = [];
  const original = methods.map((method) => [method, console[method]] as const);

  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };
  }

  return {
    lines,
    restore() {
      for (const [method, fn] of original) {
        console[method] = fn;
      }
    },
  };
}

async function failure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return (error as { toJSON(): unknown }).toJSON();
  }

  throw new Error('Expected a command failure');
}

Deno.test(
  'Polar license key management shares one state across CLI, started and connected SDK, redacts the key and survives restart but not reset',
  async () => {
    const document = await readExcerpt('license-keys');
    const directory = await Deno.makeTempDir();
    const config = {
      services: {
        billing: polar({
          organizationId,
          fixtures: {
            customers: [{ id: customerId, email: 'ada@example.test' }],
          },
        }),
        other: polar({
          fixtures: {
            customers: [{ id: otherCustomerId, email: 'bob@example.test' }],
          },
        }),
      },
    };
    const output = captureConsole();
    let host = await serveEnvironment(config, { directory });
    const run = (args: string[]) =>
      runProjectCLI([...args, '--json'], undefined, directory);
    const cli = async (args: string[]) => {
      const result = await run(['billing', ...args]);

      assert(result.code === 0, result.stderr);

      return JSON.parse(result.stdout);
    };

    const cliError = async (args: string[]) => {
      const result = await run(args);

      assert(result.code === 1, 'Expected a CLI failure');
      equal(result.stdout, '');

      return { stderr: result.stderr, error: JSON.parse(result.stderr).error };
    };

    const secrets: string[] = [];
    const visible: unknown[] = [];

    try {
      await using connected = await Emulon.connect({ config, directory });
      const sdk = connected.services.billing;

      // The acceptance flow on the CLI, compared with the connected SDK.
      const benefit: Benefit = await cli([
        'benefits',
        'create',
        '--description',
        'Chorded Pro',
        '--prefix',
        'chd',
        '--limit-activations',
        '3',
        '--enable-customer-admin',
        '--ttl',
        '1',
        '--timeframe',
        'year',
      ]);

      equal(benefit.properties, {
        prefix: 'chd',
        expires: { ttl: 1, timeframe: 'year' },
        activations: { limit: 3, enable_customer_admin: true },
        limit_usage: null,
      });
      equal(benefit.organization_id, organizationId);
      equal(
        validate(document, '#/components/schemas/BenefitLicenseKeys', benefit),
        [],
      );

      const granted: LicenseKey = await cli([
        'license-keys',
        'grant',
        '--benefit-id',
        benefit.id,
        '--customer-id',
        customerId,
      ]);

      secrets.push(granted.key);
      assert(/^CHD-[0-9A-F-]{36}$/.test(granted.key), 'Unexpected key format');
      equal(granted.display_key, `****-${granted.key.slice(-6)}`);
      equal(
        [granted.status, granted.limit_activations, granted.usage],
        ['granted', 3, 0],
      );
      equal(granted.customer, await sdk.customers.get({ id: customerId }));
      equal(
        validate(document, '#/components/schemas/LicenseKeyRead', granted),
        [],
      );

      const fromSDK = await sdk.licenseKeys.grant({
        benefitId: benefit.id,
        customerId,
      });

      secrets.push(fromSDK.key);
      assert(fromSDK.key !== granted.key, 'A key was reused');

      const list: LicenseKey[] = await cli(['license-keys', 'list']);

      equal(list, [granted, fromSDK]);
      equal(await sdk.licenseKeys.list({}), list);

      const read: LicenseKeyWithActivations = await cli([
        'license-keys',
        'get',
        '--id',
        granted.id,
      ]);

      equal(read, { ...granted, activations: [] });
      equal(await sdk.licenseKeys.get({ id: granted.id }), read);
      equal(
        Object.keys(read).sort(),
        properties(document, 'LicenseKeyWithActivations').sort(),
      );
      equal(
        validate(
          document,
          '#/components/schemas/LicenseKeyWithActivations',
          read,
        ),
        [],
      );

      const revoked: LicenseKey = await cli([
        'license-keys',
        'update',
        '--id',
        granted.id,
        '--status',
        'revoked',
      ]);

      equal(revoked.status, 'revoked');
      equal(revoked.key, granted.key);

      const regranted = await sdk.licenseKeys.update({
        id: granted.id,
        status: 'granted',
      });

      equal(regranted, {
        ...revoked,
        status: 'granted',
        modified_at: regranted.modified_at,
      });
      equal(await cli(['license-keys', 'get', '--id', granted.id]), {
        ...regranted,
        activations: [],
      });

      const inspected: Inspection = await cli([
        'license-keys',
        'inspect',
        '--id',
        granted.id,
      ]);
      const { key: _key, ...withoutKey } = regranted;

      equal(inspected, {
        ...withoutKey,
        customer: undefined,
        activation_ids: [],
      });
      equal(await sdk.licenseKeys.inspect({ id: granted.id }), inspected);
      visible.push(inspected);

      // Management failures are identical on both paths and carry no key.
      for (
        const [args, call, code] of [
          [
            [
              'license-keys',
              'grant',
              '--benefit-id',
              benefit.id,
              '--customer-id',
              crypto.randomUUID(),
            ],
            () =>
              sdk.licenseKeys.grant({
                benefitId: benefit.id,
                customerId: crypto.randomUUID(),
              }),
            'ResourceNotFound',
          ],
          [
            [
              'license-keys',
              'grant',
              '--benefit-id',
              crypto.randomUUID(),
              '--customer-id',
              customerId,
            ],
            () =>
              sdk.licenseKeys.grant({
                benefitId: crypto.randomUUID(),
                customerId,
              }),
            'ResourceNotFound',
          ],
          // Another organization's customer is unknown here.
          [
            [
              'license-keys',
              'grant',
              '--benefit-id',
              benefit.id,
              '--customer-id',
              otherCustomerId,
            ],
            () =>
              sdk.licenseKeys.grant({
                benefitId: benefit.id,
                customerId: otherCustomerId,
              }),
            'ResourceNotFound',
          ],
          [
            [
              'license-keys',
              'deactivate',
              '--id',
              granted.id,
              '--activation-id',
              granted.id,
            ],
            () =>
              sdk.licenseKeys.deactivate({
                id: granted.id,
                activationId: granted.id,
              }),
            'ResourceNotFound',
          ],
          // A key supplied where an ID belongs is not echoed back.
          [
            ['license-keys', 'get', '--id', granted.key],
            () => sdk.licenseKeys.get({ id: granted.key }),
            'ResourceNotFound',
          ],
          [
            [
              'license-keys',
              'update',
              '--id',
              granted.id,
              '--status',
              'pending',
            ],
            () =>
              sdk.licenseKeys.update({
                id: granted.id,
                status: 'pending' as 'granted',
              }),
            'VALIDATION_ERROR',
          ],
          [
            [
              'benefits',
              'create',
              '--description',
              'Chorded Pro',
              '--limit-activations',
              '3',
            ],
            () =>
              sdk.benefits.create({
                description: 'Chorded Pro',
                limitActivations: 3,
              }),
            'VALIDATION_ERROR',
          ],
        ] as const
      ) {
        const fromCLI = await cliError(['billing', ...args]);
        const fromConnected = await failure(call);

        equal(fromCLI.error.code, code);
        // IDs are random per call, so compare the shape of each failure.
        equal(
          { ...fromCLI.error, message: undefined },
          { ...(fromConnected as object), message: undefined },
        );
        equal(
          fromCLI.error.message,
          (fromConnected as { message: string }).message,
        );
        visible.push(fromCLI.stderr, fromConnected);
      }

      // Caller-supplied key material is refused without being echoed.
      visible.push(
        (await cliError([
          'billing',
          'license-keys',
          'grant',
          '--benefit-id',
          benefit.id,
          '--customer-id',
          customerId,
          '--key',
          granted.key,
        ])).stderr,
        await failure(() =>
          sdk.licenseKeys.grant({
            benefitId: benefit.id,
            customerId,
            key: granted.key,
          } as never)
        ),
      );

      // The other organization sees none of this organization's records.
      equal(await connected.services.other.licenseKeys.list({}), []);
      equal(
        (await failure(() =>
          connected.services.other.licenseKeys.get({ id: granted.id })
        ) as { code: string }).code,
        'ResourceNotFound',
      );
      equal(
        (await failure(() =>
          connected.services.other.licenseKeys.grant({
            benefitId: benefit.id,
            customerId: otherCustomerId,
          })
        ) as { code: string }).code,
        'ResourceNotFound',
      );

      // A started environment runs the same commands with its own state.
      {
        await using started = await Emulon.start({
          services: {
            billing: polar({
              fixtures: {
                customers: [{ id: customerId, email: 'ada@example.test' }],
              },
            }),
          },
        });
        const local = started.services.billing;
        const ownBenefit = await local.benefits.create({
          description: 'Chorded Pro',
          limitActivations: 3,
          enableCustomerAdmin: true,
        });
        const own = await local.licenseKeys.grant({
          benefitId: ownBenefit.id,
          customerId,
        });

        secrets.push(own.key);
        equal(Object.keys(ownBenefit), Object.keys(benefit));
        equal(Object.keys(own), Object.keys(granted));
        equal(await local.licenseKeys.list({}), [own]);
        equal(
          Object.keys(await local.licenseKeys.get({ id: own.id })),
          Object.keys(read),
        );
        equal(
          Object.keys(await local.licenseKeys.inspect({ id: own.id })),
          Object.keys(inspected),
        );
        // Another environment's key is unknown, with the same failure.
        equal(
          await failure(() => local.licenseKeys.get({ id: granted.id })),
          await failure(() => sdk.licenseKeys.get({ id: crypto.randomUUID() })),
        );
      }

      // Generic status and the event log never include a key or a grant event.
      const status = await run(['status']);
      const events = await connected.events.list();

      assert(
        events.every((event) => !event.type.startsWith('benefit_grant')),
        'A benefit_grant event was published',
      );
      visible.push(
        status.stdout,
        status.stderr,
        events,
        await sdk.webhooks.list({}),
      );

      // Restart keeps benefits, keys and customer links.
      await host.dispose();

      host = await serveEnvironment(config, { directory });

      await using restarted = await Emulon.connect({ config, directory });

      equal(
        await restarted.services.billing.licenseKeys.get({ id: granted.id }),
        await cli(['license-keys', 'get', '--id', granted.id]),
      );
      equal(
        (await restarted.services.billing.licenseKeys.list({})).length,
        2,
      );

      // Reset restores fixtures only: keys and benefits are gone.
      await restarted.reset();
      equal(await restarted.services.billing.licenseKeys.list({}), []);
      equal(
        (await failure(() =>
          restarted.services.billing.licenseKeys.get({ id: granted.id })
        ) as { code: string }).code,
        'ResourceNotFound',
      );
      equal(
        (await failure(() =>
          restarted.services.billing.licenseKeys.grant({
            benefitId: benefit.id,
            customerId,
          })
        ) as { code: string }).code,
        'ResourceNotFound',
      );
      equal(
        (await restarted.services.billing.customers.get({ id: customerId })).id,
        customerId,
      );
    } finally {
      await host.dispose();
      output.restore();
      await Deno.remove(directory, { recursive: true });
    }

    const boundary = JSON.stringify([visible, output.lines]);

    for (const secret of secrets) {
      assert(!boundary.includes(secret), 'A key reached a redacted boundary');
      assert(
        !boundary.includes(secret.slice(-12)),
        'Key material reached a redacted boundary',
      );
    }
  },
);
