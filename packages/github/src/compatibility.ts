import { type CompatibilityManifest, defineCompatibility } from 'emulon';

export const compatibility: CompatibilityManifest = defineCompatibility({
  'schemaVersion': 1,
  'plugin': '@emulon/github',
  'provider': {
    'name': 'GitHub',
    'api': 'REST and GitHub App OAuth',
  },
  'operations': [
    {
      'id': 'app.get',
      'method': 'GET',
      'path': '/app',
      'surface': 'api',
      'version': 'github-rest',
      'auth': [
        'app-jwt',
      ],
      'input': [],
      'output': 'id, slug, client_id, permissions, events',
      'events': [],
      'cases': [
        'github.octokit.1',
        'github.auth.1',
        'github.auth.2',
      ],
    },
    {
      'id': 'installations.list',
      'method': 'GET',
      'path': '/app/installations',
      'surface': 'api',
      'version': 'github-rest',
      'auth': [
        'app-jwt',
      ],
      'input': [
        'page',
        'per_page',
      ],
      'output':
        'Array of id, app_id, app_slug, account, permissions, events, repository_selection, suspended_at',
      'events': [],
      'cases': [
        'github.octokit.1',
      ],
    },
    {
      'id': 'installation-token.create',
      'method': 'POST',
      'path': '/app/installations/:installationId/access_tokens',
      'surface': 'api',
      'version': 'github-rest',
      'auth': [
        'app-jwt',
      ],
      'input': [
        'installationId',
        'repositories',
        'repository_ids',
        'permissions',
      ],
      'output': 'token, expires_at, permissions, repositories',
      'events': [],
      'cases': [
        'github.octokit.1',
        'github.auth.1',
        'github.auth.2',
      ],
    },
    {
      'id': 'user.get',
      'method': 'GET',
      'path': '/user',
      'surface': 'api',
      'version': 'github-rest',
      'auth': [
        'installation-token',
        'user-token',
      ],
      'input': [],
      'output': 'id, login, type; installation token returns a local app Bot',
      'events': [],
      'cases': [
        'github.octokit.1',
        'github.octokit.4',
        'github.user.1',
        'github.user.2',
        'github.user.3',
      ],
    },
    {
      'id': 'issues.create',
      'method': 'POST',
      'path': '/repos/:owner/:repo/issues',
      'surface': 'api',
      'version': 'github-rest',
      'auth': [
        'installation-token',
        'user-token',
      ],
      'input': [
        'owner',
        'repo',
        'title',
        'body',
      ],
      'output':
        'id, number, title, body, state, locked, user, url, html_url, repository_url, comments_url, labels, assignees, assignee, milestone, comments, created_at, updated_at, closed_at, author_association; partial provider projection',
      'events': [
        'issues.opened',
      ],
      'cases': [
        'github.octokit.1',
        'github.octokit.4',
        'github.issues.1',
        'github.issues.2',
      ],
    },
    {
      'id': 'authorization.start',
      'method': 'GET',
      'path': '/login/oauth/authorize',
      'surface': 'web',
      'version': 'oauth',
      'auth': [
        'fixture-consent',
      ],
      'input': [
        'client_id',
        'redirect_uri',
        'state',
      ],
      'output':
        'Local consent HTML or callback redirect; client/callback-bound single-use code',
      'events': [],
      'cases': [
        'github.authorization.1',
        'github.authorization.2',
        'github.authorization.3',
      ],
    },
    {
      'id': 'user-token.create',
      'method': 'POST',
      'path': '/login/oauth/access_token',
      'surface': 'web',
      'version': 'oauth',
      'auth': [
        'client-code',
      ],
      'input': [
        'client_id',
        'client_secret',
        'code',
        'redirect_uri',
        'grant_type',
      ],
      'output':
        'access_token, token_type, scope; non-expiring mode, no refresh token',
      'events': [],
      'cases': [
        'github.octokit.4',
        'github.user.1',
        'github.user.2',
        'github.user.3',
      ],
    },
  ],
  'versions': [
    {
      'id': 'github-rest',
      'accepted': [
        '2022-11-28',
      ],
      'headers': [
        'X-GitHub-Api-Version',
      ],
      'missing': 'Default 2022-11-28 subset (including empty header).',
      'unknown': '400 Not a supported version',
    },
    {
      'id': 'oauth',
      'accepted': [
        'unversioned',
      ],
      'headers': [],
      'missing': 'Unversioned web surface.',
      'unknown': 'No version negotiation on web surface.',
    },
  ],
  'authentication': {
    'flows': [
      'app-jwt',
      'installation-token',
      'user-token',
      'fixture-consent',
      'client-code',
    ],
    'keyFormats': [
      'RS256 JWT',
      'ghs_ opaque installation token',
      'ghu_ opaque user token',
    ],
    'ownership':
      'App issuer/key, owned installation, current installation grants and suspension; user access intersects current app and user grants; environment and instance isolation.',
    'unsupported': [
      'OAuth Apps',
      'PATs',
      'device flow',
      'PKCE',
      'refresh tokens',
    ],
  },
  'events': [
    {
      'id': 'issues.opened',
      'providerName': 'issues',
      'version': '2022-11-28',
      'projection':
        'action=opened, issue, repository, sender, optional installation',
      'cases': [
        'github.octokit.2',
        'github.octokit.3',
        'github.webhooks.1',
        'github.webhooks.2',
        'github.webhooks.3',
        'github.webhooks.4',
      ],
    },
  ],
  'webhooks': {
    'signing':
      'Optional X-Hub-Signature-256: sha256=<hex HMAC-SHA256 over exact UTF-8 body>; X-GitHub-Event: issues',
    'id': 'X-GitHub-Delivery: new UUID on each attempt',
    'body': 'Persisted serialized event bytes reused on redelivery',
    'success': '200-299',
    'timeoutMs': 10000,
    'retries': 'No automatic retries',
    'redelivery':
      'Manual; new provider delivery ID; signature computed over retained bytes',
    'recovery':
      'Retained queues recover on restart; an interrupted in-flight attempt has unknown external outcome.',
    'cases': [
      'github.webhooks.1',
      'github.webhooks.2',
      'github.webhooks.3',
      'github.webhooks.4',
    ],
  },
  'capabilities': [
    'http',
    'reset',
    'authorization',
    'events',
    'webhooks',
  ],
  'limitations': [
    {
      'id': 'github.limitation.1',
      'description':
        'Local fixture consent and user code exchange are implemented; OAuth Apps, PATs, device flow, PKCE, OAuth scopes, signup and GitHub login sessions are unsupported',
    },
    {
      'id': 'github.limitation.2',
      'description':
        'Exact JWT and suspended-installation error texts are local diagnostic contracts, not specified by GitHub documentation or verified against a live provider',
    },
    {
      'id': 'github.limitation.3',
      'description':
        'Error documentation_url is normalized to https://docs.github.com/rest; provider-specific links and errors arrays are not reproduced',
    },
    {
      'id': 'github.limitation.4',
      'description':
        'App and installation responses are partial projections; omitted URL, owner and timestamp fields are not emulated; suspended_at uses the epoch as a suspension marker',
    },
    {
      'id': 'github.limitation.5',
      'description':
        'Only selected repository installations are modeled; no enterprise installations or all-repositories selection',
    },
    {
      'id': 'github.limitation.6',
      'description':
        'Pagination supports page/per_page without Link headers; rate limits and User-Agent enforcement are not emulated',
    },
    {
      'id': 'github.limitation.7',
      'description':
        'Host clock uses wall time; controlled clocks can be supplied by internal test wrappers, but public clock advancement is not implemented',
    },
    {
      'id': 'github.limitation.8',
      'description':
        'Expired, unknown and foreign-instance tokens intentionally share 401 Bad credentials; wrong-installation use returns 404 Not Found',
    },
    {
      'id': 'github.limitation.9',
      'description':
        'Wrong app key and damaged signature share the same 401 response; non-RS256 headers receive a local explicit algorithm error',
    },
    {
      'id': 'github.limitation.10',
      'description':
        'Unsupported API versions return 400; absent version defaults to the declared 2022-11-28 subset',
    },
    {
      'id': 'github.limitation.11',
      'description':
        'Issue creation supports string title and optional string body only; labels, milestones and assignees are rejected; responses are partial provider projections',
    },
    {
      'id': 'github.limitation.12',
      'description':
        'GET /user with an installation token is an explicit local extension returning the app bot; GitHub documents user tokens, not installation tokens, for this endpoint',
    },
    {
      'id': 'github.limitation.13',
      'description':
        'Bot IDs reuse local app IDs; management-created issues use the emulon Bot with ID 0 and control authorization',
    },
    {
      'id': 'github.limitation.14',
      'description':
        'Persisted issue URLs retain creation-time local endpoint addresses across restarts',
    },
    {
      'id': 'github.limitation.15',
      'description':
        'Subscriptions use one instance-level webhooks destination; app webhook registrations and installation-specific routing are not connected to delivery',
    },
    {
      'id': 'github.limitation.16',
      'description':
        'Unsupported routes return 404 with only message: Not Found; no proxy fallback',
    },
    {
      'id': 'github.limitation.17',
      'description':
        'Authorization callbacks match exactly and support HTTP(S) without credentials or fragments; unknown clients show a local 404 page; mismatch and denial redirect with errors; no live-provider browser comparison',
    },
    {
      'id': 'github.limitation.18',
      'description':
        'User tokens support non-expiring mode only; refresh/unsupported grant types return HTTP 200 unsupported_grant_type; JSON and form encodings only, no XML; repository_id narrowing is unsupported and explicitly rejected without issuing a token or consuming the code',
    },
    {
      'id': 'github.limitation.19',
      'description':
        'Complete browser installation is unsupported; installations are provisioned by management commands or fixtures',
    },
  ],
  'verification': {
    'mode': 'official-client',
    'client': 'octokit@5.0.5',
    'suites': [
      {
        'path': 'packages/github/tests/auth_cases.ts',
        'cases': [
          'github.auth.1',
          'github.auth.2',
        ],
      },
      {
        'path': 'packages/github/tests/issues_cases.ts',
        'cases': [
          'github.issues.1',
          'github.issues.2',
        ],
      },
      {
        'path': 'packages/github/tests/user_cases.ts',
        'cases': [
          'github.user.1',
          'github.user.2',
          'github.user.3',
        ],
      },
      {
        'path': 'packages/github/tests/authorization_cases.ts',
        'cases': [
          'github.authorization.1',
          'github.authorization.2',
          'github.authorization.3',
        ],
      },
      {
        'path': 'packages/github/tests/webhooks_cases.ts',
        'cases': [
          'github.webhooks.1',
          'github.webhooks.2',
          'github.webhooks.3',
          'github.webhooks.4',
        ],
      },
      {
        'path': 'packages/github/tests/octokit_cases.ts',
        'cases': [
          'github.octokit.1',
          'github.octokit.2',
          'github.octokit.3',
          'github.octokit.4',
        ],
      },
    ],
    'sources': [
      'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app',
      'https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app',
      'https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api',
      'https://docs.github.com/en/rest/issues/issues#create-an-issue',
      'https://docs.github.com/en/rest/users/users#get-the-authenticated-user',
      'https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries',
      'https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries',
      'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app',
      'https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors',
    ],
    'retrieved': '2026-09-21',
    'liveProviderCompared': false,
  },
  'details': {
    'webhooks':
      'issues.opened -> issues/opened; optional HMAC-SHA256 over exact UTF-8 bytes; manual redelivery with a new provider delivery ID',
    'errorContract': {
      'malformed JWT or bad signature': {
        'status': 401,
        'message': 'A JSON web token could not be decoded',
      },
      'unsupported algorithm': {
        'status': 401,
        'message': 'Invalid JWT algorithm. Expected RS256.',
      },
      'unknown issuer': {
        'status': 401,
        'message': 'Invalid issuer',
      },
      'invalid or future iat': {
        'status': 401,
        'message':
          "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued",
      },
      'invalid or expired exp': {
        'status': 401,
        'message':
          "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires",
      },
      'exp beyond ten minutes': {
        'status': 401,
        'message':
          "'Expiration time' claim ('exp') must not be more than 10 minutes in the future",
      },
      'foreign or missing installation': {
        'status': 404,
        'message': 'Not Found',
      },
      'suspended installation': {
        'status': 403,
        'message': 'This installation has been suspended',
      },
      'permission expansion': {
        'status': 422,
        'message':
          'The permissions requested are not granted to this installation.',
      },
      'repository expansion': {
        'status': 422,
        'message':
          'The repositories requested are not available to this installation.',
      },
      'invalid request': {
        'status': 422,
        'message': 'Invalid request',
      },
      'expired or unknown installation token': {
        'status': 401,
        'message': 'Bad credentials',
      },
      'missing or ungranted repository': {
        'status': 404,
        'message': 'Not Found',
      },
      'missing issues write permission': {
        'status': 403,
        'message': 'Resource not accessible by integration',
      },
    },
    'errorBody':
      'message, documentation_url (https://docs.github.com/rest), status (decimal string)',
    'verification': {
      'client': 'octokit@5.0.5',
      'suite': 'packages/github/tests/octokit_cases.ts',
      'example': 'examples/github-app/main.ts',
      'network':
        'loopback only; dynamically allocated ports; no live-provider comparison',
      'authorizationSuite': 'packages/github/tests/authorization_cases.ts',
      'userTokenSuite': 'packages/github/tests/user_cases.ts',
      'userClient':
        'GET /user, issue creation, repository intersection, foreign-app installation denial, permission narrowing, suspension, code replay and expiry, unsupported refresh, reset invalidation',
      'userTokenExpiry':
        'Not applicable to the non-expiring issuance mode; clock advancement preserves user access',
    },
    'userTokenMode': 'non-expiring',
    'oauthErrors': {
      'status': 200,
      'wrongCredentials': 'incorrect_client_credentials',
      'wrongRedirect': 'redirect_uri_mismatch',
      'unknownExpiredOrReusedCode': 'bad_verification_code',
      'refreshOrDeviceGrant': 'unsupported_grant_type',
      'malformedBodyStatus': 400,
      'unsupportedRepositoryRestriction': {
        'status': 400,
        'error': 'invalid_request',
        'error_description': 'The repository_id parameter is not supported.',
        'compatibility':
          'Local unsupported-feature response; GitHub supports repository_id',
      },
    },
    'refresh':
      'Unsupported: no refresh token is issued; refresh requests return HTTP 200 unsupported_grant_type',
  },
});
