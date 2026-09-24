import Stripe from 'stripe';
import stripe from '@emulon/stripe';
import {
  definePlugin,
  destinationFixture,
  Emulon,
  setDestination,
} from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { CommandError } from '../../emulon/src/commands/registry.ts';
import { memoryAdapter } from '../../emulon/src/state/store.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { dispatchingStore } from '../../emulon/src/deliveries/queue.ts';
import { snapshottingStore } from '../../emulon/src/deliveries/presentation.ts';
import {
  type DeliveryScheduler,
  deliveryWorker,
} from '../../emulon/src/deliveries/worker.ts';
import { createStripe } from '../src/plugin.ts';
import { endpoint } from '../src/commands/webhooks.ts';
import { perform } from '../src/operations.ts';
import { dahlia } from '../src/versions/dahlia/mod.ts';
import {
  configFixture,
  resolveVersions,
  selectVersion,
} from '../src/versions/select.ts';
import type { StripeVersionModule } from '../src/versions/types.ts';
import type { EventInput } from '../src/webhooks/mod.ts';
import {
  presentation,
  subscriptionPolicy,
  transport,
} from '../src/webhooks/mod.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function rejects(
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error('Expected rejection');
}

const DAHLIA = '2026-04-22.dahlia';
/** A second installed version, so selection has something to choose. */
const TEST = '2099-01-01.test';

function marked<T>(value: T): T {
  return { ...value, test_view: true };
}

/**
 * Dahlia under another ID, marking what it projects. It stands in for a second
 * shipped module; the package ships only dahlia.
 */
const test: StripeVersionModule = {
  ...dahlia,
  id: TEST,
  project: async (result, expand, resolve) =>
    marked(await dahlia.project(result, expand, resolve)),
  projectEvent(type, fact) {
    const event = dahlia.projectEvent(type, fact);
    const data = event.data as { object: unknown };

    return {
      ...event,
      api_version: TEST,
      data: { ...data, object: marked(data.object) },
    };
  },
  parseEvent: (type, input) => ({
    ...dahlia.parseEvent(type, { ...input as object, api_version: DAHLIA }),
    apiVersion: TEST,
  }),
};
const modules = new Map([[DAHLIA, dahlia], [TEST, test]]);
const both = createStripe([dahlia, test], DAHLIA);

// deno-lint-ignore no-explicit-any
type Options = any;

function receiver(status = () => 200) {
  const bodies: { url: string; body: string; signature: string }[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      bodies.push({
        url: new URL(request.url).pathname,
        body: await request.text(),
        signature: request.headers.get('stripe-signature')!,
      });

      return new Response(null, { status: status() });
    },
  );

  return {
    bodies,
    url: (path: string) => `http://127.0.0.1:${server.addr.port}${path}`,
    [Symbol.asyncDispose]: () => server.shutdown(),
  };
}

function api(base: string, apiKey: string) {
  return async (
    path: string,
    options: { body?: string; headers?: Record<string, string> } = {},
  ) => {
    const response = await fetch(base + path, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/x-www-form-urlencoded',
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });

    return {
      status: response.status,
      version: response.headers.get('stripe-version'),
      // deno-lint-ignore no-explicit-any
      value: await response.json() as any,
    };
  };
}

Deno.test('Stripe API version options resolve against installed modules', () => {
  const installed = [DAHLIA, TEST];
  const resolve = (options: Options) =>
    resolveVersions(options, installed, DAHLIA);
  const invalid = (options: Options) => {
    try {
      resolve(options);
    } catch {
      return true;
    }

    return false;
  };

  assert(
    JSON.stringify(resolve(undefined)) === JSON.stringify({
      versions: [DAHLIA],
      defaultVersion: DAHLIA,
    }),
  );
  assert(resolve({ defaultApiVersion: DAHLIA }).defaultVersion === DAHLIA);
  assert(resolve({ apiVersions: [TEST, DAHLIA] }).defaultVersion === DAHLIA);
  assert(
    resolve({ apiVersions: [TEST], defaultApiVersion: TEST })
      .defaultVersion === TEST,
  );

  for (
    const options of [
      { apiVersions: [] },
      { apiVersions: ['latest'] },
      { apiVersions: ['2025-03-31.basil'] },
      { apiVersions: [DAHLIA, DAHLIA] },
      { apiVersions: DAHLIA },
      { apiVersions: [TEST] },
      { apiVersions: [DAHLIA], defaultApiVersion: TEST },
      { defaultApiVersion: TEST },
      { defaultApiVersion: 'latest' },
    ]
  ) {
    assert(invalid(options), JSON.stringify(options));
  }

  const config = { versions: [DAHLIA], defaultVersion: DAHLIA };

  assert(selectVersion(undefined, config, modules) === dahlia);
  assert(selectVersion(DAHLIA, config, modules) === dahlia);

  for (
    const header of [TEST, '2025-03-31.basil', '', 'dahlia', 'x'.repeat(9)]
  ) {
    let error: unknown;

    try {
      selectVersion(header, config, modules);
    } catch (e) {
      error = e;
    }

    assert(
      (error as { type?: string })?.type === 'invalid_request_error',
      header,
    );
  }
});

Deno.test('Stripe rejects unknown, disabled, empty and malformed versions before any effect', async () => {
  // TEST is installed but not selected, so it is disabled here.
  await using env = await Emulon.start({ services: { stripe: both() } });
  const { apiKey } = await env.services.stripe.keys.create({});
  const request = api(env.endpoints.stripe.api!, apiKey);

  for (const version of ['2025-03-31.basil', TEST, '', 'not-a-version']) {
    const result = await request('/v1/customers', {
      // An unknown parameter would fail parsing; the version fails first.
      body: 'name=Ada&unknown=x',
      headers: { 'stripe-version': version, 'idempotency-key': 'kept' },
    });

    assert(result.status === 400, `${version}: ${result.status}`);
    assert(result.value.error.type === 'invalid_request_error');
    assert(result.value.error.message.startsWith('Unsupported API version'));
    assert(!JSON.stringify(result.value).includes('not-a-version'));
    assert(result.version === DAHLIA);
    assert(
      (await request('/v1/customers/cus_none', {
        headers: { 'stripe-version': version },
      })).value.error.message.startsWith('Unsupported API version'),
    );
  }

  // Credentials are still checked first.
  const unauthenticated = await api(env.endpoints.stripe.api!, 'sk_test_no')(
    '/v1/customers',
    { body: 'name=Ada', headers: { 'stripe-version': TEST } },
  );

  assert(unauthenticated.status === 401);
  assert(unauthenticated.version === DAHLIA);

  // Nothing happened: no event, and the idempotency key is still unused.
  assert((await env.events.list({})).length === 0);

  const created = await request('/v1/customers', {
    body: 'name=Ada',
    headers: { 'idempotency-key': 'kept' },
  });

  assert(created.status === 200 && created.version === DAHLIA);
  assert((await env.events.list({})).length === 1);

  for (const apiVersion of [TEST, '2025-03-31.basil']) {
    assert(
      await rejects(() =>
        env.services.stripe.customers.get({ id: created.value.id, apiVersion })
      ) instanceof CommandError,
    );
  }

  const view = (await env.events.list({}))[0]!.payload as EventInput;

  assert(
    await rejects(() =>
      env.services.stripe.events.publish({
        type: 'customer.created',
        data: { ...view, api_version: TEST },
      })
    ) instanceof CommandError,
  );
  assert((await env.events.list({})).length === 1);
});

Deno.test('Stripe serves the account default without Stripe-Version and each enabled version exactly', async () => {
  await using env = await Emulon.start({
    services: {
      stripe: both({
        apiVersions: [DAHLIA, TEST],
        defaultApiVersion: TEST,
      } as Options),
    },
  });
  const { apiKey } = await env.services.stripe.keys.create({});
  const request = api(env.endpoints.stripe.api!, apiKey);
  const byDefault = await request('/v1/customers', {
    body: 'name=Ada',
    headers: { 'idempotency-key': 'one' },
  });

  assert(byDefault.status === 200 && byDefault.version === TEST);
  assert(byDefault.value.test_view === true);

  // One state behind every version.
  const read = await request('/v1/customers/' + byDefault.value.id, {
    headers: { 'stripe-version': DAHLIA },
  });

  assert(read.version === DAHLIA && read.value.test_view === undefined);
  assert(read.value.name === 'Ada' && read.value.id === byDefault.value.id);

  const url = new URL(env.endpoints.stripe.api!);
  const official = new Stripe(apiKey, {
    host: url.hostname,
    port: Number(url.port),
    protocol: 'http',
    apiVersion: DAHLIA,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 0,
    telemetry: false,
  });
  const retrieved = await official.customers.retrieve(byDefault.value.id);

  assert(!retrieved.deleted && retrieved.name === 'Ada');

  // A key belongs to its version: another version is a different request.
  const other = await request('/v1/customers', {
    body: 'name=Ada',
    headers: { 'idempotency-key': 'one', 'stripe-version': DAHLIA },
  });

  assert(
    other.status === 400 && other.value.error.type === 'idempotency_error',
  );
  assert(other.version === DAHLIA);

  const replay = await request('/v1/customers', {
    body: 'name=Ada',
    headers: { 'idempotency-key': 'one', 'stripe-version': TEST },
  });

  assert(JSON.stringify(replay.value) === JSON.stringify(byDefault.value));

  const pinned = await request('/v1/customers', {
    body: 'name=Grace',
    headers: { 'stripe-version': DAHLIA },
  });

  // Events are shown in the version of the request that caused them.
  const views = (await env.events.list({})).map((event) =>
    event.payload as { api_version: string; data: { object: { id: string } } }
  );

  assert(views.length === 2);
  assert(
    views[0]!.api_version === TEST &&
      views[0]!.data.object.id === byDefault.value.id,
  );
  assert(
    views[1]!.api_version === DAHLIA &&
      views[1]!.data.object.id === pinned.value.id,
  );

  // Commands show objects in their requested version or the default; the
  // events they cause are viewed in the account default.
  const service = env.services.stripe;

  assert(
    (await service.customers.get({ id: pinned.value.id })).test_view === true,
  );
  assert(
    (await service.customers.get({ id: pinned.value.id, apiVersion: DAHLIA }))
      .test_view === undefined,
  );

  const commanded = await service.customers.create({
    name: 'Linus',
    apiVersion: DAHLIA,
  });

  assert(commanded.test_view === undefined);
  assert(
    ((await env.events.list({})).at(-1)!.payload as { api_version: string })
      .api_version === TEST,
  );
});

Deno.test('Stripe webhook endpoints pin the version of their deliveries', async () => {
  const secret = 'whsec_versions';
  await using sink = receiver();
  await using env = await Emulon.start({
    services: {
      stripe: both({
        apiVersions: [DAHLIA, TEST],
        destinations: [
          {
            id: 'pinned',
            url: sink.url('/pinned'),
            secret,
            types: ['customer.created'],
            enabled: true,
            apiVersion: TEST,
          },
          {
            id: 'plain',
            url: sink.url('/plain'),
            secret,
            types: ['customer.created'],
            enabled: true,
          },
        ],
      } as Options),
    },
  });
  const service = env.services.stripe;
  const listed = await service.webhooks.destinations({});

  assert(
    JSON.stringify(listed.map((d) => [d.id, d.apiVersion])) ===
      JSON.stringify([['pinned', TEST], ['plain', DAHLIA]]),
  );
  assert(!JSON.stringify(listed).includes(secret));
  assert(!JSON.stringify(listed).includes('provider'));

  const { apiKey } = await service.keys.create({});
  const created = await api(env.endpoints.stripe.api!, apiKey)(
    '/v1/customers',
    { body: 'name=Ada', headers: { 'stripe-version': DAHLIA } },
  );

  for (const delivery of await service.webhooks.list({})) {
    await service.webhooks.wait({
      id: delivery.id,
      status: 'succeeded',
      timeout: '5s',
    });
  }

  const verifier = new Stripe('sk_test_unused', { apiVersion: DAHLIA });
  const received = new Map<string, Stripe.Event>();

  for (const { url, body, signature } of sink.bodies) {
    received.set(
      url,
      await verifier.webhooks.constructEventAsync(
        body,
        signature,
        secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      ),
    );
  }

  const pinned = received.get('/pinned')!;
  const plain = received.get('/plain')!;

  // The endpoint's version overrides the request's.
  assert(pinned.api_version === TEST && plain.api_version === DAHLIA);
  assert(pinned.id === plain.id);
  assert(
    (pinned.data.object as unknown as { test_view?: true }).test_view &&
      !(plain.data.object as unknown as { test_view?: true }).test_view,
  );
  assert(
    (pinned.data.object as Stripe.Customer).id === created.value.id &&
      (plain.data.object as Stripe.Customer).id === created.value.id,
  );
  assert(
    ((await env.events.list({}))[0]!.payload as Stripe.Event).api_version ===
      DAHLIA,
  );

  const configure = (input: { id: string; apiVersion?: string }) =>
    service.webhooks.configure({
      url: sink.url('/' + input.id),
      secret,
      types: ['customer.created'],
      enabled: true,
      ...input,
    });

  // Reconfiguring without a version keeps the pinned one; a new endpoint
  // takes the account default.
  assert((await configure({ id: 'pinned' })).apiVersion === TEST);
  assert((await configure({ id: 'fresh' })).apiVersion === DAHLIA);
  assert(
    (await configure({ id: 'plain', apiVersion: TEST })).apiVersion === TEST,
  );

  for (const apiVersion of ['2025-03-31.basil', 'latest']) {
    assert(
      await rejects(() => configure({ id: 'fresh', apiVersion })) instanceof
        CommandError,
    );
  }

  assert(
    (await service.webhooks.destinations({})).find((d) => d.id === 'fresh')!
      .apiVersion === DAHLIA,
  );
});

class FakeScheduler implements DeliveryScheduler {
  time = Date.now();
  jobs = new Map<number, { due: number; callback: () => void }>();
  serial = 0;
  now = () => this.time;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.serial;

    this.jobs.set(id, { due: this.time + delay, callback });

    return () => {
      this.jobs.delete(id);
    };
  };
  advance(ms: number) {
    this.time += ms;

    for (const [id, job] of [...this.jobs]) {
      if (job.due <= this.time) {
        this.jobs.delete(id);
        job.callback();
      }
    }
  }
}

Deno.test('Stripe retries keep the body captured before an endpoint changes version', async () => {
  let status = 500;
  await using sink = receiver(() => status);
  const config = { versions: [DAHLIA, TEST], defaultVersion: DAHLIA };
  const destination = {
    id: 'app',
    url: sink.url('/app'),
    secret: 'whsec_retry',
    types: ['customer.created'],
    enabled: true,
  };
  const handle = await memoryAdapter().open({
    environmentId: 'env',
    instanceId: 'stripe',
    version: { pluginVersion: '0.1.0', schemaVersion: 3 },
    fixtures: [
      configFixture(config),
      destinationFixture(endpoint(destination, TEST), subscriptionPolicy),
    ],
  });
  // The host's composition: snapshots are captured where deliveries enqueue.
  const store = dispatchingStore(
    snapshottingStore(
      handle.store,
      presentation(config, modules).deliverySnapshot!,
    ),
    subscriptionPolicy,
  );
  const timer = new FakeScheduler();
  const worker = deliveryWorker(handle.store, transport(modules), timer);

  try {
    await perform(store, dahlia, {
      operation: 'customers.create',
      path: '/v1/customers',
      parsed: { input: { name: 'Ada' }, expand: [] },
    }, timer.now());
    await worker.flush();
    assert(sink.bodies.length === 1);

    // The endpoint moves to dahlia while the first delivery waits to retry.
    await setDestination(
      store,
      endpoint(destination, DAHLIA),
      subscriptionPolicy,
    );

    status = 200;

    timer.advance(60000);
    await worker.flush();
    assert(Number(sink.bodies.length) === 2);
    assert(sink.bodies[1]!.body === sink.bodies[0]!.body);
    assert(JSON.parse(sink.bodies[0]!.body).api_version === TEST);
    assert(sink.bodies[1]!.signature !== sink.bodies[0]!.signature);

    // Later events follow the new version.
    await perform(store, dahlia, {
      operation: 'customers.create',
      path: '/v1/customers',
      parsed: { input: { name: 'Grace' }, expand: [] },
    }, timer.now());
    await worker.flush();
    assert(JSON.parse(sink.bodies[2]!.body).api_version === DAHLIA);
  } finally {
    await worker.pause();
    handle.close();
  }
});

Deno.test('Stripe redelivery keeps its bytes across restart and endpoint reconfiguration', async () => {
  const directory = await Deno.makeTempDir();
  await using sink = receiver();
  const destination = {
    id: 'app',
    url: sink.url('/app'),
    secret: 'whsec_restart',
    types: ['customer.created'],
    enabled: true,
  };
  const config = {
    services: {
      stripe: both({
        apiVersions: [DAHLIA, TEST],
        destinations: [{ ...destination, apiVersion: TEST }],
      } as Options),
    },
  };
  let host = await serveEnvironment(config, { directory });

  try {
    const delivered = async () => {
      await using env = await Emulon.connect({ config, directory });

      for (const delivery of await env.services.stripe.webhooks.list({})) {
        await env.services.stripe.webhooks.wait({
          id: delivery.id,
          status: 'succeeded',
          timeout: '5s',
        });
      }

      return await env.services.stripe.webhooks.list({});
    };

    const first = await (async () => {
      await using env = await Emulon.connect({ config, directory });

      await env.services.stripe.customers.create({ name: 'Ada' });

      return (await delivered())[0]!;
    })();
    const original = sink.bodies[0]!.body;

    assert(JSON.parse(original).api_version === TEST);

    {
      await using env = await Emulon.connect({ config, directory });

      await env.services.stripe.webhooks.configure({
        ...destination,
        apiVersion: DAHLIA,
      });
      await env.services.stripe.webhooks.redeliver({ id: first.id });
    }

    await delivered();
    assert(sink.bodies[1]!.body === original);

    await host[Symbol.asyncDispose]();

    host = await serveEnvironment(config, { directory });

    {
      await using env = await Emulon.connect({ config, directory });

      // The reconfigured version survives restart; fixtures do not reapply.
      assert(
        (await env.services.stripe.webhooks.destinations({}))[0]!
          .apiVersion === DAHLIA,
      );
      await env.services.stripe.webhooks.redeliver({ id: first.id });
    }

    await delivered();
    assert(sink.bodies[2]!.body === original);
    assert(
      sink.bodies.every((b) =>
        JSON.parse(b.body).id === JSON.parse(original).id
      ),
    );
  } finally {
    await host[Symbol.asyncDispose]();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('Stripe refuses to start without a version its retained state uses', async () => {
  const cases = {
    // An event caused by a request in the version.
    event: { apiVersions: [DAHLIA, TEST] },
    // A webhook endpoint pinned to the version.
    endpoint: {
      apiVersions: [DAHLIA, TEST],
      destinations: [{
        id: 'app',
        url: 'http://127.0.0.1:9/unused',
        secret: 'whsec_unused',
        types: ['customer.created'],
        enabled: false,
        apiVersion: TEST,
      }],
    },
  };

  for (const [name, options] of Object.entries(cases)) {
    const directory = await Deno.makeTempDir();

    try {
      const enabled = { services: { stripe: both(options as Options) } };
      let host = await serveEnvironment(enabled, { directory });
      let customer = '';

      try {
        await using env = await Emulon.connect({ config: enabled, directory });
        const { apiKey } = await env.services.stripe.keys.create({});

        customer = (await api(env.endpoints.stripe.api!, apiKey)(
          '/v1/customers',
          {
            body: 'name=Ada',
            headers: {
              'stripe-version': name === 'event' ? TEST : DAHLIA,
            },
          },
        )).value.id;
      } finally {
        await host[Symbol.asyncDispose]();
      }

      // Removing the version is refused rather than silently reprojected.
      const error = await rejects(() =>
        serveEnvironment({ services: { stripe: both() } }, { directory })
      );

      assert(
        error instanceof CommandError && error.code === 'ENVIRONMENT_FAILED',
        `${name}: ${error}`,
      );

      host = await serveEnvironment(enabled, { directory });

      try {
        await using env = await Emulon.connect({ config: enabled, directory });

        assert(
          (await env.services.stripe.customers.get({ id: customer })).id ===
            customer,
        );
      } finally {
        await host[Symbol.asyncDispose]();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test('Stripe state from an earlier schema is refused until reset', async () => {
  const directory = await Deno.makeTempDir();
  const { definition } = readRegistration(stripe());
  const earlier = definePlugin({
    ...definition,
    state: { ...definition.state!, schemaVersion: 2 },
  });

  try {
    const host = await serveEnvironment(
      { services: { stripe: earlier() } },
      { directory },
    );

    await host[Symbol.asyncDispose]();

    const error = await rejects(() =>
      serveEnvironment({ services: { stripe: stripe() } }, { directory })
    );

    assert(
      error instanceof CommandError && error.code === 'STATE_INCOMPATIBLE' &&
        error.message.includes('schema 3') &&
        error.message.includes('schema 2'),
      String(error),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
