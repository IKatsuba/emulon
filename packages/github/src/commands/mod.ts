import {
  type AuthorizationCommands,
  authorizationCommands,
} from './authorization.ts';
import { type WebhookCommands, webhookCommands } from './webhooks.ts';
import {
  createIssue,
  type Issue,
  type IssueInput,
  issueInput,
  issueSchema,
} from '../model/issues.ts';
import { defineCommand } from 'emulon';
import { z } from 'zod';
import {
  type AppCreated,
  appCreatedSchema,
  type AppInput,
  appInput,
  idSchema,
  type Installation,
  type InstallationInput,
  installationInput,
  installationSchema,
} from '../model/schema.ts';
import {
  createApp,
  createInstallation,
  suspendInstallation,
} from '../model/operations.ts';

const suspension = (suspended: boolean) =>
  defineCommand({
    description: suspended
      ? 'Suspend a local installation'
      : 'Unsuspend a local installation',
    input: z.strictObject({ id: idSchema }),
    output: installationSchema,
    cli: {
      path: ['installations', suspended ? 'suspend' : 'unsuspend'],
      positional: 'id',
      flags: {},
    },
    execute: (ctx, { id }) => suspendInstallation(ctx.store, id, suspended),
  });

type Operation<Input, Output> = ReturnType<
  typeof defineCommand<z.ZodType<Input, Input>, z.ZodType<Output, Output>>
>;
export type Commands = AuthorizationCommands & WebhookCommands & {
  'issues.create': Operation<IssueInput, Issue>;
  'apps.create': Operation<AppInput, AppCreated>;
  'installations.create': Operation<InstallationInput, Installation>;
  'installations.suspend': Operation<{ id: string }, Installation>;
  'installations.unsuspend': Operation<{ id: string }, Installation>;
};

export const commands: Commands = {
  ...webhookCommands,
  ...authorizationCommands,
  'issues.create': defineCommand({
    description: 'Create an issue and publish its opened event',
    input: issueInput,
    output: issueSchema,
    cli: {
      path: ['issues', 'create'],
      flags: { repo: 'repository', title: 'title', body: 'body' },
    },
    execute: (ctx, input) => createIssue(ctx, input),
  }),
  'apps.create': defineCommand({
    description:
      'Create a local GitHub App and return its private key (explicit secret output)',
    input: appInput,
    output: appCreatedSchema,
    cli: {
      path: ['apps', 'create'],
      flags: {
        slug: 'slug',
        permissions: 'permissions',
        events: 'events',
        'callback-urls': 'callbackUrls',
        webhook: 'webhook',
      },
    },
    execute: (ctx, input) => createApp(ctx.store, input),
  }),
  'installations.create': defineCommand({
    description: 'Install a local GitHub App on fixture repositories',
    input: installationInput,
    output: installationSchema,
    cli: {
      path: ['installations', 'create'],
      flags: {
        'app-id': 'appId',
        account: 'account',
        repositories: 'repositories',
      },
    },
    execute: (ctx, input) => createInstallation(ctx.store, input),
  }),
  'installations.suspend': suspension(true),
  'installations.unsuspend': suspension(false),
};
