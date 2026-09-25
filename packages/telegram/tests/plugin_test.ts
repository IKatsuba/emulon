import telegram from '@emulon/telegram';
import { Emulon } from 'emulon';
import type {
  ApiMethods,
  ReactionTypeEmoji,
  Update,
  UserFromGetMe,
} from 'grammy/types';
import { verifyCoverage } from '../../emulon/tests/helpers/compatibility.ts';
import { compatibility } from '../src/compatibility.ts';
import {
  issueToken,
  parseToken,
  sameVerifier,
  verifier,
} from '../src/auth/tokens.ts';
import {
  botUser,
  botUsername,
  createInput,
  firstBotId,
  nextBotId,
} from '../src/model/bots.ts';
import {
  channelFixtures,
  isChannelId,
  usernameKey,
} from '../src/model/channels.ts';
import { failure, isJson, parseRoute } from '../src/routes/api.ts';
import {
  type KnownMethod,
  knownMethod,
  knownMethods,
} from '../src/routes/methods.ts';
import { normalizeReactions } from '../src/model/reactions.ts';
import {
  reactionEmoji,
  updatesRequest,
  type UpdateType,
  updateTypes,
} from '../src/model/updates.ts';
import { cases as botCases } from './bot_cases.ts';
import { cases as messageCases } from './message_cases.ts';
import { cases as updateCases } from './update_cases.ts';
import { assert, equal, rejects } from './assert.ts';

const cases = [...botCases, ...messageCases, ...updateCases];

verifyCoverage(compatibility, cases);

for (const test of cases) {
  Deno.test(`${test.id}: ${test.name}`, test.run);
}

// The known-method list and the pinned client's types must name the same set.
type Typed = keyof ApiMethods;

const sameMethods:
  [Exclude<Typed, KnownMethod>, Exclude<KnownMethod, Typed>] extends
    [never, never] ? true : false = true;

Deno.test('known methods match the pinned client types, case-insensitively', () => {
  assert(sameMethods);
  equal(new Set(knownMethods).size, knownMethods.length);
  equal(knownMethod('getMe'), 'getMe');
  equal(knownMethod('GETME'), 'getMe');
  equal(knownMethod('setwebhook'), 'setWebhook');
  equal(knownMethod('getMe2'), undefined);
  equal(knownMethod('constructor'), undefined);
  equal(knownMethod('__proto__'), undefined);
});

Deno.test('tokens carry 256 random bits and parse only in canonical form', async () => {
  const issued = new Set<string>();

  for (let i = 0; i < 64; i++) {
    const token = issueToken(42);

    assert(/^42:[A-Za-z0-9_-]{43}$/.test(token), token);
    equal(parseToken(token), { botId: 42, token });
    issued.add(token.slice(3));
  }

  // 43 base64url characters encode 258 bits; the last carries 4 zero bits.
  equal(issued.size, 64);

  for (
    const malformed of [
      '',
      '42',
      '42:',
      ':abc',
      '042:abc',
      '-42:abc',
      '0:abc',
      '4.2:abc',
      '9007199254740992:abc',
      '42:ab=c',
      '42:ab c',
      '42:ab/c',
      '42:ab:c',
      ' 42:abc',
    ]
  ) {
    equal(parseToken(malformed), null);
  }

  equal(parseToken('9007199254740991:a')?.botId, Number.MAX_SAFE_INTEGER);

  const token = issueToken(7);
  const digest = await verifier(token);

  assert(/^[0-9a-f]{64}$/.test(digest) && !digest.includes(token));
  assert(sameVerifier(digest, await verifier(token)));
  assert(!sameVerifier(digest, await verifier(issueToken(7))));
  assert(!sameVerifier(digest, digest.slice(1)));
  assert(!sameVerifier(digest, ''));
});

Deno.test('routes match exactly one bot<token>/<method> pair', () => {
  equal(parseRoute('/bot1:a/getMe'), { token: '1:a', method: 'getMe' });
  equal(parseRoute('/botx/y'), { token: 'x', method: 'y' });

  for (
    const path of [
      '/',
      '/bot',
      '/bot/getMe',
      '/bot1:a',
      '/bot1:a/',
      '/bot1:a/getMe/',
      '/bot1:a/test/getMe',
      '/file/bot1:a/x',
      '//bot1:a/getMe',
      '/Bot1:a/getMe',
    ]
  ) {
    equal(parseRoute(path), null);
  }

  assert(isJson('application/json'));
  assert(isJson('Application/JSON; charset=utf-8'));
  assert(!isJson(null));
  assert(!isJson('text/plain'));
  assert(!isJson('application/json-patch+json'));
  assert(!isJson('multipart/form-data; boundary=x'));
});

Deno.test('failure envelopes hide unexpected errors', async () => {
  const response = failure(new Error('secret 1:abc'));

  equal(response.status, 500);
  equal(await response.json(), {
    ok: false,
    error_code: 500,
    description: 'Internal Server Error',
  });
});

Deno.test('bot identity rules and the getMe projection', () => {
  for (
    const valid of [
      'abcbot',
      'a1_bot',
      'PosterBot',
      'x_BOT',
      'a' + 'b'.repeat(28) + 'bot',
    ]
  ) {
    assert(botUsername.safeParse(valid).success, valid);
  }

  for (
    const invalid of [
      'abot',
      'bot',
      '1abcbot',
      '_abcbot',
      'abc_bots',
      'abc-bot',
      '@abcbot',
      'a' + 'b'.repeat(29) + 'bot',
    ]
  ) {
    assert(!botUsername.safeParse(invalid).success, invalid);
  }

  assert(!createInput.safeParse({ username: 'abcbot', firstName: '' }).success);
  assert(
    !createInput.safeParse({ username: 'abcbot', firstName: 'x'.repeat(65) })
      .success,
  );
  assert(
    !createInput.safeParse({ username: 'abcbot', firstName: 'x', id: 1 })
      .success,
  );
  equal(nextBotId([]), firstBotId);
  equal(
    nextBotId([
      { id: firstBotId + 4, username: 'a', firstName: 'a', verifier: '' },
      { id: firstBotId, username: 'b', firstName: 'b', verifier: '' },
    ]),
    firstBotId + 5,
  );

  const user = botUser({
    id: 5,
    username: 'abcbot',
    firstName: 'A',
    verifier: '0'.repeat(64),
  }) satisfies UserFromGetMe;

  assert(!Object.values(user).includes('0'.repeat(64)), 'Verifier projected');
});

Deno.test('channel fixtures: -100 IDs, titles and case-insensitive usernames', async () => {
  const channel = { id: -1001234567890, title: 'News', username: 'news_room' };

  equal(channelFixtures({ fixtures: { channels: [channel] } }), [
    { collection: 'channels', id: '-1001234567890', value: channel },
  ]);
  equal(channelFixtures(), []);
  equal(channelFixtures({}), []);
  equal(usernameKey('News_Room'), 'news_room');

  for (const id of [-1001, -1009007199254740]) {
    assert(isChannelId(id), String(id));
  }

  for (
    const id of [
      -100,
      -1234567890,
      1001234567890,
      -1001.5,
      -Infinity,
      NaN,
      -10012345678901234,
    ]
  ) {
    assert(!isChannelId(id), String(id));
  }

  for (
    const [options, message] of [
      [{
        fixtures: {
          channels: [channel, { ...channel, username: 'other' + 'x' }],
        },
      }, 'Duplicate fixture channel ID.'],
      [{
        fixtures: {
          channels: [channel, { ...channel, id: -1002, username: 'NEWS_ROOM' }],
        },
      }, 'Duplicate fixture channel username.'],
      [
        { fixtures: { channels: [{ ...channel, id: -42 }] } },
        'Invalid Telegram options.',
      ],
      [
        { fixtures: { channels: [{ ...channel, title: '' }] } },
        'Invalid Telegram options.',
      ],
      [
        { fixtures: { channels: [{ ...channel, username: '@news_room' }] } },
        'Invalid Telegram options.',
      ],
      [
        { fixtures: { channels: [{ ...channel, username: 'news' }] } },
        'Invalid Telegram options.',
      ],
      [
        { fixtures: { channels: [{ ...channel, extra: 'secret-canary' }] } },
        'Invalid Telegram options.',
      ],
      [{ fixtures: { bots: [] } }, 'Invalid Telegram options.'],
      [{ token: 'secret-canary' }, 'Invalid Telegram options.'],
    ] as const
  ) {
    try {
      // deno-lint-ignore no-explicit-any
      channelFixtures(options as any);
    } catch (error) {
      equal((error as Error).message, message);

      continue;
    }

    throw new Error(`Accepted invalid options: ${message}`);
  }

  // The host rejects invalid fixtures at startup without echoing them.
  await rejects(() =>
    Emulon.start({
      services: {
        tg: telegram({
          fixtures: {
            channels: [{ ...channel, id: 42 }],
          },
        }),
      },
    })
  );
});

// The update types and reaction emoji must match the pinned client types.
type TypedUpdate = Exclude<keyof Update, 'update_id'>;
type TypedEmoji = ReactionTypeEmoji['emoji'];
type Emoji = typeof reactionEmoji[number];

const sameUpdates:
  [Exclude<TypedUpdate, UpdateType>, Exclude<UpdateType, TypedUpdate>] extends
    [never, never] ? true : false = true;
const sameEmoji:
  [Exclude<TypedEmoji, Emoji>, Exclude<Emoji, TypedEmoji>] extends
    [never, never] ? true : false = true;

Deno.test('update types and reaction emoji match the pinned client types', () => {
  assert(sameUpdates && sameEmoji);
  equal(new Set(updateTypes).size, updateTypes.length);
  equal(new Set(reactionEmoji).size, reactionEmoji.length);
});

Deno.test('getUpdates parameters default, validate and deduplicate', () => {
  equal(updatesRequest({}), { limit: 100, timeout: 0 });
  equal(
    updatesRequest({
      offset: -3,
      limit: 1,
      timeout: 50,
      allowed_updates: ['message_reaction_count', 'message_reaction_count'],
    }),
    {
      offset: -3,
      limit: 1,
      timeout: 50,
      allowedUpdates: ['message_reaction_count'],
    },
  );
  equal(updatesRequest({ allowed_updates: [] }), {
    limit: 100,
    timeout: 0,
    allowedUpdates: [],
  });

  for (
    const [params, status] of [
      [{ limit: 0 }, 400],
      [{ limit: 100.5 }, 400],
      [{ offset: Number.MAX_SAFE_INTEGER + 1 }, 400],
      [{ offset: null }, 400],
      [{ timeout: -1 }, 400],
      [{ allowed_updates: {} }, 400],
      [{ allowed_updates: ['update_id'] }, 400],
      [{ allowed_updates: ['constructor'] }, 400],
      [{ webhook: true }, 501],
    ] as const
  ) {
    try {
      updatesRequest(params);
    } catch (error) {
      equal((error as { status?: unknown }).status, status);

      continue;
    }

    throw new Error(`Accepted ${JSON.stringify(params)}`);
  }
});

Deno.test('reaction snapshots drop zero counts and sort deterministically', () => {
  const emoji = (value: '👍' | '🔥', total_count: number) => ({
    type: { type: 'emoji', emoji: value } as const,
    total_count,
  });
  const custom = (id: string, total_count: number) => ({
    type: { custom_emoji_id: id, type: 'custom_emoji' } as const,
    total_count,
  });
  const paid = (total_count: number) => ({
    type: { type: 'paid' } as const,
    total_count,
  });

  equal(
    normalizeReactions([
      custom('9', 2),
      emoji('🔥', 2),
      paid(2),
      custom('10', 2),
      emoji('👍', 7),
      custom('11', 0),
    ]),
    [emoji('👍', 7), paid(2), emoji('🔥', 2), custom('10', 2), custom('9', 2)],
  );
  equal(normalizeReactions([paid(0)]), []);
  // Canonical key order, whatever order the caller used.
  equal(
    JSON.stringify(normalizeReactions([custom('1', 1)])),
    '[{"type":{"type":"custom_emoji","custom_emoji_id":"1"},"total_count":1}]',
  );

  for (
    const duplicate of [
      [emoji('👍', 1), emoji('👍', 0)],
      [paid(1), paid(2)],
      [custom('1', 1), custom('1', 1)],
    ]
  ) {
    try {
      normalizeReactions(duplicate);
    } catch (error) {
      equal((error as { code?: unknown }).code, 'DUPLICATE_REACTION');

      continue;
    }

    throw new Error('Accepted a duplicate reaction');
  }
});
