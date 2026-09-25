import telegram from '@emulon/telegram';
import { Emulon } from 'emulon';
import type { ReactionCount, Update } from 'grammy/types';
import { splitMessage, toTelegramMarkdownV2 } from 'md-to-telegram';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { parseMarkdownV2 } from '../src/format/markdown_v2.ts';
import { assert, equal } from './assert.ts';
import { channel } from './bot_cases.ts';
import { Bot } from './grammy.ts';
import { parts } from './post.ts';

export const { cases, register } = caseRegistry(
  'packages/telegram/tests/consumer_cases.ts',
);

type Client = InstanceType<typeof Bot>;

/** The send options of every part the declared consumer publishes. */
const post = {
  parse_mode: 'MarkdownV2',
  disable_notification: true,
  link_preview_options: { is_disabled: false },
} as const;

/**
 * One scheduled run of the declared consumer: it reads reaction counts with
 * the stored offset, or without one on its first run, until an empty batch,
 * and stores `update_id + 1` of the last update it saw.
 */
async function poll(
  bot: Client,
  stored: number | undefined,
): Promise<{ batches: Update[][]; offset: number | undefined }> {
  const batches: Update[][] = [];
  let offset = stored;

  while (true) {
    const batch = await bot.api.getUpdates({
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout: 0,
      allowed_updates: ['message_reaction_count'],
    });

    if (batch.length === 0) {
      return { batches, offset };
    }

    batches.push(batch);

    offset = batch.at(-1)!.update_id + 1;
  }
}

async function publish(bot: Client, chat: number | string, text: string[]) {
  const sent = [];

  for (const part of text) {
    sent.push(await bot.api.sendMessage(chat, part, post));
  }

  return sent;
}

const thumbs = (total_count: number): ReactionCount => ({
  type: { type: 'emoji', emoji: '👍' },
  total_count,
});

register(
  'telegram.consumer.1',
  ['getMe', 'sendMessage', 'getUpdates'],
  [],
  false,
  'the declared consumer publishes split md-to-telegram posts by ID and @username, and drains CLI and SDK reaction counts in 100-update batches across runs',
  async () => {
    const directory = await Deno.makeTempDir();
    const configured = {
      services: { tg: telegram({ fixtures: { channels: [channel] } }) },
    };
    const host = await serveEnvironment(configured, { directory });
    const cli = async (args: string[]) => {
      const result = await runProjectCLI(
        [...args, '--json'],
        undefined,
        directory,
      );

      assert(result.code === 0, result.stderr);

      return JSON.parse(result.stdout);
    };

    try {
      await using connected = await Emulon.connect({
        config: configured,
        directory,
      });
      const tg = connected.services.tg;
      const apiRoot = connected.endpoints.tg.api!;
      const issued = await cli([
        'tg',
        'bots',
        'create',
        '--username',
        'digest_bot',
        '--first-name',
        'Digest',
      ]);

      assert(!apiRoot.endsWith('/'), 'The endpoint ends with a slash');

      const bot = new Bot(issued.token, { client: { apiRoot } });

      equal((await bot.api.getMe()).username, 'digest_bot');

      // The first run has no stored offset; it subscribes and finds nothing.
      const first = await poll(bot, undefined);

      equal(first, { batches: [], offset: undefined });
      equal(
        (await tg.updates.inspect({ botId: issued.id })).allowedUpdates,
        ['message_reaction_count'],
      );

      const digest = await publish(bot, channel.id, parts);
      const notice = splitMessage(
        toTelegramMarkdownV2(
          '**Notice:** the [archive](https://example.com/archive_(2026)) moved.',
        ).text,
        { format: 'markdownv2' },
      );
      const moved = await publish(bot, `@${channel.username}`, notice);
      const sent = [...digest, ...moved];

      assert(digest.length > 2, 'The digest was not split');
      equal(
        sent.map((message) => message.message_id),
        [...sent.keys()].map((index) => index + 1),
      );

      for (const [index, message] of sent.entries()) {
        const rendered = parseMarkdownV2([...parts, ...notice][index]!);

        equal(message.chat.id, channel.id);
        equal([message.text, message.entities], [
          rendered.text,
          rendered.entities,
        ]);
      }

      equal(
        (await cli([
          'tg',
          'messages',
          'list',
          '--chat-id',
          String(channel.id),
        ])).map((message: { source: string }) => message.source),
        [...parts, ...notice],
      );

      // Reaction counts come from the command in both forms; each change of a
      // snapshot is one update, so the queue outgrows one 100-update batch.
      const expected: [number, ReactionCount[]][] = [];

      for (const message of sent) {
        const reactions = [thumbs(message.message_id)];

        await cli([
          'tg',
          'reactions',
          'set',
          '--chat-id',
          String(channel.id),
          '--message-id',
          String(message.message_id),
          '--reactions',
          JSON.stringify(reactions),
        ]);
        expected.push([message.message_id, reactions]);
      }

      for (let count = 1; expected.length < 130; count++) {
        const reactions = [
          thumbs(count),
          {
            type: { type: 'emoji', emoji: '🔥' },
            total_count: 1,
          } satisfies ReactionCount,
        ];

        await tg.reactions.set({
          chatId: channel.id,
          messageId: moved[0]!.message_id,
          reactions,
        });
        expected.push([moved[0]!.message_id, reactions]);
      }

      equal((await tg.updates.inspect({ botId: issued.id })).pending, 130);

      const second = await poll(bot, first.offset);

      equal(second.batches.map((batch) => batch.length), [100, 30]);
      equal(second.offset, 131);

      const drained = second.batches.flat();

      equal(
        drained.map((update) => update.update_id),
        expected.map((_, index) => index + 1),
      );
      equal(
        drained.map((update) => {
          const counted = update.message_reaction_count!;

          assert(
            'username' in counted.chat &&
              counted.chat.username === channel.username,
            'The update has no channel username',
          );

          return [counted.chat.id, counted.message_id, counted.reactions];
        }),
        expected.map(([messageId, reactions]) => [
          channel.id,
          messageId,
          reactions,
        ]),
      );

      // The empty call that ended the run confirmed the whole queue.
      equal((await tg.updates.inspect({ botId: issued.id })).pending, 0);
      equal(await poll(bot, second.offset), {
        batches: [],
        offset: second.offset,
      });

      await tg.reactions.set({
        chatId: channel.id,
        messageId: digest[0]!.message_id,
        reactions: [thumbs(9)],
      });

      const fourth = await poll(bot, second.offset);

      equal(
        fourth.batches.flat().map((update) => [
          update.update_id,
          update.message_reaction_count!.message_id,
          update.message_reaction_count!.reactions,
        ]),
        [[131, digest[0]!.message_id, [thumbs(9)]]],
      );
      equal(fourth.offset, 132);
    } finally {
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  },
);
