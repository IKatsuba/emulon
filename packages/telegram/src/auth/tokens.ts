/** Bot tokens are `<id>:<secret>`; grammY puts the whole token in the path. */
export interface ParsedToken {
  botId: number;
  token: string;
}

/** 32 random bytes: 256 bits, base64url without padding (43 characters). */
export const secretBytes = 32;

const shape = /^([1-9][0-9]*):([A-Za-z0-9_-]+)$/;

export function issueToken(botId: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(secretBytes));
  const secret = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

  return `${botId}:${secret}`;
}

/**
 * A token that cannot name a bot is malformed, which Telegram answers with 404
 * rather than 401. The ID must be a canonical positive safe integer so one bot
 * is never reachable through two spellings.
 */
export function parseToken(raw: string): ParsedToken | null {
  const match = shape.exec(raw);

  if (!match) {
    return null;
  }

  const botId = Number(match[1]);

  return Number.isSafeInteger(botId) && String(botId) === match[1]
    ? { botId, token: raw }
    : null;
}

/** Only this digest of the full token is stored; the token is shown once. */
export async function verifier(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Compares every position, so timing does not reveal a matching prefix. */
export function sameVerifier(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < expected.length; i++) {
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return difference === 0;
}
