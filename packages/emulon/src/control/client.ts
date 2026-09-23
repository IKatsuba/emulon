import { requestTimeout } from './timeout.ts';
import { CommandError } from '../commands/registry.ts';
import { readDiscovery } from '../runtime/discovery.ts';
import { type Connection, stale, type Target } from './protocol.ts';

export async function request(
  record: Connection,
  path: string,
  input?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  let body;

  try {
    response = await fetch(`${record.url}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'x-emulon-environment': record.id,
        'content-type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.any([
        AbortSignal.timeout(requestTimeout(path, input)),
        ...(signal ? [signal] : []),
      ]),
      redirect: 'error',
    });
    body = await response.json();
  } catch {
    if (signal?.aborted) {
      throw new CommandError('ENVIRONMENT_CLOSED', 'Client is disconnected.');
    }

    if (path === '/identity') {
      throw stale();
    }

    throw new CommandError(
      'CONTROL_CONNECTION_LOST',
      'Control request failed or timed out; its outcome may be unknown. Check emulon status before retrying.',
    );
  }

  if (response.status === 401 || (path === '/identity' && !response.ok)) {
    throw stale();
  }

  if (!response.ok) {
    const error = (body as { error: ReturnType<CommandError['toJSON']> }).error;

    throw new CommandError(
      error.code,
      error.message,
      error.fields,
      error.available,
    );
  }

  return body;
}

export async function discover(target: Target) {
  const record = await readDiscovery(target);
  const identity = await request(record, '/identity') as {
    id: string;
    endpoints: Record<string, Record<string, string>>;
  };

  if (
    !identity || identity.id !== record.id || !identity.endpoints ||
    typeof identity.endpoints !== 'object' ||
    Object.values(identity.endpoints).some((surfaces) =>
      !surfaces || typeof surfaces !== 'object' ||
      Object.values(surfaces).some((url) => typeof url !== 'string')
    )
  ) {
    throw stale();
  }

  return { record, identity };
}
