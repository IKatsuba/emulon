// Stripe's domain terms are snake_case; records keep them as field names.
// deno-lint-ignore-file camelcase
import { invalidRequest, StripeError } from '../errors.ts';
import { mergeMetadata } from '../http/fields.ts';
import {
  all,
  find,
  load,
  type Metadata,
  type Page,
  paginate,
  randomId,
  save,
  seconds,
  type Transaction,
} from './core.ts';

export interface Product {
  id: string;
  object: 'product';
  active: boolean;
  created: number;
  default_price: string | null;
  description: string | null;
  metadata: Metadata;
  name: string;
  statement_descriptor: string | null;
  tax_code: string | null;
  unit_label: string | null;
  updated: number;
  url: string | null;
}

export type TaxBehavior = 'exclusive' | 'inclusive' | 'unspecified';

export interface Price {
  id: string;
  object: 'price';
  active: boolean;
  created: number;
  currency: string;
  lookup_key: string | null;
  metadata: Metadata;
  nickname: string | null;
  product: string;
  tax_behavior: TaxBehavior;
  unit_amount: number;
}

export interface ProductInput {
  id?: string | undefined;
  name: string;
  active?: boolean | undefined;
  description?: string | undefined;
  metadata?: Metadata | undefined;
  statementDescriptor?: string | undefined;
  taxCode?: string | null | undefined;
  unitLabel?: string | undefined;
  url?: string | undefined;
}

export interface ProductUpdate {
  name?: string | undefined;
  active?: boolean | undefined;
  /** `null` clears the description. */
  description?: string | null | undefined;
  taxCode?: string | null | undefined;
  defaultPrice?: string | undefined;
  metadata?: Metadata | undefined;
}

export interface ProductFilter {
  active?: boolean | undefined;
  ids?: string[] | undefined;
  page: Page;
}

export interface PriceInput {
  product: string;
  unitAmount: number;
  currency: string;
  active?: boolean | undefined;
  lookupKey?: string | undefined;
  transferLookupKey: boolean;
  metadata?: Metadata | undefined;
  nickname?: string | undefined;
  taxBehavior?: TaxBehavior | undefined;
}

export interface PriceUpdate {
  active?: boolean | undefined;
  /** `null` clears the value. */
  nickname?: string | null | undefined;
  lookupKey?: string | null | undefined;
  transferLookupKey: boolean;
  taxBehavior?: TaxBehavior | undefined;
  metadata?: Metadata | undefined;
}

export interface PriceFilter {
  active?: boolean | undefined;
  product?: string | undefined;
  currency?: string | undefined;
  type?: 'one_time' | 'recurring' | undefined;
  lookupKeys?: string[] | undefined;
  page: Page;
}

export async function createProduct(
  tx: Transaction,
  input: ProductInput,
  now: number,
): Promise<Product> {
  const product: Product = {
    id: input.id ?? randomId('prod_', 14),
    object: 'product',
    active: input.active ?? true,
    created: seconds(now),
    default_price: null,
    description: input.description ?? null,
    metadata: input.metadata ?? {},
    name: input.name,
    statement_descriptor: input.statementDescriptor ?? null,
    tax_code: input.taxCode ?? null,
    unit_label: input.unitLabel ?? null,
    updated: seconds(now),
    url: input.url ?? null,
  };

  if (await find(tx, 'product', product.id)) {
    throw new StripeError(
      400,
      'invalid_request_error',
      'Product already exists.',
      { code: 'resource_already_exists', param: 'id' },
    );
  }

  await save(tx, product);

  return product;
}

export async function updateProduct(
  tx: Transaction,
  id: string,
  input: ProductUpdate,
  now: number,
): Promise<Product> {
  const product = await load<Product>(tx, 'product', id);
  const next: Product = {
    ...product,
    metadata: mergeMetadata(product.metadata, input.metadata),
  };

  if (input.name !== undefined) {
    next.name = input.name;
  }

  if (input.active !== undefined) {
    next.active = input.active;
  }

  if (input.description !== undefined) {
    next.description = input.description;
  }

  if (input.taxCode !== undefined) {
    next.tax_code = input.taxCode;
  }

  if (input.defaultPrice !== undefined) {
    const price = await load<Price>(
      tx,
      'price',
      input.defaultPrice,
      'default_price',
    );

    if (price.product !== product.id) {
      throw invalidRequest(
        'The default price must belong to this product.',
        'default_price',
      );
    }

    next.default_price = price.id;
  }

  next.updated = seconds(now);

  await save(tx, next);

  return next;
}

export async function listProducts(tx: Transaction, filter: ProductFilter) {
  const products = (await all<Product>(tx, 'product')).filter((product) =>
    (filter.active === undefined || product.active === filter.active) &&
    (filter.ids === undefined || filter.ids.includes(product.id))
  );

  return paginate(products, filter.page, '/v1/products');
}

/** A lookup key identifies at most one price; transferring moves it. */
async function claimLookupKey(
  tx: Transaction,
  key: string,
  transfer: boolean,
  owner: string,
) {
  const holder = (await all<Price>(tx, 'price')).find((price) =>
    price.lookup_key === key && price.id !== owner
  );

  if (holder === undefined) {
    return;
  }

  if (!transfer) {
    throw invalidRequest(
      `A price (\`${holder.id}\`) already uses that lookup key.`,
      'lookup_key',
    );
  }

  await save(tx, { ...holder, lookup_key: null });
}

export async function createPrice(
  tx: Transaction,
  input: PriceInput,
  now: number,
): Promise<Price> {
  const price: Price = {
    id: randomId('price_'),
    object: 'price',
    active: input.active ?? true,
    created: seconds(now),
    currency: input.currency,
    lookup_key: input.lookupKey ?? null,
    metadata: input.metadata ?? {},
    nickname: input.nickname ?? null,
    product: input.product,
    tax_behavior: input.taxBehavior ?? 'unspecified',
    unit_amount: input.unitAmount,
  };

  await load<Product>(tx, 'product', input.product, 'product');

  if (input.lookupKey !== undefined) {
    await claimLookupKey(
      tx,
      input.lookupKey,
      input.transferLookupKey,
      price.id,
    );
  }

  await save(tx, price);

  return price;
}

export async function updatePrice(
  tx: Transaction,
  id: string,
  input: PriceUpdate,
): Promise<Price> {
  const price = await load<Price>(tx, 'price', id);
  const next: Price = {
    ...price,
    metadata: mergeMetadata(price.metadata, input.metadata),
  };

  if (input.active !== undefined) {
    next.active = input.active;
  }

  if (input.nickname !== undefined) {
    next.nickname = input.nickname;
  }

  if (input.taxBehavior !== undefined) {
    next.tax_behavior = input.taxBehavior;
  }

  if (input.lookupKey !== undefined) {
    if (input.lookupKey !== null) {
      await claimLookupKey(
        tx,
        input.lookupKey,
        input.transferLookupKey,
        price.id,
      );
    }

    next.lookup_key = input.lookupKey;
  }

  await save(tx, next);

  return next;
}

export async function listPrices(tx: Transaction, filter: PriceFilter) {
  // Every stored price is one-time; recurring prices are not supported.
  const prices = (await all<Price>(tx, 'price')).filter((price) =>
    (filter.active === undefined || price.active === filter.active) &&
    (filter.product === undefined || price.product === filter.product) &&
    (filter.currency === undefined || price.currency === filter.currency) &&
    (filter.type === undefined || filter.type === 'one_time') &&
    (filter.lookupKeys === undefined ||
      (price.lookup_key !== null &&
        filter.lookupKeys.includes(price.lookup_key)))
  );

  return paginate(prices, filter.page, '/v1/prices');
}
