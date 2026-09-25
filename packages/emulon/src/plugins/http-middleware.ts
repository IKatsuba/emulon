import type { MiddlewareHandler } from 'hono';

/**
 * Replaces a request's signal with one composed on first read. Deno warns once
 * a native request signal is read, because it also aborts after a successful
 * response, so only handlers that observe cancellation may touch it.
 */
function defineSignal(request: Request, compose: () => AbortSignal): Request {
  let signal: AbortSignal | undefined;

  Object.defineProperty(request, 'signal', {
    configurable: true,
    get: () => signal ??= compose(),
  });

  return request;
}

export function boundedBody(limit: number): MiddlewareHandler {
  return async (c, next) => {
    const request = c.req.raw;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();

    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) {
            break;
          }

          size += chunk.value.byteLength;

          if (size > limit) {
            void reader.cancel().catch(() => {});

            return c.text('Payload too large', 413);
          }

          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }

      const body = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        body.set(chunk, offset);

        offset += chunk.length;
      }

      c.req.raw = defineSignal(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        }),
        () => request.signal,
      );
    }

    await next();
  };
}

/**
 * Pause and close abort the host signal before waiting for admitted handlers,
 * so a handler that waits on its request signal, such as a long poll, ends
 * instead of holding up reset or shutdown. Handlers that ignore the signal
 * still drain as before. Each resume starts a new signal for new requests.
 */
export function requestLifecycle() {
  let closed = false;
  let paused = false;
  let host = new AbortController();
  const active = new Set<Promise<void>>();
  const middleware: MiddlewareHandler = async (c, next) => {
    if (closed || paused) {
      return c.text('Environment unavailable', 503);
    }

    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });

    active.add(running);

    try {
      const request = c.req.raw;
      const native = Object.getPrototypeOf(request);
      const admitted = host.signal;

      defineSignal(
        request,
        () =>
          AbortSignal.any([
            Reflect.get(native, 'signal', request) as AbortSignal,
            admitted,
          ]),
      );

      await next();
    } catch {
      return c.text('Internal server error', 500);
    } finally {
      active.delete(running);
      finish();
    }
  };

  return {
    middleware,
    get closed() {
      return closed;
    },
    async pause() {
      paused = true;

      host.abort();

      await Promise.all([...active]);
    },
    resume() {
      paused = false;

      if (host.signal.aborted && !closed) {
        host = new AbortController();
      }
    },
    close() {
      closed = true;

      host.abort();

      return Promise.all([...active]).then(() => {});
    },
  };
}
