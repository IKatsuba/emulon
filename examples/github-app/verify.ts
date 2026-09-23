export async function verifyWebhook(
  secret: string,
  body: string,
  signature: string,
) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const digest = Uint8Array.from(
    signature.slice(7).match(/../g)!,
    (byte) => parseInt(byte, 16),
  );

  return await crypto.subtle.verify(
    'HMAC',
    key,
    digest,
    new TextEncoder().encode(body),
  );
}
