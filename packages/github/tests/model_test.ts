import github from '../src/mod.ts';
import { fixtures } from '../src/model/fixtures.ts';
import { makeApp, makeInstallation, setSuspended } from '../src/model/rules.ts';
import { appCredentials, resourceId } from '../src/auth/keys.ts';
import { idSchema } from '../src/model/schema.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function rejects(action: () => unknown, message: string) {
  try {
    action();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(message),
      'Unexpected validation error',
    );

    return;
  }

  throw new Error('Expected validation failure');
}

Deno.test('fixtures reject case-insensitive duplicates and missing owners', () => {
  rejects(
    () =>
      fixtures({ fixtures: { users: [{ login: 'igor' }, { login: 'Igor' }] } }),
    'Duplicate fixture user login',
  );
  rejects(
    () =>
      fixtures({
        fixtures: {
          users: [{ login: 'igor' }],
          repositories: [{ owner: 'igor', name: 'demo' }, {
            owner: 'IGOR',
            name: 'Demo',
          }],
        },
      }),
    'Duplicate fixture repository',
  );
  rejects(
    () =>
      fixtures({
        fixtures: { repositories: [{ owner: 'absent', name: 'demo' }] },
      }),
    'Unknown fixture repository owner',
  );

  const rows = fixtures({
    fixtures: {
      users: [{ login: 'Igor' }],
      repositories: [{ owner: 'IGOR', name: 'Demo', private: true }],
    },
  });

  assert(
    rows.length === 3 && rows[1]!.id === 'igor' && rows[2]!.id === 'igor/demo',
    'Fixture relationships were not normalized',
  );
});

Deno.test('installation rules reject missing, foreign and duplicate repositories without changing inputs', () => {
  const app = makeApp(
    { slug: 'Review-Bot', permissions: { issues: 'write' } },
    '1',
    { clientId: 'client', privateKey: 'private', publicKey: 'public' },
  );
  const repositories = [{
    id: '2',
    owner: 'igor',
    name: 'demo',
    fullName: 'igor/demo',
    private: true,
  }, {
    id: '3',
    owner: 'other',
    name: 'demo',
    fullName: 'other/demo',
    private: false,
  }];
  const input = { appId: '1', account: 'Igor', repositories: ['IGOR/Demo'] };
  const installation = makeInstallation(input, '4', app, repositories);

  assert(
    installation.account === 'igor' &&
      installation.repositories[0] === 'igor/demo' &&
      !installation.suspended,
    'Incorrect installation',
  );

  const suspended = setSuspended(installation, true);

  assert(
    suspended.suspended && !installation.suspended &&
      !setSuspended(suspended, false).suspended,
    'Suspension mutated its input',
  );

  installation.permissions.issues = 'read';

  assert(
    app.permissions.issues === 'write',
    'Installation aliased app permissions',
  );

  for (const names of [['igor/missing'], ['other/demo']]) {
    rejects(() =>
      makeInstallation(
        { ...input, repositories: names },
        '4',
        app,
        repositories,
      ), 'Repository is missing or belongs to another account');
  }

  rejects(
    () =>
      makeInstallation(
        { ...input, repositories: ['igor/demo', 'IGOR/DEMO'] },
        '4',
        app,
        repositories,
      ),
    'Duplicate installation repository',
  );
  rejects(
    () => makeInstallation({ ...input, appId: '9' }, '4', app, repositories),
    'App does not match',
  );
});

Deno.test('app credentials contain a working RSA-2048 pair and independent secure identifiers', async () => {
  const credentials = await appCredentials();
  const decode = (pem: string) =>
    Uint8Array.from(
      atob(
        pem.split('\n').filter((line) => line && !line.startsWith('---')).join(
          '',
        ),
      ),
      (c) => c.charCodeAt(0),
    );
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    decode(credentials.privateKey),
    algorithm,
    false,
    ['sign'],
  );
  const publicKey = await crypto.subtle.importKey(
    'spki',
    decode(credentials.publicKey),
    algorithm,
    false,
    ['verify'],
  );
  const data = new TextEncoder().encode('local GitHub app');
  const signature = await crypto.subtle.sign(algorithm, privateKey, data);

  assert(
    signature.byteLength === 256 &&
      await crypto.subtle.verify(algorithm, publicKey, signature, data),
    'RSA pair failed verification',
  );
  assert(/^Iv1\.[0-9a-f]{16}$/.test(credentials.clientId), 'Invalid client ID');

  const ids = Array.from({ length: 100 }, resourceId);

  assert(
    new Set(ids).size === ids.length &&
      ids.every((id) => idSchema.safeParse(id).success),
    'Invalid resource IDs',
  );
});

Deno.test('factory exposes actionable fixture errors before startup redaction', () => {
  rejects(
    () =>
      github({ fixtures: { users: [{ login: 'igor' }, { login: 'IGOR' }] } }),
    'Duplicate fixture user login',
  );
  rejects(
    () =>
      github({
        fixtures: { repositories: [{ owner: 'absent', name: 'demo' }] },
      }),
    'Unknown fixture repository owner',
  );
});
