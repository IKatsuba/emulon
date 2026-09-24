import { Emulon } from 'emulon';
import { listen } from '../../src/runtime/http.ts';
import versioned, {
  alpha,
  beta,
  project,
  sign,
} from '../fixtures/versioned.ts';
import { caseRegistry } from './compatibility.ts';

interface Received {
  id: string;
  signature: string;
  body: string;
}

function same(actual: unknown, wanted: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Versioned fixture mismatch: ${label}`);
  }
}

/** Contract cases of one fixture version, each executed against a started environment. */
export function versionedCases(prefix: 'alpha' | 'beta') {
  const apiVersion = prefix === 'alpha' ? alpha : beta;
  const other = prefix === 'alpha' ? beta : alpha;
  const suite = caseRegistry(
    `packages/emulon/tests/versioned_${prefix}_cases.ts`,
  );

  suite.register(
    `${prefix}.items.1`,
    ['items.create'],
    ['item.created'],
    false,
    `creates an item and its event in the ${apiVersion} projection`,
    async () => {
      await using env = await Emulon.start({
        services: { versioned: versioned() },
      });

      same(
        await env.services.versioned.items.create({ name: 'a', apiVersion }),
        project('a', apiVersion),
        'response',
      );

      const events = await env.events.list();

      same(events.map((event) => event.type), ['item.created'], 'event type');
      same(events[0]!.payload, project('a', apiVersion), 'event projection');
    },
  );
  suite.register(
    `${prefix}.webhooks.1`,
    ['items.create'],
    ['item.created'],
    true,
    `signs a ${apiVersion} endpoint snapshot, never retries and redelivers it manually`,
    async () => {
      const received: Received[] = [];
      // Rejects the first attempt, accepts the rest.
      const receiver = await listen(async (request) => {
        received.push({
          id: request.headers.get('webhook-id') ?? '',
          signature: request.headers.get('versioned-signature') ?? '',
          body: await request.text(),
        });

        return new Response(null, {
          status: received.length === 1 ? 500 : 204,
        });
      });

      try {
        await using env = await Emulon.start({
          services: { versioned: versioned() },
        });
        const service = env.services.versioned;

        await service.webhooks.configure({
          id: 'hook',
          url: receiver.url,
          secret: 'whsec',
          apiVersion,
        });
        // The request version differs; the body follows the endpoint's version.
        await service.items.create({ name: 'a', apiVersion: other });

        const [event] = await env.events.list();
        const id = JSON.stringify([event!.id, 'hook']);

        same(
          (await service.webhooks.wait({ id, status: 'failed', timeout: '5s' }))
            .status,
          'failed',
          'first attempt',
        );
        same(received.length, 1, 'no automatic retry');
        await service.webhooks.redeliver({ id });
        await service.webhooks.wait({ id, status: 'succeeded', timeout: '5s' });

        const body = JSON.stringify({
          id: event!.id,
          type: 'item.created',
          apiVersion,
          data: project('a', apiVersion),
        });

        same(received.map((item) => item.body), [body, body], 'bodies');
        same(new Set(received.map((item) => item.id)).size, 1, 'webhook ID');
        same(
          received.map((item) => item.signature),
          [await sign('whsec', body), await sign('whsec', body)],
          'signatures',
        );
      } finally {
        await receiver.stop();
      }
    },
  );

  return suite.cases;
}
