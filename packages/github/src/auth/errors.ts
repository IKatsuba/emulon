export const authMessages = {
  malformed: 'A JSON web token could not be decoded',
  algorithm: 'Invalid JWT algorithm. Expected RS256.',
  issuer: 'Invalid issuer',
  signature: 'A JSON web token could not be decoded',
  issuedAt:
    "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued",
  expired:
    "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires",
  future:
    "'Expiration time' claim ('exp') must not be more than 10 minutes in the future",
  credentials: 'Bad credentials',
  missing: 'Not Found',
  suspended: 'This installation has been suspended',
  permissions:
    'The permissions requested are not granted to this installation.',
  repositories:
    'The repositories requested are not available to this installation.',
  inaccessible: 'Resource not accessible by integration',
  invalid: 'Invalid request',
} as const;

export type Failure = keyof typeof authMessages;
export class AuthError extends Error {
  constructor(readonly reason: Failure) {
    super(authMessages[reason]);
  }
}

export function authResponse(reason: Failure): Response {
  const status = reason === 'missing'
    ? 404
    : reason === 'suspended' || reason === 'inaccessible'
    ? 403
    : ['permissions', 'repositories', 'invalid'].includes(reason)
    ? 422
    : 401;

  return Response.json({
    message: authMessages[reason],
    documentation_url: 'https://docs.github.com/rest',
    status: String(status),
  }, { status });
}
