// Bot API objects are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import { DomainError, type PluginContext } from 'emulon';
import {
  MarkdownError,
  type MessageEntity,
  parseMarkdownV2,
} from '../format/markdown_v2.ts';
import { type Bot, type BotUser, botUser } from './bots.ts';
import { type Channel, channelSchema, usernameKey } from './channels.ts';

type Store = PluginContext['store'];
type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];

/** Telegram's limit on message text, in UTF-16 code units after parsing. */
export const maxTextLength = 4096;

/**
 * A rejected send. The route turns it into a Bot API envelope; the reason is
 * one of the fixed descriptions below and never contains caller input.
 */
export class SendError extends Error {
  constructor(
    readonly status: 400 | 501,
    readonly description: string,
  ) {
    super(description);
  }
}

const badRequest = (reason: string) =>
  new SendError(400, `Bad Request: ${reason}`);

export const sendErrors = {
  parse: () => badRequest("can't parse entities"),
  tooLong: () => badRequest('message is too long'),
  empty: () => badRequest('message text is empty'),
  chatEmpty: () => badRequest('chat_id is empty'),
  chatNotFound: () => badRequest('chat not found'),
  parseMode: () => badRequest('unsupported parse_mode'),
  invalid: () => badRequest('invalid parameter value'),
  unsupported: () =>
    new SendError(501, 'Not Implemented: parameter is not emulated'),
  unsupportedMode: () =>
    new SendError(501, 'Not Implemented: parse mode is not emulated'),
} as const;

export type ParseMode = 'MarkdownV2' | null;

export interface Rendered {
  text: string;
  entities: MessageEntity[];
}

/**
 * Parsing comes before the length rule, so malformed markup is reported even
 * when it is also too long; the limit counts rendered text only.
 */
export function render(source: string, parseMode: ParseMode): Rendered {
  let rendered: Rendered;

  if (parseMode === 'MarkdownV2') {
    try {
      rendered = parseMarkdownV2(source);
    } catch (error) {
      if (error instanceof MarkdownError) {
        throw sendErrors.parse();
      }

      throw error;
    }
  } else {
    rendered = { text: source, entities: [] };
  }

  if (rendered.text.length === 0) {
    throw sendErrors.empty();
  }

  if (rendered.text.length > maxTextLength) {
    throw sendErrors.tooLong();
  }

  return rendered;
}

/** A `chat_id` as a channel ID, or a lowercase username without `@`. */
export type ChatReference = { id: number } | { username: string };

export function chatReference(value: unknown): ChatReference | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { id: value } : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  if (/^-?[1-9][0-9]*$/.test(value)) {
    const id = Number(value);

    return Number.isSafeInteger(id) ? { id } : null;
  }

  return value.startsWith('@') && value.length > 1
    ? { username: usernameKey(value.slice(1)) }
    : null;
}

export interface SendRequest {
  chat: ChatReference;
  source: string;
  parseMode: ParseMode;
}

const accepted = new Set([
  'chat_id',
  'text',
  'parse_mode',
  'disable_notification',
  'link_preview_options',
]);

/**
 * Only the fields the declared consumer sends are emulated. Any other field,
 * or a value that would change behavior the emulator does not model, is
 * refused instead of being silently ignored.
 */
export function sendRequest(params: Record<string, unknown>): SendRequest {
  if (Object.keys(params).some((key) => !accepted.has(key))) {
    throw sendErrors.unsupported();
  }

  const {
    chat_id,
    text,
    parse_mode,
    disable_notification,
    link_preview_options,
  } = params;

  if (disable_notification !== undefined) {
    if (typeof disable_notification !== 'boolean') {
      throw sendErrors.invalid();
    }
  }

  if (link_preview_options !== undefined) {
    if (
      typeof link_preview_options !== 'object' ||
      link_preview_options === null || Array.isArray(link_preview_options)
    ) {
      throw sendErrors.invalid();
    }

    const options = link_preview_options as Record<string, unknown>;

    if (
      Object.keys(options).some((key) => key !== 'is_disabled') ||
      (options.is_disabled !== undefined && options.is_disabled !== false)
    ) {
      throw sendErrors.unsupported();
    }
  }

  let parseMode: ParseMode = null;

  if (parse_mode !== undefined && parse_mode !== '') {
    if (typeof parse_mode !== 'string') {
      throw sendErrors.invalid();
    }

    // The Bot API compares parse modes without regard to case.
    const mode = parse_mode.toLowerCase();

    if (mode === 'html' || mode === 'markdown') {
      throw sendErrors.unsupportedMode();
    }

    if (mode !== 'markdownv2') {
      throw sendErrors.parseMode();
    }

    parseMode = 'MarkdownV2';
  }

  if (chat_id === undefined || chat_id === '') {
    throw sendErrors.chatEmpty();
  }

  const chat = chatReference(chat_id);

  if (!chat) {
    throw sendErrors.chatNotFound();
  }

  if (text === undefined || text === '') {
    throw sendErrors.empty();
  }

  if (typeof text !== 'string') {
    throw sendErrors.invalid();
  }

  return { chat, source: text, parseMode };
}

export const entitySchema: z.ZodType<MessageEntity, MessageEntity> = z
  .strictObject({
    type: z.enum([
      'bold',
      'italic',
      'underline',
      'strikethrough',
      'spoiler',
      'code',
      'pre',
      'text_link',
      'blockquote',
      'expandable_blockquote',
    ]),
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive(),
    url: z.string().optional(),
    language: z.string().optional(),
  }) as z.ZodType<MessageEntity, MessageEntity>;

/** A stored channel post: what was submitted and what Telegram would show. */
export interface StoredMessage {
  chatId: number;
  messageId: number;
  botId: number;
  date: number;
  parseMode: ParseMode;
  source: string;
  text: string;
  entities: MessageEntity[];
}

export const storedSchema: z.ZodType<StoredMessage, StoredMessage> = z
  .strictObject({
    chatId: z.number().int(),
    messageId: z.number().int().positive(),
    botId: z.number().int().positive(),
    date: z.number().int().nonnegative(),
    parseMode: z.literal('MarkdownV2').nullable(),
    source: z.string(),
    text: z.string(),
    entities: z.array(entitySchema),
  });

export interface ChatView {
  id: number;
  title: string;
  username: string;
  type: 'channel';
}

/** The Bot API `Message` returned by `sendMessage`. */
export interface MessageView {
  message_id: number;
  from: Pick<BotUser, 'id' | 'is_bot' | 'first_name' | 'username'>;
  sender_chat: ChatView;
  chat: ChatView;
  date: number;
  text: string;
  entities?: MessageEntity[];
}

export function chatView(channel: Channel): ChatView {
  return {
    id: channel.id,
    title: channel.title,
    username: channel.username,
    type: 'channel',
  };
}

export function messageView(
  message: StoredMessage,
  channel: Channel,
  bot: Bot,
): MessageView {
  const user = botUser(bot);

  return {
    message_id: message.messageId,
    from: {
      id: user.id,
      is_bot: true,
      first_name: user.first_name,
      username: user.username,
    },
    sender_chat: chatView(channel),
    chat: chatView(channel),
    date: message.date,
    text: message.text,
    ...(message.entities.length > 0 ? { entities: message.entities } : {}),
  };
}

export async function findChannel(
  tx: Transaction,
  chat: ChatReference,
): Promise<Channel | null> {
  if ('id' in chat) {
    const row = await tx.get('channels', String(chat.id));

    return row === undefined ? null : channelSchema.parse(row);
  }

  const channels = (await tx.list('channels')).map((row) =>
    channelSchema.parse(row.value)
  );

  return channels.find((channel) =>
    usernameKey(channel.username) === chat.username
  ) ?? null;
}

/** Message IDs sort as text in store order and as numbers in the key. */
export const messageKey = (chatId: number, messageId: number): string =>
  `${chatId}:${String(messageId).padStart(16, '0')}`;

const sequenceSchema = z.strictObject({
  next: z.number().int().positive(),
});

/**
 * The chat lookup, rendering, ID allocation and message write share one
 * transaction: a rejected send leaves no trace and allocates no ID, and
 * concurrent sends to one chat never share or skip an ID.
 */
export async function sendMessage(
  store: Store,
  bot: Bot,
  request: SendRequest,
  now: number,
): Promise<MessageView> {
  return await store.transaction(async (tx) => {
    const channel = await findChannel(tx, request.chat);

    if (!channel) {
      throw sendErrors.chatNotFound();
    }

    const rendered = render(request.source, request.parseMode);
    const sequence = await tx.get('messageSequences', String(channel.id));
    const messageId = sequence === undefined
      ? 1
      : sequenceSchema.parse(sequence).next;
    const message: StoredMessage = {
      chatId: channel.id,
      messageId,
      botId: bot.id,
      date: Math.floor(now / 1000),
      parseMode: request.parseMode,
      source: request.source,
      text: rendered.text,
      entities: rendered.entities,
    };

    await tx.put({
      collection: 'messageSequences',
      id: String(channel.id),
      value: { next: messageId + 1 },
    });
    await tx.put({
      collection: 'messages',
      id: messageKey(channel.id, messageId),
      value: message,
    });

    return messageView(message, channel, bot);
  });
}

export const listInput: z.ZodType<ListInput, ListInput> = z.strictObject({
  chatId: z.number().int(),
  limit: z.number().int().min(1).max(100).optional(),
});

export interface ListInput {
  chatId: number;
  limit?: number | undefined;
}

/**
 * The most recent `limit` messages (default 100) of one channel, oldest
 * first, so a multipart post reads in the order it was sent.
 */
export async function listMessages(
  store: Store,
  raw: ListInput,
): Promise<StoredMessage[]> {
  const input = listInput.parse(raw);

  return await store.transaction(async (tx) => {
    const channel = await findChannel(tx, { id: input.chatId });

    if (!channel) {
      throw new DomainError('CHAT_NOT_FOUND', 'No such channel.');
    }

    const messages = (await tx.list('messages'))
      .map((row) => storedSchema.parse(row.value))
      .filter((message) => message.chatId === channel.id)
      .sort((a, b) => a.messageId - b.messageId);

    return messages.slice(-(input.limit ?? 100));
  });
}
