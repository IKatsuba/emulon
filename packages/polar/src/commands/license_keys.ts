import { defineCommand } from 'emulon';
import { z } from 'zod';
import {
  type Benefit,
  type BenefitInput,
  benefitInput,
  benefitSchema,
  createBenefit,
  deactivateLicenseKey,
  getLicenseKey,
  grantLicenseKey,
  type Inspection,
  inspectionSchema,
  inspectLicenseKey,
  type LicenseKey,
  licenseKeySchema,
  type LicenseKeyWithActivations,
  licenseKeyWithActivationsSchema,
  listLicenseKeys,
  type Status,
  statuses,
  updateLicenseKey,
} from '../model/license_keys.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = {
  'benefits.create': Operation<BenefitInput, Benefit>;
  'licenseKeys.grant': Operation<
    { benefitId: string; customerId: string },
    LicenseKey
  >;
  'licenseKeys.list': Operation<Record<string, never>, LicenseKey[]>;
  'licenseKeys.get': Operation<{ id: string }, LicenseKeyWithActivations>;
  'licenseKeys.update': Operation<{ id: string; status: Status }, LicenseKey>;
  'licenseKeys.deactivate': Operation<
    { id: string; activationId: string },
    { deactivated: true }
  >;
  'licenseKeys.inspect': Operation<{ id: string }, Inspection>;
};

const id = z.string().min(1);

// These are local management commands; Polar has no matching grant HTTP API.
export const commands: Commands = {
  'benefits.create': defineCommand({
    description: 'Create a license_keys benefit in the instance organization',
    input: benefitInput,
    output: benefitSchema,
    cli: {
      path: ['benefits', 'create'],
      flags: {
        description: 'description',
        prefix: 'prefix',
        'limit-activations': 'limitActivations',
        'enable-customer-admin': 'enableCustomerAdmin',
        ttl: 'ttl',
        timeframe: 'timeframe',
        'limit-usage': 'limitUsage',
      },
    },
    execute: (ctx, input) => createBenefit(ctx.store, input, ctx.clock.now),
  }),
  'licenseKeys.grant': defineCommand({
    description:
      'Grant a benefit to a customer with a new random license key (explicit secret output)',
    input: z.strictObject({ benefitId: id, customerId: id }),
    output: licenseKeySchema,
    cli: {
      path: ['license-keys', 'grant'],
      flags: { 'benefit-id': 'benefitId', 'customer-id': 'customerId' },
    },
    execute: (ctx, input) => grantLicenseKey(ctx.store, input, ctx.clock.now),
  }),
  'licenseKeys.list': defineCommand({
    description: 'List license keys of the instance organization',
    input: z.strictObject({}),
    output: z.array(licenseKeySchema),
    cli: { path: ['license-keys', 'list'], flags: {} },
    execute: (ctx) => listLicenseKeys(ctx.store),
  }),
  'licenseKeys.get': defineCommand({
    description: 'Read a license key with its live activations',
    input: z.strictObject({ id }),
    output: licenseKeyWithActivationsSchema,
    cli: { path: ['license-keys', 'get'], flags: { id: 'id' } },
    execute: (ctx, input) => getLicenseKey(ctx.store, input.id),
  }),
  'licenseKeys.update': defineCommand({
    description:
      'Set a license key status, preserving the key, counters and activations',
    input: z.strictObject({ id, status: z.enum(statuses) }),
    output: licenseKeySchema,
    cli: {
      path: ['license-keys', 'update'],
      flags: { id: 'id', status: 'status' },
    },
    execute: (ctx, input) => updateLicenseKey(ctx.store, input, ctx.clock.now),
  }),
  'licenseKeys.deactivate': defineCommand({
    description: 'Free one live activation of a license key',
    input: z.strictObject({ id, activationId: id }),
    output: z.strictObject({ deactivated: z.literal(true) }),
    cli: {
      path: ['license-keys', 'deactivate'],
      flags: { id: 'id', 'activation-id': 'activationId' },
    },
    execute: (ctx, input) =>
      deactivateLicenseKey(ctx.store, input, ctx.clock.now),
  }),
  'licenseKeys.inspect': defineCommand({
    description:
      'Inspect license key counters, limits and live activation IDs without the key',
    input: z.strictObject({ id }),
    output: inspectionSchema,
    cli: { path: ['license-keys', 'inspect'], flags: { id: 'id' } },
    execute: (ctx, input) => inspectLicenseKey(ctx.store, input.id),
  }),
};
