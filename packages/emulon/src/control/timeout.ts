import { timeoutMilliseconds } from '../deliveries/commands.ts';

/** A requested wait gets its own deadline plus transport overhead. */
export function requestTimeout(path: string, input: unknown): number {
  if (path === '/identity') {
    return 3000;
  }

  let timeout: unknown;

  if (path === '/command' && input && typeof input === 'object') {
    const request = input as {
      command?: unknown;
      input?: { timeout?: unknown };
    };

    if (request.command === 'webhooks.wait') {
      timeout = request.input?.timeout;
    }
  }

  if (path === '/cli' && Array.isArray(input)) {
    input = input.filter((arg) => arg !== '--json');
  }

  if (
    path === '/cli' && Array.isArray(input) && input[1] === 'webhooks' &&
    input[2] === 'wait'
  ) {
    const index = input.indexOf('--timeout');

    timeout = index >= 0
      ? input[index + 1]
      : input.find((arg) =>
        typeof arg === 'string' && arg.startsWith('--timeout=')
      )?.slice(10);
  }

  const duration = typeof timeout === 'string'
    ? timeoutMilliseconds(timeout)
    : NaN;

  return Number.isFinite(duration) && duration > 0 && duration <= 2147483647
    ? Math.min(2147483647, Math.max(30000, duration + 3000))
    : 30000;
}
