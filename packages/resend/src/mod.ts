import type { z } from 'zod';
import type { CompatibilityManifest, defineCommand } from 'emulon';
import { compatibility } from './compatibility.ts';
import { definePlugin, destinationFixture } from 'emulon';
import { type Commands, commands } from './commands/mod.ts';
import { fixtures, type Options } from './model/emails.ts';
import { subscriptionPolicy, transport } from './webhooks.ts';
import { routes } from './routes/emails.ts';

const resend: ReturnType<
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
  name: '@emulon/resend',
  apiVersion: 1,
  compatibility,
  capabilities: [
    'http',
    'authorization',
    'events',
    'webhooks',
    'faults',
    'reset',
  ],
  commands,
  subscriptions: subscriptionPolicy,
  transport,
  state: {
    pluginVersion: '0.1.0',
    schemaVersion: 2,
    fixtures: (options) => {
      const destinations = options?.destinations ?? [];

      if (
        new Set(destinations.map((d) => d.id)).size !== destinations.length
      ) {
        throw new Error('Duplicate destination ID.');
      }

      return [
        ...fixtures(options),
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

export default resend;
