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
        'Only getMe is implemented; every other method typed by @grammyjs/types@3.28.0, including sendMessage, getUpdates, setWebhook, deleteWebhook and getWebhookInfo, returns a 501 Bot API envelope',
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
    ],
    'sources': [
      'https://core.telegram.org/bots/api',
      'https://core.telegram.org/bots/api#making-requests',
      'https://core.telegram.org/bots/api#getme',
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
    'transportLimit':
      'The host body limit answers oversized bodies with a plain 413 before the route runs, outside the Bot API envelope.',
  },
});
