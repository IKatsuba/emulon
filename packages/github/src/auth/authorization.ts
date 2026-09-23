import type { PluginContext } from 'emulon';
import { z } from 'zod';
import {
  appRecordSchema,
  type AppView,
  idSchema,
  loginSchema,
  type Permissions,
  permissionsSchema,
  repositorySchema,
  userSchema,
} from '../model/schema.ts';
import { narrowPermissions, narrowRepositories } from './tokens.ts';

export class AuthorizationInputError extends Error {}

export type Transaction = Parameters<
  Parameters<PluginContext['store']['transaction']>[0]
>[0];

export const authorizationLifetime = 600_000;

export interface AuthorizeInput {
  clientId: string;
  redirectUri?: string | undefined;
  state?: string | undefined;
  login: string;
  repositories: string[];
  permissions: Permissions;
}
export interface AuthorizationOutput {
  code: string;
  redirectUrl: string;
  expiresAt: string;
}

export const authorizeInput: z.ZodType<AuthorizeInput, AuthorizeInput> = z
  .strictObject({
    clientId: z.string().min(1),
    redirectUri: z.string().optional(),
    state: z.string().optional(),
    login: loginSchema,
    repositories: z.array(z.string()),
    permissions: permissionsSchema,
  });
export const authorizationOutput: z.ZodType<
  AuthorizationOutput,
  AuthorizationOutput
> = z.object({
  code: z.string(),
  redirectUrl: z.string(),
  expiresAt: z.string(),
});
export const userGrantSchema = z.object({
  id: z.string(),
  appId: idSchema,
  userId: idSchema,
  repositories: z.array(z.string()),
  permissions: permissionsSchema,
});
export const authorizationCodeSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  grant: userGrantSchema,
  expiresAt: z.number(),
  consumedAt: z.number().nullable(),
});

export type AuthorizationCode = z.infer<typeof authorizationCodeSchema>;
export interface AuthorizationRequest {
  clientId: string;
  redirectUri?: string | undefined;
  state?: string | undefined;
}

export function safeCallback(value: string): boolean {
  try {
    const url = new URL(value);

    return ['http:', 'https:'].includes(url.protocol) && !url.username &&
      !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function callbackResult(
  callback: string,
  state: string | undefined,
  result: Record<string, string>,
): string {
  const url = new URL(callback);

  for (
    const key of ['code', 'state', 'error', 'error_description', 'error_uri']
  ) {
    url.searchParams.delete(key);
  }

  for (const [key, value] of Object.entries(result)) {
    url.searchParams.set(key, value);
  }

  if (state !== undefined) {
    url.searchParams.set('state', state);
  }

  return url.href;
}

export function denial(
  callback: string,
  state: string | undefined,
  error: 'access_denied' | 'redirect_uri_mismatch',
): string {
  return callbackResult(callback, state, {
    error,
    error_description: error === 'access_denied'
      ? 'The user has denied your application access.'
      : 'The redirect_uri MUST match the registered callback URL for this application.',
    error_uri:
      '/apps/building-integrations/setting-up-and-registering-oauth-apps/troubleshooting-authorization-request-errors/#' +
      error.replaceAll('_', '-'),
  });
}

export function resolveAuthorization(
  apps: AppView[],
  request: AuthorizationRequest,
):
  | { kind: 'page'; status: 400 | 404; message: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'consent'; app: AppView; callback: string } {
  const app = apps.find((app) => app.clientId === request.clientId);

  if (!app) {
    return { kind: 'page', status: 404, message: 'Application not found' };
  }

  const fallback = app.callbackUrls[0];

  if (!fallback || !safeCallback(fallback)) {
    return {
      kind: 'page',
      status: 400,
      message: 'No supported callback URL configured',
    };
  }

  const callback = request.redirectUri ?? fallback;

  if (!app.callbackUrls.includes(callback) || !safeCallback(callback)) {
    return {
      kind: 'redirect',
      url: denial(fallback, request.state, 'redirect_uri_mismatch'),
    };
  }

  return { kind: 'consent', app, callback };
}

export async function authorizationApps(tx: Transaction) {
  return (await tx.list('apps')).map((row) => appRecordSchema.parse(row.value));
}

export function newSecret(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function secretHash(secret: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function approveAuthorization(
  tx: Transaction,
  input: AuthorizeInput,
  now: number,
): Promise<AuthorizationOutput> {
  const resolved = resolveAuthorization(await authorizationApps(tx), input);

  if (resolved.kind !== 'consent') {
    throw new AuthorizationInputError(
      'Invalid authorization client or callback.',
    );
  }

  const user = (await tx.list('users')).map((row) =>
    userSchema.parse(row.value)
  ).find((user) => user.login === input.login.toLowerCase());

  if (!user) {
    throw new AuthorizationInputError('Unknown fixture user.');
  }

  const repositories = (await tx.list('repositories')).map((row) =>
    repositorySchema.parse(row.value).fullName
  );
  const grant = {
    id: `${resolved.app.id}:${user.id}`,
    appId: resolved.app.id,
    userId: user.id,
    repositories: narrowRepositories(repositories, input.repositories),
    permissions: narrowPermissions(resolved.app.permissions, input.permissions),
  };
  const code = newSecret();
  const expiresAt = now + authorizationLifetime;

  await tx.put({ collection: 'userGrants', id: grant.id, value: grant });
  await tx.put({
    collection: 'authorizationCodes',
    id: await secretHash(code),
    value: {
      clientId: input.clientId,
      redirectUri: resolved.callback,
      grant,
      expiresAt,
      consumedAt: null,
    } satisfies AuthorizationCode,
  });

  return {
    code,
    expiresAt: new Date(expiresAt).toISOString(),
    redirectUrl: callbackResult(resolved.callback, input.state, { code }),
  };
}

export function validAuthorizationCode(
  record: AuthorizationCode,
  clientId: string,
  callback: string,
  now: number,
): boolean {
  return record.clientId === clientId && record.redirectUri === callback &&
    record.expiresAt > now && record.consumedAt === null;
}

/** Exchange must consume the code and issue the token in this same transaction. */
export async function consumeAuthorizationCode(
  tx: Transaction,
  code: string,
  clientId: string,
  callback: string,
  now: number,
): Promise<AuthorizationCode> {
  const id = await secretHash(code);
  const parsed = authorizationCodeSchema.safeParse(
    await tx.get('authorizationCodes', id),
  );

  if (
    !parsed.success ||
    !validAuthorizationCode(parsed.data, clientId, callback, now)
  ) {
    throw new Error('Invalid authorization code.');
  }

  const record = { ...parsed.data, consumedAt: now };

  await tx.put({ collection: 'authorizationCodes', id, value: record });

  return record;
}
