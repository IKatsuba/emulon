import { resourceId } from '../auth/keys.ts';
import { canonical, unique } from './rules.ts';
import { type Options, optionsSchema } from './schema.ts';

export function validateFixtures(options?: Options) {
  const parsed = optionsSchema.parse(options ?? {}).fixtures;
  const users = parsed?.users ?? [];
  const repositories = parsed?.repositories ?? [];

  unique(users.map((user) => user.login), 'fixture user login');
  unique(
    repositories.map((repo) => `${repo.owner}/${repo.name}`),
    'fixture repository',
  );

  const logins = new Set(users.map((user) => canonical(user.login)));

  for (const repo of repositories) {
    if (!logins.has(canonical(repo.owner))) {
      throw new Error(`Unknown fixture repository owner: ${repo.owner}.`);
    }
  }

  return { users, repositories };
}

export function fixtures(options?: Options) {
  const { users, repositories } = validateFixtures(options);
  const rows: { collection: string; id: string; value: unknown }[] = [];

  for (const user of users) {
    const value = { id: resourceId(), login: canonical(user.login) };

    rows.push({ collection: 'users', id: value.id, value }, {
      collection: 'accounts',
      id: value.login,
      value: { ...value, type: 'User' },
    });
  }

  for (const repo of repositories) {
    const owner = canonical(repo.owner);
    const name = canonical(repo.name);
    const value = {
      id: resourceId(),
      owner,
      name,
      fullName: `${owner}/${name}`,
      private: repo.private ?? false,
    };

    rows.push({ collection: 'repositories', id: value.fullName, value });
  }

  return rows;
}
