import { z } from 'zod';

/** Telegram public usernames: 5–32 characters, starting with a letter. */
export const channelUsername: z.ZodType<string, string> = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
);

/** Channel and supergroup IDs are negative with a `-100` decimal prefix. */
export function isChannelId(id: number): boolean {
  return Number.isSafeInteger(id) && id < 0 && /^-100\d+$/.test(String(id));
}

export const channelSchema: z.ZodType<Channel, Channel> = z.strictObject({
  id: z.number().refine(isChannelId),
  title: z.string().min(1).max(128),
  username: channelUsername,
});

export interface Channel {
  id: number;
  title: string;
  username: string;
}

export interface Options {
  fixtures?: { channels?: Channel[] | undefined } | undefined;
}

export const optionsSchema: z.ZodType<Options, Options> = z.strictObject({
  fixtures: z.strictObject({ channels: z.array(channelSchema).optional() })
    .optional(),
});

/** Usernames of bots and channels share one case-insensitive namespace. */
export function usernameKey(username: string): string {
  return username.toLowerCase();
}

/** Fixture errors name the rule, never the configured value. */
export function channelFixtures(
  options?: Options,
): { collection: string; id: string; value: Channel }[] {
  const parsed = optionsSchema.safeParse(options ?? {});

  if (!parsed.success) {
    throw new Error('Invalid Telegram options.');
  }

  const channels = parsed.data.fixtures?.channels ?? [];
  const ids = new Set<number>();
  const usernames = new Set<string>();

  for (const channel of channels) {
    if (ids.has(channel.id)) {
      throw new Error('Duplicate fixture channel ID.');
    }

    if (usernames.has(usernameKey(channel.username))) {
      throw new Error('Duplicate fixture channel username.');
    }

    ids.add(channel.id);
    usernames.add(usernameKey(channel.username));
  }

  return channels.map((channel) => ({
    collection: 'channels',
    id: String(channel.id),
    value: { ...channel },
  }));
}
