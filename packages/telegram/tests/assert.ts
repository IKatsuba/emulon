export function assert(
  value: unknown,
  message = 'Assertion failed',
): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, v],
      ) => [key, canonical(v)]),
    );
  }

  return value;
}

export function equal(actual: unknown, expected: unknown) {
  assert(
    JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}

export async function rejects(action: () => unknown) {
  try {
    await action();
  } catch {
    return;
  }

  throw new Error('Expected rejection');
}
