import { Octokit } from 'octokit';

// Explicit baseUrl configuration is required even when connection variables exist.
export function localClient(baseUrl: string, auth?: string) {
  const endpoint = new URL(baseUrl);

  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') {
    throw new Error('Expected a loopback GitHub endpoint');
  }

  return new Octokit({
    baseUrl,
    ...(auth ? { auth } : {}),
    retry: { enabled: false },
    throttle: { enabled: false },
    request: {
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.origin !== endpoint.origin) {
          throw new Error('GitHub request escaped the local endpoint');
        }

        return fetch(input, { ...init, redirect: 'error' });
      },
    },
  });
}
