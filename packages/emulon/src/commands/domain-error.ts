/** An executor failure whose code and message are safe to expose to callers. */
export class DomainError extends Error {
  /** Never include credentials, raw input, or underlying exception text. */
  constructor(readonly code: string, message: string) {
    super(message);

    this.name = 'DomainError';
  }
}
