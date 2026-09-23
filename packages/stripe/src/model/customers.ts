import { z } from 'zod';
import type { Destination, PluginContext } from 'emulon';

export const version = '2025-03-31.basil';
export const createInput: z.ZodType<CreateInput, CreateInput> = z.strictObject({
  name: z.string().optional(),
  email: z.string().optional(),
  description: z.string().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export interface CreateInput {
  name?: string | undefined;
  email?: string | undefined;
  description?: string | undefined;
  idempotencyKey?: string | undefined;
}

export const customerSchema: z.ZodType<Customer, Customer> = z.strictObject({
  id: z.string(),
  object: z.literal('customer'),
  created: z.number().int(),
  livemode: z.literal(false),
  name: z.string().nullable(),
  email: z.string().nullable(),
  description: z.string().nullable(),
  metadata: z.strictObject({}),
});

export interface Customer {
  id: string;
  object: 'customer';
  created: number;
  livemode: false;
  name: string | null;
  email: string | null;
  description: string | null;
  metadata: Record<string, never>;
}
type Store = PluginContext['store'];
export type Options = {
  destinations?: Destination[];
  fixtures?: {
    customers?: (Omit<CreateInput, 'idempotencyKey'> & { id?: string })[];
  };
};
export class StripeError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function fingerprint(input: CreateInput): string {
  return JSON.stringify([
    'POST',
    '/v1/customers',
    version,
    ...['name', 'email', 'description'].map((key) =>
      input[key as keyof CreateInput] ?? null
    ),
  ]);
}

export function expired(created: number, now: number): boolean {
  return now - created >= 86400000;
}

export function makeCustomer(
  input: CreateInput,
  id: string,
  now: number,
): Customer {
  return {
    id,
    object: 'customer',
    created: Math.floor(now / 1000),
    livemode: false,
    name: input.name ?? null,
    email: input.email ?? null,
    description: input.description ?? null,
    metadata: {},
  };
}

const savedSchema = z.object({
  fingerprint: z.string(),
  created: z.number(),
  status: z.literal(200),
  body: customerSchema,
});

export function createCustomer(
  store: Store,
  raw: CreateInput,
  now: () => number = Date.now,
): Promise<Customer> {
  const input = createInput.parse(raw);

  return store.transaction(async (tx) => {
    const time = now();
    const key = input.idempotencyKey;
    const hash = fingerprint(input);

    if (key !== undefined) {
      const value = await tx.get('idempotency', key);

      if (value !== undefined) {
        const saved = savedSchema.parse(value);

        if (!expired(saved.created, time)) {
          if (saved.fingerprint !== hash) {
            throw new StripeError(
              400,
              'idempotency_error',
              'Idempotency key was used with different parameters.',
            );
          }

          return saved.body;
        }
      }
    }

    const customer = makeCustomer(
      input,
      'cus_' + crypto.randomUUID().replaceAll('-', ''),
      time,
    );

    await tx.put({ collection: 'customers', id: customer.id, value: customer });
    await tx.record({
      type: 'customer.created',
      occurredAt: new Date(time).toISOString(),
      origin: 'service',
      payload: {
        id: 'evt_' + crypto.randomUUID().replaceAll('-', ''),
        object: 'event',
        api_version: version,
        created: customer.created,
        type: 'customer.created',
        livemode: false,
        data: { object: customer },
      },
    });

    if (key !== undefined) {
      await tx.put({
        collection: 'idempotency',
        id: key,
        value: {
          fingerprint: hash,
          created: time,
          status: 200,
          body: customer,
        },
      });
    }

    return customer;
  });
}

export function getCustomer(store: Store, id: string): Promise<Customer> {
  return store.transaction(async (tx) => {
    const value = await tx.get('customers', id);

    if (value === undefined) {
      throw new StripeError(
        404,
        'invalid_request_error',
        'Customer not found.',
        'resource_missing',
      );
    }

    return customerSchema.parse(value);
  });
}

export function fixtures(
  options?: Options,
): { collection: string; id: string; value: Customer }[] {
  const ids = new Set<string>();

  return (options?.fixtures?.customers ?? []).map(
    ({ id = 'cus_' + crypto.randomUUID().replaceAll('-', ''), ...input }) => {
      if (!/^cus_[a-zA-Z0-9]+$/.test(id) || ids.has(id)) {
        throw new Error('Invalid fixture customer ID.');
      }

      ids.add(id);

      return {
        collection: 'customers',
        id,
        value: makeCustomer(createInput.parse(input), id, Date.now()),
      };
    },
  );
}
