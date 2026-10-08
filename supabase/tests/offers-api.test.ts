import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApi } from './apiHarness';
import { loadDemoMenu, orderFactory } from './fixtures';
import { type TestDb, createTestDb, makeManager, makeOwner } from './harness';

let db: TestDb;
let api: ReturnType<typeof makeApi>;
let counterQr: string;
let straw: { product_id: string; variant_id: string };
let options: string[];
let f: ReturnType<typeof orderFactory>;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let manager: Awaited<ReturnType<typeof makeManager>>;

const setting = (key: string, value: unknown) => db.admin(`update public.settings set value = $2::jsonb where key = $1`, [key, JSON.stringify(value)]);

beforeAll(async () => {
  db = await createTestDb();
  const menu = await loadDemoMenu(db);
  straw = menu['Strawberry Splash']!;
  f = orderFactory(db, straw);
  owner = await makeOwner(db);
  manager = await makeManager(db);
  [{ slug: counterQr }] = (await db.admin<{ slug: string }>(`insert into public.qr_codes (branch_id, kind) values ($1, 'counter') returning slug`, [db.branchId])) as [{ slug: string }];
  const opts = await db.admin<{ id: string }>(
    `select o.id from public.modifier_options o join public.modifier_groups g on g.id = o.group_id
      join public.product_modifier_groups pg on pg.group_id = g.id
     where pg.product_id = $1 and o.is_default`,
    [straw.product_id],
  );
  options = opts.map((o) => o.id);
  await setting('offers_enabled', true);
});

beforeEach(() => {
  api = makeApi(db);
});

let seq = 200;
const mobile = () => `98765${String(seq++).padStart(5, '0')}`;
const line = (over: Record<string, unknown> = {}) => ({ line_id: `l${seq}`, ...straw, qty: 2, option_ids: options, ...over });
const body = (over: Record<string, unknown> = {}) => ({
  qr_slug: counterQr,
  order_type: 'takeaway',
  lines: [line()],
  customer: { name: 'Riya', mobile: mobile() },
  note: '',
  device_id: crypto.randomUUID(),
  'cf-turnstile-response': 'ok',
  ...over,
});
const checkout = (b: Record<string, unknown>) => api.call('POST', '/v1/checkout', { body: b, headers: { 'Idempotency-Key': crypto.randomUUID() }, ip: crypto.randomUUID() });
const quote = (b: Record<string, unknown>) => api.call('POST', '/v1/cart/quote', { body: b, ip: crypto.randomUUID() });
const staffCall = (sql: string, params: unknown[] = []) => db.as<any>('authenticated', manager.claims(), `select ${sql} as r`, params);

describe('coupons at the counter of the API', () => {
  beforeAll(async () => {
    await db.as('authenticated', owner.claims(), `select public.upsert_coupon($1::jsonb)`, [
      JSON.stringify({ code: 'SLUSH10', discount_type: 'percent', value: 1000, max_discount_paise: 5000, min_order_paise: 20000, usage_limit_total: 50, usage_limit_per_customer: 1, is_active: true }),
    ]);
  });

  it('the quote reports a coupon problem without failing, and applies a good one', async () => {
    const bad = await quote(body({ coupon_code: 'NOPE' }));
    expect(bad.status).toBe(200);
    expect(bad.body!.coupon).toMatchObject({ status: 'invalid' });
    expect(bad.body!.order_discount_paise).toBe(0);

    const small = await quote(body({ coupon_code: 'slush10', lines: [line({ qty: 1 })] }));
    expect(small.body!.coupon).toMatchObject({ status: 'min_not_met' });

    const good = await quote(body({ coupon_code: 'slush10' }));
    expect(good.body!.coupon).toMatchObject({ status: 'applied', code: 'SLUSH10', discount_paise: 2980 });
    expect(good.body!.total_paise).toBe(29800 - 2980);
  });

  it('checkout refuses a bad coupon, and records a good one', async () => {
    const bad = await checkout(body({ coupon_code: 'NOPE' }));
    expect(bad.status).toBe(422);
    expect(bad.body!.error.code).toBe('COUPON_INVALID');

    const res = await checkout(body({ coupon_code: 'SLUSH10' }));
    expect(res.status).toBe(201);
    expect(res.body!.total_paise).toBe(26820);
    const [o] = await db.admin<any>(`select o.order_discount_paise, o.coupon_id, r.discount_paise from public.orders o
      join public.coupon_redemptions r on r.order_id = o.id where o.public_token = $1`, [res.body!.public_token]);
    expect(o).toMatchObject({ order_discount_paise: 2980, discount_paise: 2980 });
  });
});

describe('happy hour', () => {
  it('shows on the menu and discounts matching items during its hours', async () => {
    const [cat] = await db.admin<{ id: string }>(`select category_id as id from public.products where id = $1`, [straw.product_id]);
    // SHOP_OPEN is 15:00 IST.
    await staffCall('public.upsert_promotion($1::jsonb)', [
      JSON.stringify({ kind: 'happy_hour', name: '20% off slushes', discount_type: 'percent', value: 2000, start_time: '14:00', end_time: '17:00', category_ids: [cat!.id], is_active: true }),
    ]);
    const menu = await api.call('GET', '/v1/menu?branch=bahadurgarh-s6');
    expect(menu.body!.promotions).toEqual([expect.objectContaining({ label: '20% off slushes', kind: 'happy_hour' })]);
    const q = await quote(body({ lines: [line({ qty: 1 })] }));
    expect(q.body!.promo_discount_paise).toBe(2980);
    api.clock.now = new Date('2026-09-21T18:00:00+05:30');
    expect((await quote(body({ lines: [line({ qty: 1 })] }))).body!.promo_discount_paise).toBe(0);
    await db.admin(`update public.promotions set is_active = false`);
  });
});

describe('the Lucky Draw at checkout', () => {
  it('tells the customer how close they are, and never leaks their name', async () => {
    const m = mobile();
    await f.giveLoyalty(`+91${m}`, 175000);
    const q = await quote(body({ mobile: m, lines: [line({ qty: 1 })] }));
    expect(q.body!.loyalty).toMatchObject({
      running: true,
      spend_paise: 175000,
      threshold_paise: 200000,
      adds_paise: 14900,
      after_paise: 189900,
      remaining_paise: 10100,
      token: null,
      earns_token: false,
    });
    expect(JSON.stringify(q.body)).not.toContain('Aarav');
  });

  it('says when this very order earns the token', async () => {
    const m = mobile();
    await f.giveLoyalty(`+91${m}`, 195000);
    const q = await quote(body({ mobile: m, lines: [line({ qty: 1 })] }));
    expect(q.body!.loyalty).toMatchObject({ after_paise: 209900, remaining_paise: 0, earns_token: true });
  });

  it('a new mobile starts at zero and the Lucky Draw is still running', async () => {
    const q = await quote(body({ mobile: mobile(), lines: [line({ qty: 1 })] }));
    expect(q.body!.loyalty).toMatchObject({ running: true, spend_paise: 0, earns_token: false, tokens_left: 500 });
  });

  it('the order records only its pre-GST value as loyalty spend', async () => {
    const m = mobile();
    const res = await checkout(body({ customer: { name: 'Aarav', mobile: m }, lines: [line({ qty: 2 })] }));
    expect(res.status).toBe(201);
    const [o] = await db.admin<any>(`select loyalty_eligible_paise, total_paise from public.orders where public_token = $1`, [res.body!.public_token]);
    expect(o).toMatchObject({ loyalty_eligible_paise: 29800, total_paise: 29800 });
  });

  it('the tracker shows the loyalty spend after completion', async () => {
    const m = mobile();
    const res = await checkout(body({ customer: { name: 'Diya', mobile: m } }));
    await api.webhook('payment.captured', api.razorpay.pay(res.body!.razorpay.order_id) as unknown as Record<string, unknown>);
    const [o] = await db.admin<{ id: string }>(`select id from public.orders where public_token = $1`, [res.body!.public_token]);
    await db.admin(`update public.orders set status = 'confirmed', confirmed_at = now() - interval '5 minutes' where id = $1`, [o!.id]);
    for (const s of ['preparing', 'ready', 'completed']) await db.admin(`update public.orders set status = $2::public.order_status where id = $1`, [o!.id, s]);
    const t = await api.call('GET', `/v1/orders/${res.body!.public_token}`);
    expect(t.body!.loyalty).toMatchObject({ spend_paise: 29800, threshold_paise: 200000, token: null, earned_paise: 29800 });
  });
});

describe('nightly job', () => {
  it('needs the job secret and checks both hash chains', async () => {
    expect((await api.call('POST', '/v1/jobs/nightly', { body: {} })).status).toBe(403);
    const r = await api.call('POST', '/v1/jobs/nightly', { body: {}, headers: { 'x-job-secret': 'job-secret' } });
    expect(r.body).toMatchObject({ audit_chain_ok: true, ledger_chain_ok: true });
  });
});
