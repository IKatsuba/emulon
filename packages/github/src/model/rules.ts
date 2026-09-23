import type {
  App,
  AppInput,
  Installation,
  InstallationInput,
  Repository,
} from './schema.ts';

export function canonical(value: string): string {
  return value.toLowerCase();
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values.map(canonical)).size !== values.length) {
    throw new Error(`Duplicate ${label}.`);
  }
}

export function makeApp(
  input: AppInput,
  id: string,
  credentials: Pick<
    App,
    'clientId' | 'privateKey' | 'publicKey' | 'clientSecret'
  >,
): App {
  unique(input.events ?? [], 'app event');

  return {
    id,
    slug: canonical(input.slug),
    ...credentials,
    permissions: input.permissions ?? { metadata: 'read' },
    events: input.events ?? [],
    callbackUrls: input.callbackUrls ?? [],
    webhook: input.webhook ?? null,
  };
}

export function makeInstallation(
  input: InstallationInput,
  id: string,
  app: App,
  repositories: readonly Repository[],
): Installation {
  unique(input.repositories, 'installation repository');

  if (input.appId !== app.id) {
    throw new Error('App does not match installation.');
  }

  const account = canonical(input.account);
  const names = input.repositories.map(canonical);

  for (const name of names) {
    const repo = repositories.find((repo) => canonical(repo.fullName) === name);

    if (!repo || canonical(repo.owner) !== account) {
      throw new Error('Repository is missing or belongs to another account.');
    }
  }

  return {
    id,
    appId: app.id,
    account,
    repositories: names,
    permissions: { ...app.permissions },
    suspended: false,
  };
}

export function setSuspended(
  installation: Installation,
  suspended: boolean,
): Installation {
  return { ...installation, suspended };
}
