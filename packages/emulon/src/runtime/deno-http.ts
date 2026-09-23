import type { Handler, Listener } from './http.ts';

// A structural boundary keeps Deno globals out of the npm declarations.
interface DenoHost {
  serve(
    options: {
      hostname: string;
      port: number;
      signal: AbortSignal;
      onListen(): void;
    },
    handler: Handler,
  ): {
    addr: { port: number };
    finished: Promise<void>;
  };
}

export function serveDeno(handler: Handler): Promise<Listener> {
  const host = (globalThis as unknown as { Deno: DenoHost }).Deno;
  const controller = new AbortController();
  const server = host.serve({
    hostname: '127.0.0.1',
    port: 0,
    signal: controller.signal,
    onListen() {},
  }, handler);

  return Promise.resolve({
    url: `http://127.0.0.1:${server.addr.port}`,
    async stop() {
      controller.abort();
      await server.finished;
    },
  });
}
