import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import github from '../src/mod.ts';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { parity } from '../../resend/tests/helpers/parity.ts';
import { sign } from './helpers/jwt.ts';
import { requireIssueWrite } from '../src/auth/access.ts';
import { AuthError } from '../src/auth/errors.ts';
import { type TokenRecord, validateToken } from '../src/auth/tokens.ts';
import { grantSchema, installationSchema } from '../src/model/schema.ts';
import { createIssue, type Issue } from '../src/model/issues.ts';

export const { cases, register } = caseRegistry(
  'packages/github/tests/issues_cases.ts',
);
const equal = (actual: unknown, expected: unknown) =>
  parity('issues', 'value', actual, expected);

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

const options = {
  fixtures: {
    users: [{ login: 'igor' }, { login: 'other' }],
    repositories: [{ owner: 'igor', name: 'demo', private: true }, {
      owner: 'igor',
      name: 'second',
    }, { owner: 'other', name: 'demo', private: true }],
  },
};

register(
  'github.issues.1',
  ['issues.create'],
  [],
  false,
  'pure issue access rules conceal repositories before checking write permission',
  () => {
    const repository = {
      id: '1',
      fullName: 'igor/demo',
      owner: 'igor',
      name: 'demo',
      private: true,
    };
    const token: TokenRecord = {
      token: 'secret',
      installationId: '2',
      expiresAt: 100,
      repositories: ['igor/demo'],
      permissions: { issues: 'write' },
    };

    equal(requireIssueWrite(token, repository), repository);

    for (
      const [candidate, repo, reason] of [
        [token, undefined, 'missing'],
        [{ ...token, repositories: [] }, repository, 'missing'],
        [{ ...token, permissions: {} }, repository, 'inaccessible'],
        [
          { ...token, permissions: { issues: 'read' } },
          repository,
          'inaccessible',
        ],
      ] as const
    ) {
      let failure;

      try {
        requireIssueWrite({
          ...candidate,
          repositories: [...candidate.repositories],
        }, repo);
      } catch (error) {
        assert(error instanceof AuthError, 'Unexpected error');

        failure = error.reason;
      }

      equal(failure, reason);
    }

    const installation = {
      id: '3',
      appId: '4',
      account: 'igor',
      repositories: ['igor/demo'],
      permissions: { issues: 'write' as const },
      suspended: false,
    };
    let failure;

    try {
      validateToken(token, installation, 0);
    } catch (error) {
      assert(error instanceof AuthError, 'Unexpected error');

      failure = error.reason;
    }

    equal(failure, 'missing');
  },
);

register(
  'github.issues.2',
  ['issues.create'],
  [],
  false,
  'GitHub issues share CLI/SDK state and events; provider checks live grants and rolls back failures',
  async () => {
    const directory = await Deno.makeTempDir();
    let ctx!: PluginContext;
    const { definition } = readRegistration(github());
    const observed = definePlugin({
      ...definition,
      setup(context, options) {
        ctx = context;

        return definition.setup(context, options);
      },
    });
    const config = { services: { github: observed(options) } };

    try {
      await using host = await serveEnvironment(config, { directory });
      await using env = await Emulon.connect({ config, directory });
      const gh = env.services.github;
      const api = env.endpoints.github.api!;

      equal(api, host.identity.endpoints.github!.api);

      const cli = (args: string[]) =>
        runProjectCLI([...args, '--json'], undefined, directory);
      const snapshot = () =>
        ctx.store.transaction(async (tx) => ({
          issues: await tx.list('issues'),
          counters: await tx.list('issue-counters'),
          events: await tx.outbox(),
        }));
      const stream = await env.events.follow({ type: 'issues.opened' });
      const reader = stream.getReader();

      try {
        const result = await cli([
          'github',
          'issues',
          'create',
          '--repo',
          'igor/demo',
          '--title',
          'Bug',
        ]);

        assert(result.code === 0, result.stderr);

        const first: Issue = JSON.parse(result.stdout);
        const second = await gh.issues.create({
          repository: 'igor/demo',
          title: 'Bug',
        });
        const normalize = (issue: Issue) => ({
          ...issue,
          id: 1,
          number: 1,
          url: 'URL',
          html_url: 'WEB',
          comments_url: 'COMMENTS',
          created_at: 'TIME',
          updated_at: 'TIME',
        });

        equal(normalize(first), normalize(second));
        equal([first.number, second.number], [1, 2]);
        equal(first.html_url, `${env.endpoints.github.web}/igor/demo/issues/1`);

        const third = await gh.issues.create({
          repository: 'igor/second',
          title: 'Separate',
        });

        equal(third.number, 1);

        const app = await gh.apps.create({
          slug: 'review-bot',
          permissions: { issues: 'write' },
        });
        const installation = await gh.installations.create({
          appId: app.id,
          account: 'igor',
          repositories: ['igor/demo'],
        });
        const otherInstallation = await gh.installations.create({
          appId: app.id,
          account: 'other',
          repositories: ['other/demo'],
        });
        const seconds = Math.floor(Date.now() / 1000);
        const jwt = await sign(app.privateKey, {
          iss: app.id,
          iat: seconds,
          exp: seconds + 600,
        });
        const issueToken = async (id: string, input: unknown = {}) => {
          const response = await fetch(
            `${api}/app/installations/${id}/access_tokens`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${jwt}` },
              body: JSON.stringify(input),
            },
          );
          const body = await response.json();

          equal(response.status, 201);

          return body.token as string;
        };

        const token = await issueToken(installation.id);
        const post = async (
          credential: string,
          repository = 'igor/demo',
          body: unknown = { title: 'Provider bug', body: 'Details' },
        ) => {
          const response = await fetch(`${api}/repos/${repository}/issues`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${credential}` },
            body: JSON.stringify(body),
          });

          return { status: response.status, body: await response.json() };
        };

        const principal = await fetch(`${api}/user`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        equal(principal.status, 200);

        const user = await principal.json();

        equal(user, {
          id: Number(app.id),
          login: 'review-bot[bot]',
          type: 'Bot',
        });

        const created = await post(token, 'IGOR/DEMO');

        equal(created.status, 201);
        equal(created.body.number, 3);
        equal(created.body.user, user);

        const before = await snapshot();

        equal(before.issues.length, 4);
        equal(before.events.length, 4);
        equal(before.issues.map((row) => row.value), [
          first,
          second,
          third,
          created.body,
        ]);

        for (const event of before.events) {
          equal((await reader.read()).value, event);
          equal(event.type, 'issues.opened');
          equal(event.origin, 'service');

          const payload = event.payload as { issue: Issue; action: string };

          equal(payload.action, 'opened');
          assert(
            before.issues.some((row) => row.id === String(payload.issue.id)),
            'Event has no issue',
          );
        }

        equal(await env.events.list({ type: 'issues.opened' }), before.events);

        const eventCLI = await cli(['events']);

        equal(eventCLI.code, 0);
        equal(JSON.parse(eventCLI.stdout), before.events);

        const refusal = async (
          credential: string,
          status: number,
          message: string,
          repo = 'igor/demo',
          body?: unknown,
        ) => {
          const before = await snapshot();
          const response = await post(credential, repo, body);

          equal(response, {
            status,
            body: {
              message,
              documentation_url: 'https://docs.github.com/rest',
              status: String(status),
            },
          });
          equal(await snapshot(), before);
        };

        await refusal('unknown', 401, 'Bad credentials');

        const expiring = await issueToken(installation.id);

        await ctx.store.transaction(async (tx) => {
          const row = (await tx.list('tokens')).find((row) =>
            (row.value as TokenRecord).token === expiring
          )!;

          await tx.put({
            ...row,
            value: {
              ...(row.value as TokenRecord),
              expiresAt: ctx.clock.now(),
            },
          });
        });

        await refusal(expiring, 401, 'Bad credentials');
        {
          await using foreign = await Emulon.start({
            services: { github: github(options) },
          });
          const response = await fetch(
            `${foreign.endpoints.github.api}/repos/igor/demo/issues`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              body: JSON.stringify({ title: 'Foreign' }),
            },
          );

          equal(response.status, 401);
          await response.text();
          equal(await foreign.events.list(), []);
        }

        for (
          const input of [{ repository: 'igor/demo', title: '' }, {
            repository: 'igor/missing',
            title: 'Bug',
          }]
        ) {
          const before = await snapshot();
          const result = await cli([
            'github',
            'issues',
            'create',
            '--repo',
            input.repository,
            '--title',
            input.title,
          ]);

          equal(result.code, 1);

          let failed = false;

          try {
            await gh.issues.create(input);
          } catch {
            failed = true;
          }

          assert(failed, 'SDK accepted rejected CLI input');
          equal(await snapshot(), before);
        }

        await refusal(token, 404, 'Not Found', 'igor/missing');
        await refusal(token, 404, 'Not Found', 'igor/second');
        await refusal(await issueToken(otherInstallation.id), 404, 'Not Found');
        await refusal(
          await issueToken(installation.id, {
            permissions: { issues: 'read' },
          }),
          403,
          'Resource not accessible by integration',
        );
        await refusal(
          await issueToken(installation.id, { repositories: [] }),
          404,
          'Not Found',
        );
        await refusal(token, 422, 'Invalid request', 'igor/demo', {
          title: '',
        });
        await gh.installations.suspend({ id: installation.id });
        await refusal(token, 403, 'This installation has been suspended');

        const suspendedUser = await fetch(`${api}/user`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        equal(suspendedUser.status, 403);
        await suspendedUser.text();
        await gh.installations.unsuspend({ id: installation.id });

        const grant = await ctx.store.transaction(async (tx) =>
          grantSchema.parse(await tx.get('grants', installation.id))
        );

        for (
          const change of [{ ...grant, repositoryIds: [] }, {
            ...grant,
            permissions: { issues: 'read' as const },
          }]
        ) {
          await ctx.store.transaction((tx) =>
            tx.put({ collection: 'grants', id: installation.id, value: change })
          );
          await refusal(
            token,
            change.repositoryIds.length ? 403 : 404,
            change.repositoryIds.length
              ? 'Resource not accessible by integration'
              : 'Not Found',
          );
        }

        await ctx.store.transaction((tx) =>
          tx.put({ collection: 'grants', id: installation.id, value: grant })
        );

        for (
          const change of [{ ...installation, repositories: [] }, {
            ...installation,
            permissions: { issues: 'read' as const },
          }]
        ) {
          await ctx.store.transaction((tx) =>
            tx.put({
              collection: 'installations',
              id: installation.id,
              value: change,
            })
          );
          await refusal(
            token,
            change.repositories.length ? 403 : 404,
            change.repositories.length
              ? 'Resource not accessible by integration'
              : 'Not Found',
          );
        }

        await ctx.store.transaction((tx) =>
          tx.put({
            collection: 'installations',
            id: installation.id,
            value: installationSchema.parse(installation),
          })
        );

        const failedContext: PluginContext = {
          ...ctx,
          store: {
            ...ctx.store,
            transaction: (work) =>
              ctx.store.transaction((tx) =>
                work({
                  ...tx,
                  async record(event) {
                    await tx.record(event);

                    throw new Error('Injected failure after outbox append');
                  },
                })
              ),
          },
        };
        let failed = false;

        try {
          await createIssue(failedContext, {
            repository: 'igor/demo',
            title: 'Rollback',
          });
        } catch {
          failed = true;
        }

        assert(failed, 'Failure injection did not execute');
        equal(await snapshot(), before);

        const concurrent = await Promise.all(
          Array.from({ length: 5 }, () => post(token)),
        );

        equal(concurrent.map((r) => r.status), [201, 201, 201, 201, 201]);
        equal(concurrent.map((r) => r.body.number).sort(), [4, 5, 6, 7, 8]);
        equal((await snapshot()).events.length, 9);
        await env.reset();
        equal(await snapshot(), { issues: [], counters: [], events: [] });
        await refusal(token, 401, 'Bad credentials');
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);
