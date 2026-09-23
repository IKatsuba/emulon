import { eventFilter, type Events } from '../events/stream.ts';
import { CommandError } from '../commands/registry.ts';

export async function eventResponse(
  req: Request,
  events: Events,
): Promise<Response> {
  const url = new URL(req.url);
  const filter = eventFilter.parse(
    url.searchParams.has('type') ? { type: url.searchParams.get('type')! } : {},
  );

  if (url.searchParams.get('follow') === 'true') {
    const headers = { 'content-type': 'application/x-ndjson' };

    // Hono drops HEAD bodies without cancelling them, so never allocate a subscription.
    if (req.method === 'HEAD') {
      await events.list(filter);

      return new Response(null, { headers });
    }

    const stream = await events.follow(filter);
    const reader = stream.getReader();
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();

            if (next.done) {
              controller.close();
            } else {
              controller.enqueue(
                encoder.encode(JSON.stringify(next.value) + '\n'),
              );
            }
          } catch (error) {
            // HTTP headers have already left; deliver a terminal error in-band.
            const failure = error instanceof CommandError
              ? error
              : new CommandError(
                'EVENT_STREAM_INTERRUPTED',
                'Event stream interrupted.',
              );

            controller.enqueue(
              encoder.encode(
                JSON.stringify({ error: failure.toJSON() }) + '\n',
              ),
            );
            controller.close();
          }
        },
        async cancel() {
          await reader.cancel().catch(() => {});
        },
      }),
      { headers },
    );
  }

  return Response.json(await events.list(filter));
}
