/** Compare JSON structurally without exposing credential values in failures. */
export function parity(
  operation: string,
  boundary: string,
  cli: unknown,
  sdk: unknown,
  path = '$',
): void {
  const fail = (reason: string): never => {
    throw new Error(
      `Parity ${operation}: ${boundary} differs at ${path}: ${reason} (CLI vs SDK).`,
    );
  };

  if (Object.is(cli, sdk)) {
    return;
  }

  if (Array.isArray(cli) && Array.isArray(sdk)) {
    if (cli.length !== sdk.length) {
      fail('array length');
    }

    cli.forEach((value, index) =>
      parity(operation, boundary, value, sdk[index], `${path}[${index}]`)
    );

    return;
  }

  if (
    cli !== null && sdk !== null && typeof cli === 'object' &&
    typeof sdk === 'object' && !Array.isArray(cli) && !Array.isArray(sdk)
  ) {
    const left = cli as Record<string, unknown>;
    const right = sdk as Record<string, unknown>;

    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
        parity(
          operation,
          boundary,
          Object.hasOwn(left, key),
          Object.hasOwn(right, key),
          `${path}.${key} (field presence)`,
        );
      }

      parity(operation, boundary, left[key], right[key], `${path}.${key}`);
    }

    return;
  }

  fail(typeof cli !== typeof sdk ? 'value type' : 'value');
}

export function normalize(
  value: unknown,
  symbols: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    return symbols.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, symbols));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalize(item, symbols),
      ]),
    );
  }

  return value;
}
