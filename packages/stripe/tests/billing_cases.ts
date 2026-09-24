// Stripe API fields are snake_case on the wire.
// deno-lint-ignore-file camelcase
import type Stripe from 'stripe';
import stripe from '@emulon/stripe';
import { definePlugin, Emulon, type PluginContext } from 'emulon';
import { readRegistration } from '../../emulon/src/plugins/define.ts';
import { serveEnvironment } from '../../emulon/src/control/server.ts';
import { runProjectCLI } from '../../emulon/src/cli/project.ts';
import { caseRegistry } from '../../emulon/tests/helpers/compatibility.ts';
import {
  client,
  dahliaFlavor,
  type dahliaVersion,
  type Flavor,
} from './flavors.ts';

export const { cases, register } = caseRegistry(
  'packages/stripe/tests/billing_cases.ts',
);

type Register = typeof register;
type StripeFailure = InstanceType<typeof Stripe.errors.StripeError>;

function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

export function billingCases(flavor: Flavor, register: Register) {
  const { version } = flavor;

  async function rejects(
    action: () => Promise<unknown>,
    check: (error: StripeFailure) => boolean = () => true,
  ) {
    try {
      await action();
    } catch (error) {
      assert(
        error instanceof flavor.Stripe.errors.StripeError && check(error),
        `Unexpected error: ${error}`,
      );

      return error;
    }

    throw new Error('Expected a Stripe error');
  }

  function invalid(param?: string) {
    return (error: StripeFailure) =>
      error instanceof flavor.Stripe.errors.StripeInvalidRequestError &&
      (param === undefined || error.param === param);
  }

  /** A plugin whose HTTP handlers read a controllable clock. */
  function timed(start = Date.now()) {
    const clock = { now: start };
    const { definition } = readRegistration(stripe());
    const plugin = definePlugin({
      ...definition,
      setup(ctx: PluginContext, options) {
        return definition.setup(
          { ...ctx, clock: { now: () => clock.now } },
          options,
        );
      },
    });

    return { plugin, clock };
  }

  async function started(
    options: Parameters<typeof stripe>[0] = {},
    start?: number,
  ) {
    const { plugin, clock } = timed(start);
    const env = await Emulon.start({
      services: { stripe: plugin({ ...flavor.options, ...options }) },
    });
    const { apiKey } = await env.services.stripe.keys.create({});

    return {
      env,
      clock,
      sdk: client(flavor, env.endpoints.stripe.api!, apiKey),
      [Symbol.asyncDispose]: () => env[Symbol.asyncDispose](),
    };
  }

  async function catalog(sdk: Stripe, amount = 12900) {
    const product = await sdk.products.create({
      id: 'prod_course',
      name: 'Course',
      tax_code: 'txcd_10103001',
      metadata: { productId: 'course' },
    });
    const price = await sdk.prices.create({
      product: product.id,
      unit_amount: amount,
      currency: 'USD',
      lookup_key: 'course',
    });

    return { product, price };
  }

  register(
    `${flavor.prefix}.catalog.1`,
    [
      'products.create',
      'products.get',
      'products.update',
      'products.list',
      'prices.create',
      'prices.get',
      'prices.update',
      'prices.list',
    ],
    [],
    false,
    'products with caller IDs and tax codes, prices with transferable lookup keys',
    async () => {
      await using s = await started();
      const { sdk } = s;

      await rejects(
        () => sdk.products.retrieve('prod_course'),
        (e) => e.code === 'resource_missing' && e.statusCode === 404,
      );

      const { product, price } = await catalog(sdk);

      assert(product.id === 'prod_course' && product.active);
      assert(
        product.tax_code === 'txcd_10103001' && product.type === 'service',
      );
      assert(product.metadata.productId === 'course' && !product.livemode);
      assert(price.currency === 'usd' && price.type === 'one_time');
      assert(
        price.unit_amount === 12900 &&
          String(price.unit_amount_decimal) === '12900',
      );
      await rejects(
        () => sdk.products.create({ id: product.id, name: 'Again' }),
        (e) => e.code === 'resource_already_exists',
      );
      await rejects(
        () => sdk.products.create({ name: 'X', tax_code: 'bad' }),
        invalid('tax_code'),
      );
      await rejects(
        () => sdk.products.create({ name: 'X', unknown_field: 1 } as never),
        (e) => e.code === 'parameter_unknown' && e.param === 'unknown_field',
      );

      const updated = await sdk.products.update(product.id, {
        name: 'Course v2',
        active: false,
        metadata: { productId: 'course', extra: 'x' },
      });

      assert(updated.name === 'Course v2' && !updated.active);
      assert(updated.metadata.extra === 'x');
      assert(
        (await sdk.products.update(product.id, { metadata: { extra: '' } }))
          .metadata.extra === undefined,
      );
      assert((await sdk.products.retrieve(product.id)).name === 'Course v2');
      await sdk.products.update(product.id, { active: true, tax_code: '' });
      assert((await sdk.products.retrieve(product.id)).tax_code === null);

      const other = await sdk.products.create({ name: 'Other', active: false });

      assert(/^prod_[A-Za-z0-9]{14}$/.test(other.id));
      assert(
        (await sdk.products.list({ active: true })).data.map((p) => p.id)
          .join() === product.id,
      );
      assert((await sdk.products.list({ limit: 1 })).has_more);

      await rejects(
        () =>
          sdk.prices.create({
            product: product.id,
            unit_amount: 1,
            currency: 'usd',
            lookup_key: 'course',
          }),
        invalid('lookup_key'),
      );

      const next = await sdk.prices.create({
        product: product.id,
        unit_amount: 9900,
        currency: 'usd',
        lookup_key: 'course',
        transfer_lookup_key: true,
        metadata: { productId: 'course' },
      });

      assert((await sdk.prices.retrieve(price.id)).lookup_key === null);
      assert(
        (await sdk.prices.list({
          lookup_keys: ['course'],
          active: true,
          limit: 1,
        })).data[0]!.id === next.id,
      );

      const retired = await sdk.prices.update(price.id, { active: false });

      assert(!retired.active);
      assert(
        (await sdk.prices.list({ product: product.id, active: false })).data
          .length === 1,
      );
      assert(
        (await sdk.prices.list({ lookup_keys: ['missing'] })).data.length === 0,
      );
      await rejects(
        () =>
          sdk.prices.create({
            product: 'prod_none',
            unit_amount: 1,
            currency: 'usd',
          }),
        (e) => e.code === 'resource_missing' && e.param === 'product',
      );
      await rejects(
        () =>
          sdk.prices.create({
            product: product.id,
            unit_amount: 1,
            currency: 'usd',
            recurring: { interval: 'month' },
          }),
        invalid('recurring'),
      );
      await rejects(
        () => sdk.prices.create({ product: product.id, currency: 'usd' }),
        (e) => e.code === 'parameter_missing',
      );
      await rejects(
        () => sdk.prices.list({ lookup_keys: Array(11).fill('k') }),
        invalid('lookup_keys'),
      );
    },
  );

  register(
    `${flavor.prefix}.discounts.1`,
    [
      'coupons.create',
      'coupons.get',
      'coupons.delete',
      'promotion_codes.create',
      'promotion_codes.get',
      'promotion_codes.update',
      'promotion_codes.list',
    ],
    [],
    false,
    'coupons scoped to products and promotion codes with expiry, limits and expansion',
    async () => {
      await using s = await started();
      const { sdk, clock } = s;
      const { product } = await catalog(sdk);
      const coupon = await sdk.coupons.create({
        percent_off: 25,
        duration: 'once',
        applies_to: { products: [product.id] },
        metadata: { productId: 'course' },
      });

      assert(
        coupon.percent_off === 25 && coupon.valid && coupon.amount_off === null,
      );
      assert((await sdk.coupons.retrieve(coupon.id)).times_redeemed === 0);
      await rejects(
        () => sdk.coupons.create({ percent_off: 10, amount_off: 100 }),
        invalid(),
      );
      await rejects(
        () => sdk.coupons.create({ amount_off: 100 }),
        invalid('currency'),
      );
      await rejects(() => sdk.coupons.create({ percent_off: 101 }), invalid());
      await rejects(
        () =>
          sdk.coupons.create({
            percent_off: 10,
            applies_to: { products: ['prod_none'] },
          }),
        (e) => e.code === 'resource_missing',
      );

      const fixed = await sdk.coupons.create({
        amount_off: 500,
        currency: 'USD',
      });

      assert(fixed.currency === 'usd' && fixed.amount_off === 500);

      const expiresAt = Math.floor(clock.now / 1000) + 3600;
      const code = await flavor.createPromotionCode(sdk, coupon.id, {
        code: 'LAUNCH99',
        max_redemptions: 2,
        expires_at: expiresAt,
        expand: flavor.expandCoupon,
      });
      const expanded = flavor.couponOf(code) as Stripe.Coupon;

      assert(
        code.active && code.code === 'LAUNCH99' && code.times_redeemed === 0,
      );
      assert(expanded.id === coupon.id && expanded.percent_off === 25);
      assert(code.expires_at === expiresAt && code.max_redemptions === 2);

      // Unexpanded, dahlia names the coupon; basil always embeds it.
      const plain = flavor.couponOf(await sdk.promotionCodes.retrieve(code.id));

      assert(
        flavor.expandCoupon.length
          ? plain === coupon.id
          : (plain as Stripe.Coupon).id === coupon.id,
      );
      await rejects(
        () =>
          flavor.createPromotionCode(sdk, fixed.id, {
            code: 'launch99',
          }),
        invalid('code'),
      );
      await rejects(
        () =>
          flavor.createPromotionCode(sdk, coupon.id, {
            expires_at: Math.floor(clock.now / 1000) - 1,
          }),
        invalid('expires_at'),
      );
      await rejects(
        () => flavor.createPromotionCode(sdk, 'NOPE'),
        (e) => e.code === 'resource_missing' && e.param === flavor.couponParam,
      );

      const generated = await flavor.createPromotionCode(sdk, fixed.id);

      assert(/^[A-Z0-9]{8}$/.test(generated.code));

      const listed = await sdk.promotionCodes.list({
        limit: 100,
        expand: flavor.expandCoupon.map((path) => `data.${path}`),
      });

      assert(listed.data.length === 2);
      assert(
        listed.data.every((p) => typeof flavor.couponOf(p) === 'object'),
      );
      assert(
        (await sdk.promotionCodes.list({
          code: 'launch99',
          active: true,
          limit: 1,
        }))
          .data[0]!.id === code.id,
      );
      await rejects(
        () => sdk.promotionCodes.list({ expand: ['data.nothing'] }),
        invalid('expand'),
      );

      const off = await sdk.promotionCodes.update(code.id, {
        active: false,
        expand: flavor.expandCoupon,
      });

      assert(!off.active && typeof flavor.couponOf(off) === 'object');
      assert(
        (await sdk.promotionCodes.list({ code: 'LAUNCH99', active: true })).data
          .length === 0,
      );
      assert(
        (await sdk.promotionCodes.update(code.id, { active: true })).active,
      );

      // Expiry is derived from the clock, not stored as a flag.
      clock.now += 3600 * 1000;

      assert(!(await sdk.promotionCodes.retrieve(code.id)).active);

      const deleted = await sdk.coupons.del(fixed.id);

      assert(deleted.deleted && deleted.id === fixed.id);
      await rejects(
        () => sdk.coupons.retrieve(fixed.id),
        (e) => e.statusCode === 404,
      );
      assert(!(await sdk.promotionCodes.retrieve(generated.id)).active);
    },
  );

  async function hostedPay(
    url: string,
    fields: Record<string, string> = {},
  ) {
    const page = await fetch(url);
    const html = await page.text();
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1];

    assert(page.status === 200 && token, 'Hosted page without a form');

    return await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ token, action: 'pay', ...fields }),
    });
  }

  register(
    `${flavor.prefix}.checkout.1`,
    [
      'checkout.sessions.create',
      'checkout.sessions.get',
      'checkout.sessions.list',
      'checkout.sessions.line_items',
      'checkout.sessions.expire',
      'checkout.page.get',
      'checkout.page.pay',
      'payment_intents.get',
      'charges.get',
    ],
    ['checkout.session.completed', 'checkout.session.expired'],
    false,
    'hosted Checkout with discounts, buyer payment, expiry and payment objects',
    async () => {
      await using s = await started();
      const { sdk, clock, env } = s;
      const { price } = await catalog(sdk);
      const coupon = await sdk.coupons.create({ percent_off: 25 });
      const code = await flavor.createPromotionCode(sdk, coupon.id, {
        code: 'LAUNCH99',
        max_redemptions: 1,
      });
      const base = {
        mode: 'payment' as const,
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: 'http://localhost:3000/ok?session={CHECKOUT_SESSION_ID}',
        cancel_url: 'http://localhost:3000/cancel',
      };
      const session = await sdk.checkout.sessions.create({
        ...base,
        ...(flavor.managedPayments
          ? { managed_payments: { enabled: true } }
          : {}),
        customer_email: 'ada@example.test',
        client_reference_id: 'user_1',
        discounts: [{ promotion_code: code.id }],
        metadata: { productId: 'course', userId: 'user_1' },
      } as Stripe.Checkout.SessionCreateParams);

      assert(session.id.startsWith('cs_test_') && session.status === 'open');
      assert(session.url === `${env.endpoints.stripe.web}/c/pay/${session.id}`);
      assert(
        session.amount_subtotal === 12900 && session.amount_total === 9675,
      );
      assert(session.total_details?.amount_discount === 3225);
      assert(session.expires_at - session.created === 86400);
      assert(
        session.payment_intent === null && session.payment_status === 'unpaid',
      );
      assert(session.discounts?.[0]?.promotion_code === code.id);

      const items = await sdk.checkout.sessions.listLineItems(session.id);

      assert(items.data.length === 1 && items.data[0]!.amount_total === 9675);

      for (
        const [params, param] of [
          [{ ...base, customer: 'cus_none' }, 'customer'],
          [
            { ...base, customer_email: 'a@x.test', customer: 'cus_none' },
            'customer_email',
          ],
          [{
            ...base,
            allow_promotion_codes: true,
            discounts: [{ coupon: coupon.id }],
          }, 'allow_promotion_codes'],
          [{ ...base, mode: 'subscription' }, 'mode'],
          [
            { ...base, line_items: [{ price: price.id }] },
            'line_items[0][quantity]',
          ],
          [
            { ...base, line_items: [{ price: 'price_none', quantity: 1 }] },
            'line_items[0][price]',
          ],
          [
            { ...base, discounts: [{ promotion_code: 'promo_none' }] },
            'discounts[0][promotion_code]',
          ],
          [{ ...base, success_url: 'not a url' }, 'success_url'],
        ] as const
      ) {
        await rejects(
          () => sdk.checkout.sessions.create(params as never),
          (e) => e.param === param,
        );
      }

      // The buyer pays on the hosted page.
      const paid = await hostedPay(session.url!, { name: 'Ada' });

      assert(paid.status === 303);
      assert(
        paid.headers.get('location') ===
          `http://localhost:3000/ok?session=${session.id}`,
      );

      const complete = await sdk.checkout.sessions.retrieve(session.id);

      assert(
        complete.status === 'complete' && complete.payment_status === 'paid',
      );
      assert(
        complete.url === null &&
          complete.customer_details?.email === 'ada@example.test',
      );
      assert(typeof complete.payment_intent === 'string');

      const intent = await sdk.paymentIntents.retrieve(complete.payment_intent);

      assert(intent.status === 'succeeded' && intent.amount === 9675);
      assert(typeof intent.latest_charge === 'string');

      const charge = await sdk.charges.retrieve(intent.latest_charge);

      assert(charge.paid && charge.amount === 9675 && !charge.refunded);
      assert(charge.billing_details.name === 'Ada');
      assert(
        (await sdk.checkout.sessions.list({
          payment_intent: intent.id,
          limit: 1,
        })).data[0]!.id === session.id,
      );
      assert(
        (await sdk.checkout.sessions.retrieve(session.id, {
          expand: ['payment_intent'],
        })).payment_intent !== null,
      );
      assert((await sdk.promotionCodes.retrieve(code.id)).times_redeemed === 1);
      assert(!(await sdk.promotionCodes.retrieve(code.id)).active);
      await rejects(
        () => sdk.checkout.sessions.expire(session.id),
        invalid('session'),
      );

      // The used-up code can no longer be pre-applied, but the buyer can type
      // another one; free totals need no payment.
      await rejects(
        () =>
          sdk.checkout.sessions.create({
            ...base,
            discounts: [{ promotion_code: code.id }],
          }),
        invalid('discounts[0][promotion_code]'),
      );

      const full = await sdk.coupons.create({ percent_off: 100 });

      await flavor.createPromotionCode(sdk, full.id, {
        code: 'FREE',
      });

      const typed = await sdk.checkout.sessions.create({
        ...base,
        allow_promotion_codes: true,
      });
      const typedPage = await (await fetch(typed.url!)).text();

      assert(
        typedPage.includes('name="promotion_code"') &&
          typedPage.includes('name="email"'),
      );

      const refused = await hostedPay(typed.url!, {
        email: 'b@example.test',
        promotion_code: 'NOPE',
      });

      assert(
        refused.status === 400 && (await refused.text()).includes('not active'),
      );

      const free = await env.services.stripe.checkout.sessions.complete({
        id: typed.id,
        email: 'b@example.test',
        promotionCode: 'free',
      });

      assert(
        free.amount_total === 0 &&
          free.payment_status === 'no_payment_required',
      );
      assert(free.payment_intent === null);

      // Cancel returns to cancel_url and leaves the session open.
      const cancelled = await sdk.checkout.sessions.create({
        ...base,
        customer_email: 'c@example.test',
      });
      const cancelPage = await (await fetch(cancelled.url!)).text();
      const cancelToken = /name="token" value="([^"]+)"/.exec(cancelPage)![1]!;
      const back = await fetch(cancelled.url!, {
        method: 'POST',
        redirect: 'manual',
        body: new URLSearchParams({ token: cancelToken, action: 'cancel' }),
      });

      assert(back.headers.get('location') === 'http://localhost:3000/cancel');
      assert(
        (await sdk.checkout.sessions.retrieve(cancelled.id)).status === 'open',
      );

      const forged = await fetch(cancelled.url!, {
        method: 'POST',
        body: new URLSearchParams({ token: 'forged', action: 'pay' }),
      });

      assert(forged.status === 403);
      await forged.text();

      const expired = await sdk.checkout.sessions.expire(cancelled.id);

      assert(expired.status === 'expired' && expired.url === null);

      // Sessions lapse on their own after expires_at.
      const lapsing = await sdk.checkout.sessions.create({
        ...base,
        customer_email: 'd@example.test',
      });

      clock.now += 86400 * 1000;

      assert(
        (await sdk.checkout.sessions.retrieve(lapsing.id)).status === 'expired',
      );
      assert(
        (await fetch(lapsing.url!).then((r) => r.text())).includes(
          'is expired',
        ),
      );

      const refusal = await env.services.stripe.checkout.sessions.complete({
        id: lapsing.id,
      }).then(() => undefined, (error: Error) => error);

      assert(refusal?.message.includes('expired'), String(refusal));

      const types = (await env.events.list({})).map((event) => event.type);

      assert(
        types.filter((t) => t === 'checkout.session.completed').length === 2,
      );
      assert(
        types.filter((t) => t === 'checkout.session.expired').length === 2,
      );
      await rejects(
        () => sdk.paymentIntents.retrieve('pi_none'),
        (e) => e.statusCode === 404,
      );
      await rejects(
        () => sdk.charges.retrieve('ch_none'),
        (e) => e.statusCode === 404,
      );
    },
  );

  register(
    `${flavor.prefix}.payments.1`,
    ['refunds.create', 'refunds.get', 'disputes.get'],
    ['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'],
    false,
    'partial and full refunds, dashboard refunds and bank disputes through CLI and SDK',
    async () => {
      const directory = await Deno.makeTempDir();
      const config = { services: { stripe: stripe(flavor.options) } };
      const host = await serveEnvironment(config, { directory });

      try {
        await using env = await Emulon.connect({ config, directory });
        const sdk = client(
          flavor,
          env.endpoints.stripe.api!,
          (await env.services.stripe.keys.create({})).apiKey,
        );
        const cli = async (...args: string[]) => {
          const result = await runProjectCLI(
            ['stripe', ...args, '--json'],
            undefined,
            directory,
          );

          return {
            code: result.code,
            value: result.code === 0 ? JSON.parse(result.stdout) : undefined,
          };
        };

        const { price } = await catalog(sdk, 5000);
        const pay = async (email: string) => {
          const session = await sdk.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price: price.id, quantity: 2 }],
            customer_email: email,
            success_url: 'http://localhost:3000/ok',
          });
          const done = await cli(
            'checkout',
            'sessions',
            'complete',
            session.id,
          );

          assert(done.code === 0 && done.value.status === 'complete');

          const intent = await sdk.paymentIntents.retrieve(
            done.value.payment_intent,
          );

          return { intent, charge: intent.latest_charge as string };
        };

        const first = await pay('a@example.test');
        const partial = await sdk.refunds.create({
          payment_intent: first.intent.id,
          amount: 4000,
          reason: 'requested_by_customer',
        });

        assert(partial.amount === 4000 && partial.status === 'succeeded');
        assert(partial.charge === first.charge);
        assert(
          (await sdk.refunds.retrieve(partial.id)).reason ===
            'requested_by_customer',
        );

        let charge = await sdk.charges.retrieve(first.charge);

        assert(charge.amount_refunded === 4000 && !charge.refunded);
        await rejects(
          () => sdk.refunds.create({ charge: first.charge, amount: 7000 }),
          (e) => e.code === 'amount_too_large',
        );

        const rest = await sdk.refunds.create({ charge: first.charge });

        assert(rest.amount === 6000);

        charge = await sdk.charges.retrieve(first.charge);

        assert(charge.refunded && charge.amount_refunded === 10000);
        await rejects(
          () => sdk.refunds.create({ charge: first.charge }),
          (e) => e.code === 'charge_already_refunded',
        );
        await rejects(
          () =>
            sdk.refunds.create({
              charge: first.charge,
              payment_intent: first.intent.id,
            }),
          invalid('charge'),
        );

        // Dashboard refunds and bank disputes go through the control plane.
        const second = await pay('b@example.test');
        const refunded = await env.services.stripe.refunds.create({
          charge: second.charge,
          amount: 100,
        });

        assert(refunded.amount === 100);

        const opened = await cli(
          'disputes',
          'create',
          '--charge',
          second.charge,
          '--reason',
          'product_not_received',
        );

        assert(opened.code === 0 && opened.value.status === 'needs_response');
        assert(opened.value.reason === 'product_not_received');

        const dispute = await sdk.disputes.retrieve(opened.value.id);

        assert(dispute.charge === second.charge && dispute.amount === 10000);
        assert((await sdk.charges.retrieve(second.charge)).disputed);
        assert(
          (await cli('disputes', 'create', '--charge', second.charge)).code !==
            0,
        );

        const closed = await cli(
          'disputes',
          'close',
          opened.value.id,
          '--status',
          'lost',
        );

        assert(closed.code === 0 && closed.value.status === 'lost');
        assert(
          (await cli('disputes', 'close', opened.value.id, '--status', 'won'))
            .code !== 0,
        );

        const sessionId = (await sdk.checkout.sessions.list({
          payment_intent: second.intent.id,
        })).data[0]!.id;

        assert(
          (await cli('checkout', 'sessions', 'get', sessionId)).value
            .payment_intent === second.intent.id,
        );
        assert(
          (await cli('charges', 'get', second.charge)).value.amount_refunded ===
            100,
        );

        const events = await env.events.list({});
        const refundedEvents = events.filter((e) =>
          e.type === 'charge.refunded'
        );

        assert(refundedEvents.length === 3);

        const last = refundedEvents.at(-1)!.payload as Stripe.Event;

        assert(
          last.api_version === version &&
            (last.data.object as Stripe.Charge).amount_refunded === 100,
        );
        assert(
          (last.data.previous_attributes as { amount_refunded: number })
            .amount_refunded === 0,
        );
        assert(events.some((e) => e.type === 'charge.dispute.created'));
        assert(
          ((events.find((e) => e.type === 'charge.dispute.closed')!
            .payload as Stripe.Event).data.object as Stripe.Dispute).status ===
            'lost',
        );
        await rejects(
          () => sdk.disputes.retrieve('dp_none'),
          (e) => e.statusCode === 404,
        );
      } finally {
        await host[Symbol.asyncDispose]();
        await Deno.remove(directory, { recursive: true });
      }
    },
  );

  register(
    `${flavor.prefix}.webhooks.3`,
    [],
    [],
    true,
    'checkout, refund and dispute events arrive signed and verify with the official client',
    async () => {
      const secret = 'whsec_billing_£';
      const received: Stripe.Event[] = [];
      const verifier = new flavor.Stripe('sk_test_unused', {
        apiVersion: version as typeof dahliaVersion,
      });
      const server = Deno.serve(
        { hostname: '127.0.0.1', port: 0, onListen() {} },
        async (request) => {
          received.push(
            await verifier.webhooks.constructEventAsync(
              await request.text(),
              request.headers.get('stripe-signature')!,
              secret,
              undefined,
              flavor.Stripe.createSubtleCryptoProvider(),
            ),
          );

          return new Response(null, { status: 204 });
        },
      );

      try {
        await using s = await started({
          destinations: [{
            id: 'app',
            url: `http://127.0.0.1:${server.addr.port}/webhooks/stripe`,
            secret,
            types: [
              'checkout.session.completed',
              'charge.refunded',
              'charge.dispute.created',
              'charge.dispute.closed',
            ],
            enabled: true,
          }],
        });
        const { sdk, env } = s;
        const { price } = await catalog(sdk);
        const session = await sdk.checkout.sessions.create({
          mode: 'payment',
          line_items: [{ price: price.id, quantity: 1 }],
          customer_email: 'ada@example.test',
          metadata: { productId: 'course' },
          success_url: 'http://localhost:3000/ok',
        });
        const done = await env.services.stripe.checkout.sessions.complete({
          id: session.id,
        });
        const intent = await sdk.paymentIntents.retrieve(
          done.payment_intent as string,
        );

        await sdk.refunds.create({ payment_intent: intent.id });

        const dispute = await env.services.stripe.disputes.create({
          charge: intent.latest_charge as string,
        });

        await env.services.stripe.disputes.close({
          id: dispute.id,
          status: 'won',
        });

        for (const delivery of await env.services.stripe.webhooks.list({})) {
          await env.services.stripe.webhooks.wait({
            id: delivery.id,
            status: 'succeeded',
            timeout: '10s',
          });
        }

        assert(
          received.map((e) => e.type).join() ===
            'checkout.session.completed,charge.refunded,charge.dispute.created,charge.dispute.closed',
        );

        const completed = received[0]!.data.object as Stripe.Checkout.Session;

        assert(
          completed.id === session.id &&
            completed.metadata?.productId === 'course',
        );
        assert(
          completed.payment_intent === intent.id &&
            completed.amount_total === 12900,
        );
        assert(
          received.every((e) =>
            e.api_version === version && e.livemode === false
          ),
        );
        assert(
          ((received[3]!.data.object) as Stripe.Dispute).status === 'won',
        );
      } finally {
        await server.shutdown();
      }
    },
  );
}

billingCases(dahliaFlavor, register);
