# @emulon/telegram

A local Telegram Bot API for the polling-only slice selected in
[ADR 0037](../../docs/decisions/0037-telegram-bot-api-polling-slice.md). The
[compatibility manifest](src/compatibility.ts) is the authoritative tested
scope. This release issues bots, authenticates their tokens, answers `getMe`,
publishes plain or MarkdownV2 channel posts with `sendMessage` and delivers
reaction counts through `getUpdates` polling; every other method the pinned
client types returns an explicit 501.

```ts
import { Emulon } from 'emulon';
import telegram from '@emulon/telegram';
import { Bot } from 'grammy';

await using env = await Emulon.start({
  services: {
    tg: telegram({
      fixtures: {
        channels: [{
          id: -1001234567890,
          title: 'Local News',
          username: 'local_news',
        }],
      },
    }),
  },
});
const { token } = await env.services.tg.bots.create({
  username: 'poster_bot',
  firstName: 'Poster',
});
const bot = new Bot(token, { client: { apiRoot: env.endpoints.tg.api } });
console.log(await bot.api.getMe());

const post = await bot.api.sendMessage('@local_news', '*Hello*, world\\!', {
  parse_mode: 'MarkdownV2',
});
console.log(post.message_id, post.text, post.entities);
console.log(await env.services.tg.messages.list({ chatId: -1001234567890 }));
```

## Run the example

From the repository root:

```sh
deno task example:telegram
```

The [example](../../examples/telegram/README.md) starts an instance with one
channel, issues a bot, has it convert a Markdown post with `md-to-telegram`,
split it and publish each part to `@local_news` as silent MarkdownV2 messages
with link previews enabled, sets a reaction on the post and reads it back
through `getUpdates`. It prints the published messages with their entities, the
`message_reaction_count` update and the offset to store for the next run.

## Connection and commands

The endpoint URL is grammY's `apiRoot` as is, without a trailing slash; grammY
requests `<apiRoot>/bot<token>/<method>`. For a running project configured with
instance `tg`:

```sh
emulon tg bots create --username poster_bot --first-name Poster --json
emulon tg messages list --chat-id -1001234567890 --limit 10 --json
emulon tg reactions set --chat-id -1001234567890 --message-id 1 \
  --reactions '[{"type":{"type":"emoji","emoji":"👍"},"total_count":3}]' --json
emulon tg updates inspect --bot-id 7000000001 --json
emulon tg compatibility get --json
```

`bots create` is the only output that contains a token, and it shows it once.
Tokens are `<bot id>:<secret>` with a 256-bit random secret; the instance keeps
only a SHA-256 verifier. A durable restart keeps issued tokens valid, and reset
removes every bot, so earlier tokens fail even when a new bot gets the same ID.
Bot usernames end in `bot` and share one case-insensitive namespace with channel
usernames.

`fixtures.channels` entries have a negative `-100…` `id`, a `title` and a
`username` unique without regard to case.

## Channel posts

`sendMessage` posts to a configured channel addressed by its ID or by
`@username`. It accepts `chat_id`, `text`, `parse_mode: "MarkdownV2"` (or no
parse mode), `disable_notification` and `link_preview_options` with
`is_disabled: false`; notifications and link previews are not simulated. Any
other field, `is_disabled: true`, and the HTML and legacy Markdown parse modes
fail with 501 rather than being ignored.

MarkdownV2 is parsed the way Telegram parses it into text and entities whose
offsets and lengths count UTF-16 code units: escapes, bold, italic, underline,
strikethrough, spoilers, inline code, fenced code with a language, links, block
quotations and expandable `**>…||` quotations, with Telegram's nesting rules.
This covers everything `md-to-telegram` emits for MarkdownV2, including posts
cut by its `splitMessage`; send each part as its own message. Custom emoji,
date-time entities, `tg://` mentions, non-HTTP link targets and code spanning
quoted lines are not emulated and fail with 400 `can't parse entities`, and no
URL, mention or hashtag entities are detected automatically.

Malformed markup fails with 400 `Bad Request: can't parse entities` before the
length check; text longer than 4096 UTF-16 units after parsing fails with 400
`Bad Request: message is too long`. A failed send writes nothing. Each
successful send takes the next `message_id` of its channel in the same
transaction as the write, so IDs increase without gaps across bots, concurrent
calls and restarts.

`messages list` (`messages.list`) takes a numeric `chatId` and an optional
`limit` from 1 to 100 (default 100), and returns the most recent messages oldest
first with the submitted `source`, `parseMode`, rendered `text` and `entities`.

## Reaction polling

A bot receives `message_reaction_count` updates only after it asks for them, as
in Telegram: call `getUpdates` with
`allowed_updates: ['message_reaction_count']` first. A reaction set before that
never reaches the bot.

A consumer that runs on a schedule keeps the offset between runs. On its first
run it has none; each run drains until an empty batch, and that empty call with
the new offset is what confirms the batch before it:

```ts
async function drain(bot: Bot, stored: number | undefined) {
  let offset = stored;

  while (true) {
    const updates = await bot.api.getUpdates({
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout: 0,
      allowed_updates: ['message_reaction_count'],
    });

    if (updates.length === 0) {
      return offset; // store it for the next run
    }

    for (const update of updates) {
      console.log(update.message_reaction_count?.reactions);
    }

    offset = updates.at(-1)!.update_id + 1;
  }
}

let offset = await drain(bot, undefined); // subscribes, finds nothing
await env.services.tg.reactions.set({
  chatId: -1001234567890,
  messageId: post.message_id,
  reactions: [{ type: { type: 'emoji', emoji: '👍' }, total_count: 3 }],
});
offset = await drain(bot, offset); // prints the 👍 3 count
```

`reactions set` (`reactions.set`) replaces the absolute counts of a sent channel
message with a list of Bot API `ReactionCount` objects: `emoji` reactions with
one of the emoji the Bot API types, `custom_emoji` with a numeric ID, and
`paid`, each at most once, with a nonnegative `total_count`. Zero counts are
dropped. When the counts change, every bot subscribed at that moment gets one
update with the chat, `message_id`, Unix `date` and the full `reactions` list,
in the same transaction; setting the same counts again queues nothing. Counts
are ordered by `total_count`, then paid, emoji and custom emoji.

Each bot has its own durable queue with update IDs from 1. `getUpdates` takes
`offset`, `limit` (1–100, default 100), `timeout` (seconds, default 0) and
`allowed_updates`. A nonnegative offset confirms every smaller ID, a negative
offset keeps only that many of the latest updates, and returning a batch
confirms nothing. An omitted `allowed_updates` keeps the last list and an empty
one restores Telegram's default, which leaves out reaction counts; a change
never touches updates already queued. A positive `timeout` waits in real time
and returns as soon as an update arrives. One `getUpdates` call per bot runs at
a time; an overlapping call receives 409. Disconnecting ends a waiting poll, and
reset or shutdown ends it with a 503 envelope rather than an empty batch.

`updates inspect` (`updates.inspect`) takes a `botId` and an optional `limit`
from 1 to 100, and returns the subscription, the number of pending updates and
the oldest ones, without confirming anything or showing a token.

## Envelopes

Responses are Bot API envelopes: `{ "ok": true, "result": ... }` on success and
`{ "ok": false, "error_code": ..., "description": ... }` with the same HTTP
status on failure. The token is checked before the method: a malformed token
receives 404 and a well-formed token of no issued bot 401. With a valid token,
an unknown method receives 404 and a known but unimplemented one, including
`setWebhook`, `deleteWebhook` and `getWebhookInfo`, 501. Only POST with a JSON
object body is emulated. Descriptions are fixed and never contain the token, the
path or request input.

## Limitations

The [compatibility manifest](src/compatibility.ts) lists every limitation; in
short, this is not a general Bot API:

- Only `getMe`, `sendMessage` and `getUpdates` exist; every other method,
  including the webhook methods, returns 501. There is no webhook mode, so
  updates arrive only by polling.
- Bots post only to configured channels; there are no users, groups, private
  chats, media, keyboards, inline mode or payments.
- The only update type is `message_reaction_count`, and only the `reactions set`
  command produces it; bots cannot set reactions.
- MarkdownV2 is limited to what `md-to-telegram` emits, and error descriptions
  are fixed, without the offset Telegram appends.
- An overlapping `getUpdates` receives 409 instead of ending the earlier one.

Tests use `grammy@1.44.0` and `md-to-telegram@0.1.1` on loopback and never reach
Telegram. The consumer suite runs the complete publish-and-drain loop above
through grammY, with reactions set by the CLI and SDK. Neither client is a
dependency of this package, and the installed archive checks under Node and Deno
assert that.
