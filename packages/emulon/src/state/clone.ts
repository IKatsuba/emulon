/** Clone first so validation covers the exact graph retained by the store. */
export function cloneState<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new Set<object>();

  function visit(item: unknown): void {
    if (item === null || typeof item !== 'object' || seen.has(item)) {
      return;
    }

    seen.add(item);

    if (item instanceof SharedArrayBuffer) {
      throw new Error('State values must not contain shared memory.');
    }

    if (ArrayBuffer.isView(item)) {
      visit(item.buffer);

      return;
    }

    if (item instanceof Map) {
      for (const [key, value] of item) {
        visit(key);
        visit(value);
      }
    } else if (item instanceof Set) {
      for (const value of item) {
        visit(value);
      }
    } else if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null && !(item instanceof ArrayBuffer) &&
      !(item instanceof Date) && !(item instanceof RegExp) &&
      !(item instanceof Error)
    ) {
      // Host objects can hide mutable resources in non-enumerable internal slots.
      throw new Error('Unsupported state value type.');
    }

    for (const key of Object.getOwnPropertyNames(item)) {
      visit(Object.getOwnPropertyDescriptor(item, key)?.value);
    }
  }

  visit(copy);

  return copy;
}
