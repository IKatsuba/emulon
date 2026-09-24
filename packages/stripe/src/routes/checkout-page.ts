import type { Hono } from 'hono';
import type { PluginContext } from 'emulon';
import { StripeError } from '../errors.ts';
import { find, randomId, type Transaction } from '../model/core.ts';
import {
  type CheckoutSession,
  completeSession,
  getSession,
  type LineItem,
  lineItems,
} from '../model/checkout.ts';
import type { Customer } from '../model/customers.ts';

const tokens = 'checkout_page_tokens';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/** Stripe substitutes the session ID into success URLs that ask for it. */
export function successRedirect(session: CheckoutSession): string {
  return session.success_url.replaceAll('{CHECKOUT_SESSION_ID}', session.id);
}

async function token(tx: Transaction, id: string): Promise<string> {
  const existing = await tx.get(tokens, id);

  if (typeof existing === 'string') {
    return existing;
  }

  const value = randomId('', 32);

  await tx.put({ collection: tokens, id, value });

  return value;
}

function page(
  session: CheckoutSession,
  items: LineItem[],
  formToken: string | undefined,
  needsEmail: boolean,
  error?: string,
): string {
  const lines = items.map((item) =>
    `<tr><td>${
      escape(item.description || item.price.product)
    } × ${item.quantity}</td><td>${
      money(item.amount_subtotal, item.currency)
    }</td></tr>`
  ).join('');
  const open = session.status === 'open' && formToken !== undefined;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local Stripe Checkout</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
table{width:100%;border-collapse:collapse}td{padding:.4rem 0}td:last-child{text-align:right}
label{display:block;margin:.75rem 0 .25rem}input{width:100%;padding:.5rem;box-sizing:border-box}
.actions{display:flex;gap:.5rem;margin-top:1rem}button{flex:1;padding:.6rem}
.error{color:#b00020}.note{color:#555;font-size:.85rem}</style></head>
<body><h1>Local Stripe Checkout</h1>
<p class="note">Emulated by emulon. No card is charged.</p>
<table>${lines}
<tr><td>Discount</td><td>−${
    money(session.amount_discount, session.currency)
  }</td></tr>
<tr><th align="left">Total</th><th align="right">${
    money(session.amount_total, session.currency)
  }</th></tr></table>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
${
    open
      ? `<form method="post">
<input type="hidden" name="token" value="${escape(formToken)}">
${
        needsEmail
          ? '<label for="email">Email</label><input id="email" name="email" type="email" required>'
          : ''
      }
<label for="name">Name on card</label><input id="name" name="name">
${
        session.allow_promotion_codes
          ? '<label for="code">Promotion code</label><input id="code" name="promotion_code">'
          : ''
      }
<div class="actions"><button name="action" value="pay" type="submit">Pay</button>
<button name="action" value="cancel" type="submit">Cancel</button></div></form>`
      : `<p>This Checkout Session is ${escape(session.status)}.</p>`
  }
</body></html>`;
}

async function view(
  tx: Transaction,
  id: string,
  now: number,
  version: string,
) {
  const session = await getSession(tx, id, now, version);
  const items = await lineItems(tx, id);
  const customer = session.customer
    ? await find<Customer>(tx, 'customer', session.customer)
    : undefined;
  const needsEmail = session.customer_email === null && !customer?.email;

  return {
    session,
    items,
    needsEmail,
    formToken: session.status === 'open' ? await token(tx, id) : undefined,
  };
}

/**
 * The hosted payment page a Checkout Session's `url` points to. It is not an
 * API request, so the events it causes are viewed in the account default.
 */
export function checkoutPage(
  ctx: PluginContext,
  web: Hono,
  version: string,
) {
  web.get('/c/pay/:id', async (c) => {
    try {
      const state = await ctx.store.scope().transaction((tx) =>
        view(tx, c.req.param('id'), ctx.clock.now(), version)
      );

      return c.html(
        page(state.session, state.items, state.formToken, state.needsEmail),
      );
    } catch (error) {
      if (error instanceof StripeError && error.status === 404) {
        return c.html('<!doctype html><p>Unknown Checkout Session.</p>', 404);
      }

      throw error;
    }
  });

  web.post('/c/pay/:id', async (c) => {
    const id = c.req.param('id');
    const form = await c.req.parseBody();
    const text = (key: string) =>
      typeof form[key] === 'string' && form[key] !== ''
        ? form[key] as string
        : undefined;
    const store = ctx.store.scope();

    try {
      const result = await store.transaction(async (tx) => {
        const expected = await tx.get(tokens, id);

        if (typeof expected !== 'string' || expected !== text('token')) {
          throw new StripeError(
            403,
            'invalid_request_error',
            'This payment form has expired. Reload the page and try again.',
          );
        }

        const now = ctx.clock.now();

        if (text('action') === 'cancel') {
          return {
            redirect: (await getSession(tx, id, now, version)).cancel_url,
          };
        }

        const session = await completeSession(
          tx,
          {
            id,
            email: text('email'),
            name: text('name'),
            promotionCode: text('promotion_code'),
          },
          now,
          version,
        );

        await tx.delete(tokens, id);

        return { redirect: successRedirect(session) };
      });

      return result.redirect
        ? c.redirect(result.redirect, 303)
        : c.redirect(`/c/pay/${encodeURIComponent(id)}`, 303);
    } catch (error) {
      if (!(error instanceof StripeError)) {
        throw error;
      }

      const state = await store.transaction((tx) =>
        view(tx, id, ctx.clock.now(), version)
      ).catch(() => undefined);

      if (state === undefined) {
        return c.html('<!doctype html><p>Unknown Checkout Session.</p>', 404);
      }

      return c.html(
        page(
          state.session,
          state.items,
          state.formToken,
          state.needsEmail,
          error.message,
        ),
        error.status === 403 ? 403 : 400,
      );
    }
  });
}
