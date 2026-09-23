import polar from '@emulon/polar';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { compatibility } from '../src/compatibility.ts';
import type { Customer } from '../src/model/customers.ts';
import { client, organizationId } from './customers_cases.ts';
import { assert, equal } from './assert.ts';

export const { cases, register } = caseRegistry(
  'packages/polar/tests/parity_cases.ts',
);

const secret = 'whsec_parity_секрет';

type OfficialCustomer = Awaited<
  ReturnType<ReturnType<typeof client>['customers']['get']>
>;

/**
 * The official client returns camelCase properties and `Date` objects, and
 * 0.49.0 drops `first_user_event_at`, which the pinned schema still requires.
 * Normalizing here, field by field, keeps that conversion explicit instead of
 * hiding it behind a loose comparison.
 */
function normalize(customer: OfficialCustomer): Record<string, unknown> {
  assert(customer.type === 'individual', 'The client parsed a team customer');

  return {
    id: customer.id,
    created_at: customer.createdAt.toISOString(),
    modified_at: customer.modifiedAt?.toISOString() ?? null,
    metadata: customer.metadata,
    external_id: customer.externalId ?? null,
    email: customer.email,
    email_verified: customer.emailVerified,
    type: customer.type,
    name: customer.name,
    billing_name: customer.billingName,
    billing_address: customer.billingAddress,
    tax_id: customer.taxId,
    locale: customer.locale ?? null,
    organization_id: customer.organizationId,
    default_payment_method_id: customer.defaultPaymentMethodId ?? null,
    deleted_at: customer.deletedAt?.toISOString() ?? null,
    avatar_url: customer.avatarUrl,
  };
}

function withoutDropped(customer: Customer): Record<string, unknown> {
  const { first_user_event_at: dropped, ...rest } = customer;

  equal(dropped, null);

  return rest;
}

/**
 * One manifest and one state behind every caller path, with the official
 * client's conversions written out and no credential on any boundary.
 */
async function parityContract() {
  const directory = await Deno.makeTempDir();
  const received: string[] = [];
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      received.push(await request.text());

      return new Response(null, { status: 204 });
    },
  );
  const config = {
    services: {
      billing: polar({
        organizationId,
        destinations: [{
          id: 'receiver',
          url: `http://127.0.0.1:${receiver.addr.port}`,
          secret,
          types: ['customer.created'],
          enabled: true,
        }],
      }),
    },
  };
  const host = await serveEnvironment(config, { directory });
  const cli = async (args: string[]) => {
    const result = await runProjectCLI(
      ['billing', ...args, '--json'],
      undefined,
      directory,
    );

    assert(result.code === 0, result.stderr);

    return JSON.parse(result.stdout);
  };

  const cliError = async (args: string[]) => {
    const result = await runProjectCLI(
      ['billing', ...args, '--json'],
      undefined,
      directory,
    );

    assert(result.code === 1, 'Expected a CLI failure');
    equal(result.stdout, '');

    return JSON.parse(result.stderr).error;
  };

  try {
    await using connected = await Emulon.connect({ config, directory });
    await using started = await Emulon.start({
      services: { billing: polar() },
    });

    // The manifest is one object: source, CLI, started SDK and connected SDK.
    const manifest = await cli(['compatibility', 'get']);

    equal(manifest, compatibility);
    equal(await connected.services.billing.compatibility.get({}), manifest);
    equal(await started.services.billing.compatibility.get({}), manifest);

    // Every declared case is a case this suite executes, and every executed
    // suite path exists, so the manifest advertises nothing unverified.
    for (const suite of compatibility.verification.suites) {
      assert(
        (await Deno.stat(new URL(`../../../${suite.path}`, import.meta.url)))
          .isFile,
        `Declared suite is missing: ${suite.path}`,
      );
    }

    const { apiKey } = await cli(['keys', 'create']);
    const wire: Customer = await cli([
      'customers',
      'create',
      '--email',
      'parity@example.test',
      '--name',
      'Ада 🐻',
      '--external-id',
      'usr_parity',
    ]);
    const official = client(connected.endpoints.billing.api!, apiKey);
    const read = await official.customers.get({ id: wire.id });

    assert(
      !('firstUserEventAt' in read),
      'The pinned client started returning first_user_event_at',
    );
    equal(normalize(read), withoutDropped(wire));

    const fromOfficial = await official.customers.create({
      email: 'official-parity@example.test',
    });
    const fromCLI = await cli(['customers', 'get', '--id', fromOfficial.id]);

    equal(normalize(fromOfficial), withoutDropped(fromCLI));
    equal(
      await connected.services.billing.customers.get({ id: fromOfficial.id }),
      fromCLI,
    );

    // The same input fails identically on both management paths.
    const missing = crypto.randomUUID();
    const failure = await cliError(['customers', 'get', '--id', missing]);
    let caught: unknown;

    try {
      await connected.services.billing.customers.get({ id: missing });
    } catch (error) {
      caught = (error as { toJSON(): unknown }).toJSON();
    }

    equal(caught, failure);

    const duplicate = await cliError([
      'customers',
      'create',
      '--email',
      'parity@example.test',
    ]);

    try {
      await connected.services.billing.customers.create({
        email: 'parity@example.test',
      });

      throw new Error('The duplicate was accepted');
    } catch (error) {
      equal((error as { toJSON(): unknown }).toJSON(), duplicate);
    }

    // Both customers were delivered and verified by the receiver.
    for (const delivery of await cli(['webhooks', 'list'])) {
      await cli([
        'webhooks',
        'wait',
        delivery.id,
        '--status',
        'succeeded',
        '--timeout',
        '10s',
      ]);
    }

    equal(received.length, 2);
    equal(
      received.map((body) => JSON.parse(body).data.email).sort(),
      ['official-parity@example.test', 'parity@example.test'],
    );

    const deliveries = await cli(['webhooks', 'list']);
    const inspected = await cli(['webhooks', 'inspect', deliveries[0].id]);

    equal(await connected.services.billing.webhooks.list({}), deliveries);
    equal(
      await connected.services.billing.webhooks.inspect({
        id: deliveries[0].id,
      }),
      inspected,
    );
    equal(
      await connected.services.billing.webhooks.destinations({}),
      await cli(['webhooks', 'destinations']),
    );

    const events = JSON.parse(
      (await runProjectCLI(
        ['events', '--type', 'customer.created', '--json'],
        undefined,
        directory,
      )).stdout,
    );

    equal(await connected.events.list({ type: 'customer.created' }), events);

    // Nothing a caller can read carries the issued token or the secret.
    const boundary = JSON.stringify([
      wire,
      fromCLI,
      failure,
      duplicate,
      deliveries,
      inspected,
      await cli(['webhooks', 'destinations']),
      events,
    ]);

    assert(!boundary.includes(apiKey), 'A caller result exposed the token');
    assert(!boundary.includes('polar_oat_'), 'A caller result exposed a token');
    assert(!boundary.includes(secret), 'A caller result exposed the secret');
    assert(!boundary.includes('секрет'), 'A caller result exposed the secret');
    // The manifest names the token prefix as a format, never an issued value.
    assert(
      !JSON.stringify(manifest).includes(apiKey.slice('polar_oat_'.length)),
      'The manifest exposed the token',
    );
  } finally {
    await host.dispose();
    await receiver.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

register(
  'polar.parity.1',
  ['customers.create', 'customers.get'],
  ['customer.created'],
  true,
  'one manifest and one state across CLI, started SDK, connected SDK and the official client',
  parityContract,
);
