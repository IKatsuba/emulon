import { defineCommand } from 'emulon';
import type { z } from 'zod';
import {
  createBot,
  type CreateInput,
  createInput,
  type IssuedBot,
  issuedSchema,
} from '../model/bots.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = {
  'bots.create': Operation<CreateInput, IssuedBot>;
};

export const commands: Commands = {
  'bots.create': defineCommand({
    description:
      'Create a bot administering every configured channel and issue its token once (explicit secret output)',
    input: createInput,
    output: issuedSchema,
    cli: {
      path: ['bots', 'create'],
      flags: { username: 'username', 'first-name': 'firstName' },
    },
    execute: (ctx, input) => createBot(ctx.store, input),
  }),
};
