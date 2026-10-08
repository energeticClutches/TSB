import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApi } from './apiHarness';
import { loadDemoMenu, orderFactory } from './fixtures';
import { type TestDb, createTestDb } from './harness';

let db: TestDb;
let api: ReturnType<typeof makeApi>;
let counterQr: string;
let straw: { product_id: string; variant_id: string };
let options: string[];
let f: ReturnType<typeof orderFactory>;

beforeAll(async () => {
  db = await createTestDb();
  const menu = await loadDemoMenu(db);
  straw = menu['Strawberry Splash']!;
  f = orderFactory(db, straw);
  [{ slug: counterQr }] = (await db.admin<{ slug: string }>(`insert into public.qr_codes (branch_id, kind) values ($1, 'counter') returning slug`, [db.branchId])) as [{ slug: string }];
  const opts = await db.admin<{ id: string }>(
    `select o.id from public.modifier_options o join public.modifier_groups g on g.id = o.group_id
       join public.product_modifier_groups pg on pg.group_id = g.id where pg.product_id = $1 and o.is_default`,
    [straw.product_id],
  );
  options = opts.map((o) => o.id);
});

beforeEach(() => {
  api = makeApi(db);
});

let seq = 700;
const body = () => ({
  qr_slug: counterQr,
  order_type: 'takeaway',
  lines: [{ line_id: 'l1', ...straw, qty: 1, option_ids: options }],
  customer: { name: 'Riya', mobile: `98700${String(seq++).padStart(5, '0')}` },
  note: '',
  device_id: crypto.randomUUID(),
  'cf-turnstile-response': 'ok',
});
const checkout = () => api.call('POST', '/v1/checkout', { body: body(), headers: { 'Idempotency-Key': crypto.randomUUID() }, ip: crypto.randomUUID() });
const job = (path: string, secret = 'job-secret') => api.call('POST', path, { body: {}, headers: { 'x-job-secret': secret } });

describe('reconciliation job', () => {
  it('needs the job secret', async () => {
    expect((await api.call('POST', '/v1/jobs/reconcile', { body: {} })).status).toBe(403);
    expect((await job('/v1/jobs/reconcile', 'wrong')).status).toBe(403);
  });

  it('is quiet when Razorpay and the database agree', async () => {
    const res = await checkout();
    await api.webhook('payment.captured', api.razorpay.pay(res.body!.razorpay.order_id) as unknown as Record<string, unknown>);
    const r = await job('/v1/jobs/reconcile');
    expect(r.body).toMatchObject({ status: 'ok', mismatches: 0, fixed: 0 });
  });

  it('repairs an order whose webhook never arrived, then reports it as fixed', async () => {
    const res = await checkout();
    api.razorpay.pay(res.body!.razorpay.order_id); // customer paid; no webhook came
    const before = await api.call('GET', `/v1/orders/${res.body!.public_token}`);
    expect(before.body!.status).toBe('awaiting_payment');

    const r = await job('/v1/jobs/reconcile');
    expect(r.body).toMatchObject({ status: 'fixed', fixed: 1, mismatches: 0 });
    const after = await api.call('GET', `/v1/orders/${res.body!.public_token}`);
    expect(after.body!.status).toBe('pending');
    expect(after.body!.order_number).toMatch(/^SL-/);

    // A second run has nothing left to fix.
    expect((await job('/v1/jobs/reconcile')).body).toMatchObject({ status: 'ok', fixed: 0 });
  });
});

describe('dispute webhooks', () => {
  it('a chargeback holds the order, freezes the customer and flags it', async () => {
    const res = await checkout();
    const payment = api.razorpay.pay(res.body!.razorpay.order_id);
    await api.webhook('payment.captured', payment as unknown as Record<string, unknown>);
    const hook = await api.call('POST', '/v1/webhooks/razorpay', {
      raw: JSON.stringify({ event: 'payment.dispute.created', payload: { dispute: { entity: { id: 'disp_9', payment_id: payment.id, amount: payment.amount } } } }),
      headers: {
        'x-razorpay-signature': await (await import('../functions/api/razorpay.ts')).hmacHex(
          'whsec_test',
          JSON.stringify({ event: 'payment.dispute.created', payload: { dispute: { entity: { id: 'disp_9', payment_id: payment.id, amount: payment.amount } } } }),
        ),
        'x-razorpay-event-id': `evt_${crypto.randomUUID()}`,
      },
    });
    expect(hook.status).toBe(200);
    const [o] = await db.admin<any>(
      `select o.on_hold, c.is_frozen, p.status from public.orders o join public.customers c on c.id = o.customer_id
         join public.payments p on p.order_id = o.id where o.public_token = $1`,
      [res.body!.public_token],
    );
    expect(o).toMatchObject({ on_hold: true, is_frozen: true, status: 'disputed' });
    expect(await db.admin(`select 1 from public.fraud_flags where rule = 'DISPUTE_OPENED'`)).toHaveLength(1);
  });
});

describe('nightly job', () => {
  it('runs the pattern rules, tidies up and checks both chains', async () => {
    await f.giveLoyalty('+919870012345', 50000);
    const r = await job('/v1/jobs/nightly');
    expect(r.body).toMatchObject({ audit_chain_ok: true, ledger_chain_ok: true, flags_raised: expect.any(Number) });
    expect(r.body!.housekeeping).toMatchObject({ orders_removed: expect.any(Number), webhooks_trimmed: expect.any(Number) });
  });
});

describe('blocked customers', () => {
  it('can’t check out online, and aren’t told why', async () => {
    const res = await checkout();
    const [o] = await db.admin<{ id: string; customer_mobile: string }>('select id, customer_mobile from public.orders where public_token = $1', [res.body!.public_token]);
    await db.admin(
      `insert into public.blocked_identities (branch_id, kind, value_hash, masked, scope, reason)
       values ($1, 'mobile', app.hash_mobile($2), 'xx', 'all', 'Test block')`,
      [db.branchId, o!.customer_mobile],
    );
    const again = await api.call('POST', '/v1/checkout', {
      body: { ...body(), customer: { name: 'Riya', mobile: o!.customer_mobile.slice(3) } },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      ip: crypto.randomUUID(),
    });
    expect(again.status).toBe(403);
    expect(again.body!.error.code).toBe('ORDER_NOT_ALLOWED');
    expect(again.body!.error.message).not.toMatch(/block/i);
  });
});
