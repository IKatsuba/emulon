import { CommandError } from '../commands/registry.ts';

export interface Connection {
  version: 1;
  id: string;
  url: string;
  token: string;
}
export interface Target {
  directory?: string;
  environment?: string;
}

export function environmentName(name = 'default'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new CommandError('INVALID_ENVIRONMENT', 'Invalid environment name.');
  }

  return name;
}

export function connection(value: unknown): Connection {
  const record = value as Partial<Connection> | null;

  if (
    !record || record.version !== 1 ||
    typeof record.id !== 'string' || !/^[\w-]{36}$/.test(record.id) ||
    typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token) ||
    typeof record.url !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(record.url) ||
    Number(record.url.split(':').at(-1)) > 65535
  ) {
    throw stale();
  }

  return record as Connection;
}

export function authorized(request: Request, record: Connection): boolean {
  // Browser cookies and provider credentials never confer control authority.
  return !request.headers.has('origin') &&
    request.headers.get('authorization') === `Bearer ${record.token}` &&
    request.headers.get('x-emulon-environment') === record.id;
}

export function stale(): CommandError {
  return new CommandError(
    'ENVIRONMENT_STALE',
    'Environment record is stale or cannot be authenticated. Stop its old process, remove the selected .emulon/<environment>.json record, then run emulon up (with the same --environment if used).',
  );
}

export function addresses(
  endpoints: Readonly<Record<string, Readonly<Record<string, string>>>>,
) {
  return Object.fromEntries(
    Object.entries(endpoints).map(([name, values]) => [
      name,
      Object.fromEntries(
        Object.entries(values).map(([surface, value]) => {
          try {
            const url = new URL(value);

            return [surface, `${url.protocol}//${url.host}`];
          } catch {
            return [surface, '[unavailable]'];
          }
        }),
      ),
    ]),
  );
}

export function commandRequest(
  value: unknown,
): { instance: string; command: string; input: unknown } {
  if (
    !value || typeof value !== 'object' || !('instance' in value) ||
    typeof value.instance !== 'string' || !('command' in value) ||
    typeof value.command !== 'string' || !('input' in value)
  ) {
    throw new CommandError('INVALID_REQUEST', 'Invalid command request.');
  }

  return {
    instance: value.instance,
    command: value.command,
    input: value.input,
  };
}
