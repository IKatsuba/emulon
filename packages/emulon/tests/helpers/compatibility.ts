import type { CompatibilityManifest } from 'emulon';

interface ContractCase {
  id: string;
  suite: string;
  operations: string[];
  events: string[];
  webhooks: boolean;
  name: string;
  run: (context: Deno.TestContext) => void | Promise<void>;
}

export function caseRegistry(suite: string) {
  const cases: ContractCase[] = [];

  return {
    cases,
    register(
      id: string,
      operations: string[],
      events: string[],
      webhooks: boolean,
      name: string,
      run: ContractCase['run'],
    ) {
      cases.push({ id, suite, operations, events, webhooks, name, run });
    },
  };
}

/** Equality in both directions prevents reusing a real case to claim an untested operation. */
export function verifyCoverage(
  manifest: CompatibilityManifest,
  cases: ContractCase[],
) {
  function equal(actual: string[], expected: string[], label: string) {
    if (
      new Set(actual).size !== actual.length ||
      JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())
    ) {
      throw new Error(`Compatibility coverage mismatch: ${label}`);
    }
  }

  equal(
    cases.map((test) => test.id),
    manifest.verification.suites.flatMap((suite) => [...suite.cases]),
    'case IDs',
  );

  for (const suite of manifest.verification.suites) {
    equal(
      cases.filter((test) => test.suite === suite.path).map((test) => test.id),
      [...suite.cases],
      suite.path,
    );
  }

  equal(cases.filter((test) => test.webhooks).map((test) => test.id), [
    ...manifest.webhooks.cases,
  ], 'webhooks');

  for (const kind of ['operations', 'events'] as const) {
    equal(
      [...new Set(cases.flatMap((test) => test[kind]))],
      manifest[kind].map((entry) => entry.id),
      kind,
    );

    for (const entry of manifest[kind]) {
      equal(
        cases.filter((test) => test[kind].includes(entry.id)).map((test) =>
          test.id
        ),
        [...entry.cases],
        entry.id,
      );
    }
  }
}
