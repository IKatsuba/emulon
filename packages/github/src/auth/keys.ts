/** Keep IDs decimal for future provider serialization and CLI positional inputs. */
export function resourceId(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(2));

  return String(1 + (bytes[0]! & 0xfffff) * 0x100000000 + bytes[1]!);
}

export async function appCredentials() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pem = async (
    format: 'pkcs8' | 'spki',
    key: typeof pair.privateKey,
    label: string,
  ) => {
    const bytes = new Uint8Array(await crypto.subtle.exportKey(format, key));
    const encoded = btoa(String.fromCharCode(...bytes));

    return `-----BEGIN ${label}-----\n${
      encoded.match(/.{1,64}/g)!.join('\n')
    }\n-----END ${label}-----\n`;
  };

  const clientId = 'Iv1.' +
    Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');

  return {
    clientId,
    clientSecret: Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join(''),
    privateKey: await pem('pkcs8', pair.privateKey, 'PRIVATE KEY'),
    publicKey: await pem('spki', pair.publicKey, 'PUBLIC KEY'),
  };
}
