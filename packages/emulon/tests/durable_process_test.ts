import { durableProof } from '../../../scripts/durable-proof.ts';

Deno.test('independent processes recover committed state and interrupted deliveries', async () => {
  await durableProof({
    command: Deno.execPath(),
    args: [
      'run',
      '--cached-only',
      '--allow-read',
      '--allow-write',
      '--allow-env=NODE_ENV',
      '--allow-net=127.0.0.1',
      new URL('./fixtures/durable-process.ts', import.meta.url).pathname,
    ],
    cwd: Deno.cwd(),
  });
});
