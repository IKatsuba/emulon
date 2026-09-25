import { z } from 'zod';
import { DomainError, type PluginContext } from 'emulon';
import { botSchema } from './bots.ts';
import { chatView, findChannel, messageKey } from './messages.ts';
import {
  enqueue,
  queueOf,
  type ReactionCount,
  reactionCountSchema,
  type ReactionType,
  receives,
} from './updates.ts';

type Store = PluginContext['store'];

export const reactionsInput: z.ZodType<ReactionsInput, ReactionsInput> = z
  .strictObject({
    chatId: z.number().int(),
    messageId: z.number().int().positive().safe(),
    reactions: z.array(reactionCountSchema).max(100),
  });

export interface ReactionsInput {
  chatId: number;
  messageId: number;
  reactions: ReactionCount[];
}

export interface ReactionsResult {
  chatId: number;
  messageId: number;
  reactions: ReactionCount[];
  changed: boolean;
  queued: number;
}

export const reactionsResultSchema: z.ZodType<
  ReactionsResult,
  ReactionsResult
> = z.strictObject({
  chatId: z.number().int(),
  messageId: z.number().int().positive(),
  reactions: z.array(reactionCountSchema),
  changed: z.boolean(),
  queued: z.number().int().nonnegative(),
});

const kinds: ReactionType['type'][] = ['paid', 'emoji', 'custom_emoji'];

function canonicalType(type: ReactionType): ReactionType {
  switch (type.type) {
    case 'emoji':
      return { type: 'emoji', emoji: type.emoji };
    case 'custom_emoji':
      return { type: 'custom_emoji', custom_emoji_id: type.custom_emoji_id };
    case 'paid':
      return { type: 'paid' };
  }
}

const reactionKey = (type: ReactionType) => `${type.type}:${reactionId(type)}`;

function reactionId(type: ReactionType): string {
  switch (type.type) {
    case 'emoji':
      return type.emoji;
    case 'custom_emoji':
      return type.custom_emoji_id;
    case 'paid':
      return '';
  }
}

/**
 * The stored form of an absolute snapshot: zero counts are dropped, and the
 * rest are ordered by count, then paid before emoji before custom emoji, then
 * by emoji or ID, so equal snapshots compare equal. A type listed twice is
 * ambiguous and refused.
 */
export function normalizeReactions(
  reactions: readonly ReactionCount[],
): ReactionCount[] {
  const seen = new Set<string>();

  for (const { type } of reactions) {
    const key = reactionKey(type);

    if (seen.has(key)) {
      throw new DomainError(
        'DUPLICATE_REACTION',
        'Each reaction type may appear only once.',
      );
    }

    seen.add(key);
  }

  const id = (reaction: ReactionCount) => reactionId(reaction.type);

  return reactions
    .filter((reaction) => reaction.total_count > 0)
    .map((reaction) => ({
      type: canonicalType(reaction.type),
      total_count: reaction.total_count,
    }))
    .sort((a, b) =>
      b.total_count - a.total_count ||
      kinds.indexOf(a.type.type) - kinds.indexOf(b.type.type) ||
      (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0)
    );
}

function sameReactions(
  a: readonly ReactionCount[],
  b: readonly ReactionCount[],
): boolean {
  return a.length === b.length &&
    a.every((reaction, index) =>
      reactionKey(reaction.type) === reactionKey(b[index]!.type) &&
      reaction.total_count === b[index]!.total_count
    );
}

const storedSchema = z.strictObject({
  reactions: z.array(reactionCountSchema),
});

/**
 * Replaces a message's aggregate counts. The check of the target, the counts
 * and the update of every subscribed bot commit together, so a poll either
 * sees the new counts in its queue or not at all. An unchanged snapshot queues
 * nothing.
 */
export async function setReactions(
  store: Store,
  raw: ReactionsInput,
  now: number,
): Promise<ReactionsResult> {
  const input = reactionsInput.parse(raw);
  const reactions = normalizeReactions(input.reactions);

  return await store.transaction(async (tx) => {
    const channel = await findChannel(tx, { id: input.chatId });

    if (!channel) {
      throw new DomainError('CHAT_NOT_FOUND', 'No such channel.');
    }

    const key = messageKey(channel.id, input.messageId);

    if (await tx.get('messages', key) === undefined) {
      throw new DomainError('MESSAGE_NOT_FOUND', 'No such message.');
    }

    const stored = await tx.get('reactions', key);
    const previous = stored === undefined
      ? []
      : storedSchema.parse(stored).reactions;
    const result = {
      chatId: channel.id,
      messageId: input.messageId,
      reactions,
      changed: !sameReactions(previous, reactions),
      queued: 0,
    };

    if (!result.changed) {
      return result;
    }

    await tx.put({ collection: 'reactions', id: key, value: { reactions } });

    const bots = (await tx.list('bots'))
      .map((row) => botSchema.parse(row.value))
      .sort((a, b) => a.id - b.id);

    for (const bot of bots) {
      const queue = await queueOf(tx, bot.id);

      if (!receives(queue, 'message_reaction_count')) {
        continue;
      }

      await enqueue(tx, bot.id, queue, (updateId) => ({
        update_id: updateId,
        message_reaction_count: {
          chat: chatView(channel),
          message_id: input.messageId,
          date: Math.floor(now / 1000),
          reactions,
        },
      }));
      result.queued++;
    }

    return result;
  });
}
