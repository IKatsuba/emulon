// Stripe's domain terms are snake_case; records keep them as field names.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import {
  emit,
  type Metadata,
  randomId,
  save,
  seconds,
  type Transaction,
} from './core.ts';

export { expired, fingerprint } from './core.ts';

export interface CustomerInput {
  name?: string | undefined;
  email?: string | undefined;
  description?: string | undefined;
  phone?: string | undefined;
  metadata?: Metadata | undefined;
}

const metadataInput: z.ZodType<Metadata, Metadata> = z.record(
  z.string().max(40),
  z.string().max(500),
).refine((value) => Object.keys(value).length <= 50);

const customerFields = {
  name: z.string().max(256).optional(),
  email: z.string().max(512).optional(),
  description: z.string().max(350).optional(),
  phone: z.string().max(20).optional(),
  metadata: metadataInput.optional(),
};

export const customerInput: z.ZodType<CustomerInput, CustomerInput> = z
  .strictObject(customerFields);

export type CustomerCommandInput = CustomerInput & {
  idempotencyKey?: string | undefined;
  apiVersion?: string | undefined;
};

export const customerCommandInput: z.ZodType<
  CustomerCommandInput,
  CustomerCommandInput
> = z.strictObject({
  ...customerFields,
  idempotencyKey: z.string().min(1).max(255).optional(),
  apiVersion: z.string().min(1).optional(),
});

export interface Customer {
  id: string;
  object: 'customer';
  created: number;
  description: string | null;
  email: string | null;
  invoice_prefix: string;
  metadata: Metadata;
  name: string | null;
  phone: string | null;
}

export function makeCustomer(
  input: CustomerInput,
  id: string,
  now: number,
): Customer {
  return {
    id,
    object: 'customer',
    created: seconds(now),
    description: input.description ?? null,
    email: input.email ?? null,
    invoice_prefix: randomId('', 8).toUpperCase(),
    metadata: input.metadata ?? {},
    name: input.name ?? null,
    phone: input.phone ?? null,
  };
}

export async function insertCustomer(
  tx: Transaction,
  input: CustomerInput,
  now: number,
  version: string,
): Promise<Customer> {
  const customer = makeCustomer(input, randomId('cus_', 14), now);

  await save(tx, customer);
  await emit(tx, 'customer.created', customer, now, version);

  return customer;
}

export type CustomerFixture = CustomerInput & { id?: string };

export function fixtures(
  options?: { fixtures?: { customers?: CustomerFixture[] } },
): { collection: string; id: string; value: Customer }[] {
  const ids = new Set<string>();

  return (options?.fixtures?.customers ?? []).map(
    ({ id = randomId('cus_', 14), ...input }) => {
      if (!/^cus_[a-zA-Z0-9]+$/.test(id) || ids.has(id)) {
        throw new Error('Invalid fixture customer ID.');
      }

      ids.add(id);

      const parsed = customerInput.safeParse(input);

      if (!parsed.success) {
        throw new Error('Invalid fixture customer.');
      }

      return {
        collection: 'customers',
        id,
        value: makeCustomer(parsed.data, id, Date.now()),
      };
    },
  );
}
