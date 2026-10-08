import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Claims, type TestDb, apiError, createTestDb, makeOwner, pinSession } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let cashier: Claims;
let kitchen: Claims;
let straw: { product_id: string; variant_id: string };

beforeAll(async () => {
  db = await createTestDb();
  await db.pg.exec(readFileSync(join(import.meta.dirname, '..', 'seed', 'demo_menu.sql'), 'utf8'));
  owner = await makeOwner(db);
  const mk = async (name: string, role: 'cashier' | 'kitchen', pin: string) => {
    const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), 'select public.create_pin_staff($1, $2::public.staff_role, $3) as id', [name, role, pin])) as [{ id: string }];
    return (await pinSession(db, owner.claims(), { staffId: id, pin, role })).claims;
  };
  cashier = await mk('Karan', 'cashier', '6173');
  kitchen = await mk('Neha', 'kitchen', '3906');
  const [row] = await db.admin<{ product_id: string; variant_id: string }>(
    `select p.id as product_id, v.id as variant_id from public.products p join public.product_variants v on v.product_id = p.id
     where p.name = 'Strawberry Splash' and v.is_default`,
  );
  straw = row!;
});

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.as<T>('service_role', {}, sql, params);

let seq = 0;
async function newOrder(over: Record<string, unknown> = {}) {
  seq += 1;
  const payload = {
    branch_id: db.branchId,
    idempotency_key: `idem-${seq}-${crypto.randomUUID()}`,
    request_hash: 'h1',
    order_type: 'takeaway',
    customer_name: 'Aarav',
    customer_mobile: '+919812345678',
    note: 'Kids at table',
    subtotal_paise: 29800,
    promo_discount_paise: 0,
    order_discount_paise: 0,
    delivery_fee_paise: 0,
    tax_paise: 0,
    loyalty_eligible_paise: 29800,
    eta_minutes: 6,
    lines: [
      {
        ...straw,
        product_name: 'Strawberry Splash',
        variant_name: 'Regular 350 ml',
        unit_price_paise: 14900,
        promo_discount_paise: 0,
        qty: 2,
        line_total_paise: 29800,
        prep_minutes: 4,
        options: [{ id: null, group: 'Ice level', name: 'Standard freeze', price_paise: 0 }],
      },
    ],
    ...over,
  };
  const [{ r }] = (await svc<{ r: { order_id: string; public_token: string; total_paise: number } }>('select app.create_order($1::jsonb) as r', [JSON.stringify(payload)])) as [
    { r: { order_id: string; public_token: string; total_paise: number } },
  ];
  const rzp = `order_${seq}${crypto.randomUUID().slice(0, 8)}`;
  await svc('select app.attach_razorpay_order($1, $2)', [r.order_id, rzp]);
  return { ...r, rzp, payload };
}

const capture = async (rzp: string, paymentId: string, amount: number, currency = 'INR') =>
  (await svc<{ r: any }>('select app.apply_payment_captured($1, $2, $3, $4, $5, $6, $7) as r', [rzp, paymentId, amount, currency, 'upi', 'vpahash', 'ra***@okicici']))[0]!.r;

const orderRow = async (id: string) => (await db.admin<any>('select * from public.orders where id = $1', [id]))[0];

describe('checkout creates a hidden, unpaid order', () => {
  it('stores snapshots and a generated total; staff can’t see it yet', async () => {
    const o = await newOrder();
    expect(o.total_paise).toBe(29800);
    expect(o.public_token).toMatch(/^ot_[A-Za-z0-9_-]{32}$/);
    const row = await orderRow(o.order_id);
    expect(row).toMatchObject({ status: 'awaiting_payment', order_number: null });
    expect((await db.as('authenticated', cashier, 'select id from public.orders where id = $1', [o.order_id])).length).toBe(0);
  });

  it('PY-6 / PY-7: the same idempotency key returns the same order; a different cart is refused', async () => {
    const o = await newOrder();
    const again = (await svc<{ r: any }>('select app.create_order($1::jsonb) as r', [JSON.stringify(o.payload)]))[0]!.r;
    expect(again).toMatchObject({ order_id: o.order_id, existing: true });
    const changed = { ...o.payload, request_hash: 'different' };
    expect((await apiError(svc('select app.create_order($1::jsonb)', [JSON.stringify(changed)]))).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses an empty cart and a negative total', async () => {
    expect((await apiError(newOrder({ lines: [] }))).code).toBe('VALIDATION_FAILED');
    await expect(newOrder({ order_discount_paise: 999999 })).rejects.toThrow(/check constraint/);
  });
});

describe('payment capture', () => {
  it('PY-1: a verified capture makes it a real order with SL- and pickup numbers', async () => {
    const o = await newOrder();
    const r = await capture(o.rzp, `pay_${seq}a`, 29800);
    expect(r).toMatchObject({ ok: true, duplicate: false, on_hold: false });
    expect(r.order_number).toMatch(/^SL-\d{4}$/);
    const row = await orderRow(o.order_id);
    expect(row).toMatchObject({ status: 'pending', on_hold: false, version: 2 });
    expect(row.paid_at).not.toBeNull();
    const events = await db.admin<{ to_status: string; actor_type: string }>('select to_status, actor_type from public.order_status_events where order_id = $1', [o.order_id]);
    expect(events).toEqual([{ to_status: 'pending', actor_type: 'system' }]);
    expect((await db.as('authenticated', cashier, 'select id from public.orders where id = $1', [o.order_id])).length).toBe(1);
  });

  it('PY-9: replaying the same capture changes nothing', async () => {
    const o = await newOrder();
    const first = await capture(o.rzp, `pay_${seq}r`, 29800);
    const again = await capture(o.rzp, `pay_${seq}r`, 29800);
    expect(again).toMatchObject({ ok: true, replay: true, order_number: first.order_number });
    const [{ n }] = (await db.admin<{ n: number }>('select count(*)::int n from public.payments where order_id = $1', [o.order_id])) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('PY-8: a second payment for the same order is flagged and refunded automatically', async () => {
    const o = await newOrder();
    await capture(o.rzp, `pay_${seq}x`, 29800);
    const dup = await capture(o.rzp, `pay_${seq}y`, 29800);
    expect(dup).toMatchObject({ ok: true, duplicate: true });
    const refund = (await svc<{ r: any }>('select app.create_duplicate_refund($1) as r', [dup.refund_payment_id]))[0]!.r;
    expect(refund).toMatchObject({ provider_payment_id: `pay_${seq}y`, amount_paise: 29800 });
    // Asking twice returns the same refund.
    expect((await svc<{ r: any }>('select app.create_duplicate_refund($1) as r', [dup.refund_payment_id]))[0]!.r.refund_id).toBe(refund.refund_id);
    const [flag] = await db.admin<{ rule: string }>(`select rule from public.fraud_flags where order_id = $1`, [o.order_id]);
    expect(flag!.rule).toBe('DUPLICATE_PAYMENT');
    expect((await orderRow(o.order_id)).status).toBe('pending');
  });

  it('PY-11: an amount mismatch holds the order and raises a blocking flag', async () => {
    const o = await newOrder();
    const r = await capture(o.rzp, `pay_${seq}m`, 100);
    expect(r).toMatchObject({ ok: true, on_hold: true });
    const row = await orderRow(o.order_id);
    expect(row).toMatchObject({ status: 'pending', on_hold: true });
    const [flag] = await db.admin<{ rule: string; severity: string }>(`select rule, severity from public.fraud_flags where order_id = $1`, [o.order_id]);
    expect(flag).toEqual({ rule: 'AMOUNT_MISMATCH', severity: 'block' });
  });

  it('a non-INR capture is also held', async () => {
    const o = await newOrder();
    expect(await capture(o.rzp, `pay_${seq}usd`, 29800, 'USD')).toMatchObject({ on_hold: true });
  });

  it('ignores captures for unknown Razorpay orders', async () => {
    expect(await capture('order_nope', 'pay_nope', 100)).toEqual({ ok: false, code: 'UNKNOWN_ORDER' });
  });

  it('PY-2: a failed attempt is recorded but the order stays hidden and payable', async () => {
    const o = await newOrder();
    await svc('select app.apply_payment_failed($1, $2, $3, $4)', [o.rzp, `pay_${seq}f`, 29800, 'User cancelled']);
    await svc('select app.apply_payment_failed($1, $2, $3, $4)', [o.rzp, `pay_${seq}f`, 29800, 'User cancelled']);
    await svc('select app.apply_payment_failed($1, $2, $3, $4)', ['order_unknown', 'pay_z', 1, 'x']);
    expect((await orderRow(o.order_id)).status).toBe('awaiting_payment');
    expect(await capture(o.rzp, `pay_${seq}ok`, 29800)).toMatchObject({ ok: true, duplicate: false });
  });

  it('PY-12: unpaid orders expire; a late payment revives the order and is flagged', async () => {
    const o = await newOrder();
    await db.admin(`update public.orders set payment_expires_at = now() - interval '1 second' where id = $1`, [o.order_id]);
    const [{ n }] = (await svc<{ n: number }>('select app.expire_unpaid_orders() as n')) as [{ n: number }];
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await orderRow(o.order_id)).status).toBe('payment_expired');
    const r = await capture(o.rzp, `pay_${seq}late`, 29800);
    expect(r).toMatchObject({ ok: true, late: true });
    expect(await orderRow(o.order_id)).toMatchObject({ status: 'pending', late_payment: true });
  });

  it('numbers are sequential; pickup numbers wrap after 99 and reset each day', async () => {
    const a = await newOrder();
    const b = await newOrder();
    const ra = await capture(a.rzp, `pay_${seq}n1`, 29800);
    const rb = await capture(b.rzp, `pay_${seq}n2`, 29800);
    expect(Number(rb.order_number.slice(3))).toBe(Number(ra.order_number.slice(3)) + 1);
    expect(rb.pickup_number).toBe(ra.pickup_number + 1);

    await db.admin(`update app.order_counters set last_pickup = 99`);
    const c = await newOrder();
    expect((await capture(c.rzp, `pay_${seq}n3`, 29800)).pickup_number).toBe(1);
    await db.admin(`update app.order_counters set pickup_date = pickup_date - 1, last_pickup = 42`);
    const d = await newOrder();
    expect((await capture(d.rzp, `pay_${seq}n4`, 29800)).pickup_number).toBe(1);
  });

  it('updates the customer’s visit count and spend', async () => {
    const o = await newOrder({ customer_mobile: '+919000000001', customer_name: 'Riya' });
    await capture(o.rzp, `pay_${seq}c`, 29800);
    const [c] = await db.admin<{ order_count: number; total_spent_paise: string; name: string }>(
      `select order_count, total_spent_paise::text, name from public.customers where mobile = '+919000000001'`,
    );
    expect(c).toEqual({ order_count: 1, total_spent_paise: '29800', name: 'Riya' });
  });
});

describe('status rules (enforced for every update)', () => {
  it('refuses skipped or backwards steps even from the database superuser', async () => {
    const o = await newOrder();
    await capture(o.rzp, `pay_${seq}s`, 29800);
    await expect(db.admin(`update public.orders set status = 'ready' where id = $1`, [o.order_id])).rejects.toThrow(/INVALID_TRANSITION/);
    await expect(db.admin(`update public.orders set status = 'completed' where id = $1`, [o.order_id])).rejects.toThrow(/INVALID_TRANSITION/);
    await db.admin(`update public.orders set status = 'confirmed' where id = $1`, [o.order_id]);
    await expect(db.admin(`update public.orders set status = 'awaiting_payment' where id = $1`, [o.order_id])).rejects.toThrow(/INVALID_TRANSITION/);
  });
});

describe('customer tracker, find-my-order and cancel', () => {
  it('shows the order without internal ids and with a masked mobile', async () => {
    const o = await newOrder();
    const pay = await capture(o.rzp, `pay_${seq}t`, 29800);
    const [{ r }] = (await svc<{ r: any }>('select app.order_public($1) as r', [o.public_token])) as [{ r: any }];
    expect(r).toMatchObject({
      order_number: pay.order_number,
      status: 'pending',
      payment_status: 'successful',
      total_paise: 29800,
      can_cancel: true,
      customer: { name: 'Aarav', mobile_masked: '98xxxxx678' },
      items: [{ name: 'Strawberry Splash', variant: 'Regular 350 ml', qty: 2, line_total_paise: 29800, options: ['Standard freeze'] }],
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain(o.order_id);
    expect(json).not.toContain('9812345678');
    expect(json).not.toContain('idem-');
    expect((await svc<{ r: unknown }>('select app.order_public($1) as r', ['ot_nope']))[0]!.r).toBeNull();
  });

  it('finds an order by mobile + number only when both match', async () => {
    const o = await newOrder();
    const pay = await capture(o.rzp, `pay_${seq}fo`, 29800);
    expect((await svc<{ t: string }>('select app.find_order($1, $2) as t', ['+919812345678', pay.order_number.toLowerCase()]))[0]!.t).toBe(o.public_token);
    expect((await svc<{ t: string | null }>('select app.find_order($1, $2) as t', ['+919999999999', pay.order_number]))[0]!.t).toBeNull();
  });

  it('FR-21: the customer can cancel only while pending, which creates an automatic full refund', async () => {
    const o = await newOrder();
    await capture(o.rzp, `pay_${seq}cx`, 29800);
    const r = (await svc<{ r: any }>('select app.cancel_by_customer($1, $2) as r', [o.public_token, 'Ordered by mistake']))[0]!.r;
    expect(r).toMatchObject({ provider_payment_id: `pay_${seq}cx`, amount_paise: 29800 });
    expect(await orderRow(o.order_id)).toMatchObject({ status: 'cancelled', cancel_reason: 'Ordered by mistake' });
    const [ev] = await db.admin<{ actor_type: string; reason: string }>(`select actor_type, reason from public.order_status_events where order_id = $1 and to_status = 'cancelled'`, [o.order_id]);
    expect(ev).toEqual({ actor_type: 'customer', reason: 'Ordered by mistake' });

    const accepted = await newOrder();
    await capture(accepted.rzp, `pay_${seq}cy`, 29800);
    await db.admin(`update public.orders set status = 'confirmed' where id = $1`, [accepted.order_id]);
    expect((await apiError(svc('select app.cancel_by_customer($1, $2)', [accepted.public_token, 'x']))).code).toBe('INVALID_TRANSITION');
    expect((await apiError(svc('select app.cancel_by_customer($1, $2)', ['ot_nope', 'x']))).code).toBe('NOT_FOUND');
  });
});

describe('refund processing (webhook side)', () => {
  async function cancelledOrder() {
    const o = await newOrder();
    await capture(o.rzp, `pay_${seq}rf`, 29800);
    const r = (await svc<{ r: any }>('select app.cancel_by_customer($1, $2) as r', [o.public_token, '']))[0]!.r;
    await svc('select app.refund_submitted($1, $2)', [r.refund_id, `rfnd_${seq}`]);
    return { ...o, refund: r, rfnd: `rfnd_${seq}` };
  }

  it('a processed full refund marks the payment and order refunded, once', async () => {
    const o = await cancelledOrder();
    const r = (await svc<{ r: any }>('select app.apply_refund_event($1, $2, $3, true, null) as r', [o.rfnd, 'pay', 29800]))[0]!.r;
    expect(r).toMatchObject({ ok: true, status: 'processed' });
    expect(await orderRow(o.order_id)).toMatchObject({ status: 'refunded' });
    const [p] = await db.admin<{ status: string; refunded_paise: string }>('select status, refunded_paise::text from public.payments where order_id = $1', [o.order_id]);
    expect(p).toEqual({ status: 'refunded', refunded_paise: '29800' });
    expect((await svc<{ r: any }>('select app.apply_refund_event($1, $2, $3, true, null) as r', [o.rfnd, 'pay', 29800]))[0]!.r).toMatchObject({ replay: true });
    expect((await svc<{ r: any }>('select app.apply_refund_event($1, $2, $3, true, null) as r', ['rfnd_unknown', 'pay', 1]))[0]!.r).toMatchObject({ ok: false });
  });

  it('a failed refund is flagged for follow-up', async () => {
    const o = await cancelledOrder();
    await svc('select app.apply_refund_event($1, $2, $3, false, $4)', [o.rfnd, 'pay', 29800, 'Bank rejected']);
    const [flag] = await db.admin<{ rule: string }>(`select rule from public.fraud_flags where order_id = $1 and rule = 'REFUND_FAILED'`, [o.order_id]);
    expect(flag!.rule).toBe('REFUND_FAILED');
    expect((await orderRow(o.order_id)).status).toBe('cancelled');
  });

  it('records a refund that couldn’t even be submitted', async () => {
    const o = await newOrder();
    await capture(o.rzp, `pay_${seq}sf`, 29800);
    const r = (await svc<{ r: any }>('select app.cancel_by_customer($1, $2) as r', [o.public_token, '']))[0]!.r;
    await svc('select app.refund_submit_failed($1, $2)', [r.refund_id, 'Razorpay down']);
    const [row] = await db.admin<{ status: string }>('select status from public.refunds where id = $1', [r.refund_id]);
    expect(row!.status).toBe('failed');
  });
});

describe('webhook log and access control', () => {
  it('records each webhook event once', async () => {
    const a = (await svc<{ r: any }>(`select app.record_webhook('razorpay', 'evt_1', 'payment.captured', '{}', true) as r`))[0]!.r;
    expect(a.processed).toBe(false);
    await svc('select app.webhook_done($1, null)', [a.id]);
    const b = (await svc<{ r: any }>(`select app.record_webhook('razorpay', 'evt_1', 'payment.captured', '{}', true) as r`))[0]!.r;
    expect(b).toEqual({ id: a.id, processed: true });
  });

  it('kitchen staff can’t read orders, customers or payments; cashiers can’t read full mobiles', async () => {
    for (const table of ['public.orders', 'public.payments']) {
      const rows = await db.as('authenticated', kitchen, `select count(*)::int as n from ${table}`).catch((e: Error) => e);
      expect(rows instanceof Error ? rows.message : (rows as { n: number }[])[0]!.n, table).toSatisfy((v: unknown) => v === 0 || String(v).includes('permission denied'));
    }
    expect((await db.as<{ n: number }>('authenticated', kitchen, 'select count(*)::int n from public.customers'))[0]!.n).toBe(0);
    await expect(db.as('authenticated', cashier, 'select customer_mobile from public.orders')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', cashier, 'select mobile from public.customers')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', cashier, 'select idempotency_key from public.orders')).rejects.toThrow(/permission denied/);
    await expect(db.as('authenticated', owner.claims(), `select app.create_order('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    await expect(db.as('anon', {}, `select app.order_public('x')`)).rejects.toThrow(/permission denied/);
  });
});
