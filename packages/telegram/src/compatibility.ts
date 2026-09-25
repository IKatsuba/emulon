import { type CompatibilityManifest, defineCompatibility } from 'emulon';

export const compatibility: CompatibilityManifest = defineCompatibility({
  'schemaVersion': 1,
  'plugin': '@emulon/telegram',
  'provider': {
    'name': 'Telegram',
    'api': 'Telegram Bot API',
  },
  'operations': [
    {
      'id': 'getMe',
      'method': 'POST',
      'path': '/bot:token/getMe',
      'surface': 'api',
      'version': 'bot-api',
      'auth': [
        'local-bot-token-path',
      ],
      'input': [],
      'output':
        'ok, result: id, is_bot, first_name, username, can_join_groups, can_read_all_group_messages, supports_inline_queries, can_connect_to_business, has_main_web_app, has_topics_enabled, allows_users_to_create_topics, can_manage_bots, supports_join_request_queries',
      'events': [],
      'cases': [
        'telegram.bots.1',
        'telegram.bots.2',
        'telegram.bots.3',
      ],
    },
    {
      'id': 'sendMessage',
      'method': 'POST',
      'path': '/bot:token/sendMessage',
      'surface': 'api',
      'version': 'bot-api',
      'auth': [
        'local-bot-token-path',
      ],
      'input': [
        'chat_id',
        'text',
        'parse_mode',
        'disable_notification',
        'link_preview_options',
      ],
      'output':
        'ok, result: message_id, from, sender_chat, chat, date, text, entities',
      'events': [],
      'cases': [
        'telegram.messages.1',
        'telegram.messages.2',
        'telegram.messages.3',
      ],
    },
  ],
  'versions': [
    {
      'id': 'bot-api',
      'accepted': [
        'bot-api',
      ],
      'headers': [],
      'missing':
        'The Bot API has no version selector; the method set is the one typed by @grammyjs/types@3.28.0, the types package of grammy@1.44.0.',
      'unknown':
        'No version header is read; an unknown method returns a 404 Bot API envelope and a typed but unimplemented method returns 501.',
    },
  ],
  'authentication': {
    'flows': [
      'local-bot-token-path',
    ],
    'keyFormats': [
      '<bot id>:<256-bit base64url secret> in the bot<token> path segment',
    ],
    'ownership':
      'One token authorizes one bot of one local instance; only a SHA-256 verifier is stored, reset removes bots so earlier tokens fail even when a bot ID is reused, and a durable restart keeps issued tokens valid.',
    'unsupported': [
      'Real Telegram bots and BotFather',
      'Token revocation or regeneration commands',
      'Test environment /test paths and local Bot API server modes',
      'MTProto and user accounts',
    ],
  },
  'events': [],
  'webhooks': {
    'signing':
      'Unsupported: this slice is polling-only; setWebhook, deleteWebhook and getWebhookInfo return 501 and no webhook can be installed',
    'id': 'Unsupported',
    'body': 'Unsupported',
    'success': 'Unsupported',
    'timeoutMs': 0,
    'retries': 'Unsupported',
    'redelivery': 'Unsupported',
    'recovery': 'Unsupported',
    'cases': [],
  },
  'capabilities': [
    'http',
    'authorization',
    'reset',
  ],
  'limitations': [
    {
      'id': 'telegram.limitation.1',
      'description':
        'Only getMe and sendMessage are implemented; every other method typed by @grammyjs/types@3.28.0, including getUpdates, setWebhook, deleteWebhook and getWebhookInfo, returns a 501 Bot API envelope',
    },
    {
      'id': 'telegram.limitation.2',
      'description':
        'Only POST with an application/json object body; GET, query parameters, form and multipart bodies return 501, and any getMe parameter returns 501 instead of being ignored',
    },
    {
      'id': 'telegram.limitation.3',
      'description':
        'getMe reports a bot without optional capabilities: can_join_groups is true and every other capability flag is false',
    },
    {
      'id': 'telegram.limitation.4',
      'description':
        'Failures use fixed descriptions: 404 Not Found for a path that is not bot<token>/<method>, a malformed token or an unknown method; 401 Unauthorized for a well-formed token of no issued bot; 400 for a body that is not a JSON object',
    },
    {
      'id': 'telegram.limitation.5',
      'description':
        'Bot IDs are allocated locally from 7000000001 upward and bot secrets are 43 base64url characters rather than the 35 of issued Telegram tokens',
    },
    {
      'id': 'telegram.limitation.6',
      'description':
        'sendMessage targets configured channels only, by ID or @username; it accepts chat_id, text, parse_mode MarkdownV2 or none, disable_notification and link_preview_options with is_disabled false, without simulating notifications or link previews. Any other field, is_disabled true or another link preview option returns 501, as do the HTML and legacy Markdown parse modes',
    },
    {
      'id': 'telegram.limitation.7',
      'description':
        "MarkdownV2 covers escapes, bold, italic, underline, strikethrough, spoiler, inline code, fenced code with a language, links to http and https targets, block quotations and expandable block quotations, which is everything md-to-telegram@0.1.1 emits. Custom emoji, date-time entities, user mentions through tg:// links and other link schemes return 400 can't parse entities, as does code spanning quoted lines",
    },
    {
      'id': 'telegram.limitation.8',
      'description':
        'Failures carry fixed descriptions without the offending character or offset Telegram appends; entities are only those written in markup, with no automatic url, mention or hashtag detection, and rendered text keeps leading and trailing whitespace',
    },
    {
      'id': 'telegram.limitation.9',
      'description':
        'A link target without a scheme gets http://, and a target that is not a URL keeps its text without an entity; targets are normalized by the WHATWG URL parser, which can differ from Telegram in trailing slashes and percent-encoding',
    },
  ],
  'verification': {
    'mode': 'official-client',
    'client': 'grammy@1.44.0',
    'suites': [
      {
        'path': 'packages/telegram/tests/bot_cases.ts',
        'cases': [
          'telegram.bots.1',
          'telegram.bots.2',
          'telegram.bots.3',
        ],
      },
      {
        'path': 'packages/telegram/tests/message_cases.ts',
        'cases': [
          'telegram.messages.1',
          'telegram.messages.2',
          'telegram.messages.3',
        ],
      },
    ],
    'sources': [
      'https://core.telegram.org/bots/api',
      'https://core.telegram.org/bots/api#making-requests',
      'https://core.telegram.org/bots/api#getme',
      'https://core.telegram.org/bots/api#sendmessage',
      'https://core.telegram.org/bots/api#markdownv2-style',
      'https://core.telegram.org/bots/api#messageentity',
      'https://grammy.dev/ref/core/apiclientoptions',
    ],
    'retrieved': '2026-09-25',
    'liveProviderCompared': false,
  },
  'details': {
    'route':
      'grammY builds <apiRoot>/bot<token>/<method>; the endpoint URL is apiRoot with no trailing slash. The token is validated before the method is resolved, and method names are case-insensitive.',
    'envelopes':
      'Success is HTTP 200 with {ok: true, result}; failure uses the matching HTTP status with {ok: false, error_code, description}, and no description contains the token, the path or caller input.',
    'channels':
      'fixtures.channels declares channels with a -100 prefixed negative ID, a title and a username unique without regard to case; bot usernames share that namespace.',
    'messages':
      'Every successful sendMessage allocates the next message_id of its chat in the transaction that stores the message, so IDs are gapless and monotone across bots, concurrent calls and durable restart; a failed send writes nothing. Malformed MarkdownV2 fails before the 4096 UTF-16 unit limit on rendered text. messages list returns the stored source and rendered text of up to the latest 100 messages of a channel, oldest first.',
    'transportLimit':
      'The host body limit answers oversized bodies with a plain 413 before the route runs, outside the Bot API envelope.',
  },
});
