import { compatibility } from '../src/compatibility.ts';
import { verifyCoverage } from '../../emulon/tests/helpers/compatibility.ts';
import { cases as auth } from './auth_cases.ts';
import { cases as issues } from './issues_cases.ts';
import { cases as user } from './user_cases.ts';
import { cases as authorization } from './authorization_cases.ts';
import { cases as webhooks } from './webhooks_cases.ts';
import { cases as octokit } from './octokit_cases.ts';

const cases = [
  ...auth,
  ...issues,
  ...user,
  ...authorization,
  ...webhooks,
  ...octokit,
];

verifyCoverage(compatibility, cases);

for (const test of cases) {
  Deno.test(`${test.id}: ${test.name}`, test.run);
}

Deno.test('untested compatibility operation fails even with a reused case ID', () => {
  const changed = structuredClone(compatibility);
  const mutant = {
    ...changed,
    operations: [...changed.operations, {
      ...changed.operations[0]!,
      id: 'untested',
      path: '/untested',
    }],
  };
  let rejected = false;

  try {
    verifyCoverage(mutant, cases);
  } catch {
    rejected = true;
  }

  if (!rejected) {
    throw new Error('Untested operation accepted');
  }
});
