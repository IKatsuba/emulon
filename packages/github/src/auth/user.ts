import type { PluginContext } from 'emulon';
import {
  appRecordSchema,
  grantSchema,
  installationSchema,
  repositorySchema,
  userSchema,
} from '../model/schema.ts';
import {
  authorizationCodeSchema,
  consumeAuthorizationCode,
  secretHash,
  userGrantSchema,
} from './authorization.ts';
import { authenticateInstallation } from './operations.ts';
import { AuthError } from './errors.ts';
import {
  type AccessToken,
  intersectPermissions,
  matchesToken,
  newToken,
  type UserTokenRecord,
} from './tokens.ts';

type Transaction = Parameters<
  Parameters<PluginContext['store']['transaction']>[0]
>[0];

export const exchangeErrors = {
  incorrect_client_credentials:
    'The client_id and/or client_secret passed are incorrect.',
  redirect_uri_mismatch:
    'The redirect_uri MUST match the registered callback URL for this application.',
  bad_verification_code: 'The code passed is incorrect or expired.',
  unsupported_grant_type: 'The grant_type is not supported.',
} as const;

export function exchangeError(error: keyof typeof exchangeErrors) {
  return {
    error,
    error_description: exchangeErrors[error],
    error_uri: error === 'redirect_uri_mismatch'
      ? '/apps/managing-oauth-apps/troubleshooting-authorization-request-errors/#redirect-uri-mismatch2'
      : '/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#' +
        error.replaceAll('_', '-'),
  };
}

export function codeFailure(
  record: ReturnType<typeof authorizationCodeSchema.parse> | undefined,
  clientId: string,
  redirect: string | undefined,
  now: number,
) {
  if (
    !record || record.clientId !== clientId || record.consumedAt !== null ||
    record.expiresAt <= now
  ) {
    return 'bad_verification_code';
  }

  if (redirect !== undefined && redirect !== record.redirectUri) {
    return 'redirect_uri_mismatch';
  }

  return undefined;
}

export function unsupportedTokenRequest(
  input: Record<string, string>,
) {
  if (input.repository_id !== undefined) {
    return {
      error: 'invalid_request',
      error_description: 'The repository_id parameter is not supported.',
    };
  }

  return undefined;
}

export async function exchangeCode(
  tx: Transaction,
  input: Record<string, string>,
  now: number,
) {
  const unsupported = unsupportedTokenRequest(input);

  if (unsupported) {
    return unsupported;
  }

  const app = (await tx.list('apps')).map((r) => appRecordSchema.parse(r.value))
    .find((a) => a.clientId === input.client_id);

  if (
    !app?.clientSecret ||
    !matchesToken(input.client_secret ?? '', app.clientSecret)
  ) {
    return exchangeError('incorrect_client_credentials');
  }

  if (
    input.grant_type && input.grant_type !== 'authorization_code' ||
    input.refresh_token !== undefined || input.device_code !== undefined
  ) {
    return exchangeError('unsupported_grant_type');
  }

  const parsed = authorizationCodeSchema.safeParse(
    await tx.get('authorizationCodes', await secretHash(input.code ?? '')),
  );
  const failure = codeFailure(
    parsed.success ? parsed.data : undefined,
    app.clientId,
    input.redirect_uri,
    now,
  );

  if (failure) {
    return exchangeError(failure);
  }

  const record = await consumeAuthorizationCode(
    tx,
    input.code!,
    app.clientId,
    parsed.data!.redirectUri,
    now,
  );
  const token: UserTokenRecord = {
    kind: 'user',
    token: newToken('ghu_'),
    appId: app.id,
    userId: record.grant.userId,
    grantId: record.grant.id,
    repositories: record.grant.repositories,
    permissions: record.grant.permissions,
  };

  await tx.put({ collection: 'tokens', id: crypto.randomUUID(), value: token });

  return { access_token: token.token, token_type: 'bearer', scope: '' };
}

export async function authenticateAccess(
  tx: Transaction,
  header: string | null,
  now: number,
  repository?: string,
): Promise<AccessToken> {
  const candidate = /^(?:Bearer|token) (\S+)$/i.exec(header ?? '')?.[1] ?? '';
  const token = (await tx.list('tokens')).map((r) => r.value as AccessToken)
    .find((r) => matchesToken(candidate, r.token));

  if (!token) {
    throw new AuthError('credentials');
  }

  if (token.kind !== 'user') {
    return authenticateInstallation(tx, header, undefined, now);
  }

  const app = appRecordSchema.safeParse(await tx.get('apps', token.appId));
  const grant = userGrantSchema.safeParse(
    await tx.get('userGrants', token.grantId),
  );
  const user = (await tx.list('users')).map((r) => userSchema.parse(r.value))
    .find((u) => u.id === token.userId);

  if (
    !app.success || !grant.success || !user ||
    grant.data.appId !== token.appId || grant.data.userId !== token.userId
  ) {
    throw new AuthError('credentials');
  }

  let effective = {
    ...token,
    repositories: token.repositories.filter((r) =>
      grant.data.repositories.includes(r)
    ),
    permissions: intersectPermissions(
      intersectPermissions(token.permissions, grant.data.permissions),
      app.data.permissions,
    ),
  };

  if (repository !== undefined) {
    const installation = (await tx.list('installations')).map((r) =>
      installationSchema.parse(r.value)
    ).find((i) =>
      i.appId === token.appId && i.repositories.includes(repository)
    );

    if (!installation) {
      throw new AuthError('missing');
    }

    if (installation.suspended) {
      throw new AuthError('suspended');
    }

    const installedGrant = grantSchema.safeParse(
      await tx.get('grants', installation.id),
    );

    if (!installedGrant.success) {
      throw new AuthError('missing');
    }

    const repositories = (await tx.list('repositories')).map((r) =>
      repositorySchema.parse(r.value)
    ).filter((r) =>
      installedGrant.data.repositoryIds.includes(r.id) &&
      installation.repositories.includes(r.fullName)
    );

    effective = {
      ...effective,
      repositories: effective.repositories.filter((r) =>
        repositories.some((repo) => repo.fullName === r)
      ),
      permissions: intersectPermissions(
        intersectPermissions(effective.permissions, installation.permissions),
        installedGrant.data.permissions,
      ),
    };
  }

  return effective;
}

export async function userPrincipal(tx: Transaction, userId: string) {
  const user = (await tx.list('users')).map((r) => userSchema.parse(r.value))
    .find((u) => u.id === userId);

  if (!user) {
    throw new AuthError('credentials');
  }

  return { id: Number(user.id), login: user.login, type: 'User' as const };
}
