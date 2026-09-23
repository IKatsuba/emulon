import { serve } from '@hono/node-server';
import { serveDeno } from './deno-http.ts';

export interface Listener {
  url: string;
  stop(): Promise<void>;
}
export type Handler = (request: Request) => Response | Promise<Response>;

export function listen(handler: Handler): Promise<Listener> {
  return 'Deno' in globalThis ? serveDeno(handler) : serveNode(handler);
}

export async function serveNode(handler: Handler): Promise<Listener> {
  // Keep native web globals intact when multiple runtime adapters share a process.
  const server = serve({
    fetch: handler,
    hostname: '127.0.0.1',
    port: 0,
    overrideGlobalObjects: false,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Missing listener address');
  }

  let stopping: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${address.port}`,
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
