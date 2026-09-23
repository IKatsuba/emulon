// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { invalidRequest, StripeError } from '../errors.ts';
import { type Fields, mergeMetadata } from '../http/fields.ts';
import {
  all,
  find,
  load,
  type Metadata,
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
  images: string[];
  livemode: false;
  marketing_features: [];
  metadata: Metadata;
  name: string;
  package_dimensions: null;
  shippable: null;
  statement_descriptor: string | null;
  tax_code: string | null;
  type: 'service';
  unit_label: string | null;
  updated: number;
  url: string | null;
}

export interface Price {
  id: string;
  object: 'price';
  active: boolean;
  billing_scheme: 'per_unit';
  created: number;
  currency: string;
  custom_unit_amount: null;
  livemode: false;
  lookup_key: string | null;
  metadata: Metadata;
  nickname: string | null;
  product: string;
  recurring: null;
  tax_behavior: 'exclusive' | 'inclusive' | 'unspecified';
  tiers_mode: null;
  transform_quantity: null;
  type: 'one_time';
  unit_amount: number;
  unit_amount_decimal: string;
}

const productId = /^[a-zA-Z0-9_-]{1,255}$/;
const taxCode = /^txcd_\d{8}$/;

function currency(fields: Fields, required: boolean): string | undefined {
  const value = required
    ? fields.required('currency')
    : fields.string('currency');

  if (value !== undefined && !/^[a-zA-Z]{3}$/.test(value)) {
    throw invalidRequest('Invalid currency.', 'currency');
  }

  return value?.toLowerCase();
}

function readTaxCode(fields: Fields): string | null | undefined {
  const value = fields.string('tax_code', { empty: true });

  if (value === '') {
    return null;
  }

  if (value !== undefined && !taxCode.test(value)) {
    throw invalidRequest('Invalid tax_code.', 'tax_code');
  }

  return value;
}

export async function createProduct(
  tx: Transaction,
  fields: Fields,
  now: number,
): Promise<Product> {
  const id = fields.string('id', { max: 255 });

  if (id !== undefined && !productId.test(id)) {
    throw invalidRequest('Invalid product id.', 'id');
  }

  const product: Product = {
    id: id ?? randomId('prod_', 14),
    object: 'product',
    active: fields.bool('active') ?? true,
    created: seconds(now),
    default_price: null,
    description: fields.string('description', { max: 40000 }) ?? null,
    images: [],
    livemode: false,
    marketing_features: [],
    metadata: fields.metadata() ?? {},
    name: fields.required('name', { max: 250 }),
    package_dimensions: null,
    shippable: null,
    statement_descriptor: fields.string('statement_descriptor', { max: 22 }) ??
      null,
    tax_code: readTaxCode(fields) ?? null,
    type: 'service',
    unit_label: fields.string('unit_label', { max: 12 }) ?? null,
    updated: seconds(now),
    url: fields.string('url', { max: 5000 }) ?? null,
  };

  fields.done();

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
  fields: Fields,
  now: number,
): Promise<Product> {
  const product = await load<Product>(tx, 'product', id);
  const next: Product = { ...product };
  const name = fields.string('name', { max: 250 });
  const active = fields.bool('active');
  const description = fields.string('description', {
    max: 40000,
    empty: true,
  });
  const tax = readTaxCode(fields);
  const defaultPrice = fields.string('default_price');

  next.metadata = mergeMetadata(product.metadata, fields.metadata());

  fields.done();

  if (name !== undefined) {
    next.name = name;
  }

  if (active !== undefined) {
    next.active = active;
  }

  if (description !== undefined) {
    next.description = description || null;
  }

  if (tax !== undefined) {
    next.tax_code = tax;
  }

  if (defaultPrice !== undefined) {
    const price = await load<Price>(tx, 'price', defaultPrice, 'default_price');

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

export async function listProducts(tx: Transaction, fields: Fields) {
  const active = fields.bool('active');
  const ids = fields.strings('ids');
  const products = (await all<Product>(tx, 'product')).filter((product) =>
    (active === undefined || product.active === active) &&
    (ids === undefined || ids.includes(product.id))
  );
  const list = paginate(products, fields, '/v1/products');

  fields.done();

  return list;
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
  fields: Fields,
  now: number,
): Promise<Price> {
  if (fields.has('recurring')) {
    throw invalidRequest(
      'Recurring prices are not supported by the local Stripe emulator.',
      'recurring',
    );
  }

  const productId = fields.required('product');
  const unitAmount = fields.int('unit_amount', { min: 0, max: 99999999 });
  const lookupKey = fields.string('lookup_key', { max: 200 });
  const transfer = fields.bool('transfer_lookup_key') ?? false;

  if (unitAmount === undefined) {
    throw invalidRequest(
      'Missing required param: unit_amount.',
      'unit_amount',
      'parameter_missing',
    );
  }

  const price: Price = {
    id: randomId('price_'),
    object: 'price',
    active: fields.bool('active') ?? true,
    billing_scheme: 'per_unit',
    created: seconds(now),
    currency: currency(fields, true)!,
    custom_unit_amount: null,
    livemode: false,
    lookup_key: lookupKey ?? null,
    metadata: fields.metadata() ?? {},
    nickname: fields.string('nickname', { max: 5000 }) ?? null,
    product: productId,
    recurring: null,
    tax_behavior:
      fields.oneOf('tax_behavior', ['exclusive', 'inclusive', 'unspecified']) ??
        'unspecified',
    tiers_mode: null,
    transform_quantity: null,
    type: 'one_time',
    unit_amount: unitAmount,
    unit_amount_decimal: String(unitAmount),
  };

  fields.done();
  await load<Product>(tx, 'product', productId, 'product');

  if (lookupKey !== undefined) {
    await claimLookupKey(tx, lookupKey, transfer, price.id);
  }

  await save(tx, price);

  return price;
}

export async function updatePrice(
  tx: Transaction,
  id: string,
  fields: Fields,
): Promise<Price> {
  const price = await load<Price>(tx, 'price', id);
  const next: Price = { ...price };
  const active = fields.bool('active');
  const nickname = fields.string('nickname', { max: 5000, empty: true });
  const lookupKey = fields.string('lookup_key', { max: 200, empty: true });
  const transfer = fields.bool('transfer_lookup_key') ?? false;
  const taxBehavior = fields.oneOf('tax_behavior', [
    'exclusive',
    'inclusive',
    'unspecified',
  ]);

  next.metadata = mergeMetadata(price.metadata, fields.metadata());

  fields.done();

  if (active !== undefined) {
    next.active = active;
  }

  if (nickname !== undefined) {
    next.nickname = nickname || null;
  }

  if (taxBehavior !== undefined) {
    next.tax_behavior = taxBehavior;
  }

  if (lookupKey !== undefined) {
    if (lookupKey) {
      await claimLookupKey(tx, lookupKey, transfer, price.id);
    }

    next.lookup_key = lookupKey || null;
  }

  await save(tx, next);

  return next;
}

export async function listPrices(tx: Transaction, fields: Fields) {
  const active = fields.bool('active');
  const product = fields.string('product');
  const currencyFilter = currency(fields, false);
  const type = fields.oneOf('type', ['one_time', 'recurring']);
  const lookupKeys = fields.strings('lookup_keys');

  if (lookupKeys !== undefined && lookupKeys.length > 10) {
    throw invalidRequest(
      'You may pass at most 10 lookup keys.',
      'lookup_keys',
    );
  }

  const prices = (await all<Price>(tx, 'price')).filter((price) =>
    (active === undefined || price.active === active) &&
    (product === undefined || price.product === product) &&
    (currencyFilter === undefined || price.currency === currencyFilter) &&
    (type === undefined || price.type === type) &&
    (lookupKeys === undefined ||
      (price.lookup_key !== null && lookupKeys.includes(price.lookup_key)))
  );

  const list = paginate(prices, fields, '/v1/prices');

  fields.done();

  return list;
}
