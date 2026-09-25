// Bot API envelopes are snake_case on the wire.
// deno-lint-ignore-file camelcase
import telegram from '@emulon/telegram';
import { Emulon } from 'emulon';
import type { UserFromGetMe } from 'grammy/types';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { compatibility } from '../src/compatibility.ts';
import { assert, equal } from './assert.ts';
import { Bot, GrammyError } from './grammy.ts';

export const { cases, register } = caseRegistry(
  'packages/telegram/tests/bot_cases.ts',
);

export const channel = {
  id: -1001234567890,
  title: 'Local News',
  username: 'local_news',
};

const config = () => ({
  services: { tg: telegram({ fixtures: { channels: [channel] } }) },
});

/** The client appends `/bot<token>/<method>`; `apiRoot` has no trailing slash. */
function client(apiRoot: string, token: string) {
  assert(!apiRoot.endsWith('/'), 'Endpoint URL ends with a slash');

  return new Bot(token, { client: { apiRoot } });
}

/** Neither the error nor anything it carries may contain the secret. */
async function grammyFailure(
  call: () => Promise<unknown>,
  secrets: readonly string[],
): Promise<{ error_code: number; description: string }> {
  try {
    await call();
  } catch (error) {
    assert(error instanceof GrammyError, `Not a GrammyError: ${error}`);

    const visible = [
      error.message,
      error.description,
      JSON.stringify(error.parameters),
      String(error.stack),
    ].join('\n');

    for (const secret of secrets) {
      assert(!visible.includes(secret), 'A token reached the client error');
    }

    return { error_code: error.error_code, description: error.description };
  }

  throw new Error('Expected a Bot API failure');
}

async function envelope(
  response: Response,
  secrets: readonly string[],
): Promise<unknown> {
  const text = await response.text();

  equal(
    response.headers.get('content-type')?.split(';')[0],
    'application/json',
  );

  for (const secret of secrets) {
    assert(!text.includes(secret), 'A token reached a response body');
  }

  return { status: response.status, body: JSON.parse(text) };
}

const secretOf = (token: string) => token.slice(token.indexOf(':') + 1);

register(
  'telegram.bots.1',
  ['getMe'],
  [],
  false,
  'a CLI or SDK token reaches getMe through grammY once, survives restart and never reappears',
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

      return {
        ...result,
        value: result.code === 0 ? JSON.parse(result.stdout) : undefined,
      };
    };

    try {
      const fromCLI = await cli([
        'tg',
        'bots',
        'create',
        '--username',
        'poster_bot',
        '--first-name',
        'Poster Ада',
      ]);

      assert(fromCLI.code === 0, fromCLI.stderr);
      equal(Object.keys(fromCLI.value).sort(), ['id', 'token', 'username']);
      assert(Number.isSafeInteger(fromCLI.value.id) && fromCLI.value.id > 0);
      assert(
        new RegExp(`^${fromCLI.value.id}:[A-Za-z0-9_-]{43}$`).test(
          fromCLI.value.token,
        ),
        'Unexpected token shape',
      );

      await using connected = await Emulon.connect({
        config: configured,
        directory,
      });
      const api = connected.endpoints.tg.api!;
      const me: UserFromGetMe = await client(api, fromCLI.value.token).api
        .getMe();

      equal(me, {
        id: fromCLI.value.id,
        is_bot: true,
        first_name: 'Poster Ада',
        username: 'poster_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      });

      const fromSDK = await connected.services.tg.bots.create({
        username: 'Reader_Bot',
        firstName: 'Reader',
      });

      assert(
        fromSDK.id !== fromCLI.value.id &&
          fromSDK.token !== fromCLI.value.token,
      );
      equal(
        (await client(api, fromSDK.token).api.getMe()).username,
        'Reader_Bot',
      );

      const tokens = [fromCLI.value.token, fromSDK.token];
      const secrets = [...tokens, ...tokens.map(secretOf)];

      // Usernames of bots and channels are one case-insensitive namespace.
      for (const username of ['POSTER_BOT', 'reader_bot']) {
        const duplicate = await cli([
          'tg',
          'bots',
          'create',
          '--username',
          username,
          '--first-name',
          'Twin',
        ]);

        assert(duplicate.code !== 0, 'Duplicate username accepted');
        assert(duplicate.stderr.includes('USERNAME_TAKEN'), duplicate.stderr);
      }

      const twin = await runProjectCLI(
        [
          'tg',
          'bots',
          'create',
          '--username',
          'Local_News_Bot',
          '--first-name',
          'x',
          '--json',
        ],
        undefined,
        directory,
      );

      assert(twin.code === 0, twin.stderr);

      // The dedicated command is the only credential output.
      const visible = [
        (await cli(['status'])).stdout,
        (await cli(['tg', 'compatibility', 'get'])).stdout,
        (await cli(['events', 'list'])).stdout,
        (await cli(['tg', '--help'])).stdout,
        JSON.stringify(await connected.services.tg.compatibility.get({})),
        JSON.stringify(await connected.events.list()),
        JSON.stringify(connected.endpoints),
        twin.stdout,
      ].join('\n');

      for (const secret of secrets) {
        assert(!visible.includes(secret), 'A token reached inspection output');
      }

      equal(await connected.services.tg.compatibility.get({}), compatibility);

      await host.dispose();

      host = await serveEnvironment(configured, { directory });

      await using restarted = await Emulon.connect({
        config: configured,
        directory,
      });
      const reopened = restarted.endpoints.tg.api!;

      // A durable restart keeps the verifier, not a readable token.
      equal(
        (await client(reopened, fromCLI.value.token).api.getMe()).id,
        fromCLI.value.id,
      );
      equal(
        (await client(reopened, fromSDK.token).api.getMe()).id,
        fromSDK.id,
      );

      const again = await restarted.services.tg.bots.create({
        username: 'third_bot',
        firstName: 'Third',
      });

      assert(
        again.id > fromSDK.id && !tokens.includes(again.token),
        'Restart reused an issued bot',
      );
    } finally {
      await host.dispose();
      await Deno.remove(directory, { recursive: true });
    }
  },
);

register(
  'telegram.bots.2',
  ['getMe'],
  [],
  false,
  'foreign, malformed and stale tokens fail before dispatch without revealing the token',
  async () => {
    await using env = await Emulon.start({
      services: {
        tg: telegram({ fixtures: { channels: [channel] } }),
        other: telegram(),
      },
    });
    const api = env.endpoints.tg.api!;
    const issued = await env.services.tg.bots.create({
      username: 'poster_bot',
      firstName: 'Poster',
    });
    const foreign = await env.services.other.bots.create({
      username: 'poster_bot',
      firstName: 'Poster',
    });
    const secret = secretOf(issued.token);
    const secrets = [
      issued.token,
      secret,
      foreign.token,
      secretOf(foreign.token),
    ];

    // Another instance issues the same ID; its token still fails here.
    equal(foreign.id, issued.id);
    equal((await client(api, issued.token).api.getMe()).id, issued.id);

    const unauthorized = { error_code: 401, description: 'Unauthorized' };
    const notFound = { error_code: 404, description: 'Not Found' };

    for (
      const token of [
        foreign.token,
        `${issued.id}:${'A'.repeat(43)}`,
        `${issued.id}:${secret.slice(0, -1)}`,
        `${issued.id + 1}:${secret}`,
      ]
    ) {
      equal(
        await grammyFailure(() => client(api, token).api.getMe(), secrets),
        unauthorized,
      );
    }

    for (
      const token of [
        secret,
        `${issued.id}`,
        `${issued.id}:`,
        `0${issued.id}:${secret}`,
        `-${issued.id}:${secret}`,
        `0:${secret}`,
        `9007199254740993:${secret}`,
        `${issued.id}:${secret}=`,
        `${issued.id}:${secret}:x`,
      ]
    ) {
      equal(
        await grammyFailure(() => client(api, token).api.getMe(), secrets),
        notFound,
      );
    }

    // The token is checked before the method, so neither an unknown nor an
    // unsupported method is distinguishable without a valid token.
    const wrong = client(api, foreign.token);

    equal(
      await grammyFailure(() => wrong.api.deleteWebhook(), secrets),
      unauthorized,
    );
    equal(
      await grammyFailure(
        () =>
          (wrong.api.raw as unknown as Record<
            string,
            (p: object) => Promise<unknown>
          >).notAMethod!({}),
        secrets,
      ),
      unauthorized,
    );

    // Paths other than one bot<token>/<method> pair are not Bot API routes.
    for (
      const path of [
        '/',
        `/bot${issued.token}`,
        `/bot${issued.token}/`,
        `/bot${issued.token}/getMe/`,
        `/bot${issued.token}/getMe/extra`,
        `/bot${issued.token}/test/getMe`,
        `/file/bot${issued.token}/photos/1.jpg`,
        `/BOT${issued.token}/getMe`,
        `/bot${issued.token.replace(':', '%3A')}/getMe`,
      ]
    ) {
      equal(
        await envelope(
          await fetch(api + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
          secrets,
        ),
        { status: 404, body: { ok: false, ...notFound } },
      );
    }

    await env.reset();

    equal(
      await grammyFailure(() => client(api, issued.token).api.getMe(), secrets),
      unauthorized,
    );

    // Reset restarts allocation; the reused ID must not revive the old token.
    const reissued = await env.services.tg.bots.create({
      username: 'poster_bot',
      firstName: 'Poster again',
    });

    equal(reissued.id, issued.id);
    equal(
      await grammyFailure(() => client(api, issued.token).api.getMe(), secrets),
      unauthorized,
    );
    equal(
      (await client(api, reissued.token).api.getMe()).first_name,
      'Poster again',
    );
    // Resetting both instances leaves the foreign token failing here too.
    equal(
      await grammyFailure(
        () => client(api, foreign.token).api.getMe(),
        secrets,
      ),
      unauthorized,
    );
  },
);

register(
  'telegram.bots.3',
  ['getMe'],
  [],
  false,
  'unsupported methods, transports and parameters fail with explicit envelopes',
  async () => {
    await using env = await Emulon.start(config());
    const api = env.endpoints.tg.api!;
    const { token } = await env.services.tg.bots.create({
      username: 'poster_bot',
      firstName: 'Poster',
    });
    const bot = client(api, token);
    const secrets = [token, secretOf(token)];
    const method = {
      error_code: 501,
      description: 'Not Implemented: method is not emulated',
    };

    // Polling-only: no webhook can be installed, read or removed.
    equal(
      await grammyFailure(
        () => bot.api.setWebhook('http://127.0.0.1:1/hook'),
        secrets,
      ),
      method,
    );
    equal(await grammyFailure(() => bot.api.deleteWebhook(), secrets), method);
    equal(await grammyFailure(() => bot.api.getWebhookInfo(), secrets), method);
    equal(await grammyFailure(() => bot.api.logOut(), secrets), method);
    equal(
      await grammyFailure(
        () => bot.api.forwardMessage(channel.id, channel.id, 1),
        secrets,
      ),
      method,
    );
    equal(
      await grammyFailure(
        () =>
          (bot.api.raw as unknown as Record<
            string,
            (p: object) => Promise<unknown>
          >).notAMethod!({}),
        secrets,
      ),
      { error_code: 404, description: 'Not Found' },
    );

    // Method names are case-insensitive, as in the Bot API.
    equal(
      await envelope(
        await fetch(`${api}/bot${token}/GETME`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: '{}',
        }),
        secrets,
      ),
      {
        status: 200,
        body: { ok: true, result: await bot.api.getMe() },
      },
    );

    const transport = {
      ok: false,
      error_code: 501,
      description:
        'Not Implemented: only POST requests with a JSON body are emulated',
    };
    const body = {
      ok: false,
      error_code: 400,
      description: 'Bad Request: request body must be a JSON object',
    };

    for (
      const [init, expected] of [
        [{ method: 'GET' }, transport],
        [{
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }, transport],
        [{
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: '',
        }, transport],
        [{
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          body: '--x--',
        }, transport],
        [{ method: 'POST', body: '{}' }, transport],
        [{
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '',
        }, body],
        [{
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '[]',
        }, body],
        [{
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: `"${token}"`,
        }, body],
        [{
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: `{"${token}"`,
        }, body],
        [
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [token]: token }),
          },
          {
            ok: false,
            error_code: 501,
            description: 'Not Implemented: parameter is not emulated',
          },
        ],
      ] as const
    ) {
      const response = await fetch(`${api}/bot${token}/getMe`, init);

      equal(await envelope(response, secrets), {
        status: expected.error_code,
        body: expected,
      });
    }

    // A known method is refused before its transport is considered.
    equal(
      await envelope(await fetch(`${api}/bot${token}/forwardMessage`), secrets),
      { status: 501, body: { ok: false, ...method } },
    );
  },
);
