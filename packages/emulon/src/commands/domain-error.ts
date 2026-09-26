// A registry symbol, so plugins bundled with their own copy of emulon still
// produce errors the host recognizes.
const brand = Symbol.for('emulon.DomainError');

/** An executor failure whose code and message are safe to expose to callers. */
export class DomainError extends Error {
  /** Never include credentials, raw input, or underlying exception text. */
  constructor(readonly code: string, message: string) {
    super(message);

    this.name = 'DomainError';

    Object.defineProperty(this, brand, { value: true });
  }
}

/** Recognizes a DomainError from any copy of the emulon module. */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof Error &&
    (value as unknown as Record<symbol, unknown>)[brand] === true &&
    typeof (value as { code?: unknown }).code === 'string';
}
