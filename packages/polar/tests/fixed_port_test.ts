import polar from '@emulon/polar';
import { defineConfig, Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { client, organizationId } from './customers_cases.ts';
import { assert, equal } from './assert.ts';

Deno.test('the official client keeps one fixed endpoint across emulon up runs', async () => {
  const directory = await Deno.makeTempDir();
  // The test takes a free port from the operating system, not a fixed number.
  const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;

  probe.close();

  const config = defineConfig({
    services: {
      billing: { service: polar({ organizationId }), ports: { api: port } },
    },
  });
  const api = `http://127.0.0.1:${port}`;
  let apiKey = '';
  let id = '';

  try {
    for (let run = 0; run < 2; run++) {
      await using host = await serveEnvironment(config, { directory });

      equal(host.identity.endpoints, { billing: { api } });

      if (!apiKey) {
        await using env = await Emulon.connect({
          config,
          directory,
        });

        apiKey = (await env.services.billing.keys.create({})).apiKey;
        id = (await env.services.billing.customers.create({
          email: 'ada@example.test',
        })).id;
      }

      // A token issued before the restart still works at the same address.
      const read = await client(api, apiKey).customers.get({ id });

      assert(read.id === id && read.organizationId === organizationId);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
