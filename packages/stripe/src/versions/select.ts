import { invalidRequest, type StripeError } from '../errors.ts';
import type { Transaction } from '../model/core.ts';
import type { StripeVersionModule } from './types.ts';

/** The API versions one started instance serves. */
export interface VersionConfig {
  versions: string[];
  /** The account default: requests without `Stripe-Version` and new endpoints. */
  defaultVersion: string;
}

/**
 * Resolve `apiVersions` and `defaultApiVersion` against the installed
 * modules. Without options only `baseline` is served, as before versions were
 * selectable; `baseline` stays the default whenever it is selected, and any
 * other selection must name its default.
 */
export function resolveVersions(
  options: { apiVersions?: unknown; defaultApiVersion?: unknown } | undefined,
  installed: readonly string[],
  baseline: string,
): VersionConfig {
  const requested = options?.apiVersions ?? [baseline];

  if (
    !Array.isArray(requested) || requested.length === 0 ||
    requested.some((id) => typeof id !== 'string' || !installed.includes(id))
  ) {
    throw new Error(
      `apiVersions must list installed Stripe API versions: ${
        installed.join(', ')
      }.`,
    );
  }

  const versions = requested as string[];

  if (new Set(versions).size !== versions.length) {
    throw new Error('apiVersions must not repeat a version.');
  }

  const fallback = versions.includes(baseline) ? baseline : undefined;
  const defaultVersion = options?.defaultApiVersion ?? fallback;

  if (defaultVersion === undefined) {
    throw new Error('defaultApiVersion is required without the baseline.');
  }

  if (
    typeof defaultVersion !== 'string' || !versions.includes(defaultVersion)
  ) {
    throw new Error('defaultApiVersion must be one of apiVersions.');
  }

  return { versions, defaultVersion };
}

export function unsupportedVersion(config: VersionConfig): StripeError {
  return invalidRequest(
    `Unsupported API version. This account serves ${
      config.versions.join(', ')
    }.`,
  );
}

/**
 * The module for a request: its exact `Stripe-Version` when enabled, the
 * account default without one. Unknown, disabled, empty and malformed values
 * fail; there is no fallback to another version.
 */
export function selectVersion(
  header: string | undefined,
  config: VersionConfig,
  installed: ReadonlyMap<string, StripeVersionModule>,
): StripeVersionModule {
  const id = header ?? config.defaultVersion;
  const module = config.versions.includes(id) ? installed.get(id) : undefined;

  if (module === undefined) {
    throw unsupportedVersion(config);
  }

  return module;
}

const configRow = { collection: 'config', id: 'api-versions' } as const;

export function configFixture(config: VersionConfig) {
  return { ...configRow, value: config };
}

/** The started instance's selection, for control commands. */
export async function readConfig(tx: Transaction): Promise<VersionConfig> {
  return await tx.get(configRow.collection, configRow.id) as VersionConfig;
}
