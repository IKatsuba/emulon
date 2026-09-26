// Polar request fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import polar from '@emulon/polar';
import { Emulon } from 'emulon';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { fixtures } from '../src/model/customers.ts';
import { assert, equal, rejects } from './assert.ts';

const portal = '/v1/customer-portal/license-keys';
const message =
  'Invalid organization ID: expected a version 4 UUID (RFC 4122 variant).';
const unusable = [
  // Version digit 4 outside the RFC 4122 variant.
  '00000000-0000-4000-0000-000000000000',
  // Version 1.
  'c232ab00-9414-11ec-b3c8-9e6bdeced846',
  '00000000-0000-0000-0000-000000000000',
  '3fbd6d0a2c574f068f024b1a2f2a9d11',
  'not-a-uuid',
];

Deno.test('Polar organizationId accepts only a version 4 UUID', async () => {
  for (const organizationId of unusable) {
    let thrown: unknown;

    try {
      polar({ organizationId });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof Error, organizationId);
    equal(thrown.message, message);
    await rejects(() => Promise.resolve(fixtures({ organizationId })));
  }

  const upper = '3FBD6D0A-2C57-4F06-8F02-4B1A2F2A9D11';

  equal(fixtures({ organizationId: upper })[0]?.value, {
    id: upper.toLowerCase(),
  });
  assert(
    typeof (fixtures()[0]?.value as { id: string }).id === 'string',
    'No generated organization',
  );
});

Deno.test('Polar CLI refuses an unusable organizationId at configuration', async () => {
  const directory = await Deno.makeTempDir();
  const plugin = new URL('../src/mod.ts', import.meta.url).href;

  try {
    for (const organizationId of unusable.slice(0, 2)) {
      await Deno.writeTextFile(
        `${directory}/emulon.config.ts`,
        `import polar from '${plugin}';\n` +
          `export default { services: { billing: polar({ organizationId: '${organizationId}' }) } };\n`,
      );

      const up = await runProjectCLI(['up', '--json'], undefined, directory);

      equal(up.code, 1);
      equal(JSON.parse(up.stderr).error.code, 'CONFIG_IMPORT_FAILED');
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('Polar public license cycle accepts a fixed version 4 organization', async () => {
  const organizationId = '3FBD6D0A-2C57-4F06-8F02-4B1A2F2A9D11';
  const customerId = '0d4c9a52-7f5e-4f7d-9a38-1f4ce6f5a0b1';

  await using env = await Emulon.start({
    services: {
      billing: polar({
        organizationId,
        fixtures: {
          customers: [{ id: customerId, email: 'ada@example.test' }],
        },
      }),
    },
  });
  const sdk = env.services.billing;
  const api = env.endpoints.billing.api!;
  const benefit = await sdk.benefits.create({
    description: 'Chorded licence',
    limitActivations: 1,
    enableCustomerAdmin: false,
  });
  const granted = await sdk.licenseKeys.grant({
    benefitId: benefit.id,
    customerId,
  });

  equal(granted.organization_id, organizationId.toLowerCase());

  const post = async (operation: string, body: unknown) => {
    const response = await fetch(`${api}${portal}/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return { status: response.status, text: await response.text() };
  };

  const request = { key: granted.key, organization_id: organizationId };
  const activated = await post('activate', { ...request, label: 'studio' });

  equal(activated.status, 200);

  const activation = JSON.parse(activated.text);
  const bound = { ...request, activation_id: activation.id };
  const validated = await post('validate', bound);

  equal(validated.status, 200);
  equal(JSON.parse(validated.text).validations, 1);
  equal((await post('deactivate', bound)).status, 204);
  equal(
    await post('validate', bound),
    {
      status: 404,
      text: JSON.stringify({ error: 'ResourceNotFound', detail: 'Not found' }),
    },
  );
});
