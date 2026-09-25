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
import {
  type ReactionsInput,
  reactionsInput,
  type ReactionsResult,
  reactionsResultSchema,
  setReactions,
} from '../model/reactions.ts';
import {
  type InspectInput,
  inspectInput,
  inspectUpdates,
  type QueueView,
  queueViewSchema,
} from '../model/updates.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = {
  'bots.create': Operation<CreateInput, IssuedBot>;
  'messages.list': Operation<ListInput, StoredMessage[]>;
  'reactions.set': Operation<ReactionsInput, ReactionsResult>;
  'updates.inspect': Operation<InspectInput, QueueView>;
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
  'reactions.set': defineCommand({
    description:
      'Replace the absolute reaction counts of a channel message and queue one update per subscribed bot when they change',
    input: reactionsInput,
    output: reactionsResultSchema,
    cli: {
      path: ['reactions', 'set'],
      flags: {
        'chat-id': 'chatId',
        'message-id': 'messageId',
        reactions: 'reactions',
      },
    },
    execute: (ctx, input) => setReactions(ctx.store, input, ctx.clock.now()),
  }),
  'updates.inspect': defineCommand({
    description:
      "Show a bot's pending updates and subscription without confirming them",
    input: inspectInput,
    output: queueViewSchema,
    cli: {
      path: ['updates', 'inspect'],
      flags: { 'bot-id': 'botId', limit: 'limit' },
    },
    execute: (ctx, input) => inspectUpdates(ctx.store, input),
  }),
};
