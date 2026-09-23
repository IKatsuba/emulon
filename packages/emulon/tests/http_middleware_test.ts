import { Hono } from 'hono';
import { httpContext } from '../src/plugins/http.ts';

function assert(value: unknown): asserts value {
  if (!value) {
    throw new Error('Assertion failed');
  }
}

Deno.test('host surfaces expose Hono parameters and redact failures', async () => {
  const host = httpContext();
  const app = host.context.http.surface('api');

  assert(app instanceof Hono);
  app.get('/repos/:owner/:repo', (c) => c.json(c.req.param()));
  app.get('/fail', () => {
    throw new Error('secret-token');
  });

  app.get('/rejected', () => Promise.reject('secret-token'));

  const response = await app.request('/repos/alice/demo');
  const params = await response.json();

  assert(params.owner === 'alice' && params.repo === 'demo');

  const failed = await app.request('/fail');

  assert(
    failed.status === 500 && await failed.text() === 'Internal server error',
  );

  const rejected = await app.request('/rejected');

  assert(
    rejected.status === 500 &&
      await rejected.text() === 'Internal server error',
  );

  const missing = await app.request('/missing');

  assert(
    missing.status === 404 && await missing.text() === 'Unsupported route',
  );
  await host.pause();
  assert((await app.request('/missing')).status === 503);
  host.resume();
  assert((await app.request('/repos/alice/demo')).status === 200);
  await host.stop();
  host.resume();
  assert((await app.request('/repos/alice/demo')).status === 503);
});

Deno.test('body middleware counts streamed bytes before plugin middleware and drains on pause', async () => {
  const host = httpContext();
  const app = host.context.http.surface('api', { maxBodyBytes: 4 });
  let calls = 0;

  app.use(async (_c, next) => {
    calls++;
    await next();
  });

  app.post('/echo', async (c) => c.text(await c.req.text()));

  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const request = app.request('/echo', {
    method: 'POST',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('four'));

        release = () => controller.close();

        entered();
      },
    }),
    // Node requires duplex for a streaming request; Deno accepts it as well.
    ...{ duplex: 'half' },
  });

  await started;

  let paused = false;
  const pause = host.pause().then(() => {
    paused = true;
  });

  await Promise.resolve();
  assert(!paused && calls === 0);
  release();
  assert(await (await request).text() === 'four');
  await pause;
  host.resume();

  const oversized = await app.request('/echo', {
    method: 'POST',
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('four'));
        c.enqueue(new TextEncoder().encode('!'));
        c.close();
      },
    }),
    ...{ duplex: 'half' },
  });

  assert(oversized.status === 413 && Number(calls) === 1);
  await host.stop();
});

Deno.test('surface registration and listener ownership reject invalid transitions', async () => {
  const host = httpContext();

  host.context.http.surface('api');

  for (
    const action of [
      () => host.context.http.surface('api'),
      () => host.context.http.surface(''),
      () => host.context.http.surface('bad', { maxBodyBytes: -1 }),
      () => host.context.http.listen('unknown'),
    ]
  ) {
    let rejected = false;

    try {
      await action();
    } catch {
      rejected = true;
    }

    assert(rejected);
  }

  await host.stop();

  let rejected = false;

  try {
    host.context.http.surface('late');
  } catch {
    rejected = true;
  }

  assert(rejected);
});
