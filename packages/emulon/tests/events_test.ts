import { eventHub } from '../src/events/stream.ts';
import { memoryAdapter } from '../src/state/store.ts';
import { serveNode } from '../src/runtime/http.ts';
import { serveDeno } from '../src/runtime/deno-http.ts';

Deno.test('only committed outbox events notify subscribers', async () => {
  const hub = eventHub();
  const state = await memoryAdapter().open({
    environmentId: 'test',
    instanceId: 'mail',
    version: { pluginVersion: '1', schemaVersion: 1 },
    fixtures: [],
    onEvent: hub.publish,
  });
  const reader = (await hub.follow()).getReader();
  const event = {
    type: 'test',
    occurredAt: 'now',
    origin: 'service' as const,
    payload: {},
  };

  try {
    await state.store.transaction(async (tx) => {
      await tx.record(event);

      throw new Error('rollback');
    }).catch(() => {});

    const committed = await state.store.transaction((tx) => tx.record(event));

    if ((await reader.read()).value?.id !== committed.id) {
      throw new Error('Rolled back event escaped.');
    }

    const outbox = await state.store.transaction((tx) => tx.outbox());

    if (outbox.length !== 1) {
      throw new Error('Wrong outbox.');
    }

    hub.close();

    if (!(await reader.read()).done) {
      throw new Error('Stream did not close.');
    }
  } finally {
    await reader.cancel();
    state.close();
    hub.close();
  }
});

Deno.test('slow consumers fail without preventing event commits', async () => {
  const hub = eventHub();
  const reader = (await hub.follow()).getReader();

  for (let i = 0; i < 257; i++) {
    hub.publish({
      id: String(i),
      instanceId: 'mail',
      type: 'test',
      occurredAt: 'now',
      origin: 'published',
      payload: {},
    });
  }

  let failed = false;

  try {
    await reader.read();
  } catch {
    failed = true;
  }

  hub.close();

  if (!failed) {
    throw new Error('Unbounded event buffer.');
  }
});

for (const serve of [serveNode, serveDeno]) {
  Deno.test(`${serve.name} streams before completion and cancels on disconnect`, async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => cancelled = resolve);
    const host = await serve(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              output = controller;
            },
            cancel() {
              cancelled();
            },
          }),
        ),
      )
    );

    try {
      const response = await fetch(host.url);
      const reader = response.body!.getReader();

      output.enqueue(new TextEncoder().encode('first\n'));

      if (new TextDecoder().decode((await reader.read()).value) !== 'first\n') {
        throw new Error('Buffered response.');
      }

      await reader.cancel();
      await cancellation;
    } finally {
      await host.stop();
    }
  });
}
