// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import { StripeError } from '../src/errors.ts';
import { Fields, mergeMetadata } from '../src/http/fields.ts';
import { decodeParams, keyPath, parseParams } from '../src/http/form.ts';
import { paginate, randomId } from '../src/model/core.ts';
import { totals } from '../src/model/checkout.ts';
import { promotionActive } from '../src/model/discounts.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function fails(action: () => unknown, param?: string) {
  try {
    action();
  } catch (error) {
    assert(error instanceof StripeError, String(error));
    assert(error.status === 400);
    assert(param === undefined || error.param === param, error.param);

    return;
  }

  throw new Error('Expected a Stripe error');
}

Deno.test('Stripe bracket parameters decode as the official clients encode them', () => {
  assert(
    JSON.stringify(keyPath('line_items[0][price]')) ===
      '["line_items","0","price"]',
  );
  assert(JSON.stringify(keyPath('expand[]')) === '["expand",""]');

  const params = parseParams(
    'line_items[0][price]=price_1&line_items[0][quantity]=2' +
      '&line_items[1][price]=price_2&metadata[productId]=course' +
      '&expand[]=a&expand[]=b&lookup_keys[0]=k&discounts[0][promotion_code]=promo_1' +
      '&note=%C2%A3%20%F0%9F%90%BB',
  );

  assert(
    JSON.stringify(params) === JSON.stringify({
      line_items: [{ price: 'price_1', quantity: '2' }, { price: 'price_2' }],
      metadata: { productId: 'course' },
      expand: ['a', 'b'],
      lookup_keys: ['k'],
      discounts: [{ promotion_code: 'promo_1' }],
      note: '£ 🐻',
    }),
  );

  for (
    const bad of [
      'a=1&a=2',
      'a=1&a[b]=2',
      'a[0]=1&a[2]=2',
      'a]=1',
      '[a]=1',
      'a[__proto__][x]=1',
      'constructor[x]=1',
      'a[b]=1&a[b]=2',
    ]
  ) {
    fails(() => parseParams(bad));
  }

  assert(({} as Record<string, unknown>).x === undefined);
  assert(Object.keys(decodeParams([])).length === 0);
});

Deno.test('Stripe fields coerce, bound and reject unknown parameters', () => {
  const fields = new Fields(parseParams(
    'n=5&flag=true&kind=b&items[0][x]=1&tags[0]=t&metadata[k]=v&pct=12.5',
  ));

  assert(fields.int('n', { min: 1, max: 10 }) === 5);
  assert(fields.bool('flag') === true);
  assert(fields.oneOf('kind', ['a', 'b']) === 'b');
  assert(fields.decimal('pct', { max: 100 }) === 12.5);
  assert(fields.strings('tags')?.[0] === 't');
  assert(fields.metadata()?.k === 'v');

  const [item] = fields.list('items')!;

  assert(item!.string('x') === '1');
  item!.done();
  fields.done();

  fails(() => new Fields(parseParams('n=1.5')).int('n'), 'n');
  fails(() => new Fields(parseParams('n=11')).int('n', { max: 10 }), 'n');
  fails(() => new Fields(parseParams('flag=yes')).bool('flag'), 'flag');
  fails(() => new Fields(parseParams('kind=c')).oneOf('kind', ['a']), 'kind');
  fails(() => new Fields(parseParams('s=')).string('s'), 's');
  fails(() => new Fields(parseParams('')).required('s'), 's');
  fails(() => new Fields(parseParams('metadata=x')).metadata(), 'metadata');
  fails(
    () => new Fields(parseParams(`metadata[${'k'.repeat(41)}]=v`)).metadata(),
    'metadata',
  );

  const unknown = new Fields(parseParams('a=1&nested[b]=2'));
  const nested = unknown.object('nested')!;

  unknown.string('a');
  unknown.done();
  fails(() => nested.done(), 'nested[b]');
  assert(
    Object.keys(new Fields(parseParams('metadata=')).metadata()!).length === 0,
  );

  assert(
    JSON.stringify(mergeMetadata({ a: '1', b: '2' }, { a: '', c: '3' })) ===
      '{"b":"2","c":"3"}',
  );
  assert(JSON.stringify(mergeMetadata({ a: '1' }, {})) === '{}');
  assert(mergeMetadata({ a: '1' }, undefined).a === '1');
});

Deno.test('Stripe checkout totals honor coupon scope, currency and rounding', () => {
  const items = [
    { product: 'prod_a', amount: 1000 },
    { product: 'prod_b', amount: 333 },
  ];

  const plain = totals(items, 'usd');

  assert(plain.total === 1333 && plain.discount === 0);

  const scoped = totals(items, 'usd', {
    percent_off: 50,
    amount_off: null,
    currency: null,
    applies_to: { products: ['prod_b'] },
  });

  assert(scoped.discount === 167 && scoped.total === 1166);
  assert(scoped.perItem[0] === 0 && scoped.perItem[1] === 167);

  const spread = totals(items, 'usd', {
    percent_off: 25,
    amount_off: null,
    currency: null,
  });

  assert(spread.discount === 333);
  assert(spread.perItem.reduce((sum, value) => sum + value, 0) === 333);

  const capped = totals(items, 'usd', {
    percent_off: null,
    amount_off: 5000,
    currency: 'usd',
  });

  assert(capped.discount === 1333 && capped.total === 0);
  fails(() =>
    totals(items, 'usd', {
      percent_off: null,
      amount_off: 100,
      currency: 'eur',
    })
  );
  fails(() =>
    totals(items, 'usd', {
      percent_off: 10,
      amount_off: null,
      currency: null,
      applies_to: { products: ['prod_other'] },
    })
  );
});

Deno.test('Stripe lists page newest first with stable cursors', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    id: `obj_${index}`,
    object: 'thing',
    created: Math.floor(index / 5),
  }));
  const first = paginate(items, new Fields(parseParams('limit=10')), '/v1/x');

  assert(first.data.length === 10 && first.has_more);
  assert(first.data[0]!.id === 'obj_24');

  const second = paginate(
    items,
    new Fields(parseParams(`limit=10&starting_after=${first.data[9]!.id}`)),
    '/v1/x',
  );
  const third = paginate(
    items,
    new Fields(parseParams(`limit=10&starting_after=${second.data[9]!.id}`)),
    '/v1/x',
  );
  const seen = [...first.data, ...second.data, ...third.data].map((x) => x.id);

  assert(new Set(seen).size === 25 && !third.has_more);

  const back = paginate(
    items,
    new Fields(parseParams(`limit=5&ending_before=${second.data[0]!.id}`)),
    '/v1/x',
  );

  assert(back.data.at(-1)!.id === first.data[9]!.id);
  assert(paginate(items, new Fields({}), '/v1/x').data.length === 10);
  fails(() => paginate(items, new Fields(parseParams('limit=101')), '/v1/x'));
  fails(() =>
    paginate(items, new Fields(parseParams('starting_after=nope')), '/v1/x')
  );
});

Deno.test('Stripe promotion code activity and identifiers', () => {
  const now = 1_800_000_000_000;
  const coupon = {
    id: 'C',
    object: 'coupon' as const,
    amount_off: null,
    created: 0,
    currency: null,
    duration: 'once' as const,
    duration_in_months: null,
    livemode: false as const,
    max_redemptions: null,
    metadata: {},
    name: null,
    percent_off: 10,
    redeem_by: null,
    times_redeemed: 0,
    valid: true,
  };
  const code = {
    id: 'promo_1',
    object: 'promotion_code' as const,
    active: true,
    enabled: true,
    code: 'X',
    created: 0,
    customer: null,
    expires_at: null,
    livemode: false as const,
    max_redemptions: 2,
    metadata: {},
    promotion: { type: 'coupon' as const, coupon: 'C' },
    restrictions: {
      first_time_transaction: false,
      minimum_amount: null,
      minimum_amount_currency: null,
    },
    times_redeemed: 0,
  };

  assert(promotionActive(code, coupon, now));
  assert(!promotionActive({ ...code, enabled: false }, coupon, now));
  assert(!promotionActive({ ...code, times_redeemed: 2 }, coupon, now));
  assert(!promotionActive({ ...code, expires_at: now / 1000 }, coupon, now));
  assert(promotionActive({ ...code, expires_at: now / 1000 + 1 }, coupon, now));
  assert(!promotionActive(code, undefined, now));
  assert(
    !promotionActive(code, { ...coupon, redeem_by: now / 1000 }, now),
  );
  assert(
    !promotionActive(
      code,
      { ...coupon, max_redemptions: 1, times_redeemed: 1 },
      now,
    ),
  );

  const ids = new Set(Array.from({ length: 200 }, () => randomId('cus_', 14)));

  assert(ids.size === 200);
  assert([...ids].every((id) => /^cus_[0-9A-Za-z]{14}$/.test(id)));
});
