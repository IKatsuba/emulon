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

/** Suites of every schema version, each tagged with the API version it verifies. */
export function manifestSuites(manifest: CompatibilityManifest) {
  return manifest.schemaVersion === 1
    ? manifest.verification.suites.map((suite) => ({
      ...suite,
      version: undefined,
    }))
    : manifest.verification.byVersion.flatMap((record) =>
      record.suites.map((suite) => ({ ...suite, version: record.version }))
    );
}

/** Webhook case IDs of every schema version. */
export function webhookCases(manifest: CompatibilityManifest): string[] {
  return manifest.schemaVersion === 1
    ? [...manifest.webhooks.cases]
    : manifest.webhooks.flatMap((entry) => [...entry.cases]);
}

/**
 * Equality in both directions prevents reusing a real case to claim an untested
 * operation. A version-2 case claims IDs only for the version whose suite runs it.
 */
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

  const suites = manifestSuites(manifest);
  const versionOf = (test: ContractCase) =>
    suites.find((suite) => suite.path === test.suite)?.version;
  const key = (id: string, version: string | undefined) =>
    version === undefined ? id : `${id}@${version}`;

  equal(
    cases.map((test) => test.id),
    suites.flatMap((suite) => [...suite.cases]),
    'case IDs',
  );

  for (const suite of suites) {
    equal(
      cases.filter((test) => test.suite === suite.path).map((test) => test.id),
      [...suite.cases],
      suite.path,
    );
  }

  equal(
    cases.filter((test) => test.webhooks).map((test) => test.id),
    webhookCases(manifest),
    'webhooks',
  );

  if (manifest.schemaVersion === 2) {
    for (const entry of manifest.webhooks) {
      equal(
        cases.filter((test) =>
          test.webhooks && versionOf(test) === entry.version
        )
          .map((test) => test.id),
        [...entry.cases],
        key('webhooks', entry.version),
      );
    }
  }

  for (const kind of ['operations', 'events'] as const) {
    const entries = manifest[kind].map((entry) => ({
      key: key(
        entry.id,
        manifest.schemaVersion === 1 ? undefined : entry.version,
      ),
      cases: [...entry.cases],
    }));
    const claims = (test: ContractCase) =>
      test[kind].map((id) => key(id, versionOf(test)));

    equal(
      [...new Set(cases.flatMap(claims))],
      entries.map((entry) => entry.key),
      kind,
    );

    for (const entry of entries) {
      equal(
        cases.filter((test) => claims(test).includes(entry.key)).map((test) =>
          test.id
        ),
        entry.cases,
        entry.key,
      );
    }
  }
}
