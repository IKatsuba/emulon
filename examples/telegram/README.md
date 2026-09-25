# Telegram channel bot

From the repository root, run **deno task example:telegram**.

The application starts a local Telegram Bot API with one channel, issues a bot
and connects the pinned grammY client with the endpoint as its `apiRoot`. Its
first `getUpdates` has no offset: it subscribes to `message_reaction_count` and
finds nothing. The bot converts a Markdown post with `md-to-telegram`, splits it
and sends every part to `@local_news` with `parse_mode: "MarkdownV2"`,
`disable_notification` and `link_preview_options`. The `reactions.set` command
then gives the first part 👍 3 and 🔥 1, and the bot drains `getUpdates` with
`limit: 100` and `timeout: 0` until an empty batch.

The output shows each published message with its rendered text and entities, the
received `message_reaction_count` update with both counts, and `nextOffset`, the
offset a scheduled consumer stores for its next run. The token is never printed.
The listener uses a dynamically allocated loopback port; no Telegram account or
network access is needed.

The task grants full environment access because grammY's logger reads the whole
environment when it loads. The same example runs inside **deno task check**. See
[the package guide](../../packages/telegram/README.md).
