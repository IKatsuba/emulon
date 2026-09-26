// Polar benefit and license key fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import type { PluginContext } from 'emulon';
import {
  type Customer,
  customerSchema,
  dateTime,
  organizationId,
} from './customers.ts';
import { PolarError } from './errors.ts';
import { canonicalUuid } from './portal.ts';

type Store = PluginContext['store'];
type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];

/** `maximum` of the pinned schema's 32-bit integer fields. */
const int32 = 2147483647;
const positive = z.number().int().positive().max(int32);

export const benefitCollection = 'benefits';
export const keyCollection = 'license_keys';
export const activationCollection = 'license_key_activations';

export const timeframes = ['year', 'month', 'day'] as const;

export type Timeframe = typeof timeframes[number];

export const statuses = ['granted', 'revoked', 'disabled'] as const;

export type Status = typeof statuses[number];

/**
 * The CLI maps each flag to one top-level field, so the management input is
 * flat; the paired fields become the nested `activations` and `expires`
 * properties of `BenefitLicenseKeysCreate`.
 */
export interface BenefitInput {
  description: string;
  prefix?: string | undefined;
  limitActivations?: number | undefined;
  enableCustomerAdmin?: boolean | undefined;
  ttl?: number | undefined;
  timeframe?: Timeframe | undefined;
  limitUsage?: number | undefined;
}

export const benefitInput: z.ZodType<BenefitInput, BenefitInput> = z
  .strictObject({
    description: z.string().min(3).max(42),
    prefix: z.string().optional(),
    limitActivations: positive.optional(),
    enableCustomerAdmin: z.boolean().optional(),
    ttl: positive.optional(),
    timeframe: z.enum(timeframes).optional(),
    limitUsage: positive.optional(),
  })
  .superRefine((value, ctx) => {
    for (
      const pair of [
        ['limitActivations', 'enableCustomerAdmin'],
        ['ttl', 'timeframe'],
      ] as const
    ) {
      const [first, second] = pair;

      if ((value[first] === undefined) !== (value[second] === undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Paired fields must be supplied together.',
          path: [value[first] === undefined ? first : second],
        });
      }
    }
  });

export interface BenefitProperties {
  prefix: string | null;
  expires: { ttl: number; timeframe: Timeframe } | null;
  activations: { limit: number; enable_customer_admin: boolean } | null;
  limit_usage: number | null;
}

/**
 * `BenefitLicenseKeys`. Products, customer-portal visibility and benefit
 * deletion are outside this slice, so their flags are fixed local defaults.
 */
export interface Benefit {
  id: string;
  created_at: string;
  modified_at: null;
  type: 'license_keys';
  description: string;
  selectable: true;
  deletable: true;
  is_deleted: false;
  organization_id: string;
  metadata: Record<string, never>;
  visibility: 'public';
  properties: BenefitProperties;
  visibility_configurable: true;
}

export const benefitSchema: z.ZodType<Benefit, Benefit> = z.strictObject({
  id: z.uuid(),
  created_at: dateTime,
  modified_at: z.null(),
  type: z.literal('license_keys'),
  description: z.string(),
  selectable: z.literal(true),
  deletable: z.literal(true),
  is_deleted: z.literal(false),
  organization_id: z.uuid(),
  metadata: z.strictObject({}),
  visibility: z.literal('public'),
  properties: z.strictObject({
    prefix: z.string().nullable(),
    expires: z.strictObject({
      ttl: positive,
      timeframe: z.enum(timeframes),
    }).nullable(),
    activations: z.strictObject({
      limit: positive,
      enable_customer_admin: z.boolean(),
    }).nullable(),
    limit_usage: positive.nullable(),
  }),
  visibility_configurable: z.literal(true),
});

/** The stored key: `LicenseKeyRead` without the customer, which is projected live. */
export interface StoredKey {
  id: string;
  created_at: string;
  modified_at: string | null;
  organization_id: string;
  customer_id: string;
  benefit_id: string;
  key: string;
  display_key: string;
  status: Status;
  limit_activations: number | null;
  usage: number;
  limit_usage: number | null;
  validations: number;
  last_validated_at: string | null;
  expires_at: string | null;
}

const storedKeyObject = z.strictObject({
  id: z.uuid(),
  created_at: dateTime,
  modified_at: dateTime.nullable(),
  organization_id: z.uuid(),
  customer_id: z.uuid(),
  benefit_id: z.uuid(),
  key: z.string(),
  display_key: z.string(),
  status: z.enum(statuses),
  limit_activations: positive.nullable(),
  usage: z.number().int().nonnegative(),
  limit_usage: positive.nullable(),
  validations: z.number().int().nonnegative(),
  last_validated_at: dateTime.nullable(),
  expires_at: dateTime.nullable(),
});
const storedKeySchema: z.ZodType<StoredKey, StoredKey> = storedKeyObject;

export type LicenseKey = StoredKey & { customer: Customer };

/** `LicenseKeyRead`, whose `key` is the full credential. */
export const licenseKeySchema: z.ZodType<LicenseKey, LicenseKey> =
  storedKeyObject.extend({ customer: customerSchema });

export type Metadata = Record<string, string | number | boolean>;

/** The schema's bounded metadata object, shared by `meta` and `conditions`. */
export const metadataSchema: z.ZodType<Metadata, Metadata> = z
  .record(
    z.string().min(1).max(40),
    z.union([z.string().min(1).max(500), z.number(), z.boolean()]),
  )
  .refine((value) => Object.keys(value).length <= 50, {
    message: 'At most 50 keys.',
  });

/** Conditions are internal; they never appear in an activation projection. */
export interface StoredActivation {
  id: string;
  license_key_id: string;
  label: string;
  meta: Metadata;
  conditions: Metadata;
  created_at: string;
  modified_at: string | null;
  deleted_at: string | null;
}

const storedActivationSchema: z.ZodType<StoredActivation, StoredActivation> = z
  .strictObject({
    id: z.uuid(),
    license_key_id: z.uuid(),
    label: z.string(),
    meta: metadataSchema,
    conditions: metadataSchema,
    created_at: dateTime,
    modified_at: dateTime.nullable(),
    deleted_at: dateTime.nullable(),
  });

/** `LicenseKeyActivationBase`. */
export interface Activation {
  id: string;
  license_key_id: string;
  label: string;
  meta: Metadata;
  created_at: string;
  modified_at: string | null;
}

export const activationSchema: z.ZodType<Activation, Activation> = z
  .strictObject({
    id: z.uuid(),
    license_key_id: z.uuid(),
    label: z.string(),
    meta: metadataSchema,
    created_at: dateTime,
    modified_at: dateTime.nullable(),
  });

export type LicenseKeyWithActivations = LicenseKey & {
  activations: Activation[];
};

export const licenseKeyWithActivationsSchema: z.ZodType<
  LicenseKeyWithActivations,
  LicenseKeyWithActivations
> = storedKeyObject.extend({
  customer: customerSchema,
  activations: z.array(activationSchema),
});

/** Diagnostics carry `display_key` only: the full key is a credential. */
export type Inspection = Omit<StoredKey, 'key'> & { activation_ids: string[] };

export const inspectionSchema: z.ZodType<Inspection, Inspection> =
  storedKeyObject.omit({ key: true }).extend({
    activation_ids: z.array(z.uuid()),
  });

/** An uppercase random UUID4, optionally behind the trimmed, uppercased prefix. */
export function generateKey(
  prefix: string | null,
  uuid: () => string = () => crypto.randomUUID(),
): string {
  const key = uuid().toUpperCase();

  // Polar tests the raw prefix for truthiness before trimming it.
  return prefix ? `${prefix.trim().toUpperCase()}-${key}` : key;
}

export function displayKey(key: string): string {
  return `****-${key.slice(-6)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Calendar arithmetic in UTC: a month or year keeps the day of month and
 * clamps it to the target month's length, so Jan 31 plus one month is the end
 * of February rather than a fixed number of days.
 */
export function addInterval(
  from: string,
  ttl: number,
  timeframe: Timeframe,
): string {
  const date = new Date(from);

  if (timeframe === 'day') {
    return new Date(date.getTime() + ttl * 86_400_000).toISOString();
  }

  const months = timeframe === 'year' ? ttl * 12 : ttl;
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const result = new Date(date);

  result.setUTCDate(1);
  result.setUTCFullYear(year, month);
  result.setUTCDate(
    Math.min(date.getUTCDate(), daysInMonth(year, month)),
  );

  return result.toISOString();
}

/** Expiry begins at the instant itself. */
export function isExpired(key: Pick<StoredKey, 'expires_at'>, now: number) {
  return key.expires_at !== null && now >= Date.parse(key.expires_at);
}

/** Constant-time comparison; full keys are compared case-sensitively. */
export function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
}

export function makeBenefit(
  input: BenefitInput,
  id: string,
  organization: string,
  createdAt: string,
): Benefit {
  return {
    id,
    created_at: createdAt,
    modified_at: null,
    type: 'license_keys',
    description: input.description,
    selectable: true,
    deletable: true,
    is_deleted: false,
    organization_id: organization,
    metadata: {},
    visibility: 'public',
    properties: {
      prefix: input.prefix ?? null,
      expires: input.ttl === undefined || input.timeframe === undefined
        ? null
        : { ttl: input.ttl, timeframe: input.timeframe },
      activations: input.limitActivations === undefined ||
          input.enableCustomerAdmin === undefined
        ? null
        : {
          limit: input.limitActivations,
          enable_customer_admin: input.enableCustomerAdmin,
        },
      limit_usage: input.limitUsage ?? null,
    },
    visibility_configurable: true,
  };
}

/** The grant mapping from benefit properties to a new key's limits and expiry. */
export function makeKey(
  benefit: Benefit,
  customerId: string,
  id: string,
  key: string,
  createdAt: string,
): StoredKey {
  const { activations, expires, limit_usage } = benefit.properties;

  return {
    id,
    created_at: createdAt,
    modified_at: null,
    organization_id: benefit.organization_id,
    customer_id: customerId,
    benefit_id: benefit.id,
    key,
    display_key: displayKey(key),
    status: 'granted',
    limit_activations: activations?.limit ?? null,
    usage: 0,
    limit_usage,
    validations: 0,
    last_validated_at: null,
    expires_at: expires === null
      ? null
      : addInterval(createdAt, expires.ttl, expires.timeframe),
  };
}

export function inspection(
  key: StoredKey,
  activations: readonly StoredActivation[],
): Inspection {
  const { key: _secret, ...rest } = key;

  return {
    ...rest,
    activation_ids: live(key, activations).map((activation) => activation.id),
  };
}

export function toActivation(activation: StoredActivation): Activation {
  return {
    id: activation.id,
    license_key_id: activation.license_key_id,
    label: activation.label,
    meta: activation.meta,
    created_at: activation.created_at,
    modified_at: activation.modified_at,
  };
}

/** Live activations of one key; soft-deleted rows neither count nor project. */
export function live(
  key: Pick<StoredKey, 'id'>,
  activations: readonly StoredActivation[],
): StoredActivation[] {
  return activations.filter((activation) =>
    activation.license_key_id === key.id && activation.deleted_at === null
  );
}

/** The activate refusals of ADR 0038 after key lookup, in Polar's order. */
export function activationRefusal(
  key: StoredKey,
  liveCount: number,
  now: number,
): string | null {
  if (key.status !== 'granted') {
    return 'License key is no longer active. This license key can not be activated.';
  }

  if (isExpired(key, now)) {
    return 'License key has expired.';
  }

  if (key.limit_activations === null) {
    return 'This license key does not support activations. Use the /validate endpoint instead to check license validity.';
  }

  if (liveCount >= key.limit_activations) {
    return 'License key activation limit already reached';
  }

  return null;
}

function notFound(resource: string): PolarError {
  return new PolarError(404, 'ResourceNotFound', `${resource} not found.`);
}

async function customerIn(
  tx: Transaction,
  organization: string,
  id: string,
): Promise<Customer> {
  const value = await tx.get('customers', id);

  if (value === undefined) {
    throw notFound('Customer');
  }

  const customer = customerSchema.parse(value);

  if (customer.organization_id !== organization) {
    throw notFound('Customer');
  }

  return customer;
}

async function benefitIn(
  tx: Transaction,
  organization: string,
  id: string,
): Promise<Benefit> {
  const value = await tx.get(benefitCollection, id);

  if (value === undefined) {
    throw notFound('Benefit');
  }

  const benefit = benefitSchema.parse(value);

  if (benefit.organization_id !== organization) {
    throw notFound('Benefit');
  }

  return benefit;
}

async function keyIn(
  tx: Transaction,
  organization: string,
  id: string,
): Promise<StoredKey> {
  const value = await tx.get(keyCollection, id);

  if (value === undefined) {
    throw notFound('License key');
  }

  const key = storedKeySchema.parse(value);

  if (key.organization_id !== organization) {
    throw notFound('License key');
  }

  return key;
}

async function keys(tx: Transaction): Promise<StoredKey[]> {
  return (await tx.list(keyCollection)).map((row) =>
    storedKeySchema.parse(row.value)
  );
}

async function activations(tx: Transaction): Promise<StoredActivation[]> {
  return (await tx.list(activationCollection)).map((row) =>
    storedActivationSchema.parse(row.value)
  );
}

async function project(tx: Transaction, key: StoredKey): Promise<LicenseKey> {
  return {
    ...key,
    customer: await customerIn(tx, key.organization_id, key.customer_id),
  };
}

export function createBenefit(
  store: Store,
  raw: BenefitInput,
  now: () => number = Date.now,
): Promise<Benefit> {
  const input = benefitInput.parse(raw);

  return store.transaction(async (tx) => {
    const benefit = makeBenefit(
      input,
      crypto.randomUUID(),
      await organizationId(tx),
      new Date(now()).toISOString(),
    );

    await tx.put({
      collection: benefitCollection,
      id: benefit.id,
      value: benefit,
    });

    return benefit;
  });
}

/** Generation attempts before giving up on an organization-unique key. */
const attempts = 10;

/**
 * Both records must exist in the instance organization. The key is always
 * generated here; a caller never supplies key material.
 */
export function grantLicenseKey(
  store: Store,
  input: { benefitId: string; customerId: string },
  now: () => number = Date.now,
  uuid: () => string = () => crypto.randomUUID(),
): Promise<LicenseKey> {
  return store.transaction(async (tx) => {
    const organization = await organizationId(tx);
    const benefit = await benefitIn(tx, organization, input.benefitId);
    const customer = await customerIn(tx, organization, input.customerId);
    const taken = (await keys(tx))
      .filter((key) => key.organization_id === organization)
      .map((key) => key.key);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const key = generateKey(benefit.properties.prefix, uuid);

      if (taken.some((existing) => sameKey(existing, key))) {
        continue;
      }

      const record = makeKey(
        benefit,
        customer.id,
        crypto.randomUUID(),
        key,
        new Date(now()).toISOString(),
      );

      await tx.put({ collection: keyCollection, id: record.id, value: record });

      return { ...record, customer };
    }

    throw new Error('Could not generate a unique license key.');
  });
}

export function listLicenseKeys(store: Store): Promise<LicenseKey[]> {
  return store.transaction(async (tx) => {
    const organization = await organizationId(tx);
    const result: LicenseKey[] = [];

    for (const key of await keys(tx)) {
      if (key.organization_id === organization) {
        result.push(await project(tx, key));
      }
    }

    return result;
  });
}

export function getLicenseKey(
  store: Store,
  id: string,
): Promise<LicenseKeyWithActivations> {
  return store.transaction(async (tx) => {
    const key = await keyIn(tx, await organizationId(tx), id);

    return {
      ...await project(tx, key),
      activations: live(key, await activations(tx)).map(toActivation),
    };
  });
}

/** Status changes preserve the key, its counters and its activations. */
export function updateLicenseKey(
  store: Store,
  input: { id: string; status: Status },
  now: () => number = Date.now,
): Promise<LicenseKey> {
  return store.transaction(async (tx) => {
    const key = await keyIn(tx, await organizationId(tx), input.id);
    const updated: StoredKey = {
      ...key,
      status: input.status,
      modified_at: new Date(now()).toISOString(),
    };

    await tx.put({ collection: keyCollection, id: key.id, value: updated });

    return project(tx, updated);
  });
}

async function release(
  tx: Transaction,
  key: StoredKey,
  activationId: string,
  now: number,
): Promise<boolean> {
  const activation = live(key, await activations(tx))
    .find((candidate) => candidate.id === activationId);

  if (activation === undefined) {
    return false;
  }

  const at = new Date(now).toISOString();

  await tx.put({
    collection: activationCollection,
    id: activation.id,
    value: { ...activation, deleted_at: at, modified_at: at },
  });

  return true;
}

/** Soft-deletes one live activation that belongs to the given key. */
export function deactivateLicenseKey(
  store: Store,
  input: { id: string; activationId: string },
  now: () => number = Date.now,
): Promise<{ deactivated: true }> {
  return store.transaction(async (tx) => {
    const key = await keyIn(tx, await organizationId(tx), input.id);

    if (!await release(tx, key, input.activationId, now())) {
      throw notFound('License key activation');
    }

    return { deactivated: true };
  });
}

export function inspectLicenseKey(
  store: Store,
  id: string,
): Promise<Inspection> {
  return store.transaction(async (tx) =>
    inspection(
      await keyIn(tx, await organizationId(tx), id),
      await activations(tx),
    )
  );
}

/** Lookup by exact key within the organization; anything else is not found. */
async function keyByValue(
  tx: Transaction,
  supplied: string,
  value: string,
): Promise<StoredKey> {
  const organization = await organizationId(tx);
  // Both sides are UUIDs; Polar compares them as values, not as text.
  const key = canonicalUuid(supplied) === canonicalUuid(organization)
    ? (await keys(tx)).find((candidate) =>
      candidate.organization_id === organization &&
      sameKey(candidate.key, value)
    )
    : undefined;

  if (key === undefined) {
    throw new PolarError(404, 'ResourceNotFound', 'Not found');
  }

  return key;
}

/**
 * The activation state primitive: the lookup, refusal checks and the new row
 * share one serialized transaction, so concurrent callers can never exceed
 * the key's activation limit.
 */
export function activateLicenseKey(
  store: Store,
  input: {
    key: string;
    organizationId: string;
    label: string;
    conditions: Metadata;
    meta: Metadata;
  },
  now: () => number = Date.now,
): Promise<Activation & { license_key: LicenseKey }> {
  return store.transaction(async (tx) => {
    const key = await keyByValue(tx, input.organizationId, input.key);
    const at = now();
    const refusal = activationRefusal(
      key,
      live(key, await activations(tx)).length,
      at,
    );

    if (refusal !== null) {
      throw new PolarError(403, 'NotPermitted', refusal);
    }

    const createdAt = new Date(at).toISOString();
    const activation: StoredActivation = {
      id: crypto.randomUUID(),
      license_key_id: key.id,
      label: input.label,
      meta: input.meta,
      conditions: input.conditions,
      created_at: createdAt,
      modified_at: null,
      deleted_at: null,
    };

    await tx.put({
      collection: activationCollection,
      id: activation.id,
      value: activation,
    });

    return { ...toActivation(activation), license_key: await project(tx, key) };
  });
}

/** `ValidatedLicenseKey`: the key as read, plus the named activation or null. */
export type ValidatedLicenseKey = LicenseKey & {
  activation: Activation | null;
};

export const validatedLicenseKeySchema: z.ZodType<
  ValidatedLicenseKey,
  ValidatedLicenseKey
> = storedKeyObject.extend({
  customer: customerSchema,
  activation: activationSchema.nullable(),
});

/**
 * Whole-object JSON equality: the same members with the same JSON values in
 * any member order. A number never equals a boolean or a string here.
 */
export function sameConditions(a: Metadata, b: Metadata): boolean {
  const names = Object.keys(a);

  return names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && a[name] === b[name]);
}

export interface Validation {
  activationId: string | null;
  benefitId: string | null;
  customerId: string | null;
  incrementUsage: number | null;
  conditions: Metadata;
}

function mismatch(detail: string): PolarError {
  return new PolarError(404, 'ResourceNotFound', detail);
}

/**
 * The validate refusals of ADR 0038 after key lookup, in Polar's order:
 * status, expiry, activation lookup, nonempty conditions, benefit, customer
 * and usage allowance. The found activation is returned for the projection.
 */
export function validationRefusal(
  key: StoredKey,
  activations: readonly StoredActivation[],
  request: Validation,
  now: number,
): { refusal: PolarError } | { activation: StoredActivation | null } {
  if (key.status !== 'granted') {
    return { refusal: mismatch('License key is no longer active.') };
  }

  if (isExpired(key, now)) {
    return { refusal: mismatch('License key has expired.') };
  }

  let activation: StoredActivation | null = null;

  if (request.activationId !== null) {
    activation = live(key, activations).find((candidate) =>
      canonicalUuid(candidate.id) === request.activationId
    ) ?? null;

    if (activation === null) {
      return { refusal: mismatch('Not found') };
    }

    if (
      Object.keys(activation.conditions).length > 0 &&
      !sameConditions(activation.conditions, request.conditions)
    ) {
      return {
        refusal: mismatch('License key does not match required conditions'),
      };
    }
  }

  if (
    request.benefitId !== null &&
    request.benefitId !== canonicalUuid(key.benefit_id)
  ) {
    return { refusal: mismatch('License key does not match given benefit.') };
  }

  if (
    request.customerId !== null &&
    request.customerId !== canonicalUuid(key.customer_id)
  ) {
    return { refusal: mismatch('License key does not match given user.') };
  }

  if (
    request.incrementUsage !== null && request.incrementUsage > 0 &&
    key.limit_usage !== null
  ) {
    const remaining = key.limit_usage - key.usage;

    if (request.incrementUsage > remaining) {
      return {
        refusal: new PolarError(
          400,
          'BadRequest',
          `License key only has ${remaining} more usages.`,
        ),
      };
    }
  }

  return { activation };
}

/** The counters a successful validation leaves behind. */
export function validated(
  key: StoredKey,
  incrementUsage: number | null,
  now: number,
): StoredKey {
  return {
    ...key,
    usage: key.usage +
      (incrementUsage !== null && incrementUsage > 0 ? incrementUsage : 0),
    validations: key.validations + 1,
    last_validated_at: new Date(now).toISOString(),
  };
}

/**
 * Lookup, refusal checks and counter writes share one serialized transaction,
 * so concurrent validations neither lose an increment nor overrun the usage
 * limit. A refusal writes nothing.
 */
export function validateLicenseKey(
  store: Store,
  input: { key: string; organizationId: string } & Validation,
  now: () => number = Date.now,
): Promise<ValidatedLicenseKey> {
  return store.transaction(async (tx) => {
    const key = await keyByValue(tx, input.organizationId, input.key);
    const at = now();
    const outcome = validationRefusal(key, await activations(tx), input, at);

    if ('refusal' in outcome) {
      throw outcome.refusal;
    }

    const updated = validated(key, input.incrementUsage, at);

    await tx.put({ collection: keyCollection, id: key.id, value: updated });

    return {
      ...await project(tx, updated),
      activation: outcome.activation === null
        ? null
        : toActivation(outcome.activation),
    };
  });
}

/**
 * Frees one live activation of the key named by value. Polar rechecks neither
 * status nor expiry here, so a revoked or expired key can still release one.
 */
export function releaseActivation(
  store: Store,
  input: { key: string; organizationId: string; activationId: string },
  now: () => number = Date.now,
): Promise<void> {
  return store.transaction(async (tx) => {
    const key = await keyByValue(tx, input.organizationId, input.key);

    // Activation IDs are generated lowercase, the canonical form of a request.
    if (!await release(tx, key, input.activationId, now())) {
      throw mismatch('Not found');
    }
  });
}
