const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
    .replaceAll('=', '');

export async function sign(
  privateKey: string,
  claims: Record<string, unknown>,
  alg = 'RS256',
) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(
      atob(privateKey.replace(/-----[^-]+-----|\s/g, '')),
      (c) => c.charCodeAt(0),
    ),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = [{ alg, typ: 'JWT' }, claims].map((v) =>
    encode(new TextEncoder().encode(JSON.stringify(v)))
  ).join('.');

  return `${data}.${
    encode(
      new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          key,
          new TextEncoder().encode(data),
        ),
      ),
    )
  }`;
}
