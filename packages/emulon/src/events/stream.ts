import { z } from 'zod';
import type { EventRecord } from '../state/store.ts';

export const eventFilter: z.ZodType<EventFilter> = z.strictObject({
  type: z.string().min(1).optional(),
});

export type EventFilter = { type?: string | undefined };
export interface Events {
  list(filter?: EventFilter): Promise<EventRecord[]>;
  follow(filter?: EventFilter): Promise<ReadableStream<EventRecord>>;
}

export function eventHub() {
  const subscribers = new Map<
    ReadableStreamDefaultController<EventRecord>,
    EventFilter
  >();
  let closed = false;

  return {
    publish(event: EventRecord) {
      for (const [controller, filter] of subscribers) {
        if (filter.type && filter.type !== event.type) {
          continue;
        }

        if ((controller.desiredSize ?? 0) <= 0) {
          controller.error(new Error('Event consumer is too slow.'));
          subscribers.delete(controller);
        } else {
          controller.enqueue(structuredClone(event));
        }
      }
    },
    follow(filter: EventFilter = {}): Promise<ReadableStream<EventRecord>> {
      filter = eventFilter.parse(filter);

      if (closed) {
        return Promise.reject(new Error('Environment is disposed.'));
      }

      let controller: ReadableStreamDefaultController<EventRecord>;

      return Promise.resolve(
        new ReadableStream<EventRecord>({
          start(value) {
            controller = value;

            subscribers.set(controller, filter);
          },
          cancel() {
            subscribers.delete(controller);
          },
        }, { highWaterMark: 256 }),
      );
    },
    interrupt(error: Error) {
      for (const controller of subscribers.keys()) {
        controller.error(error);
      }

      subscribers.clear();
    },
    close() {
      closed = true;

      for (const controller of subscribers.keys()) {
        controller.close();
      }

      subscribers.clear();
    },
  };
}
