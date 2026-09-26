// Polar customer fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { z } from 'zod';
import type { Destination, PluginContext } from 'emulon';
import { PolarError, PolarValidationError, validationIssue } from './errors.ts';

/** The pinned Polar API schema; see docs/decisions/0033-polar-initial-slice.md. */
export const apiVersion = '2026-04';
/** `CustomerIndividualCreate.name` in the pinned schema. */
export const nameLimit = 256;
/**
 * Every `format: date-time` field of the pinned schema, matching what
 * `@polar-sh/sdk@0.49.0` accepts: an offset or `Z`, never a bare local time.
 */
export const dateTime: z.ZodType<string, string> = z.iso.datetime({
  offset: true,
});

export const createInput: z.ZodType<CreateInput, CreateInput> = z.strictObject({
  email: z.email(),
  name: z.string().max(nameLimit).optional(),
  externalId: z.string().min(1).optional(),
});
/** Provider JSON keeps the schema's snake_case names and its optional type. */
export const createBody: z.ZodType<CreateBody, CreateBody> = z.strictObject({
  email: z.email(),
  name: z.string().max(nameLimit).nullable().optional(),
  external_id: z.string().min(1).nullable().optional(),
  type: z.literal('individual').optional(),
});

export interface CreateInput {
  email: string;
  name?: string | undefined;
  externalId?: string | undefined;
}
export interface CreateBody {
  email: string;
  name?: string | null | undefined;
  external_id?: string | null | undefined;
  type?: 'individual' | undefined;
}

export const customerSchema: z.ZodType<Customer, Customer> = z.strictObject({
  id: z.uuid(),
  created_at: dateTime,
  modified_at: z.null(),
  metadata: z.strictObject({}),
  external_id: z.string().nullable(),
  email: z.string(),
  email_verified: z.literal(false),
  type: z.literal('individual'),
  name: z.string().nullable(),
  billing_name: z.null(),
  billing_address: z.null(),
  tax_id: z.null(),
  locale: z.null(),
  organization_id: z.uuid(),
  default_payment_method_id: z.null(),
  deleted_at: z.null(),
  first_user_event_at: z.null(),
  avatar_url: z.null(),
});

/**
 * The declared individual projection. Billing, identity verification, member
 * creation and avatar lookup are unimplemented, so their fields stay null.
 */
export interface Customer {
  id: string;
  created_at: string;
  modified_at: null;
  metadata: Record<string, never>;
  external_id: string | null;
  email: string;
  email_verified: false;
  type: 'individual';
  name: string | null;
  billing_name: null;
  billing_address: null;
  tax_id: null;
  locale: null;
  organization_id: string;
  default_payment_method_id: null;
  deleted_at: null;
  first_user_event_at: null;
  avatar_url: null;
}

export type FixtureCustomer = CreateInput & { id?: string };
export type Options = {
  organizationId?: string;
  destinations?: Destination[];
  fixtures?: { customers?: FixtureCustomer[] };
};
type Store = PluginContext['store'];
type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];

export const organizationCollection = 'organization';
const organizationRow = 'self';

/** An explicit null and an omitted field both mean "no value" locally. */
export function fromBody(body: CreateBody): CreateInput {
  return {
    email: body.email,
    ...(body.name === undefined || body.name === null ? {} : {
      name: body.name,
    }),
    ...(body.external_id === undefined || body.external_id === null ? {} : {
      externalId: body.external_id,
    }),
  };
}

export function makeCustomer(
  input: CreateInput,
  id: string,
  organizationId: string,
  createdAt: string,
): Customer {
  return {
    id,
    created_at: createdAt,
    modified_at: null,
    metadata: {},
    external_id: input.externalId ?? null,
    email: input.email,
    email_verified: false,
    type: 'individual',
    name: input.name ?? null,
    billing_name: null,
    billing_address: null,
    tax_id: null,
    locale: null,
    organization_id: organizationId,
    default_payment_method_id: null,
    deleted_at: null,
    first_user_event_at: null,
    avatar_url: null,
  };
}

/** The conflicting field, or null when the organization accepts the customer. */
export function conflict(
  existing: readonly Customer[],
  input: CreateInput,
): 'email' | 'external_id' | null {
  for (const customer of existing) {
    if (customer.email === input.email) {
      return 'email';
    }

    if (
      input.externalId !== undefined &&
      customer.external_id === input.externalId
    ) {
      return 'external_id';
    }
  }

  return null;
}

export async function organizationId(tx: Transaction): Promise<string> {
  const value = await tx.get(organizationCollection, organizationRow);
  const parsed = z.object({ id: z.uuid() }).safeParse(value);

  if (!parsed.success) {
    throw new PolarError(
      401,
      'Unauthorized',
      'The local organization is unavailable.',
    );
  }

  return parsed.data.id;
}

export function getOrganizationId(store: Store): Promise<string> {
  return store.transaction(organizationId);
}

/** One transaction commits the customer and its immutable event, or neither. */
export function createCustomer(
  store: Store,
  raw: CreateInput,
  now: () => number = Date.now,
): Promise<Customer> {
  const input = createInput.parse(raw);

  return store.transaction(async (tx) => {
    const organization = await organizationId(tx);
    const existing = (await tx.list('customers')).map((row) =>
      customerSchema.parse(row.value)
    );
    const duplicate = conflict(existing, input);

    if (duplicate !== null) {
      throw new PolarError(
        409,
        'CustomerAlreadyExists',
        `A customer with this ${duplicate} already exists.`,
      );
    }

    const createdAt = new Date(now()).toISOString();
    const customer = makeCustomer(
      input,
      crypto.randomUUID(),
      organization,
      createdAt,
    );

    await tx.put({ collection: 'customers', id: customer.id, value: customer });
    await tx.record({
      type: 'customer.created',
      occurredAt: createdAt,
      origin: 'service',
      payload: {
        type: 'customer.created',
        timestamp: createdAt,
        api_version: apiVersion,
        data: customer,
      },
    });

    return customer;
  });
}

export function getCustomer(store: Store, id: string): Promise<Customer> {
  if (!z.uuid().safeParse(id).success) {
    throw new PolarValidationError([
      validationIssue(['path', 'id'], 'Input should be a valid UUID', 'uuid'),
    ]);
  }

  return store.transaction(async (tx) => {
    const value = await tx.get('customers', id);

    if (value === undefined) {
      throw new PolarError(404, 'ResourceNotFound', 'Customer not found.');
    }

    return customerSchema.parse(value);
  });
}

/** Fixtures seed the organization and its customers and emit no events. */
export function fixtures(
  options?: Options,
): { collection: string; id: string; value: unknown }[] {
  const organization = options?.organizationId ?? crypto.randomUUID();

  if (!z.uuid().safeParse(organization).success) {
    throw new Error('Invalid organization ID.');
  }

  const createdAt = new Date().toISOString();
  const ids = new Set<string>();
  const seeded: Customer[] = [];

  for (
    const { id = crypto.randomUUID(), ...input }
      of options?.fixtures?.customers ?? []
  ) {
    if (!z.uuid().safeParse(id).success || ids.has(id)) {
      throw new Error('Invalid fixture customer ID.');
    }

    const parsed = createInput.parse(input);

    if (conflict(seeded, parsed) !== null) {
      throw new Error('Duplicate fixture customer email or external ID.');
    }

    ids.add(id);
    seeded.push(makeCustomer(parsed, id, organization, createdAt));
  }

  return [
    {
      collection: organizationCollection,
      id: organizationRow,
      value: { id: organization },
    },
    ...seeded.map((customer) => ({
      collection: 'customers',
      id: customer.id,
      value: customer,
    })),
  ];
}
