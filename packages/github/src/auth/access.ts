import { AuthError } from './errors.ts';
import type { AccessToken } from './tokens.ts';
import type { Repository } from '../model/schema.ts';

/** Apply resource checks only after intersecting the current principal grants. */
export function requireIssueWrite(token: AccessToken, repository?: Repository) {
  if (!repository || !token.repositories.includes(repository.fullName)) {
    throw new AuthError('missing');
  }

  if (token.permissions.issues !== 'write') {
    throw new AuthError('inaccessible');
  }

  return repository;
}
