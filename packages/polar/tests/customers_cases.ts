import { Polar } from '@polar-sh/sdk';
import polar from '@emulon/polar';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { apiVersion, type Customer } from '../src/model/customers.ts';
import { properties, readExcerpt, validate } from './schema.ts';
import { assert, equal, rejects } from './assert.ts';

const { cases, register } = caseRegistry(
  'packages/polar/tests/customers_cases.ts',
);

export const customerCases = cases;
export const organizationId = '3fbd6d0a-2c57-4f06-8f02-4b1a2f2a9d11';

/**
 * The official client appends `/v1` itself and must never reach the network.
 * It reads the whole environment on construction, which the suite does not
 * grant; an empty environment keeps its own POLAR_* defaults out of the test.
 */
export function client(api: string, apiKey: string) {
  const environment = Deno.env.toObject;

  Deno.env.toObject = () => ({});

  try {
    return new Polar({
      accessToken: apiKey,
      serverURL: api,
      retryConfig: { strategy: 'none' },
    });
  } finally {
    Deno.env.toObject = environment;
  }
}

function expectSchema(
  document: Awaited<ReturnType<typeof readExcerpt>>,
  customer: Customer,
) {
  equal(Object.keys(customer), properties(document, 'CustomerIndividual'));

  for (const schema of ['Customer', 'CustomerIndividual']) {
    equal(validate(document, `#/components/schemas/${schema}`, customer), []);
  }
}

register(
  'polar.customers.1',
  ['customers.create', 'customers.get'],
  ['customer.created'],
  false,
  'CLI, connected SDK, official client and wire projection share one host',
  async () => {
    const document = await readExcerpt();
    const directory = await Deno.makeTempDir();
    const config = { services: { billing: polar({ organizationId }) } };
    let host = await serveEnvironment(config, { directory });
    const cli = async (args: string[]) => {
      const result = await runProjectCLI(
        ['billing', ...args, '--json'],
        undefined,
        directory,
      );

      assert(result.code === 0, result.stderr);

      return JSON.parse(result.stdout);
    };

    try {
      const { apiKey } = await cli(['keys', 'create']);

      assert(apiKey.startsWith('polar_oat_'));

      await using connected = await Emulon.connect({ config, directory });
      const api = connected.endpoints.billing.api!;
      const official = client(api, apiKey);
      const request = async (path: string, init?: RequestInit) => {
        const response = await fetch(api + path, {
          ...init,
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'polar-version': apiVersion,
            ...init?.headers,
          },
        });

        equal(response.headers.get('polar-version'), apiVersion);

        return { status: response.status, body: await response.json() };
      };

      const fromCLI: Customer = await cli([
        'customers',
        'create',
        '--email',
        'cli@example.test',
        '--name',
        'CLI Ада 🐻',
        '--external-id',
        'usr_cli',
      ]);

      expectSchema(document, fromCLI);
      equal(fromCLI.organization_id, organizationId);
      equal(
        await connected.services.billing.customers.get({ id: fromCLI.id }),
        fromCLI,
      );
      equal((await request('/v1/customers/' + fromCLI.id)).body, fromCLI);

      const read = await official.customers.get({ id: fromCLI.id });

      // The official client converts to camelCase and Date; compare explicitly.
      equal(read.id, fromCLI.id);
      equal(read.email, fromCLI.email);
      equal(read.name, fromCLI.name);
      equal(read.externalId, fromCLI.external_id);
      equal(read.organizationId, organizationId);
      equal(read.createdAt.toISOString(), fromCLI.created_at);
      equal(read.type, 'individual');

      const created = await official.customers.create({
        email: 'official@example.test',
        name: 'Official',
        externalId: 'usr_official',
      });
      const wire = await request('/v1/customers/' + created.id);

      equal(wire.status, 200);
      expectSchema(document, wire.body);
      equal(await cli(['customers', 'get', '--id', created.id]), wire.body);
      equal(
        await connected.services.billing.customers.get({ id: created.id }),
        wire.body,
      );

      const fromSDK = await connected.services.billing.customers.create({
        email: 'sdk@example.test',
      });

      expectSchema(document, fromSDK);
      equal(fromSDK.name, null);
      equal(fromSDK.external_id, null);
      equal(await cli(['customers', 'get', '--id', fromSDK.id]), fromSDK);

      const posted = await request('/v1/customers/', {
        method: 'POST',
        body: JSON.stringify({
          email: 'http@example.test',
          name: null,
          external_id: null,
          type: 'individual',
        }),
      });

      equal(posted.status, 201);
      expectSchema(document, posted.body);
      equal(
        await connected.services.billing.customers.get({ id: posted.body.id }),
        posted.body,
      );

      const unslashed = await request('/v1/customers', {
        method: 'POST',
        body: JSON.stringify({ email: 'unslashed@example.test' }),
      });

      equal(unslashed.status, 201);

      const events = await connected.events.list({ type: 'customer.created' });

      equal(events.length, 5);

      for (const event of events) {
        equal(event.origin, 'service');
        equal(
          validate(
            document,
            '#/components/schemas/WebhookCustomerCreatedPayload',
            event.payload,
          ),
          [],
        );

        const payload = event.payload as {
          api_version: string;
          data: Customer;
        };

        equal(payload.api_version, apiVersion);
        equal(payload.data.organization_id, organizationId);
      }

      await host.dispose();

      host = await serveEnvironment(config, { directory });

      await using restarted = await Emulon.connect({ config, directory });

      equal(
        await restarted.services.billing.customers.get({ id: fromCLI.id }),
        fromCLI,
      );
      equal(
        (await restarted.events.list({ type: 'customer.created' })).length,
        5,
      );

      const afterRestart = await client(
        restarted.endpoints.billing.api!,
        apiKey,
      ).customers.get({ id: created.id });

      equal(afterRestart.email, 'official@example.test');
      await restarted.reset();
      await rejects(() =>
        restarted.services.billing.customers.get({ id: fromCLI.id })
      );
      equal(await restarted.events.list(), []);

      const invalidated = await fetch(
        restarted.endpoints.billing.api! + '/v1/customers/' + fromCLI.id,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );

      equal(invalidated.status, 401);
      await invalidated.json();

      const reissued = await restarted.services.billing.keys.create({});
      const reborn = await restarted.services.billing.customers.create({
        email: 'cli@example.test',
        externalId: 'usr_cli',
      });

      assert(reborn.id !== fromCLI.id, 'Reset kept the old customer');
      equal(reborn.organization_id, organizationId);
      equal(
        (await client(restarted.endpoints.billing.api!, reissued.apiKey)
          .customers.get({ id: reborn.id })).email,
        'cli@example.test',
      );
    } finally {
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'polar.customers.2',
  ['customers.create', 'customers.get'],
  ['customer.created'],
  false,
  'authentication, version, strict input, isolation and concurrent uniqueness',
  async () => {
    const document = await readExcerpt();
    const config = {
      services: {
        billing: polar({
          organizationId,
          fixtures: {
            customers: [{ email: 'seed@example.test', externalId: 'usr_seed' }],
          },
        }),
        other: polar(),
      },
    };
    await using env = await Emulon.start(config);
    const api = env.endpoints.billing.api!;
    let apiKey = (await env.services.billing.keys.create({})).apiKey;
    const request = async (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
      key = apiKey,
    ) => {
      const response = await fetch(api + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });

      return {
        status: response.status,
        version: response.headers.get('polar-version'),
        body: await response.json(),
      };
    };

    // Fixtures load without events and keep the organization of the instance.
    equal(await env.events.list(), []);

    let created = 0;
    const noNewEvents = async () => {
      const events = await env.events.list();

      equal(events.length, created);
      equal(
        events.map((event) => event.type),
        Array(created).fill('customer.created'),
      );
    };

    const seeded = await env.services.billing.customers.create({
      email: 'first@example.test',
    });

    created += 1;

    expectSchema(document, seeded);
    equal(seeded.organization_id, organizationId);

    // The official client also reaches a started, in-process environment.
    const official = client(api, apiKey);
    const read = await official.customers.get({ id: seeded.id });

    equal(read.email, seeded.email);
    equal(read.organizationId, organizationId);
    equal(
      (await env.services.billing.customers.get({
        id: (await official.customers.create({ email: 'started@example.test' }))
          .id,
      })).email,
      'started@example.test',
    );

    created += 1;

    await noNewEvents();

    for (
      const credential of [
        '',
        'polar_oat_unknown',
        'polar_at_o_forged',
        'polar_oat_' + '0'.repeat(64),
        (await env.services.other.keys.create({})).apiKey,
      ]
    ) {
      const result = await request(
        '/v1/customers/' + seeded.id,
        undefined,
        {},
        credential,
      );

      equal(result.status, 401);
      equal(result.body.error, 'Unauthorized');
      equal(result.version, null);
      assert(
        !JSON.stringify(result.body).includes('polar_'),
        'Error echoed a credential',
      );
    }

    for (const version of ['', '2026-05', '2025-04', 'current']) {
      const rejected = await request(
        '/v1/customers/',
        { email: 'version@example.test' },
        { 'polar-version': version },
      );

      equal(rejected.status, 404);
      equal(rejected.body.error, 'UnsupportedOperation');
      equal(rejected.version, null);
    }

    await noNewEvents();

    for (
      const body of [
        null,
        [],
        {},
        { email: 'not-an-email' },
        { email: 'a@example.test', organization_id: organizationId },
        { email: 'a@example.test', metadata: { plan: 'pro' } },
        { email: 'a@example.test', type: 'team' },
        { email: 'a@example.test', billing_address: { country: 'FR' } },
        { email: 'a@example.test', tax_id: 'FR61954506077' },
        { email: 'a@example.test', locale: 'fr' },
        { email: 'a@example.test', owner: { email: 'b@example.test' } },
        { email: 'a@example.test', external_id: '' },
        { email: 'a@example.test', name: 'x'.repeat(257) },
        { email: 'a@example.test', id: crypto.randomUUID() },
        { email: 'a@example.test', created_at: '2026-01-01T00:00:00Z' },
      ]
    ) {
      const rejected = await request('/v1/customers/', body);

      equal(rejected.status, 422);
      assert(Array.isArray(rejected.body.detail), 'Missing validation detail');
      assert(
        !JSON.stringify(rejected.body).includes('example.test'),
        'Validation detail echoed input',
      );
    }

    equal((await request('/v1/customers/', '{')).status, 422);

    // A rejected query key is never echoed: the caller may have put a
    // credential there. The selected version still reaches the response.
    for (
      const query of [
        '?organization_id=x',
        '?expand=x&limit=1',
        '?' + encodeURIComponent(apiKey) + '=x',
      ]
    ) {
      const rejected = await request('/v1/customers/' + query, {
        email: 'a@example.test',
      });

      equal(rejected.status, 422);
      equal(rejected.version, apiVersion);
      equal(rejected.body.detail, [{
        loc: ['query'],
        msg: 'Unsupported field',
        type: 'extra_forbidden',
      }]);
      equal(
        (await request('/v1/customers/' + seeded.id + query)).status,
        422,
      );
    }

    assert(
      !JSON.stringify(
        (await request('/v1/customers/?' + encodeURIComponent(apiKey) + '=x'))
          .body,
      ).includes('polar_'),
      'Query error echoed a credential',
    );

    // Every response past authentication carries the selected version.
    for (
      const [path, body] of [
        ['/v1/customers/', { email: 'not-an-email' }],
        ['/v1/customers/', { email: 'seed@example.test' }],
        ['/v1/customers/' + crypto.randomUUID(), undefined],
        ['/v1/products/', undefined],
      ] as const
    ) {
      equal((await request(path, body)).version, apiVersion);
    }

    equal((await request('/v1/customers/not-a-uuid')).status, 422);
    equal(
      (await request('/v1/customers/' + crypto.randomUUID())).body.error,
      'ResourceNotFound',
    );
    equal((await request('/v1/products/')).body.error, 'UnsupportedOperation');
    equal((await request('/v1/customers/' + seeded.id + '/state')).status, 404);
    await noNewEvents();

    // Fixture identities take part in uniqueness without having emitted events.
    for (
      const duplicate of [
        { email: 'seed@example.test' },
        { email: 'other@example.test', external_id: 'usr_seed' },
        { email: 'first@example.test' },
      ]
    ) {
      const rejected = await request('/v1/customers/', duplicate);

      equal(rejected.status, 409);
      equal(rejected.body.error, 'CustomerAlreadyExists');
    }

    await rejects(() =>
      env.services.billing.customers.create({ email: 'seed@example.test' })
    );
    await noNewEvents();

    const emailRace = await Promise.all(
      Array.from(
        { length: 8 },
        () => request('/v1/customers/', { email: 'race@example.test' }),
      ),
    );

    equal(emailRace.filter((result) => result.status === 201).length, 1);

    equal(emailRace.filter((result) => result.status === 409).length, 7);

    const externalRace = await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        request('/v1/customers/', {
          email: `race-${index}@example.test`,
          external_id: 'usr_race',
        })),
    );

    equal(externalRace.filter((result) => result.status === 201).length, 1);
    equal(externalRace.filter((result) => result.status === 409).length, 7);
    equal((await env.events.list()).length, created + 2);

    created += 2;

    // Case-sensitive local uniqueness is a declared limitation.
    equal(
      (await request('/v1/customers/', { email: 'SEED@example.test' })).status,
      201,
    );

    created += 1;

    await noNewEvents();

    const foreign = await env.services.other.customers.create({
      email: 'seed@example.test',
    });

    assert(
      foreign.organization_id !== organizationId,
      'Instances share an organization',
    );
    await rejects(() => env.services.billing.customers.get({ id: foreign.id }));
    equal((await request('/v1/customers/' + foreign.id)).status, 404);
    await env.reset();

    apiKey = (await env.services.billing.keys.create({})).apiKey;

    equal((await request('/v1/customers/' + seeded.id)).status, 404);
    equal(await env.events.list(), []);
    // Reset restores fixtures, so the seeded identity is taken again.
    equal(
      (await request('/v1/customers/', { email: 'seed@example.test' })).status,
      409,
    );
  },
);
