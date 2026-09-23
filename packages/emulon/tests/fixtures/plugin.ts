import { z } from 'zod';
import { defineCommand, definePlugin, type PluginInstance } from 'emulon';

export const setups: unknown[] = [];

export default definePlugin({
  name: 'test-mail',
  apiVersion: 1,
  capabilities: ['http'],
  commands: {
    send: defineCommand({
      description: 'Send a message',
      input: z.object({}),
      output: z.object({}),
      cli: { path: ['send'], flags: {} },
      execute: () => ({}),
    }),
  },
  setup(_ctx, options: { sender?: string } = {}): Promise<PluginInstance> {
    setups.push(options);

    return Promise.resolve({
      endpoints: {},
      ready: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    });
  },
});
