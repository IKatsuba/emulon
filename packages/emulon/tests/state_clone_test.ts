import { cloneState } from '../src/state/clone.ts';

Deno.test('state cloning preserves supported cyclic graphs without shared references', () => {
  const bytes = new Uint8Array([7]);
  const value = {
    bytes,
    view: new DataView(bytes.buffer),
    date: new Date(0),
    pattern: /value/gi,
    error: new Error('example', { cause: { bytes } }),
    map: new Map<unknown, unknown>(),
    set: new Set<unknown>(),
    absent: undefined,
    large: 1n,
  };

  value.map.set(value, bytes);
  value.set.add(value);

  const copy = cloneState(value);

  bytes[0] = 99;

  if (
    copy === value || copy.bytes[0] !== 7 ||
    copy.view.buffer !== copy.bytes.buffer ||
    copy.map.get(copy) !== copy.bytes || !copy.set.has(copy) ||
    copy.date.getTime() !== 0 || copy.pattern.source !== 'value' ||
    (copy.error.cause as { bytes: Uint8Array }).bytes !== copy.bytes ||
    copy.absent !== undefined || copy.large !== 1n
  ) {
    throw new Error(
      'State clone lost graph identity or retained external memory',
    );
  }
});

Deno.test('state cloning rejects host objects with hidden shared memory', () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });

  try {
    cloneState({ memory });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Unsupported state value type.'
    ) {
      return;
    }

    throw error;
  }

  throw new Error('Expected hidden shared memory to be rejected');
});
