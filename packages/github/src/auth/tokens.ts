import { z } from 'zod';
import {
  type Installation,
  type Permissions,
  permissionsSchema,
} from '../model/schema.ts';
import { AuthError } from './errors.ts';

export const tokenRequest = z.strictObject({
  repositories: z.array(z.string().min(1)).max(500).optional(),
  repository_ids: z.array(z.number().int().positive().safe()).max(500)
    .optional(),
  permissions: permissionsSchema.optional(),
}).refine((v) => !(v.repositories && v.repository_ids));

export interface TokenRecord {
  kind?: 'installation';
  token: string;
  installationId: string;
  expiresAt: number;
  repositories: string[];
  permissions: Permissions;
}

export function narrowPermissions(
  granted: Permissions,
  requested: Permissions = granted,
): Permissions {
  for (const [name, level] of Object.entries(requested)) {
    if (
      !Object.hasOwn(granted, name) ||
      (level === 'write' && granted[name] !== 'write')
    ) {
      throw new AuthError('permissions');
    }
  }

  return { ...requested };
}

export function narrowRepositories(
  granted: readonly string[],
  requested: readonly string[] = granted,
): string[] {
  if (requested.some((name) => !granted.includes(name))) {
    throw new AuthError('repositories');
  }

  return [...new Set(requested)];
}

export function tokenExpiry(now: number): number {
  return now + 3600_000;
}

export function newToken(prefix = 'ghs_'): string {
  return prefix +
    Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
}

export function matchesToken(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < expected.length; i++) {
    difference |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return difference === 0;
}

export function validateToken(
  token: TokenRecord | undefined,
  installation: Installation | undefined,
  now: number,
): TokenRecord {
  if (!token || token.expiresAt <= now) {
    throw new AuthError('credentials');
  }

  if (!installation || token.installationId !== installation.id) {
    throw new AuthError('missing');
  }

  if (installation.suspended) {
    throw new AuthError('suspended');
  }

  return {
    ...token,
    repositories: token.repositories.filter((r) =>
      installation.repositories.includes(r)
    ),
    permissions: intersectPermissions(
      token.permissions,
      installation.permissions,
    ),
  };
}

export function intersectPermissions(
  left: Permissions,
  right: Permissions,
): Permissions {
  return Object.fromEntries(
    Object.entries(left).filter(([name]) => Object.hasOwn(right, name)).map((
      [name, level],
    ) => [
      name,
      level === 'write' && right[name] === 'write' ? 'write' : 'read',
    ]),
  );
}

export interface UserTokenRecord {
  kind: 'user';
  token: string;
  appId: string;
  userId: string;
  grantId: string;
  repositories: string[];
  permissions: Permissions;
}
export type AccessToken = TokenRecord | UserTokenRecord;
