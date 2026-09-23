import type { z } from 'zod';
import type { CompatibilityManifest, defineCommand } from 'emulon';
import { compatibility } from './compatibility.ts';
import { authorizationRoutes } from './routes/authorization.ts';
import {
  subscriptionPolicy,
  transport,
  webhookFixtures,
} from './webhooks/mod.ts';
import { bindIssueSurfaces } from './model/issues.ts';
import { definePlugin } from 'emulon';
import { type Commands, commands } from './commands/mod.ts';
import { fixtures, validateFixtures } from './model/fixtures.ts';
import type { Options } from './model/schema.ts';
import { routes } from './routes/mod.ts';

const factory: ReturnType<
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
  name: '@emulon/github',
  apiVersion: 1,
  compatibility,
  capabilities: ['http', 'reset', 'authorization', 'events', 'webhooks'],
  commands,
  subscriptions: subscriptionPolicy,
  transport,
  state: {
    pluginVersion: '0.1.0',
    schemaVersion: 1,
    fixtures: (
      options,
    ) => [...fixtures(options), ...webhookFixtures(options)],
  },
  async setup(ctx) {
    routes(ctx.http.surface('api'), ctx);

    const webSurface = ctx.http.surface('web');

    routes(webSurface);
    authorizationRoutes(webSurface, ctx);

    const api = await ctx.http.listen('api');
    const web = await ctx.http.listen('web');

    bindIssueSurfaces(ctx, { api, web });

    return {
      endpoints: { api, web },
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
  },
});

export default function github(options?: Options): ReturnType<typeof factory> {
  validateFixtures(options);
  webhookFixtures(options);

  return factory(options);
}
