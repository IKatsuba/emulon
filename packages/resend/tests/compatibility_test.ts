import { compatibility } from '../src/compatibility.ts';
import { verifyCoverage } from '../../emulon/tests/helpers/compatibility.ts';
import { cases as surface } from './surface_cases.ts';
import { cases as deliveryScenarios } from './delivery_scenarios_cases.ts';
import { cases as worker } from './worker_cases.ts';

const cases = [...surface, ...deliveryScenarios, ...worker];

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
