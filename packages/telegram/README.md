# @emulon/telegram

A local Telegram Bot API for the polling-only slice selected in
[ADR 0037](../../docs/decisions/0037-telegram-bot-api-polling-slice.md). The
[compatibility manifest](src/compatibility.ts) is the authoritative tested
scope. This release issues bots, authenticates their tokens and answers `getMe`;
every other method the pinned client types returns an explicit 501.

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
```

The endpoint URL is grammY's `apiRoot` as is, without a trailing slash; grammY
requests `<apiRoot>/bot<token>/<method>`. For a running project configured with
instance `tg`:

```sh
emulon tg bots create --username poster_bot --first-name Poster --json
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

Responses are Bot API envelopes: `{ "ok": true, "result": ... }` on success and
`{ "ok": false, "error_code": ..., "description": ... }` with the same HTTP
status on failure. The token is checked before the method: a malformed token
receives 404 and a well-formed token of no issued bot 401. With a valid token,
an unknown method receives 404 and a known but unimplemented one, including
`setWebhook`, `deleteWebhook` and `getWebhookInfo`, 501. Only POST with a JSON
object body is emulated. Descriptions are fixed and never contain the token, the
path or request input.

Tests use `grammy@1.44.0` on loopback and never reach Telegram; grammY is not a
dependency of this package.
