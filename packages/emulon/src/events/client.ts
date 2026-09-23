import { request } from '../control/client.ts';
import { CommandError } from '../commands/registry.ts';
import type { Connection } from '../control/protocol.ts';
import { type EventFilter, eventFilter, type Events } from './stream.ts';
import type { EventRecord } from '../state/store.ts';

export function remoteEvents(record: Connection, signal: AbortSignal): Events {
  function path(input: EventFilter = {}, follow = false) {
    const filter = eventFilter.parse(input);
    const query = new URLSearchParams(follow ? { follow: 'true' } : {});

    if (filter.type) {
      query.set('type', filter.type);
    }

    return '/events?' + query;
  }

  return {
    async list(filter) {
      return await request(
        record,
        path(filter),
        undefined,
        signal,
      ) as EventRecord[];
    },
    async follow(filter) {
      const response = await fetch(record.url + path(filter, true), {
        headers: {
          authorization: 'Bearer ' + record.token,
          'x-emulon-environment': record.id,
        },
        signal,
        redirect: 'error',
      });

      if (!response.ok) {
        const { error } = await response.json() as {
          error: ReturnType<CommandError['toJSON']>;
        };

        throw new CommandError(error.code, error.message);
      }

      if (!response.body) {
        throw new Error('Cannot open event stream.');
      }

      let pending = '';

      return response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
        new TransformStream<string, EventRecord>({
          transform(chunk, controller) {
            pending += chunk;

            let end;

            while ((end = pending.indexOf('\n')) !== -1) {
              const frame = JSON.parse(pending.slice(0, end));

              if (frame.error) {
                throw new CommandError(frame.error.code, frame.error.message);
              }

              controller.enqueue(frame);

              pending = pending.slice(end + 1);
            }
          },
        }),
      );
    },
  };
}
