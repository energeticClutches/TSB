import { beforeAll, describe, expect, it } from 'vitest';
import { type Claims, type TestDb, apiError, createTestDb, makeManager, makeOwner, pinSession } from './harness';
import { loadDemoMenu, orderFactory } from './fixtures';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let manager: Awaited<ReturnType<typeof makeManager>>;
let cashier: Claims;
let cashierId: string;
let kitchen: Claims;
let f: ReturnType<typeof orderFactory>;

beforeAll(async () => {
  db = await createTestDb();
  const menu = await loadDemoMenu(db);
  owner = await makeOwner(db);
  manager = await makeManager(db);
  const mk = async (name: string, role: 'cashier' | 'kitchen', pin: string) => {
    const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), 'select public.create_pin_staff($1, $2::public.staff_role, $3) as id', [name, role, pin])) as [{ id: string }];
    return { id, claims: (await pinSession(db, owner.claims(), { staffId: id, pin, role })).claims };
  };
  const c = await mk('Karan', 'cashier', '6173');
  cashier = c.claims;
  cashierId = c.id;
  kitchen = (await mk('Neha', 'kitchen', '3906')).claims;
  f = orderFactory(db, menu['Strawberry Splash']!);
});

const call = async <T = any>(claims: Claims, sql: string, params: unknown[] = []): Promise<T> =>
  ((await db.as<{ r: T }>('authenticated', claims, `select ${sql} as r`, params))[0] as { r: T }).r;
const row = async (sql: string, params: unknown[] = []) => (await db.admin<any>(sql, params))[0];
const version = async (id: string) => (await row('select version from public.orders where id = $1', [id])).version as number;

async function accepted() {
  const o = await f.paid();
  await call(cashier, 'public.accept_order($1, $2)', [o.order_id, await version(o.order_id)]);
  return o;
}
async function completed() {
  const o = await accepted();
  for (const to of ['preparing', 'ready', 'completed']) {
    await call(cashier, 'public.advance_order($1, $2, $3::public.order_status)', [o.order_id, await version(o.order_id), to]);
  }
  return o;
}

describe('live board and kitchen', () => {
  it('shows paid orders to the counter with a masked mobile; unpaid ones stay hidden', async () => {
    const unpaid = await f.checkout();
    const o = await f.paid();
    const board = await call(cashier, 'public.live_orders()');
    const ids = board.orders.map((x: any) => x.id);
    expect(ids).toContain(o.order_id);
    expect(ids).not.toContain(unpaid.order_id);
    const card = board.orders.find((x: any) => x.id === o.order_id);
    expect(card.mobile_masked).toBe('98xxxxx678');
    expect(JSON.stringify(card)).not.toContain('9812345678');
    expect(card.items).toHaveLength(2);
    expect(card.items[0].options[0].name).toBe('Popping boba');
    expect(board.late_after_min).toBe(5);
  });

  it('kitchen can’t open the counter board, and its own view has no prices or phone numbers', async () => {
    expect((await apiError(call(kitchen, 'public.live_orders()'))).code).toBe('FORBIDDEN');
    const o = await accepted();
    const k = await call(kitchen, 'public.kitchen_orders()');
    const card = k.orders.find((x: any) => x.id === o.order_id);
    expect(card.items[0].name).toBe('Strawberry Splash');
    const text = JSON.stringify(k);
    expect(text).not.toMatch(/price|paise|mobile|customer/);
    expect((await apiError(call(cashier, 'public.kitchen_orders()'))).code).toBe('FORBIDDEN');
  });
});

describe('accepting an order', () => {
  it('needs the current version, confirms, and issues a gap-free receipt', async () => {
    const o = await f.paid();
    const v = await version(o.order_id);
    expect((await apiError(call(cashier, 'public.accept_order($1, $2)', [o.order_id, v - 1]))).code).toBe('VERSION_CONFLICT');
    const r = await call(cashier, 'public.accept_order($1, $2)', [o.order_id, v]);
    expect(r).toEqual({ status: 'confirmed', version: v + 1 });
    expect((await apiError(call(cashier, 'public.accept_order($1, $2)', [o.order_id, v + 1]))).code).toBe('INVALID_TRANSITION');

    const receipt = await call(cashier, 'public.order_receipt($1)', [o.order_id]);
    expect(receipt.receipt_number).toMatch(/^SLB\/\d{4}-\d{2}\/\d{6}$/);
    expect(receipt.snapshot.totals.total_paise).toBe(48700);
    expect(receipt.snapshot.items).toHaveLength(2);
    expect(receipt.snapshot.payment.vpa_masked).toBe('aa***@okaxis');

    const next = await accepted();
    const second = await call(cashier, 'public.order_receipt($1)', [next.order_id]);
    const n = (s: string) => Number(s.split('/')[2]);
    expect(n(second.receipt_number)).toBe(n(receipt.receipt_number) + 1);
  });

  it('receipts can’t be edited or deleted, even by the database owner role', async () => {
    const o = await accepted();
    await expect(db.admin('update public.receipts set snapshot = $1 where order_id = $2', ['{}', o.order_id])).rejects.toThrow();
    await expect(db.admin('delete from public.receipts where order_id = $1', [o.order_id])).rejects.toThrow();
  });

  it('a held order can’t be accepted until a manager clears it with a note', async () => {
    const o = await f.paid({}, 100); // amount mismatch → on hold
    const v = await version(o.order_id);
    expect((await apiError(call(cashier, 'public.accept_order($1, $2)', [o.order_id, v]))).code).toBe('ORDER_ON_HOLD');
    expect((await apiError(call(cashier, 'public.clear_order_hold($1, $2)', [o.order_id, 'looks fine']))).code).toBe('FORBIDDEN');
    expect((await apiError(call(manager.claims(), 'public.clear_order_hold($1, $2)', [o.order_id, '']))).code).toBe('VALIDATION_FAILED');
    const cleared = await call(manager.claims(), 'public.clear_order_hold($1, $2)', [o.order_id, 'Customer paid the rest in cash']);
    expect(cleared.on_hold).toBe(false);
    await call(cashier, 'public.accept_order($1, $2)', [o.order_id, cleared.version]);
    const audit = await row(`select reason from public.audit_logs where action = 'order.clear_hold' and entity_id = $1`, [o.order_id]);
    expect(audit.reason).toBe('Customer paid the rest in cash');
  });

});

describe('moving orders along', () => {
  it('kitchen does Start and Ready only; the counter hands over; no skipping steps', async () => {
    const o = await accepted();
    expect((await apiError(call(kitchen, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'ready']))).code).toBe('INVALID_TRANSITION');
    await call(kitchen, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'preparing']);
    await call(kitchen, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'ready']);
    expect((await apiError(call(kitchen, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'completed']))).code).toBe('INVALID_TRANSITION');
    expect((await apiError(call(cashier, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'out_for_delivery']))).code).toBe('INVALID_TRANSITION');
    await call(cashier, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'completed']);
    const done = await row('select status, preparing_at, ready_at, completed_at from public.orders where id = $1', [o.order_id]);
    expect(done.status).toBe('completed');
    expect(done.preparing_at && done.ready_at && done.completed_at).toBeTruthy();
    const events = await db.admin<any>('select to_status, actor_type from public.order_status_events where order_id = $1 order by id', [o.order_id]);
    expect(events.map((e) => e.to_status)).toEqual(['pending', 'confirmed', 'preparing', 'ready', 'completed']);
    expect(events.at(-1).actor_type).toBe('staff');
  });

  it('delivery orders go out for delivery, then delivered', async () => {
    const o = await f.paid({ order_type: 'delivery', delivery_address: 'H 12, Sector 6', delivery_fee_paise: 3000 });
    await call(cashier, 'public.accept_order($1, $2)', [o.order_id, await version(o.order_id)]);
    for (const to of ['preparing', 'ready']) await call(cashier, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), to]);
    expect((await apiError(call(cashier, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'completed']))).code).toBe('INVALID_TRANSITION');
    await call(cashier, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'out_for_delivery']);
    await call(cashier, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'delivered']);
  });

  it('only a manager can step back, with a reason, and it’s audited', async () => {
    const o = await accepted();
    await call(kitchen, 'public.advance_order($1, $2, $3)', [o.order_id, await version(o.order_id), 'preparing']);
    expect((await apiError(call(cashier, 'public.revert_order_status($1, $2, $3)', [o.order_id, await version(o.order_id), 'mis-tap']))).code).toBe('FORBIDDEN');
    expect((await apiError(call(manager.claims(), 'public.revert_order_status($1, $2, $3)', [o.order_id, await version(o.order_id), '']))).code).toBe('VALIDATION_FAILED');
    const r = await call(manager.claims(), 'public.revert_order_status($1, $2, $3)', [o.order_id, await version(o.order_id), 'Tapped Start by mistake']);
    expect(r.status).toBe('confirmed');
    expect((await row('select preparing_at from public.orders where id = $1', [o.order_id])).preparing_at).toBeNull();
    const ev = await row(`select reason from public.order_status_events where order_id = $1 order by id desc limit 1`, [o.order_id]);
    expect(ev.reason).toBe('Tapped Start by mistake');
    expect(await row(`select 1 as x from public.audit_logs where action = 'order.step_back' and entity_id = $1`, [o.order_id])).toBeTruthy();
  });

  it('revealing the full mobile is logged every time', async () => {
    const o = await f.paid();
    const before = Number((await row(`select count(*) as n from public.audit_logs where action = 'order.reveal_mobile'`)).n);
    expect(await call(cashier, 'public.reveal_customer_mobile($1)', [o.order_id])).toEqual({ mobile: '+919812345678' });
    await call(cashier, 'public.reveal_customer_mobile($1)', [o.order_id]);
    expect(Number((await row(`select count(*) as n from public.audit_logs where action = 'order.reveal_mobile'`)).n)).toBe(before + 2);
    expect((await apiError(call(kitchen, 'public.reveal_customer_mobile($1)', [o.order_id]))).code).toBe('FORBIDDEN');
  });
});

describe('rejecting and refunds', () => {
  it('rejecting needs a reason and raises a full refund request any manager can approve', async () => {
    const o = await f.paid();
    const v = await version(o.order_id);
    expect((await apiError(call(cashier, 'public.reject_order($1, $2, $3)', [o.order_id, v, '']))).code).toBe('VALIDATION_FAILED');
    const r = await call(cashier, 'public.reject_order($1, $2, $3)', [o.order_id, v, 'Out of strawberries']);
    expect(r.status).toBe('rejected');
    const refund = await row('select * from public.refunds where id = $1', [r.refund_id]);
    expect(refund).toMatchObject({ kind: 'full', status: 'requested', amount_paise: 48700, requested_by: null });

    expect((await apiError(call(cashier, 'public.decide_refund($1, true, null)', [r.refund_id]))).code).toBe('FORBIDDEN');
    const d = await call(manager.claims(), 'public.decide_refund($1, true, null)', [r.refund_id]);
    expect(d).toMatchObject({ status: 'approved', amount_paise: 48700, provider_payment_id: o.payId });

    // Razorpay accepts it, then confirms by webhook → the order becomes refunded.
    await f.svc('select app.refund_submitted($1, $2)', [r.refund_id, 'rfnd_rej1']);
    await f.svc('select app.apply_refund_event($1, $2, $3, true, null)', ['rfnd_rej1', o.payId, 48700]);
    expect((await row('select status from public.orders where id = $1', [o.order_id])).status).toBe('refunded');
    expect((await row('select refunded_qty from public.order_items where order_id = $1 order by sort_order', [o.order_id])).refunded_qty).toBe(2);
  });

  it('partial refunds are priced by the server and can’t exceed what’s left', async () => {
    const o = await completed();
    const items = await db.admin<any>('select id, qty from public.order_items where order_id = $1 order by sort_order', [o.order_id]);
    const straw = items[0].id;
    expect((await apiError(call(cashier, `public.request_refund($1, 'partial', $2::jsonb, $3)`, [o.order_id, JSON.stringify([{ order_item_id: straw, qty: 3 }]), 'Spilled']))).code).toBe('VALIDATION_FAILED');
    const p = await call(cashier, `public.request_refund($1, 'partial', $2::jsonb, $3)`, [o.order_id, JSON.stringify([{ order_item_id: straw, qty: 1 }]), 'Spilled one']);
    expect(p).toMatchObject({ amount_paise: 14900, status: 'requested', needs: 'manager' });
    // One of the two strawberries is now "in progress", so only one more can be asked for.
    expect((await apiError(call(cashier, `public.request_refund($1, 'partial', $2::jsonb, $3)`, [o.order_id, JSON.stringify([{ order_item_id: straw, qty: 2 }]), 'again']))).code).toBe('VALIDATION_FAILED');
    const full = await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Customer unhappy']);
    expect(full.amount_paise).toBe(48700 - 14900);
    expect((await apiError(call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'more']))).code).toBe('INVALID_TRANSITION');
  });

  it('declining frees the amount again and needs a note', async () => {
    const o = await completed();
    const r = await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Wrong flavour']);
    expect((await apiError(call(manager.claims(), 'public.decide_refund($1, false, null)', [r.refund_id]))).code).toBe('VALIDATION_FAILED');
    const d = await call(manager.claims(), 'public.decide_refund($1, false, $2)', [r.refund_id, 'Customer drank it all']);
    expect(d.status).toBe('declined');
    expect((await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Asked again'])).amount_paise).toBe(48700);
  });

  it('maker–checker: you can’t approve your own request', async () => {
    const o = await completed();
    const r = await call(manager.claims(), `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Cold drink was warm']);
    expect((await apiError(call(manager.claims(), 'public.decide_refund($1, true, null)', [r.refund_id]))).code).toBe('FORBIDDEN');
    expect((await call(owner.claims(), 'public.decide_refund($1, true, null)', [r.refund_id])).status).toBe('approved');
    expect((await apiError(call(owner.claims(), 'public.decide_refund($1, true, null)', [r.refund_id]))).code).toBe('INVALID_TRANSITION');
  });

  it('big refunds need the Owner with a fresh 2FA code', async () => {
    await db.admin(`update public.settings set value = '20000' where key = 'refund_owner_approval_above_paise'`);
    try {
      const o = await completed();
      const r = await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Whole order wrong']);
      expect(r.needs).toBe('owner');
      const alerts = await call(manager.claims(), 'public.staff_alerts()');
      const ownerAlerts = await call(owner.claims(), 'public.staff_alerts()');
      expect(ownerAlerts.refund_requests).toBeGreaterThan(alerts.refund_requests);
      expect((await apiError(call(manager.claims(), 'public.decide_refund($1, true, null)', [r.refund_id]))).code).toBe('NEEDS_OWNER_APPROVAL');
      const stale = await apiError(call(owner.claims(3600), 'public.decide_refund($1, true, null)', [r.refund_id]));
      expect(stale).toMatchObject({ code: 'FORBIDDEN', hint: { reason: 'step_up_required' } });
      expect((await call(owner.claims(), 'public.decide_refund($1, true, null)', [r.refund_id])).status).toBe('approved');
      // A manager may still decline a big one.
      const o2 = await completed();
      const r2 = await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o2.order_id, 'Whole order wrong']);
      expect((await call(manager.claims(), 'public.decide_refund($1, false, $2)', [r2.refund_id, 'Not our mistake'])).status).toBe('declined');
    } finally {
      await db.admin(`update public.settings set value = '50000' where key = 'refund_owner_approval_above_paise'`);
    }
  });

  it('failed refunds can be sent again by a manager', async () => {
    const o = await completed();
    const r = await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Refund please']);
    await call(manager.claims(), 'public.decide_refund($1, true, null)', [r.refund_id]);
    await f.svc('select app.refund_submit_failed($1, $2)', [r.refund_id, 'Razorpay down']);
    expect((await apiError(call(cashier, 'public.refund_for_submission($1)', [r.refund_id]))).code).toBe('FORBIDDEN');
    const again = await call(manager.claims(), 'public.refund_for_submission($1)', [r.refund_id]);
    expect(again).toMatchObject({ provider_payment_id: o.payId, amount_paise: 48700 });
    expect((await row('select status from public.refunds where id = $1', [r.refund_id])).status).toBe('approved');
  });

  it('flags a staff member who asks for too many refunds in a day', async () => {
    await db.admin(`update public.settings set value = '1' where key = 'refund_daily_limit_per_staff'`);
    try {
      const a = await completed();
      const b = await completed();
      const before = Number((await row(`select count(*) as n from public.fraud_flags where rule = 'REFUND_VOLUME'`)).n);
      await call(owner.claims(), `public.request_refund($1, 'full', null, $2)`, [a.order_id, 'One']);
      await call(owner.claims(), `public.request_refund($1, 'full', null, $2)`, [b.order_id, 'Two']);
      expect(Number((await row(`select count(*) as n from public.fraud_flags where rule = 'REFUND_VOLUME'`)).n)).toBeGreaterThan(before);
    } finally {
      await db.admin(`update public.settings set value = '5' where key = 'refund_daily_limit_per_staff'`);
    }
  });

  it('the refund queue and order detail show who asked and who decided', async () => {
    const o = await completed();
    const r = await call(cashier, `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Queue check']);
    const q = await call(manager.claims(), 'public.refund_queue()');
    const item = q.find((x: any) => x.id === r.refund_id);
    expect(item).toMatchObject({ requested_by: 'Karan', status: 'requested', customer_name: 'Aarav' });
    expect((await apiError(call(cashier, 'public.refund_queue()'))).code).toBe('FORBIDDEN');
    const d = await call(cashier, 'public.order_detail($1)', [o.order_id]);
    expect(d.refunds[0]).toMatchObject({ requested_by: 'Karan', status: 'requested' });
    expect(d.timeline.map((e: any) => e.to)).toEqual(['pending', 'confirmed', 'preparing', 'ready', 'completed']);
    expect(d.receipt_number).toMatch(/^SLB\//);
  });
});

describe('history', () => {
  it('searches by pickup number, order number and mobile; cashiers only see today', async () => {
    const o = await f.paid({ customer_mobile: '+919000011111', customer_name: 'Ishita' });
    const info = await row('select order_number, pickup_number from public.orders where id = $1', [o.order_id]);
    const byMobile = await call(cashier, 'public.order_history($1::jsonb)', [JSON.stringify({ q: '9000011111' })]);
    expect(byMobile.rows.map((x: any) => x.id)).toEqual([o.order_id]);
    const byNumber = await call(cashier, 'public.order_history($1::jsonb)', [JSON.stringify({ q: info.order_number })]);
    expect(byNumber.rows[0].id).toBe(o.order_id);
    expect(byNumber.rows[0].payment_status).toBe('successful');

    await db.admin(`update public.orders set paid_at = now() - interval '3 days' where id = $1`, [o.order_id]);
    const from = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
    const cashierView = await call(cashier, 'public.order_history($1::jsonb)', [JSON.stringify({ q: 'Ishita', from })]);
    expect(cashierView.total).toBe(0);
    expect((await apiError(call(cashier, 'public.order_detail($1)', [o.order_id]))).code).toBe('NOT_FOUND');
    const managerView = await call(manager.claims(), 'public.order_history($1::jsonb)', [JSON.stringify({ q: 'Ishita', from })]);
    expect(managerView.total).toBe(1);
    expect((await apiError(call(manager.claims(), 'public.order_history($1::jsonb)', [JSON.stringify({ from: '2026-01-01', to: '2026-09-01' })]))).code).toBe('VALIDATION_FAILED');
  });
});

describe('QR codes', () => {
  it('creates a random-slug code per table, one active per table, managers only', async () => {
    expect((await apiError(call(cashier, `public.create_qr('table', '07')`))).code).toBe('FORBIDDEN');
    expect((await apiError(call(manager.claims(), `public.create_qr('table', 'Table #7!')`))).code).toBe('VALIDATION_FAILED');
    const q = await call(manager.claims(), `public.create_qr('table', '07')`);
    expect(q.slug).toMatch(/^[A-Za-z0-9]{10}$/);
    expect((await apiError(call(manager.claims(), `public.create_qr('table', '07')`))).code).toBe('VALIDATION_FAILED');

    await call(manager.claims(), 'public.set_qr_active($1, false)', [q.id]);
    const lookup = await f.svc<{ r: any }>('select app.qr_lookup($1) as r', [q.slug]);
    expect(lookup[0]!.r).toMatchObject({ active: false, table_label: '07' });
    const q2 = await call(manager.claims(), `public.create_qr('table', '07')`);
    expect(q2.slug).not.toBe(q.slug);
    expect((await apiError(call(manager.claims(), 'public.set_qr_active($1, true)', [q.id]))).code).toBe('VALIDATION_FAILED');

    const counter = await call(owner.claims(), `public.create_qr('counter', null)`);
    const list = await call(manager.claims(), 'public.list_qr_codes()');
    expect(list.map((x: any) => x.id)).toEqual(expect.arrayContaining([q.id, q2.id, counter.id]));
    expect(list.find((x: any) => x.id === q2.id)).toMatchObject({ table_label: '07', is_active: true, orders_30d: 0 });
  });
});

describe('financial year', () => {
  it('turns over on 1 April in India', async () => {
    const fy = async (at: string) => (await row('select app.financial_year($1::timestamptz) as y', [at])).y;
    expect(await fy('2026-03-31T18:29:00Z')).toBe('2025-26'); // 23:59 IST, 31 March
    expect(await fy('2026-03-31T18:31:00Z')).toBe('2026-27'); // 00:01 IST, 1 April
    expect(await fy('2027-01-15T10:00:00Z')).toBe('2026-27');
    expect(await fy('2099-12-01T10:00:00Z')).toBe('2099-00');
  });
});
