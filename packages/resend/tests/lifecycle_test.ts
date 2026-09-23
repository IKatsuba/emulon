import { definePlugin, Emulon } from 'emulon';
import resend from '@emulon/resend';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

async function closed(url: string) {
  try {
    const response = await fetch(url);

    await response.body?.cancel();
  } catch {
    return;
  }

  throw new Error('Listener is still open');
}

Deno.test('Resend environments own separate listeners and support await using', async () => {
  const config = { services: { mail: resend(), other: resend() } };
  let url = '';

  {
    await using env = await Emulon.start(config);

    url = env.endpoints.mail.api!;

    assert(url !== env.endpoints.other.api);

    const response = await fetch(`${url}/health`);

    assert(response.status === 200);
    assert((await response.json()).status === 'ok');
    assert(Object.keys(env.services).join() === 'mail,other');
  }

  await closed(url);

  const again = await Emulon.start(config);
  const nextURL = again.endpoints.mail.api!;

  await Promise.all([again.dispose(), again.dispose()]);
  await again[Symbol.asyncDispose]();
  await closed(nextURL);
});

for (const failure of ['setup', 'ready']) {
  Deno.test(`partial ${failure} failure closes every owned listener`, async () => {
    const urls: string[] = [];
    const stops: string[] = [];
    const plugin = definePlugin({
      name: 'fixture',
      apiVersion: 1,
      capabilities: ['http'],
      commands: {},
      async setup(ctx, name: string) {
        ctx.http.surface('api');

        const api = await ctx.http.listen('api');

        urls.push(api);

        if (name === 'bad' && failure === 'setup') {
          throw new Error('secret');
        }

        return {
          endpoints: { api },
          ready() {
            return name === 'bad'
              ? Promise.reject(new Error('secret'))
              : Promise.resolve();
          },
          stop() {
            stops.push(name);

            return Promise.resolve();
          },
        };
      },
    });

    try {
      await Emulon.start({
        services: { good: plugin('good'), broken: plugin('bad') },
      });

      throw new Error('Expected startup failure');
    } catch (error) {
      assert(error instanceof Error && error.message.includes('"broken"'));
      assert(!String(error).includes('secret'));
    }

    assert(stops.includes('good'));

    if (failure === 'ready') {
      assert(stops.join() === 'bad,good');
    }

    for (const url of urls) {
      await closed(url);
    }
  });
}

Deno.test('bounded bodies and exact routes are enforced before handlers', async () => {
  let calls = 0;
  const plugin = definePlugin({
    name: 'echo',
    apiVersion: 1,
    capabilities: ['http'],
    commands: {},
    async setup(ctx) {
      ctx.http.surface('api', { maxBodyBytes: 4 }).post('/echo', async (c) => {
        const request = c.req.raw;

        calls++;

        return new Response(await request.text());
      });

      const api = await ctx.http.listen('api');

      return {
        endpoints: { api },
        ready: async () => {},
        stop: async () => {},
      };
    },
  });
  await using env = await Emulon.start({ services: { echo: plugin() } });

  for (
    const [path, body, status] of [['/echo', 'four', 200], [
      '/echo',
      'large',
      413,
    ], ['/missing', '', 404]] as const
  ) {
    const response = await fetch(env.endpoints.echo.api + path, {
      method: 'POST',
      body,
    });

    assert(response.status === status);
    await response.text();
  }

  assert(calls === 1);
});

Deno.test('shutdown continues after plugin errors and closes retained contexts', async () => {
  let retained: import('emulon').PluginContext | undefined;
  let stops = 0;
  const fixture = definePlugin({
    name: 'fixture',
    apiVersion: 1,
    capabilities: ['http'],
    commands: {},
    async setup(ctx) {
      retained = ctx;

      ctx.http.surface('api');

      const api = await ctx.http.listen('api');

      return {
        endpoints: { api },
        ready: () => Promise.resolve(),
        stop() {
          stops++;

          return Promise.reject(new Error('secret'));
        },
      };
    },
  });
  const env = await Emulon.start({ services: { a: fixture(), b: fixture() } });
  const first = env.dispose();

  assert(first === env.dispose());

  try {
    await first;

    throw new Error('Expected shutdown failure');
  } catch (error) {
    assert(error instanceof AggregateError);
  }

  assert(stops === 2);
  await closed(env.endpoints.a.api!);
  await closed(env.endpoints.b.api!);

  let rejected = false;

  try {
    await retained!.http.listen('late');
  } catch {
    rejected = true;
  }

  assert(rejected);
});
