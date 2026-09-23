import type { PluginContext } from 'emulon';

type Store = PluginContext['store'];

export function matchesKey(header: string | null, key: string): boolean {
  if (!key.startsWith('cal_') || key.startsWith('cal_live_')) {
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
  const apiKey = 'cal_' +
    Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');

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
