// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import type { PluginContext } from 'emulon';
import { invalidRequest, missing, StripeError } from '../errors.ts';
import { Fields } from '../http/fields.ts';

export const version = '2026-04-22.dahlia';

export type Store = PluginContext['store'];
export type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];
export type Metadata = Record<string, string>;
// deno-lint-ignore no-explicit-any
export type StripeObject = { id: string; object: string } & Record<string, any>;

const alphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Unguessable identifiers in Stripe's prefix_random shape. */
export function randomId(prefix: string, length = 24): string {
  let out = '';

  // 248 is the largest multiple of 62 not above 256; discarding bytes from 248
  // up keeps every character equally likely.
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < 248 && out.length < length) {
        out += alphabet[byte % 62];
      }
    }
  }

  return prefix + out;
}

export function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Stripe resources this plugin stores, by collection. */
export const collections = {
  customer: 'customers',
  product: 'products',
  price: 'prices',
  coupon: 'coupons',
  promotion_code: 'promotion_codes',
  'checkout.session': 'checkout_sessions',
  payment_intent: 'payment_intents',
  charge: 'charges',
  refund: 'refunds',
  dispute: 'disputes',
} as const;

export type Kind = keyof typeof collections;

const names: Record<Kind, string> = {
  customer: 'customer',
  product: 'product',
  price: 'price',
  coupon: 'coupon',
  promotion_code: 'promotion code',
  'checkout.session': 'checkout.session',
  payment_intent: 'payment_intent',
  charge: 'charge',
  refund: 'refund',
  dispute: 'dispute',
};

export async function find<T extends StripeObject>(
  tx: Transaction,
  kind: Kind,
  id: string,
): Promise<T | undefined> {
  return await tx.get(collections[kind], id) as T | undefined;
}

export async function load<T extends StripeObject>(
  tx: Transaction,
  kind: Kind,
  id: string,
  param = 'id',
): Promise<T> {
  const value = await find<T>(tx, kind, id);

  if (value === undefined) {
    throw missing(names[kind], id, param);
  }

  return value;
}

export async function save(tx: Transaction, value: StripeObject) {
  await tx.put({
    collection: collections[value.object as Kind],
    id: value.id,
    value,
  });
}

export async function all<T extends StripeObject>(
  tx: Transaction,
  kind: Kind,
): Promise<T[]> {
  return (await tx.list(collections[kind])).map((row) => row.value as T);
}

/** Record a Stripe event in the same transaction as the change it describes. */
export async function emit(
  tx: Transaction,
  type: string,
  object: StripeObject,
  now: number,
  previous?: Record<string, unknown>,
) {
  await tx.record({
    type,
    occurredAt: new Date(now).toISOString(),
    origin: 'service',
    payload: {
      id: randomId('evt_'),
      object: 'event',
      api_version: version,
      created: seconds(now),
      data: {
        object: structuredClone(object),
        ...(previous ? { previous_attributes: previous } : {}),
      },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
    },
  });
}

export interface List<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  url: string;
}

/**
 * Newest-first pagination with `limit` (1-100, default 10) and
 * `starting_after`/`ending_before`, as every Stripe list endpoint accepts.
 */
export function paginate<T extends StripeObject & { created: number }>(
  items: T[],
  fields: Fields,
  url: string,
): List<T> {
  const limit = fields.int('limit', { min: 1, max: 100 }) ?? 10;
  const after = fields.string('starting_after');
  const before = fields.string('ending_before');

  if (after && before) {
    throw invalidRequest(
      'You may only specify one of these parameters: starting_after, ending_before.',
    );
  }

  // Creation order breaks ties so pages never skip or repeat an object.
  const sorted = items.map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.created - a.item.created || b.index - a.index)
    .map(({ item }) => item);
  const cursor = after ?? before;
  const position = cursor === undefined
    ? -1
    : sorted.findIndex((item) => item.id === cursor);

  if (cursor !== undefined && position === -1) {
    throw invalidRequest(
      `No such object: '${cursor}'`,
      after ? 'starting_after' : 'ending_before',
      'resource_missing',
    );
  }

  const window = before !== undefined
    ? sorted.slice(Math.max(0, position - limit), position)
    : sorted.slice(position + 1, position + 1 + limit);
  const has_more = before !== undefined
    ? position - limit > 0
    : position + 1 + limit < sorted.length;

  return { object: 'list', data: window, has_more, url };
}

/** Which collection an expandable property refers to. */
const expandable: Record<string, Kind> = {
  coupon: 'coupon',
  customer: 'customer',
  product: 'product',
  price: 'price',
  promotion_code: 'promotion_code',
  payment_intent: 'payment_intent',
  latest_charge: 'charge',
  charge: 'charge',
  default_price: 'price',
};

/**
 * Replace ID strings with their objects along `expand[]` paths such as
 * `promotion.coupon` or `data.promotion.coupon`. Unknown or non-ID paths are
 * rejected like Stripe does, instead of being ignored.
 */
export async function expand<T>(
  tx: Transaction,
  value: T,
  paths: string[],
): Promise<T> {
  if (paths.length === 0) {
    return value;
  }

  const result = structuredClone(value) as Record<string, unknown>;

  for (const path of paths) {
    if (path.split('.').length > 4) {
      throw invalidRequest(
        `You cannot expand more than 4 levels of a property: ${path}.`,
        'expand',
      );
    }

    await expandPath(tx, result, path.split('.'), path);
  }

  return result as T;
}

async function expandPath(
  tx: Transaction,
  node: unknown,
  path: string[],
  full: string,
): Promise<void> {
  const [head, ...rest] = path;

  if (head === undefined || node === null || typeof node !== 'object') {
    return;
  }

  const record = node as Record<string, unknown>;

  if (head === 'data' && Array.isArray(record.data)) {
    for (const item of record.data) {
      await expandPath(tx, item, rest, full);
    }

    return;
  }

  if (!Object.hasOwn(record, head)) {
    throw invalidRequest(
      `This property cannot be expanded (${full}).`,
      'expand',
    );
  }

  if (rest.length > 0) {
    await expandPath(tx, record[head], rest, full);

    return;
  }

  const kind = expandable[head];
  const current = record[head];

  if (kind === undefined) {
    throw invalidRequest(
      `This property cannot be expanded (${full}).`,
      'expand',
    );
  }

  if (typeof current === 'string') {
    record[head] = await find(tx, kind, current) ?? current;
  }
}

const idempotencySchema = (value: unknown) =>
  value as { fingerprint: string; created: number; body: unknown };

/**
 * Run a mutation once per idempotency key. The saved result commits with the
 * mutation, so concurrent requests with one key serialize and replay; a
 * failure rolls back and caches nothing.
 */
export async function idempotent<T>(
  store: Store,
  key: string | undefined,
  fingerprint: string,
  now: number,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return await store.transaction(async (tx) => {
    if (key !== undefined) {
      if (key.length === 0 || key.length > 255) {
        throw invalidRequest('Invalid idempotency key.', 'Idempotency-Key');
      }

      const saved = await tx.get('idempotency', key);

      if (saved !== undefined) {
        const entry = idempotencySchema(saved);

        if (now - entry.created < 86400000) {
          if (entry.fingerprint !== fingerprint) {
            throw new StripeError(
              400,
              'idempotency_error',
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            );
          }

          return entry.body as T;
        }
      }
    }

    const body = await work(tx);

    if (key !== undefined) {
      await tx.put({
        collection: 'idempotency',
        id: key,
        value: { fingerprint, created: now, body },
      });
    }

    return body;
  });
}
