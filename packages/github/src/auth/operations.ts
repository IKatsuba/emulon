import type { PluginContext } from 'emulon';
import {
  appRecordSchema,
  grantSchema,
  installationSchema,
  repositorySchema,
} from '../model/schema.ts';
import { AuthError } from './errors.ts';
import { parseJWT, verifyJWT } from './jwt.ts';
import {
  type AccessToken,
  intersectPermissions,
  matchesToken,
  narrowPermissions,
  narrowRepositories,
  newToken,
  tokenExpiry,
  type TokenRecord,
  tokenRequest,
  validateToken,
} from './tokens.ts';

type Store = PluginContext['store'];
type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];

export async function authenticateApp(
  tx: Transaction,
  header: string | null,
  now: number,
) {
  const jwt = parseJWT(header);
  const app = (await tx.list('apps')).map((row) =>
    appRecordSchema.parse(row.value)
  ).find((app) => app.id === jwt.issuer || app.clientId === jwt.issuer);

  if (!app) {
    throw new AuthError('issuer');
  }

  await verifyJWT(jwt, app, now);

  return app;
}

export async function issueToken(
  tx: Transaction,
  appId: string,
  installationId: string,
  input: unknown,
  now: number,
) {
  const value = await tx.get('installations', installationId);

  if (!value) {
    throw new AuthError('missing');
  }

  const installation = installationSchema.parse(value);

  if (installation.appId !== appId) {
    throw new AuthError('missing');
  }

  if (installation.suspended) {
    throw new AuthError('suspended');
  }

  const parsed = tokenRequest.safeParse(input);

  if (!parsed.success) {
    throw new AuthError('invalid');
  }

  const request = parsed.data;
  const grant = grantSchema.parse(await tx.get('grants', installationId));
  const repos = (await tx.list('repositories')).map((row) =>
    repositorySchema.parse(row.value)
  ).filter((repo) =>
    installation.repositories.includes(repo.fullName) &&
    grant.repositoryIds.includes(repo.id)
  );
  let requested: string[] | undefined;

  if (request.repositories) {
    requested = request.repositories.map((name) => {
      const repo = repos.find((repo) =>
        repo.name.toLowerCase() === name.toLowerCase()
      );

      if (!repo) {
        throw new AuthError('repositories');
      }

      return repo.fullName;
    });
  }

  if (request.repository_ids) {
    requested = request.repository_ids.map((id) => {
      const repo = repos.find((repo) => repo.id === String(id));

      if (!repo) {
        throw new AuthError('repositories');
      }

      return repo.fullName;
    });
  }

  const token: TokenRecord = {
    kind: 'installation',
    token: newToken(),
    installationId,
    expiresAt: tokenExpiry(now),
    repositories: narrowRepositories(repos.map((r) => r.fullName), requested),
    permissions: narrowPermissions(
      intersectPermissions(grant.permissions, installation.permissions),
      request.permissions,
    ),
  };

  await tx.put({ collection: 'tokens', id: crypto.randomUUID(), value: token });

  return {
    token: token.token,
    expires_at: new Date(token.expiresAt).toISOString(),
    permissions: token.permissions,
    repository_selection: 'selected',
    repositories: repos.filter((r) => token.repositories.includes(r.fullName))
      .map((r) => ({
        id: Number(r.id),
        name: r.name,
        full_name: r.fullName,
        private: r.private,
      })),
  };
}

/** Call within the same transaction as the protected resource operation. */
export async function authenticateInstallation(
  tx: Transaction,
  header: string | null,
  installationId: string | undefined,
  now: number,
): Promise<TokenRecord> {
  const candidate = /^(?:Bearer|token) (\S+)$/i.exec(header ?? '')?.[1] ?? '';
  const records = (await tx.list('tokens')).map((row) =>
    row.value as AccessToken
  );
  const token = records.find((record) => matchesToken(candidate, record.token));

  if (!token || token.kind === 'user' || token.expiresAt <= now) {
    throw new AuthError('credentials');
  }

  installationId ??= token.installationId;

  const value = await tx.get('installations', installationId);
  const installation = value ? installationSchema.parse(value) : undefined;
  const effective = validateToken(token, installation, now);
  const grantValue = await tx.get('grants', installationId);

  if (!grantValue) {
    throw new AuthError('missing');
  }

  const grant = grantSchema.parse(grantValue);
  const repos = (await tx.list('repositories')).map((row) =>
    repositorySchema.parse(row.value)
  ).filter((r) => grant.repositoryIds.includes(r.id));

  return validateToken(effective, {
    ...installation!,
    repositories: repos.map((r) => r.fullName),
    permissions: grant.permissions,
  }, now);
}
