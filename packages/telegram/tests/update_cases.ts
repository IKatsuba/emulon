// Bot API envelopes are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { connect } from 'node:net';
import telegram from '@emulon/telegram';
import { Emulon } from 'emulon';
import type { ReactionCount, Update } from 'grammy/types';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { assert, equal } from './assert.ts';
import { channel } from './bot_cases.ts';
import { Bot, GrammyError } from './grammy.ts';

export const { cases, register } = caseRegistry(
  'packages/telegram/tests/update_cases.ts',
);

const config = () => ({
  services: { tg: telegram({ fixtures: { channels: [channel] } }) },
});

const client = (apiRoot: string, token: string) =>
  new Bot(token, { client: { apiRoot } });

const subscribe = { allowed_updates: ['message_reaction_count'] } as const;

const thumbs = (total_count: number): ReactionCount => ({
  type: { type: 'emoji', emoji: '👍' },
  total_count,
});

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

async function commandFailure(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }

  throw new Error('Expected a command failure');
}

/** Drains the queue the way a polling consumer does, confirming as it goes. */
async function drain(bot: InstanceType<typeof Bot>): Promise<Update[]> {
  const drained: Update[] = [];
  let offset: number | undefined;

  while (true) {
    const batch = await bot.api.getUpdates({
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout: 0,
    });

    if (batch.length === 0) {
      return drained;
    }

    drained.push(...batch);

    offset = batch.at(-1)!.update_id + 1;
  }
}

/**
 * Sends one getUpdates request on its own connection and returns a function
 * that resets it, as a killed client would.
 */
async function rawPoll(
  apiRoot: string,
  token: string,
  body: unknown,
): Promise<() => void> {
  const url = new URL(apiRoot);
  const payload = JSON.stringify(body);
  const socket = connect({ host: url.hostname, port: Number(url.port) });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.on('error', () => {});

  socket.write(
    [
      `POST /bot${token}/getUpdates HTTP/1.1`,
      `host: ${url.host}`,
      'content-type: application/json',
      `content-length: ${new TextEncoder().encode(payload).length}`,
      '',
      payload,
    ].join('\r\n'),
  );

  return () => socket.resetAndDestroy();
}

const conflict = {
  error_code: 409,
  description:
    'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
};
const cancelled = {
  error_code: 503,
  description: 'Service Unavailable: the request was cancelled',
};

register(
  'telegram.updates.1',
  ['getUpdates'],
  [],
  false,
  'a subscribed bot drains reaction counts set by CLI and SDK, confirms by offset, and keeps queue and offset across restart',
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
      const tg = connected.services.tg;
      const issued = await tg.bots.create({
        username: 'poll_bot',
        firstName: 'Poller',
      });
      const bot = client(connected.endpoints.tg.api!, issued.token);
      const first = await bot.api.sendMessage(channel.id, 'first');
      const second = await bot.api.sendMessage(channel.id, 'second');

      // Telegram's default subscription leaves reaction counts out.
      equal(
        (await tg.reactions.set({
          chatId: channel.id,
          messageId: first.message_id,
          reactions: [thumbs(1)],
        })).queued,
        0,
      );
      equal(await bot.api.getUpdates({ ...subscribe, timeout: 0 }), []);

      const fromSDK = await tg.reactions.set({
        chatId: channel.id,
        messageId: first.message_id,
        reactions: [
          { type: { type: 'paid' }, total_count: 2 },
          thumbs(5),
          {
            type: {
              custom_emoji_id: '5368324170671202286',
              type: 'custom_emoji',
            },
            total_count: 0,
          },
        ],
      });
      const sdkReactions = [thumbs(5), {
        type: { type: 'paid' },
        total_count: 2,
      }];

      equal(fromSDK, {
        chatId: channel.id,
        messageId: first.message_id,
        reactions: sdkReactions,
        changed: true,
        queued: 1,
      });

      const cliReactions = [{
        type: { type: 'custom_emoji', custom_emoji_id: '42' },
        total_count: 1,
      }, { type: { type: 'emoji', emoji: '❤‍🔥' }, total_count: 1 }];
      const set = [
        'tg',
        'reactions',
        'set',
        '--chat-id',
        String(channel.id),
        '--message-id',
        String(second.message_id),
        '--reactions',
      ];

      equal(
        (await cli([...set, JSON.stringify(cliReactions)])).queued,
        1,
      );

      // Emoji before custom emoji at equal counts; the same snapshot in another
      // order is unchanged and queues nothing.
      const sorted = [cliReactions[1], cliReactions[0]];

      equal(await cli([...set, JSON.stringify(cliReactions.toReversed())]), {
        chatId: channel.id,
        messageId: second.message_id,
        reactions: sorted,
        changed: false,
        queued: 0,
      });

      const inspected = await tg.updates.inspect({ botId: issued.id });

      equal(inspected.pending, 2);
      equal(inspected.allowedUpdates, ['message_reaction_count']);
      equal(
        await cli(['tg', 'updates', 'inspect', '--bot-id', String(issued.id)]),
        inspected,
      );
      assert(
        !JSON.stringify(inspected).includes(issued.token.split(':')[1]!),
        'Inspection shows the token',
      );

      await host.dispose();

      host = await serveEnvironment(configured, { directory });

      await using restarted = await Emulon.connect({
        config: configured,
        directory,
      });
      const again = client(restarted.endpoints.tg.api!, issued.token);

      // Inspection confirmed nothing, and the queue survived the restart.
      equal(
        await restarted.services.tg.updates.inspect({ botId: issued.id }),
        inspected,
      );

      const drained = await drain(again);

      equal(drained.map((update) => update.update_id), [1, 2]);
      equal(
        drained.map((update) => {
          const counted = update.message_reaction_count!;

          return [
            counted.chat.id,
            'username' in counted.chat ? counted.chat.username : undefined,
            counted.message_id,
            counted.reactions,
          ];
        }),
        [
          [channel.id, channel.username, first.message_id, sdkReactions],
          [channel.id, channel.username, second.message_id, sorted],
        ],
      );
      equal(drained, inspected.updates);

      for (const update of drained) {
        const date = update.message_reaction_count!.date;

        assert(Math.abs(date - Date.now() / 1000) < 60, 'Unexpected date');
        equal(Object.keys(update).sort(), [
          'message_reaction_count',
          'update_id',
        ]);
      }

      equal(
        await again.api.getUpdates({ offset: 3, limit: 100, timeout: 0 }),
        [],
      );

      await host.dispose();

      host = await serveEnvironment(configured, { directory });

      await using third = await Emulon.connect({
        config: configured,
        directory,
      });
      const last = client(third.endpoints.tg.api!, issued.token);

      // The confirmation, the subscription and the next ID are durable.
      equal(await last.api.getUpdates({ timeout: 0 }), []);
      await third.services.tg.reactions.set({
        chatId: channel.id,
        messageId: second.message_id,
        reactions: [],
      });
      equal(
        (await last.api.getUpdates({ timeout: 0 })).map((update) => [
          update.update_id,
          update.message_reaction_count?.reactions,
        ]),
        [[3, []]],
      );
    } finally {
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'telegram.updates.2',
  ['getUpdates'],
  [],
  false,
  'offsets confirm and forget, subscriptions change only future updates, and invalid input fails without effect',
  async () => {
    await using env = await Emulon.start(config());
    const api = env.endpoints.tg.api!;
    const tg = env.services.tg;
    const one = await tg.bots.create({ username: 'one_bot', firstName: 'A' });
    const two = await tg.bots.create({ username: 'two_bot', firstName: 'B' });
    const a = client(api, one.token);
    const b = client(api, two.token);
    const { message_id } = await a.api.sendMessage(channel.id, 'post');
    let count = 0;
    const react = () =>
      tg.reactions.set({
        chatId: channel.id,
        messageId: message_id,
        reactions: [thumbs(++count)],
      });
    const pending = async (botId: number) =>
      (await tg.updates.inspect({ botId })).updates.map((update) =>
        update.update_id
      );

    await a.api.getUpdates(subscribe);

    for (let i = 0; i < 5; i++) {
      equal((await react()).queued, 1);
    }

    // Only the subscribed bot has a queue.
    equal(await pending(two.id), []);
    equal(await pending(one.id), [1, 2, 3, 4, 5]);
    equal((await tg.updates.inspect({ botId: one.id, limit: 2 })).pending, 5);
    equal(
      (await tg.updates.inspect({ botId: one.id, limit: 2 })).updates.length,
      2,
    );

    // A batch is not a confirmation; an offset confirms past the limit.
    equal(
      (await a.api.getUpdates({ limit: 2 })).map((u) => u.update_id),
      [1, 2],
    );
    equal(await pending(one.id), [1, 2, 3, 4, 5]);
    equal(
      (await a.api.getUpdates({ offset: 4, limit: 1 })).map((u) => u.update_id),
      [4],
    );
    equal(await pending(one.id), [4, 5]);
    // A negative offset keeps the last updates and forgets the rest.
    equal(
      (await a.api.getUpdates({ offset: -1 })).map((u) => u.update_id),
      [5],
    );
    equal(await pending(one.id), [5]);

    // A new subscription neither filters nor recreates queued updates.
    await a.api.getUpdates({ allowed_updates: ['message'], timeout: 0 });
    equal(await pending(one.id), [5]);
    equal((await react()).queued, 0);
    // An omitted list keeps the selection; an empty one restores the default.
    await b.api.getUpdates(subscribe);
    await b.api.getUpdates({ timeout: 0 });
    equal((await react()).queued, 1);
    equal(await pending(two.id), [1]);
    await b.api.getUpdates({ allowed_updates: [] });
    equal((await tg.updates.inspect({ botId: two.id })).allowedUpdates, []);
    equal((await react()).queued, 0);
    equal(await pending(two.id), [1]);

    const call = async (body: unknown) => {
      const response = await fetch(`${api}/bot${one.token}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      return [response.status, (await response.json()).description];
    };

    const invalid = [400, 'Bad Request: invalid parameter value'];
    const limit = [400, 'Bad Request: limit must be between 1 and 100'];
    const allowed = [400, 'Bad Request: invalid allowed_updates'];

    for (
      const [body, expected] of [
        [{ limit: 0 }, limit],
        [{ limit: 101 }, limit],
        [{ limit: 1.5 }, limit],
        [{ limit: '10' }, limit],
        [{ offset: '1' }, invalid],
        [{ offset: 0.5 }, invalid],
        [{ timeout: -1 }, invalid],
        [{ timeout: true }, invalid],
        [{ allowed_updates: 'message_reaction_count' }, allowed],
        [{ allowed_updates: ['message_reaction_counts'] }, allowed],
        [{ allowed_updates: [1] }, allowed],
        [{ offset: 6, allowed_updates: ['nope'] }, allowed],
        [{ offset: 6, secret: 'x' }, [
          501,
          'Not Implemented: parameter is not emulated',
        ]],
      ] as const
    ) {
      equal(await call(body), expected);
    }

    // No rejected request confirmed or resubscribed anything.
    equal(await pending(one.id), [5]);
    equal((await tg.updates.inspect({ botId: one.id })).allowedUpdates, [
      'message',
    ]);

    for (
      const [call, code] of [
        [
          () =>
            tg.reactions.set({ chatId: -1001, messageId: 1, reactions: [] }),
          'CHAT_NOT_FOUND',
        ],
        [() =>
          tg.reactions.set({
            chatId: channel.id,
            messageId: 99,
            reactions: [],
          }), 'MESSAGE_NOT_FOUND'],
        [() =>
          tg.reactions.set({
            chatId: channel.id,
            messageId: message_id,
            reactions: [thumbs(1), thumbs(2)],
          }), 'DUPLICATE_REACTION'],
        [() =>
          tg.reactions.set({
            chatId: channel.id,
            messageId: message_id,
            // Only the typed reaction emoji are accepted.
            reactions: [{
              type: { type: 'emoji', emoji: 'x' as '👍' },
              total_count: 1,
            }],
          }), 'VALIDATION_ERROR'],
        [() =>
          tg.reactions.set({
            chatId: channel.id,
            messageId: message_id,
            reactions: [thumbs(-1)],
          }), 'VALIDATION_ERROR'],
        [() => tg.updates.inspect({ botId: 1 }), 'BOT_NOT_FOUND'],
      ] as const
    ) {
      equal(await commandFailure(call), code);
    }

    await env.reset();

    const again = await tg.bots.create({ username: 'one_bot', firstName: 'A' });

    equal(await tg.updates.inspect({ botId: again.id }), {
      botId: again.id,
      allowedUpdates: [],
      pending: 0,
      updates: [],
    });
  },
);

register(
  'telegram.updates.3',
  ['getUpdates'],
  [],
  false,
  'a long poll returns when a reaction lands, admits one reader per bot, and ends on disconnect, reset and shutdown without an empty batch',
  async () => {
    const env = await Emulon.start(config());

    try {
      const api = env.endpoints.tg.api!;
      const tg = env.services.tg;
      const issued = await tg.bots.create({
        username: 'poll_bot',
        firstName: 'Poller',
      });
      const bot = client(api, issued.token);
      const { message_id } = await bot.api.sendMessage(channel.id, 'post');

      await bot.api.getUpdates(subscribe);

      // The poll wakes on the commit, long before its timeout.
      let started = performance.now();
      const woken = bot.api.getUpdates({ timeout: 30 });

      await new Promise((resolve) => setTimeout(resolve, 200));
      equal(await grammyFailure(() => bot.api.getUpdates()), conflict);
      await tg.reactions.set({
        chatId: channel.id,
        messageId: message_id,
        reactions: [thumbs(1)],
      });
      equal((await woken).map((update) => update.update_id), [1]);
      assert(performance.now() - started < 5000, 'The poll did not wake');

      // An empty timeout waits the stated real time.
      started = performance.now();

      equal(await bot.api.getUpdates({ offset: 2, timeout: 1 }), []);

      const waited = performance.now() - started;

      assert(waited >= 900 && waited < 5000, `Waited ${waited} ms`);

      // A disconnected poller releases the bot for the next reader. A reset
      // raw socket makes the disconnect exact: Deno's fetch can deliver an
      // aborted request again on a fresh connection.
      const reset = await rawPoll(api, issued.token, { timeout: 30 });

      await new Promise((resolve) => setTimeout(resolve, 200));
      reset();

      let reader: unknown;

      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          reader = await bot.api.getUpdates({ timeout: 0 });

          break;
        } catch (error) {
          assert(
            error instanceof GrammyError && error.error_code === 409,
            String(error),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      equal(reader, []);

      // Reset cancels the poll before it waits for handlers to drain.
      started = performance.now();

      const resetting = grammyFailure(() =>
        bot.api.getUpdates({ timeout: 30 })
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      await env.reset();
      equal(await resetting, cancelled);
      assert(performance.now() - started < 5000, 'Reset waited for the poll');

      const next = await tg.bots.create({
        username: 'next_bot',
        firstName: 'Next',
      });
      const fresh = client(api, next.token);

      await fresh.api.getUpdates(subscribe);

      const stopping = fresh.api.getUpdates({ timeout: 30 }).then(
        (updates) => updates,
        (error) =>
          error instanceof GrammyError
            ? { error_code: error.error_code, description: error.description }
            : 'network',
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      started = performance.now();

      await env.dispose();

      const outcome = await stopping;

      assert(
        outcome === 'network' ||
          JSON.stringify(outcome) === JSON.stringify(cancelled),
        `Shutdown ended the poll with ${JSON.stringify(outcome)}`,
      );
      assert(
        performance.now() - started < 5000,
        'Shutdown waited for the poll',
      );
    } finally {
      await env.dispose();
    }
  },
);
