// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import type { Destination } from 'emulon';
import { invalidRequest } from '../errors.ts';
import type { Fields } from '../http/fields.ts';
import type { Params } from '../http/form.ts';
import {
  idempotent,
  load,
  type Metadata,
  randomId,
  save,
  seconds,
  type Store,
  type Transaction,
} from './core.ts';
import { emit } from './core.ts';

export { version } from './core.ts';

export interface CreateInput {
  name?: string | undefined;
  email?: string | undefined;
  description?: string | undefined;
  phone?: string | undefined;
  metadata?: Metadata | undefined;
  idempotencyKey?: string | undefined;
}

const metadataInput = z.record(z.string().max(40), z.string().max(500))
  .refine((value) => Object.keys(value).length <= 50);

export const createInput: z.ZodType<CreateInput, CreateInput> = z.strictObject({
  name: z.string().max(256).optional(),
  email: z.string().max(512).optional(),
  description: z.string().max(350).optional(),
  phone: z.string().max(20).optional(),
  metadata: metadataInput.optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export interface Customer {
  id: string;
  object: 'customer';
  address: null;
  balance: number;
  created: number;
  currency: string | null;
  default_source: null;
  delinquent: boolean;
  description: string | null;
  discount: null;
  email: string | null;
  invoice_prefix: string;
  invoice_settings: {
    custom_fields: null;
    default_payment_method: null;
    footer: null;
    rendering_options: null;
  };
  livemode: false;
  metadata: Metadata;
  name: string | null;
  next_invoice_sequence: number;
  phone: string | null;
  preferred_locales: string[];
  shipping: null;
  tax_exempt: 'none';
  test_clock: null;
}

export const customerSchema: z.ZodType<Customer, Customer> = z.looseObject({
  id: z.string(),
  object: z.literal('customer'),
  created: z.number().int(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
}) as unknown as z.ZodType<Customer, Customer>;

export type Options = {
  destinations?: Destination[];
  fixtures?: {
    customers?: (Omit<CreateInput, 'idempotencyKey'> & { id?: string })[];
  };
};

/** Canonical request identity, shared by HTTP and control commands. */
export function fingerprint(method: string, path: string, params: Params) {
  const canonical = (value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
        Object.keys(value).sort().map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
      )
      : Array.isArray(value)
      ? value.map(canonical)
      : value;

  return JSON.stringify([method, path, canonical(params)]);
}

export function expired(created: number, now: number): boolean {
  return now - created >= 86400000;
}

export function makeCustomer(
  input: Omit<CreateInput, 'idempotencyKey'>,
  id: string,
  now: number,
): Customer {
  return {
    id,
    object: 'customer',
    address: null,
    balance: 0,
    created: seconds(now),
    currency: null,
    default_source: null,
    delinquent: false,
    description: input.description ?? null,
    discount: null,
    email: input.email ?? null,
    invoice_prefix: randomId('', 8).toUpperCase(),
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null,
    },
    livemode: false,
    metadata: input.metadata ?? {},
    name: input.name ?? null,
    next_invoice_sequence: 1,
    phone: input.phone ?? null,
    preferred_locales: [],
    shipping: null,
    tax_exempt: 'none',
    test_clock: null,
  };
}

/** The form parameters a command input corresponds to. */
export function customerParams(input: CreateInput): Params {
  const params: Params = {};

  for (const key of ['name', 'email', 'description', 'phone'] as const) {
    if (input[key] !== undefined) {
      params[key] = input[key]!;
    }
  }

  if (input.metadata !== undefined) {
    params.metadata = { ...input.metadata };
  }

  return params;
}

export function readCustomerFields(fields: Fields): CreateInput {
  const input: CreateInput = {
    name: fields.string('name', { max: 256 }),
    email: fields.string('email', { max: 512 }),
    description: fields.string('description', { max: 350 }),
    phone: fields.string('phone', { max: 20 }),
    metadata: fields.metadata(),
  };

  fields.done();

  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

export async function insertCustomer(
  tx: Transaction,
  input: Omit<CreateInput, 'idempotencyKey'>,
  now: number,
): Promise<Customer> {
  const customer = makeCustomer(input, randomId('cus_', 14), now);

  await save(tx, customer);
  await emit(tx, 'customer.created', customer, now);

  return customer;
}

export function createCustomer(
  store: Store,
  raw: CreateInput,
  now: () => number = Date.now,
): Promise<Customer> {
  const parsed = createInput.safeParse(raw);

  if (!parsed.success) {
    return Promise.reject(invalidRequest('Invalid customer input.'));
  }

  const { idempotencyKey, ...input } = parsed.data;
  const time = now();

  return idempotent(
    store,
    idempotencyKey,
    fingerprint('POST', '/v1/customers', customerParams(input)),
    time,
    (tx) => insertCustomer(tx, input, time),
  );
}

export function getCustomer(store: Store, id: string): Promise<Customer> {
  return store.transaction((tx) => load<Customer>(tx, 'customer', id));
}

export function fixtures(
  options?: Options,
): { collection: string; id: string; value: Customer }[] {
  const ids = new Set<string>();

  return (options?.fixtures?.customers ?? []).map(
    ({ id = randomId('cus_', 14), ...input }) => {
      if (!/^cus_[a-zA-Z0-9]+$/.test(id) || ids.has(id)) {
        throw new Error('Invalid fixture customer ID.');
      }

      ids.add(id);

      const parsed = createInput.safeParse(input);

      if (!parsed.success || parsed.data.idempotencyKey !== undefined) {
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
