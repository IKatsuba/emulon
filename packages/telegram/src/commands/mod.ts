import { defineCommand } from 'emulon';
import { z } from 'zod';
import {
  createBot,
  type CreateInput,
  createInput,
  type IssuedBot,
  issuedSchema,
} from '../model/bots.ts';
import {
  type ListInput,
  listInput,
  listMessages,
  type StoredMessage,
  storedSchema,
} from '../model/messages.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = {
  'bots.create': Operation<CreateInput, IssuedBot>;
  'messages.list': Operation<ListInput, StoredMessage[]>;
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
  'messages.list': defineCommand({
    description:
      'List the most recent messages of a channel by ID, oldest first',
    input: listInput,
    output: z.array(storedSchema),
    cli: {
      path: ['messages', 'list'],
      flags: { 'chat-id': 'chatId', limit: 'limit' },
    },
    execute: (ctx, input) => listMessages(ctx.store, input),
  }),
};
