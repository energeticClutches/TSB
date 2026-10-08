import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApi } from './apiHarness';
import { type TestDb, createTestDb } from './harness';

let db: TestDb;
let api: ReturnType<typeof makeApi>;
let tableQr: string;
let counterQr: string;
let disabledQr: string;
let items: Record<string, { product_id: string; variant_id: string; ice: string; boba: string }>;

beforeAll(async () => {
  db = await createTestDb();
  await db.pg.exec(readFileSync(join(import.meta.dirname, '..', 'seed', 'demo_menu.sql'), 'utf8'));
  const [t] = await db.admin<{ id: string }>(`insert into public.dining_tables (branch_id, label) values ($1, '04') returning id`, [db.branchId]);
  [{ slug: tableQr }] = (await db.admin<{ slug: string }>(`insert into public.qr_codes (branch_id, kind, table_id) values ($1, 'table', $2) returning slug`, [db.branchId, t!.id])) as [{ slug: string }];
  [{ slug: counterQr }] = (await db.admin<{ slug: string }>(`insert into public.qr_codes (branch_id, kind) values ($1, 'counter') returning slug`, [db.branchId])) as [{ slug: string }];
  [{ slug: disabledQr }] = (await db.admin<{ slug: string }>(`insert into public.qr_codes (branch_id, kind, is_active) values ($1, 'counter', false) returning slug`, [db.branchId])) as [{ slug: string }];
  const rows = await db.admin<{ name: string; product_id: string; variant_id: string }>(
    `select p.name, p.id as product_id, v.id as variant_id from public.products p join public.product_variants v on v.product_id = p.id and v.is_default`,
  );
  const [ice] = await db.admin<{ id: string }>(`select o.id from public.modifier_options o join public.modifier_groups g on g.id = o.group_id where g.name = 'Ice level' and o.is_default`);
  const [sweet] = await db.admin<{ id: string }>(`select o.id from public.modifier_options o join public.modifier_groups g on g.id = o.group_id where g.name = 'Sweetness' and o.is_default`);
  const [boba] = await db.admin<{ id: string }>(`select id from public.modifier_options where name = 'Popping boba'`);
  items = Object.fromEntries(rows.map((r) => [r.name, { ...r, ice: `${ice!.id},${sweet!.id}`, boba: boba!.id }]));
});

beforeEach(() => {
  api = makeApi(db);
});

let mobileSeq = 100;
const nextMobile = () => `98765${String(mobileSeq++).padStart(5, '0')}`;
const slushLine = (qty = 2, extra: string[] = []) => {
  const s = items['Strawberry Splash']!;
  return { line_id: 'l1', product_id: s.product_id, variant_id: s.variant_id, qty, option_ids: [...s.ice.split(','), ...extra] };
};
const checkoutBody = (over: Record<string, unknown> = {}) => ({
  qr_slug: tableQr,
  order_type: 'dine_in',
  lines: [slushLine()],
  customer: { name: 'Aarav', mobile: nextMobile() },
  note: 'Kids at table',
  device_id: crypto.randomUUID(),
  'cf-turnstile-response': 'ok',
  ...over,
});
const doCheckout = (body: Record<string, unknown>, key: string = crypto.randomUUID()) =>
  api.call('POST', '/v1/checkout', { body, headers: { 'Idempotency-Key': key }, ip: crypto.randomUUID() });

describe('QR codes', () => {
  it('resolves table and counter QR codes; refuses unknown and disabled ones', async () => {
    expect((await api.call('GET', `/v1/qr/${tableQr}`)).body).toMatchObject({ kind: 'table', table_label: '04', branch_slug: 'bahadurgarh-s6' });
    expect((await api.call('GET', `/v1/qr/${counterQr}`)).body).toMatchObject({ kind: 'counter', table_label: null });
    expect((await api.call('GET', '/v1/qr/unknownslug')).status).toBe(404);
    expect((await api.call('GET', '/v1/qr/a')).status).toBe(404);
    const disabled = await api.call('GET', `/v1/qr/${disabledQr}`);
    expect(disabled.status).toBe(410);
    expect(disabled.body!.error.code).toBe('QR_DISABLED');
  });
});

describe('quote', () => {
  it('prices the cart on the server and reports whether the shop is open', async () => {
    const r = await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'dine_in', lines: [slushLine(2, [items['Strawberry Splash']!.boba])] } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, total_paise: (14900 + 3000) * 2, ordering_open: true, problems: [] });
    expect(r.body!.quote_hash).toMatch(/^qh_[0-9a-f]{24}$/);
    api.clock.now = new Date('2026-09-21T23:30:00+05:30');
    const closed = await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'dine_in', lines: [slushLine()] } });
    expect(closed.body).toMatchObject({ ordering_open: false });
  });

  it('enforces which order types each QR code allows', async () => {
    expect((await api.call('POST', '/v1/cart/quote', { body: { qr_slug: counterQr, order_type: 'dine_in', lines: [slushLine()] } })).status).toBe(422);
    expect((await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'delivery', lines: [slushLine()] } })).status).toBe(422);
    expect((await api.call('POST', '/v1/cart/quote', { body: { order_type: 'dine_in', lines: [slushLine()] } })).status).toBe(422);
    expect((await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'pickup', lines: [] } })).status).toBe(422);
  });

  it('rejects malformed carts', async () => {
    const bad = await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'dine_in', lines: [{ product_id: 'x' }] } });
    expect(bad.body!.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { line: 0 } });
    expect((await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'dine_in', lines: 'nope' } })).status).toBe(422);
    const tooMany = Array.from({ length: 31 }, () => slushLine());
    expect((await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'dine_in', lines: tooMany } })).status).toBe(422);
  });
});

describe('checkout', () => {
  it('creates a Razorpay order for the SERVER total, never the browser’s', async () => {
    const body = checkoutBody({ lines: [{ ...slushLine(), unit_price_paise: 1, total_paise: 1 }], total_paise: 1 });
    const r = await doCheckout(body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ total_paise: 29800, razorpay: { key_id: 'rzp_test_fake', amount: 29800, currency: 'INR', name: 'The Slush Bar' } });
    expect(r.body!.public_token).toMatch(/^ot_/);
    expect(api.razorpay.orders.get(r.body!.razorpay.order_id)!.amount).toBe(29800);
  });

  it('PY-6/PY-7: retrying with the same key returns the same order; a different cart with that key is refused', async () => {
    const body = checkoutBody();
    const key = crypto.randomUUID();
    const first = await doCheckout(body, key);
    const again = await doCheckout(body, key);
    expect(again.status).toBe(200);
    expect(again.body!.public_token).toBe(first.body!.public_token);
    expect(again.body!.razorpay.order_id).toBe(first.body!.razorpay.order_id);
    expect(api.razorpay.orders.size).toBe(1);
    expect((await doCheckout({ ...body, lines: [slushLine(3)] }, key)).body!.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requires the bot check, a request key, a name and a valid mobile', async () => {
    expect((await doCheckout(checkoutBody({ 'cf-turnstile-response': 'bad' }))).body!.error.code).toBe('BOT_CHECK_FAILED');
    expect((await api.call('POST', '/v1/checkout', { body: checkoutBody() })).body!.error.code).toBe('VALIDATION_FAILED');
    const bad = await doCheckout(checkoutBody({ customer: { name: '', mobile: '12345' } }));
    expect(bad.body!.error.details.fields).toEqual({ name: 'Please enter your name.', mobile: 'Enter a 10-digit Indian mobile number.' });
  });

  it('refuses orders outside business hours', async () => {
    api.clock.now = new Date('2026-09-21T22:50:00+05:30'); // 10 minutes before close, inside the 15-minute buffer
    const r = await doCheckout(checkoutBody());
    expect(r.status).toBe(409);
    expect(r.body!.error.code).toBe('SHOP_CLOSED');
  });

  it('PR-10: a changed price is caught before payment, with the new quote', async () => {
    const quoted = await api.call('POST', '/v1/cart/quote', { body: { qr_slug: tableQr, order_type: 'dine_in', lines: [slushLine()] } });
    await db.admin(`update public.product_variants set price_paise = 15900 where id = $1`, [items['Strawberry Splash']!.variant_id]);
    try {
      const r = await doCheckout(checkoutBody({ quote_hash: quoted.body!.quote_hash }));
      expect(r.status).toBe(409);
      expect(r.body!.error).toMatchObject({ code: 'PRICE_CHANGED', details: { quote: { total_paise: 31800 } } });
      expect(api.razorpay.orders.size).toBe(0);
    } finally {
      await db.admin(`update public.product_variants set price_paise = 14900 where id = $1`, [items['Strawberry Splash']!.variant_id]);
    }
  });

  it('PR-11: sold-out or not-yet-available items can’t be paid for', async () => {
    const kiwi = items['Kiwi Kick']!;
    await db.admin(`update public.products set is_sold_out = true where id = $1`, [kiwi.product_id]);
    const r = await doCheckout(checkoutBody({ lines: [{ line_id: 'k', product_id: kiwi.product_id, variant_id: kiwi.variant_id, qty: 1, option_ids: kiwi.ice.split(',') }] }));
    expect(r.body!.error).toMatchObject({ code: 'ITEM_UNAVAILABLE', message: 'Kiwi Kick can’t be ordered right now.' });
    await db.admin(`update public.products set is_sold_out = false where id = $1`, [kiwi.product_id]);

    const pizza = items['Cheesy Farmhouse Pizza']!; // pizzas start at 4 PM; it's 3 PM
    const p = await doCheckout(checkoutBody({ lines: [{ line_id: 'p', product_id: pizza.product_id, variant_id: pizza.variant_id, qty: 1, option_ids: [] }] }));
    expect(p.body!.error.code).toBe('ITEM_UNAVAILABLE');
    const missingChoice = await doCheckout(checkoutBody({ lines: [{ ...slushLine(), option_ids: [] }] }));
    expect(missingChoice.body!.error.code).toBe('VALIDATION_FAILED');
  });

  it('PY-13: when Razorpay is down, nothing is charged and a retry works once it’s back', async () => {
    const body = checkoutBody();
    const key = crypto.randomUUID();
    api.razorpay.down = true;
    const down = await doCheckout(body, key);
    expect(down.status).toBe(503);
    expect(down.body!.error.code).toBe('PAYMENTS_UNAVAILABLE');
    api.razorpay.down = false;
    const retry = await doCheckout(body, key);
    expect(retry.status).toBe(200);
    expect(retry.body!.razorpay.order_id).toMatch(/^order_T/);
  });

  it('caps paid orders per mobile per day', async () => {
    const mobile = nextMobile();
    await db.admin(`update public.settings set value = '1' where key = 'max_paid_orders_per_mobile_per_day'`);
    try {
      const first = await doCheckout(checkoutBody({ customer: { name: 'A', mobile } }));
      await api.webhook('payment.captured', api.razorpay.pay(first.body!.razorpay.order_id) as unknown as Record<string, unknown>);
      const second = await doCheckout(checkoutBody({ customer: { name: 'A', mobile } }));
      expect(second.body!.error.code).toBe('ORDER_NOT_ALLOWED');
    } finally {
      await db.admin(`update public.settings set value = '10' where key = 'max_paid_orders_per_mobile_per_day'`);
    }
  });

  it('rate-limits checkout per device', async () => {
    const device = crypto.randomUUID();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await doCheckout(checkoutBody({ device_id: device }))).status);
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe('after payment', () => {
  async function paidFlow() {
    const c = await doCheckout(checkoutBody());
    return { token: c.body!.public_token as string, rzp: c.body!.razorpay.order_id as string };
  }

  it('PY-3 / PY-16: "I’ve paid" asks Razorpay directly, so a missing webhook doesn’t lose the order', async () => {
    const { token, rzp } = await paidFlow();
    const before = await api.call('POST', `/v1/orders/${token}/payment-check`, { body: {} });
    expect(before.body).toMatchObject({ payment_status: 'pending', order_status: 'awaiting_payment', order_number: null });
    api.razorpay.pay(rzp);
    const after = await api.call('POST', `/v1/orders/${token}/payment-check`, { body: {} });
    expect(after.body).toMatchObject({ payment_status: 'successful', order_status: 'pending' });
    expect(after.body!.order_number).toMatch(/^SL-/);
  });

  it('a failed UPI attempt leaves the order payable', async () => {
    const { token, rzp } = await paidFlow();
    api.razorpay.pay(rzp, { status: 'failed', error_description: 'Payment declined' });
    const r = await api.call('POST', `/v1/orders/${token}/payment-check`, { body: {} });
    expect(r.body).toMatchObject({ order_status: 'awaiting_payment' });
  });

  it('PY-1 / PY-9 / PY-10: webhooks mark the order paid once; forged ones are refused', async () => {
    const { token, rzp } = await paidFlow();
    const payment = api.razorpay.pay(rzp) as unknown as Record<string, unknown>;
    expect((await api.webhook('payment.captured', payment, { badSignature: true })).status).toBe(400);
    expect((await api.call('GET', `/v1/orders/${token}`)).body!.status).toBe('awaiting_payment');

    const ok = await api.webhook('payment.captured', payment, { eventId: 'evt_same' });
    expect(ok.body).toEqual({ ok: true });
    const replay = await api.webhook('payment.captured', payment, { eventId: 'evt_same' });
    expect(replay.body).toEqual({ ok: true, replay: true });
    const tracker = await api.call('GET', `/v1/orders/${token}`);
    expect(tracker.body).toMatchObject({ status: 'pending', payment_status: 'successful', can_cancel: true, table_label: '04' });
    expect(tracker.headers.get('referrer-policy')).toBe('no-referrer');
    const [p] = await db.admin<{ payer_vpa_masked: string; payer_vpa_hash: string }>(
      'select payer_vpa_masked, payer_vpa_hash from public.payments where provider_payment_id = $1',
      [payment.id],
    );
    expect(p!.payer_vpa_masked).toBe('ra***@okicici');
    expect(p!.payer_vpa_hash).not.toContain('rahul');
  });

  it('PY-8: a second payment is refunded automatically through Razorpay', async () => {
    const { rzp } = await paidFlow();
    await api.webhook('payment.captured', api.razorpay.pay(rzp) as unknown as Record<string, unknown>);
    const second = api.razorpay.pay(rzp);
    await api.webhook('payment.captured', second as unknown as Record<string, unknown>);
    expect(api.razorpay.refunds).toEqual([expect.objectContaining({ payment_id: second.id, amount_paise: second.amount })]);
    const [row] = await db.admin<{ status: string }>(`select r.status from public.refunds r join public.payments p on p.id = r.payment_id where p.provider_payment_id = $1`, [second.id]);
    expect(row!.status).toBe('processing');
  });

  it('FR-21: the customer cancels before acceptance → refund submitted → refund webhook marks it refunded', async () => {
    const { token, rzp } = await paidFlow();
    await api.webhook('payment.captured', api.razorpay.pay(rzp) as unknown as Record<string, unknown>);
    const cancel = await api.call('POST', `/v1/orders/${token}/cancel`, { body: { reason: 'Changed my mind' } });
    expect(cancel.body).toMatchObject({ status: 'cancelled', refund: { status: 'processing', amount_paise: 29800 } });
    const refund = api.razorpay.refunds.at(-1)!;
    await api.webhook('refund.processed', { id: refund.id, payment_id: refund.payment_id, amount: refund.amount_paise, status: 'processed' });
    expect((await api.call('GET', `/v1/orders/${token}`)).body).toMatchObject({ status: 'refunded', payment_status: 'refunded', refund: { status: 'processed' } });
    expect((await api.call('POST', `/v1/orders/${token}/cancel`, { body: {} })).body!.error.code).toBe('INVALID_TRANSITION');
  });

  it('a refund that Razorpay can’t accept right now is kept as failed for retry', async () => {
    const { token, rzp } = await paidFlow();
    await api.webhook('payment.captured', api.razorpay.pay(rzp) as unknown as Record<string, unknown>);
    api.razorpay.down = true;
    const cancel = await api.call('POST', `/v1/orders/${token}/cancel`, { body: {} });
    expect(cancel.body).toMatchObject({ status: 'cancelled', refund: { status: 'failed' } });
  });

  it('unknown tokens and malformed webhooks are rejected', async () => {
    expect((await api.call('GET', '/v1/orders/ot_nope')).status).toBe(404);
    expect((await api.call('GET', `/v1/orders/ot_${'a'.repeat(32)}`)).status).toBe(404);
    expect((await api.call('POST', '/v1/webhooks/razorpay', { raw: 'not json', headers: { 'x-razorpay-signature': 'x' } })).status).toBe(400);
  });
});

describe('find my order', () => {
  it('needs the bot check, matches mobile + number, and is rate limited', async () => {
    const mobile = nextMobile();
    const c = await doCheckout(checkoutBody({ customer: { name: 'Riya', mobile } }));
    await api.webhook('payment.captured', api.razorpay.pay(c.body!.razorpay.order_id) as unknown as Record<string, unknown>);
    const number = (await api.call('GET', `/v1/orders/${c.body!.public_token}`)).body!.order_number as string;
    const ip = crypto.randomUUID();
    const find = (body: Record<string, unknown>) => api.call('POST', '/v1/orders/find', { body: { 'cf-turnstile-response': 'ok', ...body }, ip });

    expect((await api.call('POST', '/v1/orders/find', { body: { mobile, order_number: number }, ip })).body!.error.code).toBe('BOT_CHECK_FAILED');
    expect((await find({ mobile, order_number: number.toLowerCase() })).body).toEqual({ public_token: c.body!.public_token });
    expect((await find({ mobile: nextMobile(), order_number: number })).status).toBe(404);
    expect((await find({ mobile, order_number: 'nonsense' })).status).toBe(404);
    expect((await find({ mobile, order_number: number })).status).toBe(200); // 5th lookup in 15 min: still allowed
    expect((await find({ mobile, order_number: number })).status).toBe(429); // 6th: blocked
  });
});

describe('scheduled jobs', () => {
  it('expires unpaid checkouts only with the job secret', async () => {
    expect((await api.call('POST', '/v1/jobs/expire-payments', { headers: { 'x-job-secret': 'wrong' } })).status).toBe(403);
    const ok = await api.call('POST', '/v1/jobs/expire-payments', { headers: { 'x-job-secret': 'job-secret' } });
    expect(ok.status).toBe(200);
    expect(typeof ok.body!.expired).toBe('number');
  });
});
