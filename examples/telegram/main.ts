import { Emulon } from 'emulon';
import telegram from '@emulon/telegram';
import { Bot } from 'grammy';
import { splitMessage, toTelegramMarkdownV2 } from 'md-to-telegram';

const channel = {
  id: -1001234567890,
  title: 'Local News',
  username: 'local_news',
};

const markdown = `# Release notes 🚀

The **local** Bot API now answers \`getUpdates\`, see the
[guide](https://example.com/guide_(v1)).

> Reactions arrive as absolute counts.`;

/**
 * Reads reaction counts until an empty batch, starting from the stored offset
 * or, on a first run, from the oldest unconfirmed update. Every call names the
 * update types it wants, since the default leaves reaction counts out.
 */
async function drain(bot: Bot, stored: number | undefined) {
  const updates = [];
  let offset = stored;

  while (true) {
    const batch = await bot.api.getUpdates({
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout: 0,
      allowed_updates: ['message_reaction_count'],
    });

    if (batch.length === 0) {
      return { updates, offset };
    }

    updates.push(...batch);

    offset = batch.at(-1)!.update_id + 1;
  }
}

export async function runExample() {
  await using env = await Emulon.start({
    services: { tg: telegram({ fixtures: { channels: [channel] } }) },
  });
  const { token } = await env.services.tg.bots.create({
    username: 'poster_bot',
    firstName: 'Poster',
  });
  const bot = new Bot(token, { client: { apiRoot: env.endpoints.tg.api! } });

  // The first run subscribes before any reaction exists and finds nothing.
  const subscribed = await drain(bot, undefined);
  const parts = splitMessage(toTelegramMarkdownV2(markdown).text, {
    format: 'markdownv2',
  });
  const posted = [];

  for (const part of parts) {
    posted.push(
      await bot.api.sendMessage(`@${channel.username}`, part, {
        parse_mode: 'MarkdownV2',
        disable_notification: true,
        link_preview_options: { is_disabled: false },
      }),
    );
  }

  // A reader reacts; locally that is the reactions.set command.
  await env.services.tg.reactions.set({
    chatId: channel.id,
    messageId: posted[0]!.message_id,
    reactions: [
      { type: { type: 'emoji', emoji: '👍' }, total_count: 3 },
      { type: { type: 'emoji', emoji: '🔥' }, total_count: 1 },
    ],
  });

  const received = await drain(bot, subscribed.offset);

  return {
    posted: posted.map(({ message_id, chat, text, entities }) => ({
      message_id,
      chat: `@${'username' in chat ? chat.username : chat.id}`,
      text,
      entities,
    })),
    updates: received.updates,
    nextOffset: received.offset,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await runExample(), null, 2));
}
