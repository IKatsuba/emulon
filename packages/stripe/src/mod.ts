import type { z } from 'zod';
import type { CompatibilityManifest, defineCommand } from 'emulon';
import { definePlugin, destinationFixture } from 'emulon';
import { type Commands, commands } from './commands/mod.ts';
import { fixtures, type Options } from './model/customers.ts';
import { compatibility } from './compatibility.ts';
import { routes } from './routes/api.ts';
import { checkoutPage } from './routes/checkout-page.ts';

import { subscriptionPolicy, transport } from './webhooks/mod.ts';

const stripe: ReturnType<
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
  name: '@emulon/stripe',
  apiVersion: 1,
  compatibility,
  capabilities: ['http', 'authorization', 'events', 'webhooks', 'reset'],
  commands,
  subscriptions: subscriptionPolicy,
  transport,
  state: {
    pluginVersion: '0.1.0',
    schemaVersion: 2,
    fixtures: (options) => {
      const destinations = options?.destinations ?? [];

      if (new Set(destinations.map((d) => d.id)).size !== destinations.length) {
        throw new Error('Duplicate destination ID.');
      }

      return [
        ...fixtures(options),
        ...destinations.map((d) => destinationFixture(d, subscriptionPolicy)),
      ];
    },
  },
  async setup(ctx) {
    let web = '';

    // Session URLs name the hosted page, which listens only after routing.
    routes(
      ctx,
      ctx.http.surface('api'),
      (id) => `${web}/c/pay/${encodeURIComponent(id)}`,
    );
    checkoutPage(ctx, ctx.http.surface('web'));

    const api = await ctx.http.listen('api');

    web = await ctx.http.listen('web');

    return {
      endpoints: { api, web },
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  },
});

export default stripe;
