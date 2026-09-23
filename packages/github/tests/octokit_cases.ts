import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { RequestError } from 'octokit';
import { definePlugin, Emulon } from 'emulon';
import github from '../src/mod.ts';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { parity } from '../../resend/tests/helpers/parity.ts';
import { localClient } from '../../../examples/github-app/client.ts';
import { sign } from './helpers/jwt.ts';
import { runExample } from '../../../examples/github-app/main.ts';

export const { cases, register } = caseRegistry(
  'packages/github/tests/octokit_cases.ts',
);

const equal = (actual: unknown, expected: unknown) =>
  parity('Octokit contract', 'value', actual, expected);

async function failure(
  work: () => Promise<unknown>,
  status: number,
  message: string,
  body: unknown = {
    message,
    documentation_url: 'https://docs.github.com/rest',
    status: String(status),
  },
) {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof RequestError)) {
      throw error;
    }

    equal(error.status, status);
    equal(error.response?.data, body);
    equal(error.message.includes(message), true);
    equal(new URL(error.request.url).hostname, '127.0.0.1');

    return;
  }

  throw new Error('Octokit accepted a rejected operation');
}

register(
  'github.octokit.1',
  [
    'app.get',
    'installations.list',
    'installation-token.create',
    'user.get',
    'issues.create',
  ],
  [],
  false,
  'official Octokit exercises GitHub App routes and scoped provider errors on loopback',
  async () => {
    let now = 1_800_000_000_000;
    const { definition } = readRegistration(github());
    const controlled = definePlugin({
      ...definition,
      setup(ctx, options) {
        return definition.setup({ ...ctx, clock: { now: () => now } }, options);
      },
    });
    await using env = await Emulon.start({
      services: {
        github: controlled({
          fixtures: {
            users: [{ login: 'igor' }, { login: 'other' }],
            repositories: [
              { owner: 'igor', name: 'one', private: true },
              { owner: 'igor', name: 'two', private: true },
              { owner: 'other', name: 'one', private: true },
            ],
          },
        }),
      },
    });
    const gh = env.services.github;
    const app = await gh.apps.create({
      slug: 'bot',
      permissions: { issues: 'write' },
    });
    const foreignApp = await gh.apps.create({ slug: 'foreign' });
    const installation = await gh.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/one', 'igor/two'],
    });
    const other = await gh.installations.create({
      appId: app.id,
      account: 'other',
      repositories: ['other/one'],
    });
    const foreign = await gh.installations.create({
      appId: foreignApp.id,
      account: 'other',
      repositories: ['other/one'],
    });
    const claims = { iss: app.id, iat: now / 1000 - 60, exp: now / 1000 + 600 };
    const api = env.endpoints.github.api!;
    const client = localClient(api, await sign(app.privateKey, claims));
    const view = await client.rest.apps.getAuthenticated();

    equal(view.status, 200);
    equal(view.data?.id, Number(app.id));
    equal(view.data?.slug, 'bot');

    const list = await client.rest.apps.listInstallations();

    equal(list.status, 200);
    equal(list.data.map((item) => item.id), [
      Number(installation.id),
      Number(other.id),
    ]);

    const issueToken = (id = installation.id) =>
      client.rest.apps.createInstallationAccessToken({
        installation_id: Number(id),
      });
    const issued = await issueToken();

    equal(issued.status, 201);
    equal(issued.data.expires_at, new Date(now + 3600_000).toISOString());
    equal(issued.data.permissions, { issues: 'write' });

    const principal = localClient(api, issued.data.token);
    const user = await principal.rest.users.getAuthenticated();

    equal(user.status, 200);
    equal(user.data, { id: Number(app.id), login: 'bot[bot]', type: 'Bot' });

    const create = (sdk = principal, owner = 'igor', repo = 'one') =>
      sdk.rest.issues.create({
        owner,
        repo,
        title: 'Contract issue',
        body: 'Details',
      });
    const issue = await create();

    equal(issue.status, 201);
    equal(issue.data.number, 1);
    equal(issue.data.title, 'Contract issue');
    equal(issue.data.user, user.data);
    equal((await env.events.list()).length, 1);

    const wrongKey = localClient(
      api,
      await sign(foreignApp.privateKey, claims),
    );

    await failure(
      () => wrongKey.rest.apps.getAuthenticated(),
      401,
      'A JSON web token could not be decoded',
    );
    await failure(() => issueToken(foreign.id), 404, 'Not Found');

    const otherToken = await issueToken(other.id);
    const otherClient = localClient(api, otherToken.data.token);

    equal((await create(otherClient, 'other')).status, 201);
    await failure(() => create(otherClient), 404, 'Not Found');
    await failure(() => create(principal, 'other'), 404, 'Not Found');

    const narrowed = await client.rest.apps.createInstallationAccessToken({
      installation_id: Number(installation.id),
      repositories: ['one'],
      permissions: { issues: 'read' },
    });

    equal(narrowed.data.permissions, { issues: 'read' });
    equal(narrowed.data.repositories?.map((repo) => repo.full_name), [
      'igor/one',
    ]);

    const readOnly = localClient(api, narrowed.data.token);

    await failure(
      () => create(readOnly),
      403,
      'Resource not accessible by integration',
    );
    await failure(() => create(readOnly, 'igor', 'two'), 404, 'Not Found');
    await failure(
      () =>
        client.rest.apps.createInstallationAccessToken({
          installation_id: Number(installation.id),
          permissions: { contents: 'write' },
        }),
      422,
      'The permissions requested are not granted to this installation.',
    );
    await failure(
      () =>
        client.rest.apps.createInstallationAccessToken({
          installation_id: Number(installation.id),
          repositories: ['missing'],
        }),
      422,
      'The repositories requested are not available to this installation.',
    );

    await gh.installations.suspend({ id: installation.id });
    await failure(
      () => issueToken(),
      403,
      'This installation has been suspended',
    );
    await failure(() => create(), 403, 'This installation has been suspended');
    await gh.installations.unsuspend({ id: installation.id });

    now += 3600_000 - 1;

    equal((await principal.rest.users.getAuthenticated()).status, 200);
    now++;
    await failure(
      () => principal.rest.users.getAuthenticated(),
      401,
      'Bad credentials',
    );
    await failure(() => create(), 401, 'Bad credentials');
    equal((await env.events.list()).length, 2);

    await failure(
      () =>
        client.rest.apps.getAuthenticated({
          headers: { 'x-github-api-version': '2099-01-01' },
        }),
      400,
      'Not a supported version',
    );
    await failure(() => client.request('GET /unsupported'), 404, 'Not Found', {
      message: 'Not Found',
    });
  },
);

register(
  'github.octokit.2',
  [],
  ['issues.opened'],
  false,
  'github-app example inspects and redelivers a signed issues webhook',
  async () => {
    const result = await runExample();

    equal(result.deliveryStatus, 'succeeded');
    equal(result.webhook.event, 'issues');
    equal(result.webhook.signatureVerified, true);
    equal(result.redeliveryStatus, 'succeeded');
    equal(result.redeliveredWebhook.signatureVerified, true);
    equal(result.redeliveredWebhook.event, 'issues');
    equal(result.redeliveredWebhook.payload, result.webhook.payload);
    equal(
      result.redeliveredWebhook.delivery === result.webhook.delivery,
      false,
    );

    const [initial, repeated] = result.deliveryInspections;

    equal(initial!.id, repeated!.id);
    equal(initial!.status, 'succeeded');
    equal(repeated!.status, 'succeeded');
    equal(initial!.attempts.length, 1);
    equal(repeated!.attempts.length, 2);
    equal(repeated!.attempts[0], initial!.attempts[0]);
    equal(
      repeated!.attempts.map((attempt) => attempt.responseStatus),
      [204, 204],
    );
    equal(
      repeated!.attempts.map((attempt) => attempt.providerDeliveryId).sort(),
      [result.webhook.delivery, result.redeliveredWebhook.delivery].sort(),
    );
    equal(/^[0-9a-f-]{36}$/.test(result.webhook.delivery), true);

    const payload = result.webhook.payload as {
      action: string;
      issue: unknown;
    };

    equal(payload.action, 'opened');
    equal(payload.issue, result.issue);
    equal(result.issue.number, 1);
    equal(result.user.login, 'igor');
    equal(result.user.type, 'User');
    equal(result.userIssue.number, 2);
    equal(result.userIssue.user, result.user);
    equal(result.userWebhook.event, 'issues');

    const userPayload = result.userWebhook.payload as {
      issue: unknown;
      sender: unknown;
    };

    equal(userPayload.issue, result.userIssue);
    equal(userPayload.sender, result.user);
  },
);

register(
  'github.octokit.3',
  [],
  ['issues.opened'],
  false,
  'example receiver rejects tampered bodies and malformed signatures',
  async () => {
    const { verifyWebhook } = await import(
      '../../../examples/github-app/verify.ts'
    );
    const signature =
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

    equal(
      await verifyWebhook(
        "It's a Secret to Everybody",
        'Hello, World!',
        signature,
      ),
      true,
    );
    equal(
      await verifyWebhook("It's a Secret to Everybody", 'Changed', signature),
      false,
    );
    equal(await verifyWebhook('wrong', 'Hello, World!', signature), false);

    for (const malformed of ['', 'sha1=abc', 'sha256=zz', signature + '00']) {
      equal(await verifyWebhook('secret', 'body', malformed), false);
    }
  },
);

register(
  'github.octokit.4',
  ['user.get', 'issues.create', 'user-token.create'],
  [],
  false,
  'official Octokit exercises user code exchange, intersection and OAuth errors',
  async () => {
    let now = Date.now();
    const { definition } = readRegistration(github());
    const controlled = definePlugin({
      ...definition,
      setup(ctx, options) {
        return definition.setup({ ...ctx, clock: { now: () => now } }, options);
      },
    });
    await using env = await Emulon.start({
      services: {
        github: controlled({
          fixtures: {
            users: [{ login: 'igor' }],
            repositories: ['both', 'app-only', 'user-only', 'foreign'].map((
              name,
            ) => ({
              owner: 'igor',
              name,
              private: true,
            })),
          },
        }),
      },
    });
    const gh = env.services.github;
    const callback = env.endpoints.github.web! + '/callback';
    const app = await gh.apps.create({
      slug: 'user-client',
      callbackUrls: [callback],
      permissions: { issues: 'write' },
    });
    const foreign = await gh.apps.create({
      slug: 'foreign',
      permissions: { issues: 'write' },
    });
    const installation = await gh.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/both', 'igor/app-only'],
    });

    await gh.installations.create({
      appId: foreign.id,
      account: 'igor',
      repositories: ['igor/foreign'],
    });

    const approve = (
      repositories = ['igor/both', 'igor/user-only', 'igor/foreign'],
      level: 'read' | 'write' = 'write',
    ) =>
      gh.authorization.approve({
        clientId: app.clientId,
        login: 'igor',
        repositories,
        permissions: { issues: level },
      });
    const web = localClient(env.endpoints.github.web!);
    const exchange = (code: string, extra = {}) =>
      web.request('POST /login/oauth/access_token', {
        headers: { accept: 'application/json' },
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: callback,
        code,
        ...extra,
      });
    const authorization = await approve();
    const issued = await exchange(authorization.code);

    equal(issued.status, 200);
    equal(issued.data.token_type, 'bearer');
    equal(issued.data.scope, '');
    equal(issued.data.access_token.startsWith('ghu_'), true);
    equal(Object.keys(issued.data).sort(), [
      'access_token',
      'scope',
      'token_type',
    ]);

    const oauthFailure = async (
      code: string,
      error = 'bad_verification_code',
      extra = {},
    ) => {
      const response = await exchange(code, extra);

      equal(response.status, 200);
      equal(response.data, {
        error,
        error_description: error === 'bad_verification_code'
          ? 'The code passed is incorrect or expired.'
          : 'The grant_type is not supported.',
        error_uri:
          '/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#' +
          error.replaceAll('_', '-'),
      });
    };

    await oauthFailure(authorization.code);
    await oauthFailure(authorization.code, 'unsupported_grant_type', {
      grant_type: 'refresh_token',
      refresh_token: 'unsupported',
    });

    const client = localClient(
      env.endpoints.github.api!,
      issued.data.access_token,
    );
    const user = await client.rest.users.getAuthenticated();

    equal(user.status, 200);
    equal(user.data.login, 'igor');
    equal(user.data.type, 'User');

    const create = (repo = 'both', sdk = client) =>
      sdk.rest.issues.create({
        owner: 'igor',
        repo,
        title: 'User intersection',
      });
    const issue = await create();

    equal(issue.status, 201);
    equal(issue.data.user, user.data);
    equal((await env.events.list()).length, 1);

    for (const repo of ['app-only', 'user-only', 'foreign']) {
      await failure(() => create(repo), 404, 'Not Found');
    }

    await approve(['igor/both'], 'read');
    await failure(
      () => create(),
      403,
      'Resource not accessible by integration',
    );

    const narrowCode = await approve(['igor/both'], 'read');
    const narrowToken = await exchange(narrowCode.code);
    const narrow = localClient(
      env.endpoints.github.api!,
      narrowToken.data.access_token,
    );

    await approve(['igor/both', 'igor/app-only']);
    await failure(
      () => create('both', narrow),
      403,
      'Resource not accessible by integration',
    );
    await failure(() => create('app-only', narrow), 404, 'Not Found');
    await failure(() => create('app-only'), 404, 'Not Found');
    await gh.installations.suspend({ id: installation.id });
    await failure(() => create(), 403, 'This installation has been suspended');
    await gh.installations.unsuspend({ id: installation.id });

    const expiredCode = await approve();

    now = Date.parse(expiredCode.expiresAt);

    await oauthFailure(expiredCode.code);

    // ADR 0024 has no expiring user-token mode: advancing time must preserve access.
    now += 365 * 24 * 3600_000;

    equal((await client.rest.users.getAuthenticated()).status, 200);
    equal((await env.events.list()).length, 1);
    await env.reset();
    await failure(
      () => client.rest.users.getAuthenticated(),
      401,
      'Bad credentials',
    );
    await failure(() => create(), 401, 'Bad credentials');
  },
);
