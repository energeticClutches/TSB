import { beforeAll, describe, expect, it } from 'vitest';
import { loadDemoMenu, orderFactory } from './fixtures';
import { type Claims, type TestDb, apiError, createTestDb, makeManager, makeOwner, pinSession } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let manager: Awaited<ReturnType<typeof makeManager>>;
let cashier: Claims;
let cashierId: string;
let f: ReturnType<typeof orderFactory>;

beforeAll(async () => {
  db = await createTestDb();
  const menu = await loadDemoMenu(db);
  owner = await makeOwner(db);
  manager = await makeManager(db);
  const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), `select public.create_pin_staff('Karan', 'cashier', '6173') as id`)) as [{ id: string }];
  cashierId = id;
  cashier = (await pinSession(db, owner.claims(), { staffId: id, pin: '6173', role: 'cashier' })).claims;
  f = orderFactory(db, menu['Strawberry Splash']!);
});

const call = async <T = any>(claims: Claims, sql: string, params: unknown[] = []): Promise<T> =>
  ((await db.as<{ r: T }>('authenticated', claims, `select ${sql} as r`, params))[0] as { r: T }).r;
const svc = <T = any>(sql: string, params: unknown[] = []) => db.as<T>('service_role', {}, sql, params);
const row = async (sql: string, params: unknown[] = []) => (await db.admin<any>(sql, params))[0];
const version = async (id: string) => (await row('select version from public.orders where id = $1', [id])).version as number;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
/** This mobile's loyalty spend in the running campaign. */
const spendOf = async (mobile: string) =>
  Number(
    (await row(`select coalesce(a.spend_paise, 0) as spend from public.customers c
                  left join public.loyalty_accounts a on a.customer_id = c.id where c.mobile = $1`, [mobile])).spend,
  );

let mobileSeq = 100;
const newMobile = () => `+91970000${String(mobileSeq++).padStart(4, '0')}`;

async function completed(mobile = newMobile(), over: Record<string, unknown> = {}) {
  const o = await f.paid({ customer_mobile: mobile, ...over });
  await call(cashier, 'public.accept_order($1, $2)', [o.order_id, await version(o.order_id)]);
  for (const s of ['preparing', 'ready', 'completed']) {
    await call(cashier, 'public.advance_order($1, $2, $3::public.order_status)', [o.order_id, await version(o.order_id), s]);
  }
  return { ...o, mobile };
}

describe('reports', () => {
  beforeAll(async () => {
    await completed();
    await completed();
    const rejected = await f.paid();
    await call(cashier, 'public.reject_order($1, $2, $3)', [rejected.order_id, await version(rejected.order_id), 'Machine down']);
  });

  it('counts only real sales, grouped by day, and never lets cashiers read them', async () => {
    const p = JSON.stringify({ from: today(), to: today(), grain: 'day' });
    expect((await apiError(call(cashier, 'public.report_sales($1::jsonb)', [p]))).code).toBe('FORBIDDEN');
    const sales = await call(manager.claims(), 'public.report_sales($1::jsonb)', [p]);
    expect(sales.total).toMatchObject({ orders: 2, gross_paise: 97400, refund_paise: 0 });
    expect(sales.rows[0]).toMatchObject({ bucket: today(), orders: 2, avg_paise: 48700 });
  });

  it('breaks sales down by product, category and hour', async () => {
    const p = JSON.stringify({ from: today(), to: today() });
    const products = await call(manager.claims(), 'public.report_products($1::jsonb)', [p]);
    expect(products.find((x: any) => x.name === 'Strawberry Splash')).toMatchObject({ qty: 4, gross_paise: 59600 });
    expect(products.find((x: any) => x.name === 'Blue Lagoon')).toMatchObject({ qty: 2 });
    const cats = await call(manager.claims(), 'public.report_categories($1::jsonb)', [p]);
    expect(cats.find((c: any) => c.name === 'Slushes')).toMatchObject({ qty: 6, gross_paise: 97400 });
    const hours = await call(manager.claims(), 'public.report_hours($1::jsonb)', [p]);
    expect(hours.reduce((s: number, h: any) => s + h.orders, 0)).toBe(2);
  });

  it('reports payments, refunds, tokens and customers', async () => {
    const o = await completed();
    const r = await call(cashier, `public.request_refund($1, 'full', null, 'Bad batch')`, [o.order_id]);
    await call(manager.claims(), 'public.decide_refund($1, true, null)', [r.refund_id]);
    await svc('select app.refund_submitted($1, $2)', [r.refund_id, `rfnd_${r.refund_id.slice(-10)}`]);
    await svc('select app.apply_refund_event($1, $2, $3, true, null)', [`rfnd_${r.refund_id.slice(-10)}`, o.payId, 48700]);

    const p = JSON.stringify({ from: today(), to: today() });
    const pay = await call(manager.claims(), 'public.report_payments($1::jsonb)', [p]);
    expect(pay.methods[0]).toMatchObject({ method: 'upi' });
    expect(pay.refunds.find((x: any) => x.status === 'processed')).toMatchObject({ count: 1, amount_paise: 48700 });

    const tok = await call(manager.claims(), 'public.report_tokens($1::jsonb)', [p]);
    expect(tok).toMatchObject({ running: true, token_limit: 500, threshold_paise: 200000 });
    expect(tok.tokens_issued + tok.tokens_left).toBe(500);
    expect(Number(tok.loyalty_spend_paise)).toBeGreaterThan(0);
    expect(tok.bands.map((b: any) => b.label)).toContain('Just started');

    const cust = await call(manager.claims(), 'public.report_customers($1::jsonb)', [p]);
    expect(cust.ordering).toBeGreaterThanOrEqual(3);
    expect(cust.top[0]).toMatchObject({ mobile_masked: expect.stringContaining('xxxxx') });
    expect(JSON.stringify(cust)).not.toMatch(/\+91\d{10}/);
  });

  it('gives the dashboard today’s figures in one call', async () => {
    const d = await call(owner.claims(), 'public.dashboard_today()');
    expect(d.today.orders).toBeGreaterThanOrEqual(3);
    expect(d.live).toMatchObject({ pending: expect.any(Number), in_kitchen: expect.any(Number) });
    expect(d.attention).toHaveProperty('fraud_flags');
    expect(d.tokens).toMatchObject({ running: true, token_limit: 500 });
    expect((await apiError(call(cashier, 'public.dashboard_today()'))).code).toBe('FORBIDDEN');
  });

  it('refuses silly periods', async () => {
    expect((await apiError(call(manager.claims(), 'public.report_sales($1::jsonb)', [JSON.stringify({ from: '2020-01-01', to: today() })]))).code).toBe('VALIDATION_FAILED');
    expect((await apiError(call(manager.claims(), 'public.report_sales($1::jsonb)', [JSON.stringify({ grain: 'week' })]))).code).toBe('VALIDATION_FAILED');
  });
});

describe('risk', () => {
  it('blocks an identity by hash and stops that number ordering or using offers', async () => {
    const o = await completed();
    expect((await apiError(call(cashier, `public.block_identity($1, 'mobile', 'all', 'Abuse')`, [o.order_id]))).code).toBe('FORBIDDEN');
    expect((await apiError(call(manager.claims(), `public.block_identity($1, 'mobile', 'all', '')`, [o.order_id]))).code).toBe('VALIDATION_FAILED');
    const b = await call(manager.claims(), `public.block_identity($1, 'mobile', 'all', $2)`, [o.order_id, 'Repeated chargebacks']);
    expect(b.masked).toMatch(/^97xxxxx/);
    const stored = await row('select * from public.blocked_identities where id = $1', [b.id]);
    expect(stored.value_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(o.mobile);

    const ctx = (await svc<{ r: any }>('select app.offer_context($1, $2, null, null) as r', [db.branchId, o.mobile]))[0]!.r;
    expect(ctx).toMatchObject({ blocked: 'all', offers_enabled: false, happy_hours: [] });
    // Blocked: the Lucky Draw stops counting for them too.
    expect(ctx.loyalty.earning).toBe(false);

    await call(manager.claims(), 'public.unblock_identity($1, $2)', [b.id, 'Sorted out with the customer']);
    expect(await row('select 1 as x from public.blocked_identities where id = $1', [b.id])).toBeUndefined();
  });

  it('blocks a UPI id only for offers, leaving ordering alone', async () => {
    const o = await completed();
    const b = await call(manager.claims(), `public.block_identity($1, 'vpa', 'offers', $2, 30)`, [o.order_id, 'Offer farming']);
    expect(b.masked).toBe('aa***@okaxis');
    const vpaHash = (await row('select value_hash from public.blocked_identities where id = $1', [b.id])).value_hash;
    expect((await row(`select app.block_scope_for(null, null, $1) as s`, [vpaHash])).s).toBe('offers');
    await call(manager.claims(), 'public.unblock_identity($1, $2)', [b.id, 'test']);
  });

  it('a chargeback freezes the customer, holds the order and takes back the loyalty spend', async () => {
    const o = await completed();
    expect(await spendOf(o.mobile)).toBe(48700);
    const r = await svc<{ r: any }>('select app.apply_dispute($1, $2, $3) as r', [o.payId, 'disp_1', 'created']);
    expect(r[0]!.r.ok).toBe(true);
    expect(await row('select status, dispute_id from public.payments where provider_payment_id = $1', [o.payId])).toMatchObject({ status: 'disputed', dispute_id: 'disp_1' });
    expect(await row('select on_hold, hold_reason from public.orders where id = $1', [o.order_id])).toMatchObject({ on_hold: true });
    expect(await row('select is_frozen from public.customers where mobile = $1', [o.mobile])).toMatchObject({ is_frozen: true });
    expect(await spendOf(o.mobile)).toBe(0);
    expect(await row(`select 1 as x from public.fraud_flags where rule = 'DISPUTE_OPENED' and order_id = $1`, [o.order_id])).toBeTruthy();
    expect((await svc<{ r: any }>('select app.apply_dispute($1, $2, $3) as r', [o.payId, 'disp_1', 'created']))[0]!.r.replay).toBe(true);
  });

  it('reconciles against the provider: quiet when they agree, flags when they don’t', async () => {
    const o = await completed();
    const p = (from: string, payments: unknown[]) =>
      JSON.stringify({ branch_id: db.branchId, window_start: from, window_end: new Date(Date.now() + 60_000).toISOString(), payments });
    const all = await db.admin<any>(`select provider_payment_id, amount_paise from public.payments where status <> 'failed' and not is_duplicate`);
    const since = new Date(Date.now() - 3600_000).toISOString();

    const ok = (await svc<{ r: any }>('select app.reconcile($1::jsonb) as r', [
      p(since, all.map((x) => ({ id: x.provider_payment_id, amount: Number(x.amount_paise), status: 'captured' }))),
    ]))[0]!.r;
    expect(ok).toMatchObject({ status: 'ok', mismatches: 0 });

    const bad = (await svc<{ r: any }>('select app.reconcile($1::jsonb) as r', [
      p(since, [{ id: 'pay_ghost', amount: 12300, status: 'captured' }, { id: o.payId, amount: 1, status: 'captured' }]),
    ]))[0]!.r;
    expect(bad.status).toBe('needs_review');
    const flag = await row(`select details from public.fraud_flags where rule = 'RECON_MISMATCH' order by id desc limit 1`);
    const kinds = flag.details.mismatches.map((m: any) => m.kind);
    expect(kinds).toContain('missing_in_db');
    expect(kinds).toContain('amount_differs');
    expect(kinds).toContain('missing_at_provider');
  });

  it('raises pattern flags: one device with many mobiles, and a new UPI id on an order that earns a token', async () => {
    const device = 'devicehash-shared';
    for (let i = 0; i < 4; i++) {
      const m = newMobile();
      await completed(m, { device_id_hash: device });
    }
    const n = Number((await svc<{ n: number }>('select app.run_fraud_rules() as n'))[0]!.n);
    expect(n).toBeGreaterThan(0);
    const flag = await row(`select details, severity from public.fraud_flags where rule = 'MULTI_MOBILE_DEVICE' order by id desc limit 1`);
    expect(flag).toMatchObject({ severity: 'warn' });
    expect(flag.details.mobiles).toBeGreaterThan(3);
    // Running again doesn't pile up duplicates for the same device.
    const before = Number((await row(`select count(*) as n from public.fraud_flags where rule = 'MULTI_MOBILE_DEVICE'`)).n);
    await svc('select app.run_fraud_rules()');
    expect(Number((await row(`select count(*) as n from public.fraud_flags where rule = 'MULTI_MOBILE_DEVICE'`)).n)).toBe(before);

    // A mobile one order short of the threshold, paid from a UPI id it has never used.
    const m = newMobile();
    await f.giveLoyalty(m, 195000);
    const tokenOrder = await completed(m);
    await svc('select app.run_fraud_rules()');
    expect(await row(`select 1 as x from public.fraud_flags where rule = 'TOKEN_EARNED_NEW_VPA' and order_id = $1`, [tokenOrder.order_id])).toBeTruthy();
  });

  it('flags are reviewed by someone else and show up on the risk screen', async () => {
    const [flag] = await db.admin<any>(`select id from public.fraud_flags where status = 'open' order by id limit 1`);
    expect((await apiError(call(manager.claims(), 'public.review_fraud_flag($1, $2, null)', [flag.id, 'nonsense']))).code).toBe('VALIDATION_FAILED');
    await call(manager.claims(), 'public.review_fraud_flag($1, $2, $3)', [flag.id, 'cleared', 'Checked with Razorpay']);
    expect(await row('select status, review_note from public.fraud_flags where id = $1', [flag.id])).toMatchObject({ status: 'cleared', review_note: 'Checked with Razorpay' });
    expect((await apiError(call(manager.claims(), 'public.review_fraud_flag($1, $2, null)', [flag.id, 'cleared']))).code).toBe('INVALID_TRANSITION');

    // A flag about a staff member can't be cleared by that person.
    await db.admin(`insert into public.fraud_flags (branch_id, rule, severity, staff_id) values ($1, 'REFUND_VOLUME', 'warn', $2)`, [db.branchId, cashierId]);
    const [own] = await db.admin<any>(`select id from public.fraud_flags where staff_id = $1 order by id desc limit 1`, [cashierId]);
    const asCashierManager = { ...manager.claims(), staff_id: cashierId };
    expect((await apiError(call(asCashierManager, 'public.review_fraud_flag($1, $2, null)', [own.id, 'cleared']))).code).toBeDefined();

    const risk = await call(owner.claims(), 'public.risk_overview()');
    expect(risk.open_count).toBeGreaterThan(0);
    expect(risk.reconciliation).toMatchObject({ status: 'needs_review' });
    expect(risk.chains).toEqual({ audit_ok: true, ledger_ok: true });
    expect(risk.disputes).toBe(1);
    expect((await apiError(call(cashier, 'public.risk_overview()'))).code).toBe('FORBIDDEN');
  });

  it('housekeeping removes only old, unpaid, abandoned checkouts', async () => {
    const old = await f.checkout();
    const recent = await f.checkout();
    const paid = await completed();
    await db.admin(`update public.orders set status = 'payment_expired', created_at = now() - interval '40 days' where id = $1`, [old.order_id]);
    await db.admin(`update public.orders set status = 'payment_expired' where id = $1`, [recent.order_id]);
    const r = (await svc<{ r: any }>('select app.housekeeping() as r'))[0]!.r;
    expect(r.orders_removed).toBe(1);
    expect(await row('select 1 as x from public.orders where id = $1', [old.order_id])).toBeUndefined();
    expect(await row('select 1 as x from public.orders where id = $1', [recent.order_id])).toBeTruthy();
    expect(await row('select 1 as x from public.orders where id = $1', [paid.order_id])).toBeTruthy();
  });
});
