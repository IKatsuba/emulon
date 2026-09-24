import { Emulon, type EventRecord } from 'emulon';
import { serveEnvironment } from '../src/control/server.ts';
import { runProjectCLI } from '../src/cli/project.ts';
import { listen } from '../src/runtime/http.ts';
import { plain, presented, sign } from './fixtures/presentation.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

interface Received {
  body: string;
  id: string;
  timestamp: string;
  signature: string;
}

// Rejects the first attempt of every provider delivery ID, then accepts.
async function receiver() {
  const requests: Received[] = [];
  const waiters: (() => void)[] = [];
  const listener = await listen(async (request) => {
    const received = {
      body: await request.text(),
      id: request.headers.get('webhook-id')!,
      timestamp: request.headers.get('webhook-timestamp')!,
      signature: request.headers.get('x-signature')!,
    };
    const first = !requests.some((item) => item.id === received.id);

    requests.push(received);
    waiters.splice(0).forEach((wake) => wake());

    return new Response(null, { status: first ? 500 : 200 });
  });

  return {
    url: listener.url,
    requests,
    stop: () => listener.stop(),
    async bodies(id: string) {
      for (const item of requests.filter((item) => item.id === id)) {
        equal(item.signature, await sign('secret', item.timestamp, item.body));
      }

      return requests.filter((item) => item.id === id).map((item) =>
        JSON.parse(item.body)
      );
    },
  };
}

async function inspect(
  env: { webhooks: { inspect(input: { id: string }): Promise<unknown> } },
  id: string,
) {
  const { attempts } = await env.webhooks.inspect({ id }) as {
    attempts: { providerDeliveryId: string; requestBytes: number[] }[];
  };

  return attempts.map((attempt) => ({
    id: attempt.providerDeliveryId,
    body: new TextDecoder().decode(new Uint8Array(attempt.requestBytes)),
  }));
}

const view = (label: string, event: EventRecord, name: string) => ({
  ...event,
  payload: { label, id: event.id, data: { name } },
});

Deno.test('presentation hooks project events and retain exact delivery bytes across retry, redelivery and restart', async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir());
  const hook = await receiver();
  let host = await serveEnvironment({
    services: { p: presented({ label: 'first' }) },
  }, { directory });

  try {
    const config = { services: { p: presented({ label: 'first' }) } };
    let env = await Emulon.connect({ config, directory });
    let p = env.services.p;

    await p.webhooks.configure({
      id: 'hook',
      url: hook.url,
      secret: 'secret',
      version: 'b',
    });
    equal(await p.webhooks.destinations({}), [{
      id: 'hook',
      url: hook.url,
      types: ['item.saved'],
      enabled: true,
      provider: { version: 'b' },
    }]);

    const { eventId } = await p.items.save({ name: 'one' });
    const delivery = JSON.stringify([eventId, 'hook']);
    const subscribed = await p.webhooks.wait({
      id: delivery,
      timeout: '5s',
    });
    const expected = {
      id: eventId,
      label: 'first',
      version: 'b',
      data: { name: 'one' },
    };
    const providerId = hook.requests[0]!.id;

    equal(subscribed.status, 'succeeded');
    // A failed attempt and its retry send identical bytes and delivery ID.
    equal(await hook.bodies(providerId), [expected, expected]);
    equal(hook.requests[0]!.body, JSON.stringify(expected));

    // Later settings changes never rewrite an already materialized body.
    await p.webhooks.configure({
      id: 'hook',
      url: hook.url,
      secret: 'secret',
      version: 'c',
    });
    await p.webhooks.redeliver({ id: delivery });
    await p.webhooks.wait({ id: delivery, timeout: '5s' });
    equal(await hook.bodies(providerId), [expected, expected, expected]);

    // Direct sends capture the destination's current settings.
    const direct = await p.webhooks.send({
      type: 'item.saved',
      data: { name: 'direct' },
      destination: 'hook',
    });

    await p.webhooks.wait({ id: direct.id, timeout: '5s' });

    const directEvent = (await env.events.list()).at(-1)!;
    const directBody = {
      id: directEvent.id,
      label: 'first',
      version: 'c',
      data: { name: 'direct' },
    };

    equal(
      await hook.bodies(hook.requests.at(-1)!.id),
      [directBody, directBody],
    );

    // Hold a delivery across restart with different presentation options.
    await p.webhooks.hold({ hold: true });

    const held = await p.items.save({ name: 'held' });
    const heldId = JSON.stringify([held.eventId, 'hook']);
    const heldBody = {
      id: held.eventId,
      label: 'first',
      version: 'c',
      data: { name: 'held' },
    };

    await p.webhooks.hold({ hold: false });
    await env.dispose();
    await host.dispose();

    const count = hook.requests.length;
    const restarted = { services: { p: presented({ label: 'second' }) } };

    host = await serveEnvironment(restarted, { directory });
    env = await Emulon.connect({ config: restarted, directory });
    p = env.services.p;

    equal(hook.requests.length, count);
    await p.webhooks.release({ id: heldId });
    await p.webhooks.wait({ id: heldId, timeout: '5s' });
    equal(
      await hook.bodies(hook.requests.at(-1)!.id),
      [heldBody, heldBody],
    );
    equal(
      (await inspect(p, heldId)).map((attempt) => attempt.body),
      [JSON.stringify(heldBody), JSON.stringify(heldBody)],
    );

    // Views use the current options; the canonical payload is unchanged.
    const listed = await env.events.list();

    equal(listed.map((event) => event.payload), [
      { label: 'second', id: eventId, data: { name: 'one' } },
      { label: 'second', id: directEvent.id, data: { name: 'direct' } },
      { label: 'second', id: held.eventId, data: { name: 'held' } },
    ]);

    const cli = await runProjectCLI(['events', '--json'], undefined, directory);

    equal(cli.code, 0);
    equal(JSON.parse(cli.stdout), listed);

    const lines: string[] = [];
    let ready!: () => void;
    const subscribedCLI = new Promise<void>((resolve) => ready = resolve);
    const following = runProjectCLI(
      ['events', '--follow'],
      undefined,
      directory,
      (line) => lines.push(line),
      ready,
    );
    const stream = (await env.events.follow()).getReader();

    await subscribedCLI;

    const next = await p.items.save({ name: 'followed' });
    const followed = (await stream.read()).value!;

    equal(followed, view('second', followed, 'followed'));
    equal(followed.id, next.eventId);
    await stream.cancel();
    await env.dispose();
    await host.dispose();
    await following;
    equal(lines.map((line) => JSON.parse(line)), [followed]);
  } finally {
    await host.dispose();
    await hook.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('started SDK lists and follows event views', async () => {
  const env = await Emulon.start({
    services: { p: presented({ label: 'local' }) },
  });

  try {
    const stream = (await env.events.follow({ type: 'item.saved' }))
      .getReader();
    const { eventId } = await env.services.p.items.save({ name: 'one' });
    const [listed] = await env.events.list();

    equal(listed!.id, eventId);
    equal(listed, view('local', listed!, 'one'));
    equal((await stream.read()).value, listed);
    await stream.cancel();
  } finally {
    await env.dispose();
  }
});

Deno.test('plugins without hooks keep canonical events, destinations and serializer bytes', async () => {
  const hook = await receiver();
  const env = await Emulon.start({
    services: { p: plain({ label: 'unused' }) },
  });

  try {
    const p = env.services.p;

    await p.webhooks.configure({ id: 'hook', url: hook.url, secret: 'secret' });

    const { eventId } = await p.items.save({ name: 'one' });
    const id = JSON.stringify([eventId, 'hook']);

    await p.webhooks.wait({ id, timeout: '5s' });
    equal((await env.events.list()).map((event) => event.payload), [
      { name: 'one' },
    ]);
    equal(await hook.bodies(hook.requests[0]!.id), [
      { name: 'one' },
      { name: 'one' },
    ]);
    equal(await p.webhooks.destinations({}), [{
      id: 'hook',
      url: hook.url,
      types: ['item.saved'],
      enabled: true,
    }]);
  } finally {
    await env.dispose();
    await hook.stop();
  }
});

Deno.test('presentation factories must return hook functions', async () => {
  const { definePlugin } = await import('emulon');
  const broken = definePlugin({
    name: 'broken',
    apiVersion: 1,
    capabilities: [],
    commands: {},
    presentation: () => ({ eventView: 'not a function' as never }),
    setup: () =>
      Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      }),
  });

  try {
    await Emulon.start({ services: { broken: broken() } });
  } catch (error) {
    equal((error as { code?: string }).code, 'ENVIRONMENT_FAILED');

    return;
  }

  throw new Error('Expected startup failure');
});
