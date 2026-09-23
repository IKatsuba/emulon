import { defineCommand } from 'emulon';
import {
  approveAuthorization,
  type AuthorizationOutput,
  authorizationOutput,
  type AuthorizeInput,
  authorizeInput,
} from '../auth/authorization.ts';
import type { z } from 'zod';

export type AuthorizationCommands = {
  'authorization.approve': ReturnType<
    typeof defineCommand<
      z.ZodType<AuthorizeInput, AuthorizeInput>,
      z.ZodType<AuthorizationOutput, AuthorizationOutput>
    >
  >;
};

export const authorizationCommands: AuthorizationCommands = {
  'authorization.approve': defineCommand({
    description:
      'Approve local fixture consent without a browser (explicit secret output; not a GitHub API)',
    input: authorizeInput,
    output: authorizationOutput,
    cli: {
      path: ['authorization', 'approve'],
      flags: {
        'client-id': 'clientId',
        'redirect-uri': 'redirectUri',
        state: 'state',
        login: 'login',
        repositories: 'repositories',
        permissions: 'permissions',
      },
    },
    execute: (ctx, input) =>
      ctx.store.transaction((tx) =>
        approveAuthorization(tx, input, ctx.clock.now())
      ),
  }),
};
