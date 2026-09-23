import { subscriptionPolicy, transport } from './webhooks/mod.ts';
import type { z } from 'zod';
import type { CompatibilityManifest, defineCommand } from 'emulon';
import { definePlugin, destinationFixture } from 'emulon';
import { type Commands, commands } from './commands/mod.ts';
import { fixtures, type Options } from './model/scheduling.ts';
import { compatibility } from './compatibility.ts';
import { routes } from './routes/mod.ts';

const calcom: ReturnType<
  typeof definePlugin<
    Options | undefined,
    Commands & {
      'compatibility.get': ReturnType<
        typeof defineCommand<
          z.ZodObject<Record<string, never>>,
          z.ZodType<CompatibilityManifest>
        >
      >;
    }
  >
> = definePlugin<Options | undefined, Commands>({
  name: '@emulon/calcom',
  apiVersion: 1,
  compatibility,
  capabilities: ['http', 'authorization', 'events', 'webhooks', 'reset'],
  commands,
  subscriptions: subscriptionPolicy,
  transport,
  state: {
    pluginVersion: '0.1.0',
    schemaVersion: 1,
    fixtures: (options) => {
      const rows = fixtures(options);
      const destinations = options?.destinations ?? [];

      if (new Set(destinations.map((d) => d.id)).size !== destinations.length) {
        throw new Error('Duplicate destination ID.');
      }

      return [
        ...rows,
        ...destinations.map((d) => destinationFixture(d, subscriptionPolicy)),
      ];
    },
  },
  async setup(ctx) {
    routes(ctx, ctx.http.surface('api'));

    const api = await ctx.http.listen('api');

    return {
      endpoints: { api },
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  },
});

export default calcom;
