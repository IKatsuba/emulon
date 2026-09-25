// Bot API envelopes are snake_case on the wire.
// deno-lint-ignore-file camelcase
import telegram from '@emulon/telegram';
import { Emulon } from 'emulon';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { parseMarkdownV2 } from '../src/format/markdown_v2.ts';
import { assert, equal } from './assert.ts';
import { channel } from './bot_cases.ts';
import { Bot, GrammyError } from './grammy.ts';
import { parts } from './post.ts';

export const { cases, register } = caseRegistry(
  'packages/telegram/tests/message_cases.ts',
);

const other = { id: -1009876543210, title: 'Other', username: 'OtherNews' };

const config = () => ({
  services: {
    tg: telegram({ fixtures: { channels: [channel, other] } }),
  },
});

const client = (apiRoot: string, token: string) =>
  new Bot(token, { client: { apiRoot } });

async function grammyFailure(
  call: () => Promise<unknown>,
): Promise<{ error_code: number; description: string }> {
  try {
    await call();
  } catch (error) {
    assert(error instanceof GrammyError, `Not a GrammyError: ${error}`);

    return { error_code: error.error_code, description: error.description };
  }

  throw new Error('Expected a Bot API failure');
}

const post = {
  parse_mode: 'MarkdownV2',
  disable_notification: true,
  link_preview_options: { is_disabled: false },
} as const;

register(
  'telegram.messages.1',
  ['sendMessage'],
  [],
  false,
  'a split md-to-telegram post reaches a channel by ID and @username with increasing IDs, listed alike by CLI and SDK, across restart',
  async () => {
    const directory = await Deno.makeTempDir();
    const configured = config();
    let host = await serveEnvironment(configured, { directory });
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
      const issued = await connected.services.tg.bots.create({
        username: 'poster_bot',
        firstName: 'Poster',
      });
      const bot = client(connected.endpoints.tg.api!, issued.token);
      const me = await bot.api.getMe();

      assert(parts.length > 2, 'The post was not split');

      const sent = [];

      for (const [index, part] of parts.entries()) {
        // Alternate both address forms; the username is case-insensitive.
        const chat = index % 2 === 0 ? channel.id : '@LOCAL_NEWS';

        sent.push(await bot.api.sendMessage(chat, part, post));
      }

      equal(
        sent.map((message) => message.message_id),
        [
          ...parts.keys(),
        ].map((index) => index + 1),
      );

      const expectedChat = {
        id: channel.id,
        title: channel.title,
        username: channel.username,
        type: 'channel',
      };

      for (const [index, message] of sent.entries()) {
        const rendered = parseMarkdownV2(parts[index]!);

        equal(message.chat, expectedChat);
        equal(message.sender_chat, expectedChat);
        equal(message.from, {
          id: me.id,
          is_bot: true,
          first_name: me.first_name,
          username: me.username,
        });
        equal(message.text, rendered.text);
        equal(message.entities, rendered.entities);
        assert(
          Math.abs(message.date - Date.now() / 1000) < 60,
          'Unexpected date',
        );
      }

      // Another channel keeps its own sequence; plain text has no entities.
      const plain = await bot.api.sendMessage(other.id, '*not bold*.');

      equal(plain.message_id, 1);
      equal(plain.text, '*not bold*.');
      assert(!('entities' in plain), 'Plain text has entities');

      const expected = sent.map((message, index) => ({
        chatId: channel.id,
        messageId: message.message_id,
        botId: issued.id,
        date: message.date,
        parseMode: 'MarkdownV2',
        source: parts[index],
        text: message.text,
        entities: message.entities,
      }));
      const fromSDK = await connected.services.tg.messages.list({
        chatId: channel.id,
      });

      equal(fromSDK, expected);
      equal(
        await cli(['tg', 'messages', 'list', '--chat-id', String(channel.id)]),
        expected,
      );
      equal(
        await cli([
          'tg',
          'messages',
          'list',
          '--chat-id',
          String(channel.id),
          '--limit',
          '2',
        ]),
        expected.slice(-2),
      );
      equal(
        (await connected.services.tg.messages.list({
          chatId: other.id,
          limit: 1,
        })).map((message) => [message.parseMode, message.source]),
        [[null, '*not bold*.']],
      );

      await host.dispose();

      host = await serveEnvironment(configured, { directory });

      await using restarted = await Emulon.connect({
        config: configured,
        directory,
      });
      const again = client(restarted.endpoints.tg.api!, issued.token);

      // A durable restart continues each chat's sequence.
      equal(
        (await again.api.sendMessage('@local_news', 'after restart'))
          .message_id,
        parts.length + 1,
      );
      equal(
        (await restarted.services.tg.messages.list({ chatId: channel.id }))
          .length,
        parts.length + 1,
      );
    } finally {
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'telegram.messages.2',
  ['sendMessage'],
  [],
  false,
  'bad markup, oversized text, unknown chats and unsupported fields fail with Bot API descriptions, write nothing and spend no ID',
  async () => {
    await using env = await Emulon.start(config());
    const api = env.endpoints.tg.api!;
    const { token } = await env.services.tg.bots.create({
      username: 'poster_bot',
      firstName: 'Poster',
    });
    const bot = client(api, token);
    const parse = {
      error_code: 400,
      description: "Bad Request: can't parse entities",
    };
    const tooLong = {
      error_code: 400,
      description: 'Bad Request: message is too long',
    };
    const unsupported = {
      error_code: 501,
      description: 'Not Implemented: parameter is not emulated',
    };

    equal((await bot.api.sendMessage(channel.id, 'first')).message_id, 1);

    for (
      const [call, expected] of [
        [() => bot.api.sendMessage(channel.id, 'Unescaped.', post), parse],
        [() => bot.api.sendMessage(channel.id, '*unclosed', post), parse],
        [
          () => bot.api.sendMessage(channel.id, '\\.'.repeat(4097), post),
          tooLong,
        ],
        [() => bot.api.sendMessage(channel.id, 'x'.repeat(4097)), tooLong],
        // The syntax error wins over the length.
        [
          () => bot.api.sendMessage(channel.id, `${'x'.repeat(5000)}!`, post),
          parse,
        ],
        [() => bot.api.sendMessage(channel.id, '**', post), {
          error_code: 400,
          description: 'Bad Request: message text is empty',
        }],
        [() => bot.api.sendMessage(-1001, 'x'), {
          error_code: 400,
          description: 'Bad Request: chat not found',
        }],
        [() => bot.api.sendMessage('@nobody_here', 'x'), {
          error_code: 400,
          description: 'Bad Request: chat not found',
        }],
        [
          () =>
            bot.api.sendMessage(channel.id, 'x', {
              reply_markup: { inline_keyboard: [] },
            }),
          unsupported,
        ],
        [
          () =>
            bot.api.sendMessage(channel.id, 'x', {
              link_preview_options: { is_disabled: true },
            }),
          unsupported,
        ],
        [
          () =>
            bot.api.sendMessage(channel.id, 'x', {
              entities: [{ type: 'bold', offset: 0, length: 1 }],
            }),
          unsupported,
        ],
        [() => bot.api.sendMessage(channel.id, 'x', { parse_mode: 'HTML' }), {
          error_code: 501,
          description: 'Not Implemented: parse mode is not emulated',
        }],
      ] as const
    ) {
      equal(await grammyFailure(call), expected);
    }

    // Exactly 4096 rendered units passes even though the source is longer.
    const limit = await bot.api.sendMessage(
      channel.id,
      '\\.'.repeat(4096),
      post,
    );

    equal([limit.message_id, limit.text.length], [2, 4096]);
    equal(
      (await env.services.tg.messages.list({ chatId: channel.id })).map((
        message,
      ) => message.messageId),
      [1, 2],
    );

    // Listing an unknown channel is a command error, not an empty list.
    let listed = false;

    try {
      await env.services.tg.messages.list({ chatId: -1001 });

      listed = true;
    } catch (error) {
      equal((error as { code?: unknown }).code, 'CHAT_NOT_FOUND');
    }

    assert(!listed, 'Listed an unknown channel');
  },
);

register(
  'telegram.messages.3',
  ['sendMessage'],
  [],
  false,
  'concurrent sends from two bots share one gapless per-chat sequence and reset clears it',
  async () => {
    await using env = await Emulon.start(config());
    const api = env.endpoints.tg.api!;
    const bots = await Promise.all(
      ['one_bot', 'two_bot'].map(async (username) =>
        client(
          api,
          (await env.services.tg.bots.create({ username, firstName: 'B' }))
            .token,
        )
      ),
    );
    const sent = await Promise.all(
      Array.from(
        { length: 20 },
        (_, i) =>
          bots[i % 2]!.api.sendMessage(
            i % 3 === 0 ? '@local_news' : channel.id,
            `message ${i}`,
          ),
      ),
    );

    equal(
      sent.map((message) => message.message_id).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );

    const listed = await env.services.tg.messages.list({ chatId: channel.id });

    equal(
      listed.map((message) => message.messageId),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );

    // Each listed message is the one its response described.
    for (const message of sent) {
      equal(
        listed.find((entry) => entry.messageId === message.message_id)?.text,
        message.text,
      );
    }

    await env.reset();

    equal(await env.services.tg.messages.list({ chatId: channel.id }), []);

    const { token } = await env.services.tg.bots.create({
      username: 'one_bot',
      firstName: 'B',
    });

    equal(
      (await client(api, token).api.sendMessage(channel.id, 'fresh'))
        .message_id,
      1,
    );
  },
);
