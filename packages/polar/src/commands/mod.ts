import { defineCommand } from 'emulon';
import { z } from 'zod';
import {
  type Commands as WebhookCommands,
  commands as webhookCommands,
} from './webhooks.ts';
import {
  type Commands as LicenseKeyCommands,
  commands as licenseKeyCommands,
} from './license_keys.ts';
import {
  createCustomer,
  type CreateInput,
  createInput,
  type Customer,
  customerSchema,
  getCustomer,
} from '../model/customers.ts';
import { createKey } from '../auth/keys.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = WebhookCommands & LicenseKeyCommands & {
  'customers.create': Operation<CreateInput, Customer>;
  'customers.get': Operation<{ id: string }, Customer>;
  'keys.create': Operation<Record<string, never>, { apiKey: string }>;
};

export const commands: Commands = {
  ...webhookCommands,
  ...licenseKeyCommands,
  'customers.create': defineCommand({
    description:
      'Create an organization customer and record customer.created atomically',
    input: createInput,
    // Management output is the provider wire projection, never Date objects.
    output: customerSchema,
    cli: {
      path: ['customers', 'create'],
      flags: { email: 'email', name: 'name', 'external-id': 'externalId' },
    },
    execute: (ctx, input) => createCustomer(ctx.store, input, ctx.clock.now),
  }),
  'customers.get': defineCommand({
    description: 'Read an organization customer',
    input: z.strictObject({ id: z.string().min(1) }),
    output: customerSchema,
    cli: { path: ['customers', 'get'], flags: { id: 'id' } },
    execute: (ctx, { id }) => getCustomer(ctx.store, id),
  }),
  'keys.create': defineCommand({
    description:
      'Issue a local organization access token (explicit secret output)',
    input: z.strictObject({}),
    output: z.object({ apiKey: z.string() }),
    cli: { path: ['keys', 'create'], flags: {} },
    execute: (ctx) => createKey(ctx.store),
  }),
};
