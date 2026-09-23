import { localClient } from './client.ts';

// This drives the local fixture picker over HTTP, without a browser or GitHub login.
export async function consent(
  web: string,
  clientId: string,
  callback: string,
  state: string,
) {
  const client = localClient(web);
  const page = await client.request('GET /login/oauth/authorize', {
    client_id: clientId,
    redirect_uri: callback,
    state,
  });
  const session = String(page.data).match(/name="session" value="([^"]+)"/)
    ?.[1];

  if (!session) {
    throw new Error('Local consent form did not contain a session');
  }

  const response = await fetch(new URL('/login/oauth/consent', web), {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: new URL(web).origin },
    body: new URLSearchParams({
      session,
      login: 'igor',
      repositories: 'igor/demo',
      'permission:issues': 'write',
      decision: 'approve',
    }),
  });

  await response.text();

  if (response.status !== 302) {
    throw new Error('Local consent failed');
  }

  const location = new URL(response.headers.get('location') ?? '', web);
  const expected = new URL(callback);

  if (
    location.origin !== expected.origin ||
    location.pathname !== expected.pathname ||
    location.searchParams.get('state') !== state
  ) {
    throw new Error('Invalid authorization callback or state');
  }

  const code = location.searchParams.get('code');

  if (!code) {
    throw new Error('Authorization callback did not contain a code');
  }

  return code;
}

export async function exchange(
  web: string,
  app: { clientId: string; clientSecret: string },
  code: string,
  callback: string,
) {
  const response = await localClient(web).request(
    'POST /login/oauth/access_token',
    {
      headers: { accept: 'application/json' },
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: callback,
    },
  );

  // OAuth errors have HTTP 200, so callers must inspect the parsed body as well.
  if (response.data.error) {
    throw new Error(`Code exchange failed: ${response.data.error}`);
  }

  if (typeof response.data.access_token !== 'string') {
    throw new Error('Missing user token');
  }

  return response.data.access_token as string;
}
