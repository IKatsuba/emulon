import type { PluginContext } from 'emulon';
import { appCredentials, resourceId } from '../auth/keys.ts';
import { canonical, makeApp, makeInstallation, setSuspended } from './rules.ts';
import {
  type AppInput,
  appRecordSchema,
  appSchema,
  type InstallationInput,
  installationSchema,
  repositorySchema,
} from './schema.ts';

type Store = PluginContext['store'];

export async function createApp(store: Store, input: AppInput) {
  const scoped = store.scope();
  const app = makeApp(input, resourceId(), await appCredentials());

  return scoped.transaction(async (tx) => {
    const apps = (await tx.list('apps')).map((row) =>
      appRecordSchema.parse(row.value)
    );

    if (apps.some((existing) => existing.slug === app.slug)) {
      throw new Error('Duplicate app slug.');
    }

    if (await tx.get('apps', app.id)) {
      throw new Error('App ID collision; retry creation.');
    }

    await tx.put({ collection: 'apps', id: app.id, value: app });

    return {
      ...appSchema.parse(app),
      privateKey: app.privateKey,
      clientSecret: app.clientSecret!,
    };
  });
}

export function createInstallation(store: Store, input: InstallationInput) {
  return store.transaction(async (tx) => {
    const value = await tx.get('apps', input.appId);

    if (!value) {
      throw new Error('Unknown app.');
    }

    if (!await tx.get('accounts', canonical(input.account))) {
      throw new Error('Unknown installation account.');
    }

    const existing = (await tx.list('installations')).map((row) =>
      installationSchema.parse(row.value)
    );

    if (
      existing.some((item) =>
        item.appId === input.appId && item.account === canonical(input.account)
      )
    ) {
      throw new Error('App is already installed on this account.');
    }

    const repositories = (await tx.list('repositories')).map((row) =>
      repositorySchema.parse(row.value)
    );
    const installation = makeInstallation(
      input,
      resourceId(),
      appRecordSchema.parse(value),
      repositories,
    );

    if (await tx.get('installations', installation.id)) {
      throw new Error('Installation ID collision; retry creation.');
    }

    await tx.put({
      collection: 'installations',
      id: installation.id,
      value: installation,
    });
    await tx.put({
      collection: 'grants',
      id: installation.id,
      value: {
        installationId: installation.id,
        repositoryIds: repositories.filter((repo) =>
          installation.repositories.includes(repo.fullName)
        ).map((repo) => repo.id),
        permissions: installation.permissions,
      },
    });

    return installation;
  });
}

export function suspendInstallation(
  store: Store,
  id: string,
  suspended: boolean,
) {
  return store.transaction(async (tx) => {
    const value = await tx.get('installations', id);

    if (!value) {
      throw new Error('Unknown installation.');
    }

    const installation = setSuspended(
      installationSchema.parse(value),
      suspended,
    );

    await tx.put({ collection: 'installations', id, value: installation });

    return installation;
  });
}
