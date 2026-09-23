// GitHub REST issue fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import { DomainError, type PluginContext } from 'emulon';
import { requireIssueWrite } from '../auth/access.ts';
import { AuthError } from '../auth/errors.ts';
import { authenticateAccess, userPrincipal } from '../auth/user.ts';
import { resourceId } from '../auth/keys.ts';
import {
  appRecordSchema,
  installationSchema,
  repositorySchema,
} from './schema.ts';

export const providerIssueInput = z.strictObject({
  title: z.string().trim().min(1),
  body: z.string().optional(),
});
export const issueInput: z.ZodType<IssueInput, IssueInput> = providerIssueInput
  .extend({
    repository: z.string().regex(/^[^/]+\/[^/]+$/),
  });
const principalSchema: z.ZodType<Principal, Principal> = z.object({
  id: z.number().int(),
  login: z.string(),
  type: z.enum(['Bot', 'User']),
});
export const issueSchema: z.ZodType<Issue, Issue> = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.literal('open'),
  locked: z.literal(false),
  html_url: z.string(),
  url: z.string(),
  repository_url: z.string(),
  comments_url: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(principalSchema),
  assignee: z.null(),
  milestone: z.null(),
  comments: z.literal(0),
  user: principalSchema,
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.null(),
  author_association: z.literal('NONE'),
});

export interface IssueInput {
  repository: string;
  title: string;
  body?: string | undefined;
}
interface Principal {
  id: number;
  login: string;
  type: 'Bot' | 'User';
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open';
  locked: false;
  html_url: string;
  url: string;
  repository_url: string;
  comments_url: string;
  labels: string[];
  assignees: Principal[];
  assignee: null;
  milestone: null;
  comments: 0;
  user: Principal;
  created_at: string;
  updated_at: string;
  closed_at: null;
  author_association: 'NONE';
}
type Transaction = Parameters<
  Parameters<PluginContext['store']['transaction']>[0]
>[0];

const surfaces = new WeakMap<
  PluginContext['http'],
  { api: string; web: string }
>();

export function bindIssueSurfaces(
  ctx: PluginContext,
  endpoints: { api: string; web: string },
) {
  surfaces.set(ctx.http, endpoints);
}

export async function installationPrincipal(
  tx: Transaction,
  installationId: string,
) {
  const installation = installationSchema.parse(
    await tx.get('installations', installationId),
  );
  const value = await tx.get('apps', installation.appId);

  if (!value) {
    throw new AuthError('missing');
  }

  const app = appRecordSchema.parse(value);

  return {
    id: Number(app.id),
    login: `${app.slug}[bot]`,
    type: 'Bot' as const,
  };
}

export function createIssue(
  ctx: PluginContext,
  input: IssueInput,
  authorization?: string | null,
): Promise<Issue> {
  return ctx.store.transaction(async (tx) => {
    const token = authorization === undefined
      ? undefined
      : await authenticateAccess(
        tx,
        authorization,
        ctx.clock.now(),
        input.repository.toLowerCase(),
      );
    const repository = (await tx.list('repositories')).map((row) =>
      repositorySchema.parse(row.value)
    )
      .find((repo) => repo.fullName === input.repository.toLowerCase());

    if (token) {
      requireIssueWrite(token, repository);
    }

    if (!repository) {
      if (authorization === undefined) {
        throw new DomainError(
          'REPOSITORY_NOT_FOUND',
          'Repository not found. Configure it in github fixtures.repositories before creating an issue.',
        );
      }

      throw new AuthError('missing');
    }

    const user = token
      ? token.kind === 'user'
        ? await userPrincipal(tx, token.userId)
        : await installationPrincipal(tx, token.installationId)
      : { id: 0, login: 'emulon', type: 'Bot' as const };
    const endpoints = surfaces.get(ctx.http);

    if (!endpoints) {
      throw new Error('Issue surfaces are not ready.');
    }

    const previous = await tx.get('issue-counters', repository.id);
    const number = z.number().int().nonnegative().safe().parse(previous ?? 0) +
      1;
    const now = new Date(ctx.clock.now()).toISOString();
    const base = `${endpoints.api}/repos/${repository.fullName}`;
    const issue = issueSchema.parse({
      id: Number(resourceId()),
      number,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      locked: false,
      html_url: `${endpoints.web}/${repository.fullName}/issues/${number}`,
      url: `${base}/issues/${number}`,
      repository_url: base,
      comments_url: `${base}/issues/${number}/comments`,
      labels: [],
      assignees: [],
      assignee: null,
      milestone: null,
      comments: 0,
      user,
      created_at: now,
      updated_at: now,
      closed_at: null,
      author_association: 'NONE',
    });

    if (await tx.get('issues', String(issue.id))) {
      throw new Error('Issue ID collision; retry creation.');
    }

    await tx.put({ collection: 'issues', id: String(issue.id), value: issue });
    await tx.put({
      collection: 'issue-counters',
      id: repository.id,
      value: number,
    });
    await tx.record({
      type: 'issues.opened',
      origin: 'service',
      occurredAt: now,
      payload: {
        action: 'opened',
        issue,
        repository: {
          id: Number(repository.id),
          name: repository.name,
          full_name: repository.fullName,
          private: repository.private,
        },
        sender: user,
        ...(token && token.kind !== 'user'
          ? { installation: { id: Number(token.installationId) } }
          : {}),
      },
    });

    return issue;
  });
}
