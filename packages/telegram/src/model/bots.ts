// Bot API objects are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import { DomainError, type PluginContext } from 'emulon';
import {
  issueToken,
  type ParsedToken,
  sameVerifier,
  verifier,
} from '../auth/tokens.ts';
import { channelSchema, usernameKey } from './channels.ts';

type Store = PluginContext['store'];

/** Telegram bot usernames: 5–32 characters that end in `bot`. */
export const botUsername: z.ZodType<string, string> = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/,
);

export const createInput: z.ZodType<CreateInput, CreateInput> = z.strictObject({
  username: botUsername,
  firstName: z.string().min(1).max(64),
});

export interface CreateInput {
  username: string;
  firstName: string;
}

/** The only output that carries the token; it is never readable again. */
export interface IssuedBot {
  id: number;
  username: string;
  token: string;
}

export const issuedSchema: z.ZodType<IssuedBot, IssuedBot> = z.strictObject({
  id: z.number().int().positive().safe(),
  username: z.string(),
  token: z.string(),
});

export const botSchema: z.ZodType<Bot, Bot> = z.strictObject({
  id: z.number().int().positive().safe(),
  username: z.string(),
  firstName: z.string(),
  verifier: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface Bot {
  id: number;
  username: string;
  firstName: string;
  verifier: string;
}

/** The `getMe` projection: a bot without optional capabilities. */
export interface BotUser {
  id: number;
  is_bot: true;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
  can_connect_to_business: boolean;
  has_main_web_app: boolean;
  has_topics_enabled: boolean;
  allows_users_to_create_topics: boolean;
  can_manage_bots: boolean;
  supports_join_request_queries: boolean;
}

/** IDs look like issued Telegram bot IDs and stay far from channel IDs. */
export const firstBotId = 7_000_000_001;

export function nextBotId(existing: readonly Bot[]): number {
  return existing.reduce((next, bot) => Math.max(next, bot.id + 1), firstBotId);
}

export function botUser(bot: Bot): BotUser {
  return {
    id: bot.id,
    is_bot: true,
    first_name: bot.firstName,
    username: bot.username,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

/**
 * The username check, ID allocation and verifier write commit together, so
 * two concurrent creations can never share a username or an ID.
 */
export async function createBot(
  store: Store,
  raw: CreateInput,
): Promise<IssuedBot> {
  const input = createInput.parse(raw);

  return await store.transaction(async (tx) => {
    const bots = (await tx.list('bots')).map((row) =>
      botSchema.parse(row.value)
    );
    const taken = new Set([
      ...bots.map((bot) => usernameKey(bot.username)),
      ...(await tx.list('channels')).map((row) =>
        usernameKey(channelSchema.parse(row.value).username)
      ),
    ]);

    if (taken.has(usernameKey(input.username))) {
      throw new DomainError(
        'USERNAME_TAKEN',
        'A bot or channel already uses this username.',
      );
    }

    const id = nextBotId(bots);
    const token = issueToken(id);
    const bot: Bot = {
      id,
      username: input.username,
      firstName: input.firstName,
      verifier: await verifier(token),
    };

    await tx.put({ collection: 'bots', id: String(id), value: bot });

    return { id, username: bot.username, token };
  });
}

/** The bot a well-formed token names, or null when it names no issued bot. */
export async function authenticate(
  store: Store,
  token: ParsedToken,
): Promise<Bot | null> {
  const presented = await verifier(token.token);

  return await store.transaction(async (tx) => {
    const row = await tx.get('bots', String(token.botId));

    if (row === undefined) {
      return null;
    }

    const bot = botSchema.parse(row);

    return sameVerifier(presented, bot.verifier) ? bot : null;
  });
}
