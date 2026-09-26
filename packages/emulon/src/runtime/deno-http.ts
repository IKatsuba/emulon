import type { Handler, Listener } from './http.ts';
import { PortInUseError } from './port-in-use.ts';

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
    addr: { hostname: string; port: number };
    finished: Promise<void>;
  };
}

export function serveDeno(handler: Handler, port = 0): Promise<Listener> {
  const host = (globalThis as unknown as { Deno: DenoHost }).Deno;
  const controller = new AbortController();
  let server: ReturnType<DenoHost['serve']>;

  try {
    server = host.serve({
      hostname: '127.0.0.1',
      port,
      signal: controller.signal,
      onListen() {},
    }, handler);
  } catch (error) {
    const { name, code } = error as { name?: unknown; code?: unknown };

    if (port && (name === 'AddrInUse' || code === 'EADDRINUSE')) {
      return Promise.reject(new PortInUseError(port));
    }

    return Promise.reject(error);
  }

  return Promise.resolve({
    url: `http://${server.addr.hostname}:${server.addr.port}`,
    async stop() {
      controller.abort();
      await server.finished;
    },
  });
}
