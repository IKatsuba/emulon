import { Hono } from 'hono';
import { eventResponse } from '../src/control/events.ts';
import type { Events } from '../src/events/stream.ts';
import type { EventRecord } from '../src/state/store.ts';
import { serveNode } from '../src/runtime/http.ts';
import { serveDeno } from '../src/runtime/deno-http.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

for (const serve of [serveNode, serveDeno]) {
  Deno.test(`${serve.name} control HEAD allocates no subscription and GET cancels`, async () => {
    let subscriptions = 0;
    let output!: ReadableStreamDefaultController<EventRecord>;
    const cancelled = Promise.withResolvers<void>();
    const event: EventRecord = {
      id: 'event-1',
      instanceId: 'mail',
      type: 'test',
      occurredAt: 'now',
      origin: 'published',
      payload: {},
    };
    const events: Events = {
      list: () => Promise.resolve([event]),
      follow(filter) {
        equal(filter, { type: 'test' });
        subscriptions++;

        return Promise.resolve(
          new ReadableStream<EventRecord>({
            start(controller) {
              output = controller;
            },
            cancel() {
              subscriptions--;
              cancelled.resolve();
            },
          }),
        );
      },
    };
    const app = new Hono();

    app.get('/events', (c) => eventResponse(c.req.raw, events));

    const host = await serve(app.fetch);

    try {
      for (let i = 0; i < 3; i++) {
        const response = await fetch(
          host.url + '/events?follow=true&type=test',
          { method: 'HEAD' },
        );

        equal(response.status, 200);
        equal(response.headers.get('content-type'), 'application/x-ndjson');
        equal(await response.text(), '');
        equal(subscriptions, 0);
      }

      const listed = await fetch(host.url + '/events?type=test');

      equal(await listed.json(), [event]);

      const response = await fetch(host.url + '/events?follow=true&type=test');

      equal(response.status, 200);
      equal(subscriptions, 1);

      const reader = response.body!.getReader();

      output.enqueue(event);
      equal(
        new TextDecoder().decode((await reader.read()).value),
        JSON.stringify(event) + '\n',
      );
      await reader.cancel();
      await cancelled.promise;
      equal(subscriptions, 0);
    } finally {
      await host.stop();
    }
  });
}
