// Stripe's domain terms are snake_case; records keep them as field names.
// deno-lint-ignore-file camelcase
import type { PluginContext } from 'emulon';
import { invalidRequest, missing, StripeError } from '../errors.ts';

export type Store = PluginContext['store'];
export type Transaction = Parameters<Parameters<Store['transaction']>[0]>[0];
export type Metadata = Record<string, string>;

/**
 * A stored resource. Records hold the semantic state of a resource, not a
 * Stripe wire object: version modules add constant fields, derive
 * version-specific shapes and choose which properties are shown.
 */
export type ResourceRecord = { id: string; object: Kind };

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

export async function find<T extends ResourceRecord>(
  tx: Transaction,
  kind: Kind,
  id: string,
): Promise<T | undefined> {
  return await tx.get(collections[kind], id) as T | undefined;
}

export async function load<T extends ResourceRecord>(
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

export async function save<T extends ResourceRecord>(
  tx: Transaction,
  value: T,
) {
  await tx.put({
    collection: collections[value.object],
    id: value.id,
    value,
  });
}

export async function all<T extends ResourceRecord>(
  tx: Transaction,
  kind: Kind,
): Promise<T[]> {
  return (await tx.list(collections[kind])).map((row) => row.value as T);
}

/**
 * The canonical fact behind a Stripe event, captured when it happens. Version
 * modules project it into an event envelope; `apiVersion` names the view the
 * source request selected, while each webhook endpoint projects its own.
 */
export interface EventFact {
  id: string;
  apiVersion: string;
  created: number;
  object: ResourceRecord;
  previous?: Record<string, unknown>;
  pendingWebhooks: number;
  request: { id: string | null; idempotencyKey: string | null };
}

/** Record a Stripe event in the same transaction as the change it describes. */
export async function emit(
  tx: Transaction,
  type: string,
  object: ResourceRecord,
  now: number,
  version: string,
  previous?: Record<string, unknown>,
) {
  await tx.record({
    type,
    occurredAt: new Date(now).toISOString(),
    origin: 'service',
    payload: {
      id: randomId('evt_'),
      apiVersion: version,
      created: seconds(now),
      object: structuredClone(object),
      ...(previous ? { previous } : {}),
      pendingWebhooks: 1,
      request: { id: null, idempotencyKey: null },
    } satisfies EventFact,
  });
}

/** A canonical list page; version modules project each member. */
export interface List<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  url: string;
}

export interface Page {
  limit: number;
  startingAfter?: string | undefined;
  endingBefore?: string | undefined;
}

/**
 * Newest-first pagination with `limit` (1-100, default 10) and
 * `starting_after`/`ending_before`, as every Stripe list endpoint accepts.
 */
export function paginate<T extends { id: string; created: number }>(
  items: T[],
  page: Page,
  url: string,
): List<T> {
  const { limit, startingAfter: after, endingBefore: before } = page;

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

/** Canonical request identity, shared by HTTP and control commands. */
export function fingerprint(method: string, path: string, input: unknown) {
  const canonical = (value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
        Object.keys(value).sort()
          .filter((key) =>
            (value as Record<string, unknown>)[key] !== undefined
          )
          .map((key) => [
            key,
            canonical((value as Record<string, unknown>)[key]),
          ]),
      )
      : Array.isArray(value)
      ? value.map(canonical)
      : value;

  return JSON.stringify([method, path, canonical(input)]);
}

export function expired(created: number, now: number): boolean {
  return now - created >= 86400000;
}

/** Look up the current view of a resource that a projection expands. */
export type Resolver = (
  kind: Kind,
  id: string,
) => Promise<ResourceRecord | undefined>;

interface Saved {
  fingerprint: string;
  created: number;
  result: unknown;
  expanded: [Kind, string, ResourceRecord | null][];
}

const savedSchema = (value: unknown) => value as Saved;

/**
 * Run a mutation once per idempotency key. The canonical result and every
 * resource its projection expanded commit with the mutation, so a replay
 * projects the same snapshot without repeating state changes or events.
 * Concurrent requests with one key serialize; a failure caches nothing.
 */
export async function idempotent(
  store: Store,
  key: string | undefined,
  identity: string,
  now: number,
  work: (tx: Transaction) => Promise<unknown>,
  present: (result: unknown, resolve: Resolver) => Promise<unknown>,
  resolver: (tx: Transaction) => Resolver,
): Promise<unknown> {
  return await store.transaction(async (tx) => {
    if (key !== undefined) {
      if (key.length === 0 || key.length > 255) {
        throw invalidRequest('Invalid idempotency key.', 'Idempotency-Key');
      }

      const raw = await tx.get('idempotency', key);

      if (raw !== undefined) {
        const saved = savedSchema(raw);

        if (!expired(saved.created, now)) {
          if (saved.fingerprint !== identity) {
            throw new StripeError(
              400,
              'idempotency_error',
              'Keys for idempotent requests can only be used with the same parameters they were first used with.',
            );
          }

          const expanded = new Map(
            saved.expanded.map(([kind, id, value]) => [
              JSON.stringify([kind, id]),
              value ?? undefined,
            ]),
          );

          return await present(
            saved.result,
            (kind, id) =>
              Promise.resolve(expanded.get(JSON.stringify([kind, id]))),
          );
        }
      }
    }

    const result = await work(tx);
    const expanded: Saved['expanded'] = [];
    const live = resolver(tx);
    const body = await present(result, async (kind, id) => {
      const value = await live(kind, id);

      expanded.push([kind, id, value ?? null]);

      return value;
    });

    if (key !== undefined) {
      await tx.put({
        collection: 'idempotency',
        id: key,
        value: {
          fingerprint: identity,
          created: now,
          result,
          expanded,
        } satisfies Saved,
      });
    }

    return body;
  });
}
