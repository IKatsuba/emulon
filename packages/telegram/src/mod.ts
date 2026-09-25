import type { z } from 'zod';
import type { CompatibilityManifest, defineCommand } from 'emulon';
import { definePlugin } from 'emulon';
import { type Commands, commands } from './commands/mod.ts';
import { compatibility } from './compatibility.ts';
import { channelFixtures, type Options } from './model/channels.ts';
import { routes } from './routes/api.ts';

const telegram: ReturnType<
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
  name: '@emulon/telegram',
  apiVersion: 1,
  compatibility,
  capabilities: ['http', 'authorization', 'reset'],
  commands,
  state: {
    pluginVersion: '0.1.0',
    schemaVersion: 1,
    // Bots are never fixtures: reset removes them and every issued token.
    fixtures: channelFixtures,
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

export default telegram;
