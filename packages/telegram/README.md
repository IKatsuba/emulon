# @emulon/telegram

A local Telegram Bot API for the polling-only slice selected in
[ADR 0037](../../docs/decisions/0037-telegram-bot-api-polling-slice.md). The
[compatibility manifest](src/compatibility.ts) is the authoritative tested
scope. This release issues bots, authenticates their tokens, answers `getMe` and
publishes plain or MarkdownV2 channel posts with `sendMessage`; every other
method the pinned client types returns an explicit 501.

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

The endpoint URL is grammY's `apiRoot` as is, without a trailing slash; grammY
requests `<apiRoot>/bot<token>/<method>`. For a running project configured with
instance `tg`:

```sh
emulon tg bots create --username poster_bot --first-name Poster --json
emulon tg messages list --chat-id -1001234567890 --limit 10 --json
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

Responses are Bot API envelopes: `{ "ok": true, "result": ... }` on success and
`{ "ok": false, "error_code": ..., "description": ... }` with the same HTTP
status on failure. The token is checked before the method: a malformed token
receives 404 and a well-formed token of no issued bot 401. With a valid token,
an unknown method receives 404 and a known but unimplemented one, including
`setWebhook`, `deleteWebhook` and `getWebhookInfo`, 501. Only POST with a JSON
object body is emulated. Descriptions are fixed and never contain the token, the
path or request input.

Tests use `grammy@1.44.0` and `md-to-telegram@0.1.1` on loopback and never reach
Telegram; neither is a dependency of this package.
