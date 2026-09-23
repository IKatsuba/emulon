import { defineCommand } from 'emulon';
import { z } from 'zod';
import {
  createCustomer,
  type CreateInput,
  createInput,
  type Customer,
  customerSchema,
  getCustomer,
} from '../model/customers.ts';
import { createKey } from '../auth/keys.ts';

import {
  type Commands as WebhookCommands,
  commands as webhookCommands,
} from './webhooks.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = WebhookCommands & {
  'customers.create': Operation<CreateInput, Customer>;
  'customers.get': Operation<{ id: string }, Customer>;
  'keys.create': Operation<Record<string, never>, { apiKey: string }>;
};

export const commands: Commands = {
  ...webhookCommands,
  'customers.create': defineCommand({
    description: 'Create a customer and record customer.created',
    input: createInput,
    output: customerSchema,
    cli: {
      path: ['customers', 'create'],
      flags: {
        name: 'name',
        email: 'email',
        description: 'description',
        'idempotency-key': 'idempotencyKey',
      },
    },
    execute: (ctx, input) => createCustomer(ctx.store, input, ctx.clock.now),
  }),
  'customers.get': defineCommand({
    description: 'Read a customer',
    input: z.strictObject({ id: z.string().min(1) }),
    output: customerSchema,
    cli: { path: ['customers', 'get'], flags: { id: 'id' } },
    execute: (ctx, { id }) => getCustomer(ctx.store, id),
  }),
  'keys.create': defineCommand({
    description: 'Issue a local test API key',
    input: z.strictObject({}),
    output: z.object({ apiKey: z.string() }),
    cli: { path: ['keys', 'create'], flags: {} },
    execute: (ctx) => createKey(ctx.store),
  }),
};
