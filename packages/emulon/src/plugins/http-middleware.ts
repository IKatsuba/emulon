import type { MiddlewareHandler } from 'hono';

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

      c.req.raw = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      });
    }

    await next();
  };
}

export function requestLifecycle() {
  let closed = false;
  let paused = false;
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

      await Promise.all([...active]);
    },
    resume() {
      paused = false;
    },
    close() {
      closed = true;

      return Promise.all([...active]).then(() => {});
    },
  };
}
