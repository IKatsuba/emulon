import type { App } from '../model/schema.ts';
import { AuthError } from './errors.ts';

const encoder = new TextEncoder();

function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new AuthError('malformed');
  }

  return Uint8Array.from(
    atob(segment.replaceAll('-', '+').replaceAll('_', '/')),
    (c) => c.charCodeAt(0),
  );
}

function object(segment: string): Record<string, unknown> {
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(decode(segment)),
  );

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthError('malformed');
  }

  return value;
}

export function parseJWT(header: string | null) {
  try {
    const match = /^Bearer ([^ ]+)$/i.exec(header ?? '');
    const parts = match?.[1]?.split('.');

    if (!parts || parts.length !== 3) {
      throw new AuthError('malformed');
    }

    const [head, body, signature] = parts as [string, string, string];
    const metadata = object(head);
    const claims = object(body);

    if (metadata.alg !== 'RS256') {
      throw new AuthError('algorithm');
    }

    if (metadata.crit !== undefined) {
      throw new AuthError('malformed');
    }

    if (
      !(typeof claims.iss === 'string' && claims.iss.length) &&
      !(typeof claims.iss === 'number' && Number.isSafeInteger(claims.iss))
    ) {
      throw new AuthError('issuer');
    }

    return {
      issuer: String(claims.iss),
      claims,
      data: encoder.encode(`${head}.${body}`),
      signature: decode(signature),
    };
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    throw new AuthError('malformed');
  }
}

export function validateTimes(
  claims: Record<string, unknown>,
  now: number,
): void {
  const seconds = Math.floor(now / 1000);

  if (
    typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) ||
    claims.iat > seconds
  ) {
    throw new AuthError('issuedAt');
  }

  if (
    typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) ||
    claims.exp <= seconds || claims.exp <= claims.iat
  ) {
    throw new AuthError('expired');
  }

  if (claims.exp > seconds + 600) {
    throw new AuthError('future');
  }
}

export async function verifyJWT(
  jwt: ReturnType<typeof parseJWT>,
  app: App,
  now: number,
): Promise<void> {
  if (jwt.issuer !== app.id && jwt.issuer !== app.clientId) {
    throw new AuthError('issuer');
  }

  const bytes = Uint8Array.from(
    atob(app.publicKey.replace(/-----[^-]+-----|\s/g, '')),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'spki',
    bytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  if (
    !await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      jwt.signature,
      jwt.data,
    )
  ) {
    throw new AuthError('signature');
  }

  validateTimes(jwt.claims, now);
}
