import { serve } from '@hono/node-server';
import { serveDeno } from './deno-http.ts';
import { PortInUseError } from './port-in-use.ts';

export interface Listener {
  url: string;
  stop(): Promise<void>;
}
export type Handler = (request: Request) => Response | Promise<Response>;

/** Binds loopback only; port 0 lets the operating system allocate one. */
export function listen(handler: Handler, port = 0): Promise<Listener> {
  return 'Deno' in globalThis
    ? serveDeno(handler, port)
    : serveNode(handler, port);
}

export async function serveNode(handler: Handler, port = 0): Promise<Listener> {
  // Keep native web globals intact when multiple runtime adapters share a process.
  const server = serve({
    fetch: handler,
    hostname: '127.0.0.1',
    port,
    overrideGlobalObjects: false,
  });

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error & { code?: string }) => {
      reject(
        port && error.code === 'EADDRINUSE' ? new PortInUseError(port) : error,
      );
    };

    server.once('error', failed);
    server.once('listening', () => {
      server.off('error', failed);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Missing listener address');
  }

  let stopping: Promise<void> | undefined;

  return {
    url: `http://${address.address}:${address.port}`,
    stop() {
      return stopping ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());

        if ('closeAllConnections' in server) {
          server.closeAllConnections();
        }
      });
    },
  };
}
