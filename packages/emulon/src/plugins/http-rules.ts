export function bodyLimit(value = 1024 * 1024): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid HTTP body limit');
  }

  return value;
}
