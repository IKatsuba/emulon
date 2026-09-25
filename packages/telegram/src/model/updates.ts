// Bot API objects are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import { DomainError, type PluginContext } from 'emulon';
import { botSchema } from './bots.ts';
import type { ChatView } from './messages.ts';

type Store = PluginContext['store'];
type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];

/**
 * Every update type typed by `@grammyjs/types@3.28.0`; a test keeps this list
 * equal to those types. Only `message_reaction_count` is ever generated.
 */
export const updateTypes = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'guest_message',
  'message_reaction',
  'message_reaction_count',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'managed_bot',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
  'purchased_paid_media',
] as const;

export type UpdateType = typeof updateTypes[number];

/** The reaction emoji typed by `@grammyjs/types@3.28.0`. */
export const reactionEmoji = [
  '👍',
  '👎',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤‍🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨‍💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷‍♂',
  '🤷',
  '🤷‍♀',
  '😡',
] as const;

export type ReactionType =
  | { type: 'emoji'; emoji: typeof reactionEmoji[number] }
  | { type: 'custom_emoji'; custom_emoji_id: string }
  | { type: 'paid' };

export interface ReactionCount {
  type: ReactionType;
  total_count: number;
}

export const reactionTypeSchema: z.ZodType<ReactionType, ReactionType> = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('emoji'), emoji: z.enum(reactionEmoji) }),
    z.strictObject({
      type: z.literal('custom_emoji'),
      custom_emoji_id: z.string().regex(/^[0-9]{1,20}$/),
    }),
    z.strictObject({ type: z.literal('paid') }),
  ]);

export const reactionCountSchema: z.ZodType<ReactionCount, ReactionCount> = z
  .strictObject({
    type: reactionTypeSchema,
    total_count: z.number().int().nonnegative().safe(),
  });

export interface ReactionCountUpdate {
  update_id: number;
  message_reaction_count: {
    chat: ChatView;
    message_id: number;
    date: number;
    reactions: ReactionCount[];
  };
}

export const updateSchema: z.ZodType<ReactionCountUpdate, ReactionCountUpdate> =
  z.strictObject({
    update_id: z.number().int().positive().safe(),
    message_reaction_count: z.strictObject({
      chat: z.strictObject({
        id: z.number().int(),
        title: z.string(),
        username: z.string(),
        type: z.literal('channel'),
      }),
      message_id: z.number().int().positive(),
      date: z.number().int().nonnegative(),
      reactions: z.array(reactionCountSchema),
    }),
  });

/** A rejected `getUpdates`; descriptions are fixed and never echo input. */
export class UpdatesError extends Error {
  constructor(
    readonly status: 400 | 409 | 501 | 503,
    readonly description: string,
  ) {
    super(description);
  }
}

export const updatesErrors = {
  invalid: () => new UpdatesError(400, 'Bad Request: invalid parameter value'),
  limit: () =>
    new UpdatesError(400, 'Bad Request: limit must be between 1 and 100'),
  allowedUpdates: () =>
    new UpdatesError(400, 'Bad Request: invalid allowed_updates'),
  unsupported: () =>
    new UpdatesError(501, 'Not Implemented: parameter is not emulated'),
  conflict: () =>
    new UpdatesError(
      409,
      'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
    ),
  cancelled: () =>
    new UpdatesError(503, 'Service Unavailable: the request was cancelled'),
} as const;

export interface UpdatesRequest {
  offset?: number;
  limit: number;
  timeout: number;
  allowedUpdates?: UpdateType[];
}

const accepted = new Set(['offset', 'limit', 'timeout', 'allowed_updates']);
const known = new Set<string>(updateTypes);

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/** Only the documented polling fields; anything else is refused, not ignored. */
export function updatesRequest(
  params: Record<string, unknown>,
): UpdatesRequest {
  if (Object.keys(params).some((key) => !accepted.has(key))) {
    throw updatesErrors.unsupported();
  }

  const { offset, limit, timeout, allowed_updates } = params;
  const request: UpdatesRequest = { limit: 100, timeout: 0 };

  if (offset !== undefined) {
    if (!isInteger(offset)) {
      throw updatesErrors.invalid();
    }

    request.offset = offset;
  }

  if (limit !== undefined) {
    if (!isInteger(limit) || limit < 1 || limit > 100) {
      throw updatesErrors.limit();
    }

    request.limit = limit;
  }

  if (timeout !== undefined) {
    if (!isInteger(timeout) || timeout < 0) {
      throw updatesErrors.invalid();
    }

    request.timeout = timeout;
  }

  if (allowed_updates !== undefined) {
    if (
      !Array.isArray(allowed_updates) ||
      allowed_updates.some((type) =>
        typeof type !== 'string' || !known.has(type)
      )
    ) {
      throw updatesErrors.allowedUpdates();
    }

    request.allowedUpdates = [...new Set(allowed_updates as UpdateType[])];
  }

  return request;
}

/**
 * Per-bot queue state. An empty `allowedUpdates` is Telegram's default, which
 * leaves out `message_reaction_count`.
 */
export interface Queue {
  nextUpdateId: number;
  allowedUpdates: UpdateType[];
}

const queueSchema: z.ZodType<Queue, Queue> = z.strictObject({
  nextUpdateId: z.number().int().positive().safe(),
  allowedUpdates: z.array(z.enum(updateTypes)),
});

const storedUpdateSchema = z.strictObject({
  botId: z.number().int().positive().safe(),
  update: updateSchema,
});

/** Update IDs sort as text in store order and as numbers in the key. */
const updateKey = (botId: number, updateId: number) =>
  `${botId}:${String(updateId).padStart(16, '0')}`;

export async function queueOf(tx: Transaction, botId: number): Promise<Queue> {
  const row = await tx.get('updateQueues', String(botId));

  return row === undefined
    ? { nextUpdateId: 1, allowedUpdates: [] }
    : queueSchema.parse(row);
}

export function receives(queue: Queue, type: UpdateType): boolean {
  return queue.allowedUpdates.includes(type);
}

/** The bot's queued updates in ID order. */
export async function queued(
  tx: Transaction,
  botId: number,
): Promise<ReactionCountUpdate[]> {
  return (await tx.list('updates'))
    .map((row) => storedUpdateSchema.parse(row.value))
    .filter((row) => row.botId === botId)
    .map((row) => row.update)
    .sort((a, b) => a.update_id - b.update_id);
}

/** Allocates the next update ID of one bot and queues the update it builds. */
export async function enqueue(
  tx: Transaction,
  botId: number,
  queue: Queue,
  build: (updateId: number) => ReactionCountUpdate,
): Promise<void> {
  const update = build(queue.nextUpdateId);

  await tx.put({
    collection: 'updateQueues',
    id: String(botId),
    value: { ...queue, nextUpdateId: queue.nextUpdateId + 1 },
  });
  await tx.put({
    collection: 'updates',
    id: updateKey(botId, update.update_id),
    value: { botId, update },
  });
}

/**
 * The first read of a `getUpdates` call: it confirms by offset, replaces the
 * subscription when one is given, then returns the head of the queue without
 * confirming it.
 */
export async function takeUpdates(
  tx: Transaction,
  botId: number,
  request: Pick<UpdatesRequest, 'offset' | 'limit' | 'allowedUpdates'>,
): Promise<ReactionCountUpdate[]> {
  let updates = await queued(tx, botId);

  if (request.offset !== undefined) {
    const forgotten = request.offset < 0
      ? updates.slice(0, Math.max(0, updates.length + request.offset))
      : updates.filter((update) => update.update_id < request.offset!);

    for (const update of forgotten) {
      await tx.delete('updates', updateKey(botId, update.update_id));
    }

    updates = updates.slice(forgotten.length);
  }

  if (request.allowedUpdates !== undefined) {
    await tx.put({
      collection: 'updateQueues',
      id: String(botId),
      value: {
        ...await queueOf(tx, botId),
        allowedUpdates: request.allowedUpdates,
      },
    });
  }

  return updates.slice(0, request.limit);
}

/** `setTimeout` accepts at most a signed 32-bit millisecond delay. */
const maxDelay = 2 ** 31 - 1;

/**
 * Waits on real time for committed updates. The store listener is attached
 * before every read, so a commit between the read and the wait is not lost.
 * Cancellation is an error, never an empty batch: after a reset the caller
 * must not mistake a cancelled poll for a drained queue.
 */
export async function pollUpdates(
  store: Store,
  botId: number,
  request: UpdatesRequest,
  signal: AbortSignal,
): Promise<ReactionCountUpdate[]> {
  const deadline = performance.now() + request.timeout * 1000;
  let changed = false;
  let wake = () => {};

  const unsubscribe = store.subscribe(() => {
    changed = true;

    wake();
  });

  const cancel = () => wake();

  signal.addEventListener('abort', cancel);

  try {
    let first = true;

    while (true) {
      if (signal.aborted) {
        throw updatesErrors.cancelled();
      }

      changed = false;

      let batch: ReactionCountUpdate[];

      try {
        batch = await store.transaction((tx) =>
          first
            ? takeUpdates(tx, botId, request)
            : takeUpdates(tx, botId, { limit: request.limit })
        );
      } catch (error) {
        throw signal.aborted ? updatesErrors.cancelled() : error;
      }

      first = false;

      if (signal.aborted) {
        throw updatesErrors.cancelled();
      }

      const remaining = deadline - performance.now();

      if (batch.length > 0 || remaining <= 0) {
        return batch;
      }

      if (!changed) {
        let timer: ReturnType<typeof setTimeout> | undefined;

        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, Math.min(remaining, maxDelay));
        });

        clearTimeout(timer);

        wake = () => {};
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    unsubscribe();
  }
}

export const inspectInput: z.ZodType<InspectInput, InspectInput> = z
  .strictObject({
    botId: z.number().int().positive().safe(),
    limit: z.number().int().min(1).max(100).optional(),
  });

export interface InspectInput {
  botId: number;
  limit?: number | undefined;
}

export interface QueueView {
  botId: number;
  allowedUpdates: UpdateType[];
  pending: number;
  updates: ReactionCountUpdate[];
}

export const queueViewSchema: z.ZodType<QueueView, QueueView> = z.strictObject({
  botId: z.number().int().positive().safe(),
  allowedUpdates: z.array(z.enum(updateTypes)),
  pending: z.number().int().nonnegative(),
  updates: z.array(updateSchema),
});

/**
 * The oldest `limit` pending updates (default 100) and the subscription of one
 * bot. Reading confirms nothing and shows no credential.
 */
export async function inspectUpdates(
  store: Store,
  raw: InspectInput,
): Promise<QueueView> {
  const input = inspectInput.parse(raw);

  return await store.transaction(async (tx) => {
    const row = await tx.get('bots', String(input.botId));

    if (row === undefined) {
      throw new DomainError('BOT_NOT_FOUND', 'No such bot.');
    }

    const bot = botSchema.parse(row);
    const updates = await queued(tx, bot.id);

    return {
      botId: bot.id,
      allowedUpdates: (await queueOf(tx, bot.id)).allowedUpdates,
      pending: updates.length,
      updates: updates.slice(0, input.limit ?? 100),
    };
  });
}
