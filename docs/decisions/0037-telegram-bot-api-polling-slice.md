# 0037: Telegram Bot API polling slice

Status: Accepted.

## Context and options

The first Telegram consumer publishes MarkdownV2 posts to a channel with
`grammY@1.44.0`, then drains `message_reaction_count` updates with `getUpdates`.
It addresses a channel by numeric ID or `@username`, uses a JSON request body,
and reads `message_id` from each send response. Its long posts become several
independent `sendMessage` calls. The initial plugin must support that complete
loop without implying general Bot API coverage.

The host already supplies isolated HTTP surfaces, transactional instance state,
typed control commands, and a reset barrier. A generic core Bot API router or
update queue would make other plugins inherit Telegram-specific behavior. A
Telegram-owned route and queue use the existing facilities without adding a
provider protocol to core. A full webhook delivery implementation would add
outbound transport, retry, secret-header, and recovery policy that this consumer
does not use; accepting `setWebhook` without delivery would falsely disable
polling. Choose a polling-only first slice. A later webhook slice must make
delivery and polling mutually exclusive before it can accept `setWebhook`.

## Package, identity, and route

Ship an official `@emulon/telegram` package with a default plugin factory and
one `api` Hono surface. The connection recipe gives grammY the endpoint URL as
`apiRoot` with no trailing slash; grammY constructs
`<apiRoot>/bot<token>/<method>`. The token is part of the path, not an
authorization header. The plugin matches exactly one `bot<token>/<method>` pair
per request, validates the token before method dispatch, and never forwards an
unknown method or route to Telegram. The declared consumer transport is POST
with JSON; other transports and content types fail explicitly and are not
compatibility claims. Successful responses use HTTP 200 and
`{ "ok": true, "result": ... }`. Ordinary provider failures use the matching
HTTP status and `{ "ok": false, "error_code": number, "description": string }`;
`parameters` is present only when a supported error needs it. Unknown methods
and paths receive a 404 Bot API envelope; known unsupported operations or fields
receive an explicit 501 envelope with a fixed safe description. Bad input,
unknown chat, and malformed MarkdownV2 receive a 400 envelope. Error messages
must not interpolate the token, URL, message text, or unknown fields.

The control command `bots.create` (`bots create`) takes a unique bot `username`
and `firstName`, creates its identity, and returns `{ id, username, token }`
once. Its positive safe-integer bot ID and a cryptographically random secret
form `<id>:<secret>`; use at least 256 random bits encoded with URL-safe
characters. Store only a verifier for the full token. Check it in constant time
after resolving the ID, and scope the lookup to this plugin instance. Do not put
tokens in compatibility metadata, inspect output, request diagnostics, errors,
or ordinary status output. The dedicated authenticated command is the explicit
credential output. Reset removes generated bots and credentials, so previous
tokens cannot work, including when an ID is reused. Durable restart retains the
issued bot and verifier without revealing the token again. `getMe` returns that
bot's valid Bot API `User` projection.

`fixtures.channels` entries have a unique negative safe-integer `id` in the
`-100…` form, `title`, and unique case-insensitive `username`. Creating a bot
makes it an administrator able to post and receive reaction counts in every
configured channel; this first slice has no membership or rights commands. Store
channel identity, bot identity, and each sent message under the plugin instance.
Resolve numeric `chat_id` and `@username` to the same channel. Every successful
`sendMessage` allocates the next positive `message_id` for that chat in the same
transaction as the message write; IDs are monotone per chat across bots,
concurrent calls, and durable restart. A failed send allocates no ID. The
response is a Bot API `Message` projection with at least `message_id`, `date`,
`chat`, `from`, and `text`, plus parsed `entities` when present. Store the
original submitted text and rendered text for management inspection. Accept
`parse_mode: "MarkdownV2"`, `disable_notification: true`, and
`link_preview_options: { is_disabled: false }`; the latter two are accepted
without simulating client notifications or remote link previews. Plain text
without `parse_mode` is allowed. Explicit unsupported send fields and modes fail
instead of being ignored.

## MarkdownV2 boundary

The Telegram package owns a pure parser from MarkdownV2 source to rendered text
and Bot API entities with UTF-16 offsets and lengths. It recognizes escapes,
bold, italic, underline, strikethrough, spoilers, inline and fenced code, links,
and the nesting and context-specific escaping rules needed by Telegram
MarkdownV2. It rejects malformed delimiters, invalid nesting, unescaped reserved
characters, and unsupported constructs with the safe 400 description
`Bad Request: can't parse entities`. Do not approximate this with a regex that
merely removes punctuation. Compute the 1–4096 length limit on rendered UTF-16
code units after parsing, excluding escape characters, delimiters, and link
targets; an oversized result receives `Bad Request: message is too long`. A
malformed input fails before the length check; neither failure writes a message.
The parser and length rule have focused tests, including escaped punctuation,
nested formatting, links, astral characters, and boundaries. A post split by the
caller is several ordinary messages, never joined by the plugin.

## Reaction updates and polling

The Bot API update queue is Telegram instance state, separate from Emulon's
event outbox and webhook delivery queue. Each bot has a durable, ordered queue,
next positive `update_id`, and remembered `allowed_updates`. A control
`reactions.set` command (`reactions set`) replaces the absolute aggregate
reaction counts on an existing channel message. Its input is a list of unique
reaction types and nonnegative integer `total_count` values: `emoji` with
`emoji`, `custom_emoji` with `custom_emoji_id`, or `paid`. Normalize ordering
and omit zero counts. A changed snapshot atomically records the counts and
enqueues one `message_reaction_count` update per subscribed administrator bot,
with `chat.id`, `chat.username`, `message_id`, Unix `date`, and the full
`reactions` list. An identical snapshot produces no update. There are no
synthetic users or per-user `message_reaction` updates. The bot must explicitly
subscribe to `message_reaction_count` before the mutation: Telegram's default
and an explicit empty `allowed_updates` exclude it. Changing the subscription
does not retroactively filter or recreate queued updates.

`getUpdates` operates on the authenticated bot only. With no offset it reads
from the earliest unconfirmed update. A nonnegative offset atomically removes
queued updates with smaller IDs, including ones outside the current limit, then
returns up to `limit` from the remaining queue in ID order; returning a batch
does not itself confirm it. A negative offset selects the last `-offset` queued
updates and forgets older ones, matching the documented Bot API queue operation.
`limit` defaults to 100 and accepts 1–100. `timeout` defaults to zero; zero
returns immediately, while a positive value waits up to the stated real-time
seconds for an eligible update. `allowed_updates` omitted preserves the previous
selection; an explicit list replaces it for future updates, with an empty list
restoring the Telegram default. The initial generator emits only
`message_reaction_count`, and the manifest discloses that limit. Validate known
update-type names while rejecting malformed values. Queue read, confirmation,
subscription change, and update ID allocation must be transactional. Permit one
active long poll per bot; an overlapping poll gets a 409 Bot API envelope rather
than racing another reader.

Long poll waits outside a store transaction, subscribes to committed store
changes, and rechecks state after subscribing so a commit cannot be missed. The
wait uses monotonic real time, not virtual time. Client abort cancels the wait
and releases its subscription. Host pause for reset or shutdown must abort
active poll waits before waiting for admitted HTTP handlers to drain; the poll
must not turn that cancellation into a successful empty batch across
generations. Use a host-owned abort signal composed with the incoming web
`Request.signal` at the existing HTTP lifecycle middleware boundary. This is an
internal host change, not a new plugin-authoring method or a Node/Deno API in
the Telegram package. Keep ordinary admitted handlers' drain behavior. Verify
disconnect, reset, and shutdown cancellation through both runtime adapters with
dynamic loopback ports.

The declared commands also include `messages.list` (`messages list`) by chat,
returning bounded sent-message projections in message ID order, and
`updates.inspect` (`updates inspect`) by bot, returning bounded queue and
subscription state without credentials. These use the same control command
contract through CLI and started or connected SDK clients. The reactions command
takes `chatId`, `messageId`, and the absolute `reactions` list, then validates
that the target channel and message exist before mutation. Message listing takes
`chatId` and an optional limit; queue inspection takes `botId` and an optional
limit. Inspection bounds and pagination must allow a caller to read a multi-part
post or a batch of up to 100 pending updates. Inspect reads do not acknowledge
updates. Do not add a live-user model or a provider-side reaction-setting
method.

## Webhook mode and compatibility

Do not implement `setWebhook`, `deleteWebhook`, or `getWebhookInfo` in this
slice. All three return explicit 501 Bot API envelopes; no webhook state can be
installed, so polling has no webhook conflict in this slice. Do not claim the
Telegram `webhooks` capability. A future webhook mode must handle `secret_token`
and `X-Telegram-Bot-Api-Secret-Token`, outbound delivery, retry and recovery,
`getWebhookInfo`, switching and pending-update policy, and a 409 `getUpdates`
response whenever a webhook is installed. Merely storing a webhook URL and
returning 409 would break the supported reaction drain without providing another
delivery path.

The package owns a validated compatibility manifest as in
[ADR 0028](0028-compatibility-manifest.md): claim only implemented POST
operations, bot-token authentication, the reaction-count update projection, and
tested limitations. Its `webhooks` field describes the unsupported mode with no
webhook cases. Add `grammy@1.44.0` as an exact, test-only Deno import; it must
not enter the Telegram npm archive or production dependencies. Tests use its
configured local `apiRoot` and dynamic loopback port to prove `getMe`, both chat
address forms, multi-part `sendMessage`, GrammyError on bad Markdown and
oversize text, subscription, reaction injection, repeated `getUpdates` with
offset confirmation, empty drain, and cancellation. A README and runnable
example show one bot posting and reading a reaction by polling. Archive checks
must install the package in clean offline Node and Deno consumers and verify
CLI/SDK/manifest parity. No test calls a real provider or the public network.
Configuration of an external consumer is outside this package.

## Delivery sequence

Each part below is independently reviewable and passes `deno task check` before
handoff. Dependencies run in the listed order.

1. **Bot and HTTP foundation.** Add the official package, build and installed
   consumer registration, the exact test-only grammY pin, fixture channels,
   secure `bots.create`, route authentication, `getMe`, and a manifest claiming
   only passing cases. Completion proves a freshly issued token works through
   grammY on loopback, wrong and stale tokens fail, reset invalidates it, and
   the archive works under Node without Deno installed.
2. **Channel publishing.** Add the pure MarkdownV2 parser, `sendMessage`,
   `messages.list`, and their manifest cases. Completion proves numeric and
   username addresses, separate monotone IDs for multipart posts, rendered
   length and syntax errors before mutation, and CLI/SDK inspection parity.
3. **Reaction polling.** Add the aggregate reaction command, per-bot update
   queue, `getUpdates`, `updates.inspect`, and host-side HTTP cancellation.
   Completion proves offset and subscription rules, actual long polling,
   disconnect and reset behavior on Node and Deno, durable recovery, and
   explicit webhook/method errors, with manifest cases updated.
4. **Consumer proof and guide.** Add the pinned grammY end-to-end suite,
   runnable example, README, and final compatibility and offline archive
   verification. Completion proves the exact publish-and-drain scenario through
   the official client and all published entry points, with no test dependency
   in the production archive.

## Consequences and references

This slice intentionally has no media, files, keyboards, inline mode, payments,
Mini Apps, MTProto, live users, webhook delivery, or general Bot API
compatibility. The grammar fixtures of the first consumer are not present in
this repository; the implementation and acceptance proof must include its actual
MarkdownV2 posting shapes or record a concrete uncovered construct before
claiming compatibility. Request URLs contain bot credentials, so logging and
diagnostics must redact the path segment even for failed routes. The host's
existing generic pre-route body-limit response is a documented transport-limit
exception to the provider envelope; normal method and field errors remain Bot
API envelopes. A reaction set before the bot first opts into
`message_reaction_count` is intentionally absent from the queue; the example and
consumer proof must subscribe before injecting one.

- [Telegram Bot API](https://core.telegram.org/bots/api) specifies methods,
  MarkdownV2, update confirmation and subscriptions, reaction-count payloads,
  and webhook exclusivity.
- [Telegram Bot API changelog](https://core.telegram.org/bots/api-changelog)
  records explicit reaction-count subscription.
- [ADR 0014](0014-hono-http-layer.md) specifies owned Hono surfaces and HTTP
  lifecycle middleware.
- [ADR 0026](0026-reset-observation-barrier.md) specifies the reset barrier.

## Addendum: channel publishing decisions

These choices were open inside the scope above and are settled by the channel
publishing part. They add no provider operation beyond this ADR.

- **Test-only `md-to-telegram@0.1.1`.** The first consumer builds its posts with
  `toTelegramMarkdownV2` and cuts them with
  `splitMessage(text, { format: 'markdownv2' })`. The package is added as an
  exact, test-only Deno import like grammY: a representative post (headings,
  lists, links with parentheses, inline and fenced code, bold, italic, both,
  strikethrough, spoiler, underline, quotations, an expandable quotation, a
  table, a thematic break, astral characters and a paragraph longer than one
  message) is converted, split and sent part by part through grammY. It never
  enters the npm archive; the installed proof asserts that.
- **Constructs.** The parser accepts everything that converter emits for
  MarkdownV2: escapes, `*bold*`, `_italic_`, `__underline__`, `~strike~`,
  `||spoiler||`, inline code, fenced code with an optional language, links, `>`
  block quotations and `**>…||` expandable block quotations. It follows the
  TDLib parser's single pass: `__` binds greedily, empty entities are dropped,
  entities nest only by containment, links cannot contain links, and a quotation
  cannot start inside another entity or be left with one open. A quotation
  includes the newline that ends its last line and is expandable when that line
  ends in `||` outside a spoiler. Custom emoji, date-time entities, `tg://`
  mentions and non-HTTP link schemes are refused with `can't parse entities`
  instead of being rendered differently, as is code spanning quoted lines, whose
  prefix rules are undocumented. Link targets without a scheme get `http://`; a
  target that is not a URL keeps its text without an entity, as Telegram does.
  Telegram's automatic URL, mention and hashtag entities and its whitespace
  trimming are not emulated. Each limit is a manifest limitation.
- **Validation order.** Unsupported fields are refused first (501), then the
  chat is resolved (400 `chat not found`), then the text is parsed (400
  `can't parse entities`), then an empty result (400 `message text is empty`)
  and the length (400 `message is too long`) are checked, all before an ID is
  allocated. `disable_notification` accepts either boolean and
  `link_preview_options` accepts `{}` or `is_disabled: false`, since both are
  the defaults the emulator already follows; HTML and legacy Markdown parse
  modes return 501.
- **Message projection.** A channel post carries `sender_chat` equal to `chat`
  as Telegram returns it, and also the `from` bot user this ADR requires.
- **Listing.** `messages.list` takes a numeric `chatId`, because a CLI flag
  cannot mix string and number values, and an optional `limit` of 1–100 (default
  100). It returns the most recent messages oldest first, so a recent multipart
  post always reads whole and in order.
