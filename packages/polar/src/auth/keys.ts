import type { PluginContext } from 'emulon';

type Store = PluginContext['store'];

/** Polar organization access tokens carry this prefix and Bearer authentication. */
export const keyPrefix = 'polar_oat_';
/** Other Polar credential prefixes are never a local alternative. */
const foreignPrefixes = [
  'polar_at_u_',
  'polar_at_o_',
  'polar_rt_u_',
  'polar_rt_o_',
  'polar_ci_',
  'polar_cs_',
  'polar_crt_',
  'polar_ac_',
];

export function issuedKey(): string {
  return keyPrefix +
    Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
}

/** Membership of the issued set decides; the prefix alone never authorizes. */
export function matchesKey(header: string | null, key: string): boolean {
  if (
    !key.startsWith(keyPrefix) ||
    foreignPrefixes.some((prefix) => key.startsWith(prefix))
  ) {
    return false;
  }

  const expected = `Bearer ${key}`;

  if (header === null || header.length !== expected.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < expected.length; i++) {
    difference |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return difference === 0;
}

export function createKey(store: Store): Promise<{ apiKey: string }> {
  const apiKey = issuedKey();

  return store.transaction(async (tx) => {
    await tx.put({
      collection: 'keys',
      id: crypto.randomUUID(),
      value: apiKey,
    });

    return { apiKey };
  });
}

export function authorized(
  store: Store,
  header: string | null,
): Promise<boolean> {
  return store.transaction(async (tx) =>
    (await tx.list('keys')).some((row) =>
      typeof row.value === 'string' && matchesKey(header, row.value)
    )
  );
}
