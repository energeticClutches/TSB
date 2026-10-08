/**
 * The Lucky Draw: cumulative loyalty spend (excluding GST) earns ONE token per mobile,
 * automatically, until the campaign's 500 numbers run out.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDemoMenu, orderFactory } from './fixtures';
import { type Claims, type TestDb, apiError, createTestDb, makeManager, makeOwner, pinSession } from './harness';

let db: TestDb;
let owner: Awaited<ReturnType<typeof makeOwner>>;
let manager: Awaited<ReturnType<typeof makeManager>>;
let cashier: Claims;
let f: ReturnType<typeof orderFactory>;

beforeAll(async () => {
  db = await createTestDb();
  const menu = await loadDemoMenu(db);
  owner = await makeOwner(db);
  manager = await makeManager(db);
  const [{ id }] = (await db.as<{ id: string }>('authenticated', owner.claims(), `select public.create_pin_staff('Karan', 'cashier', '6173') as id`)) as [{ id: string }];
  cashier = (await pinSession(db, owner.claims(), { staffId: id, pin: '6173', role: 'cashier' })).claims;
  f = orderFactory(db, menu['Strawberry Splash']!);
});

const call = async <T = any>(claims: Claims, sql: string, params: unknown[] = []): Promise<T> =>
  ((await db.as<{ r: T }>('authenticated', claims, `select ${sql} as r`, params))[0] as { r: T }).r;
const row = async (sql: string, params: unknown[] = []) => (await db.admin<any>(sql, params))[0];
const version = async (id: string) => (await row('select version from public.orders where id = $1', [id])).version as number;
const customer = (mobile: string) => row('select * from public.customers where mobile = $1', [mobile]);

/** This mobile's loyalty spend in the running campaign. */
const spendOf = async (mobile: string) =>
  Number(
    (
      await row(
        `select coalesce(a.spend_paise, 0) as spend from public.customers c
           left join public.loyalty_accounts a on a.customer_id = c.id
          where c.mobile = $1`,
        [mobile],
      )
    ).spend,
  );
const tokenOf = async (mobile: string) =>
  await row(
    `select t.* from public.lucky_draw_tokens t join public.customers c on c.id = t.customer_id where c.mobile = $1`,
    [mobile],
  );

let mobileSeq = 1000;
const newMobile = () => `+91980000${String(mobileSeq++).padStart(4, '0')}`;

async function step(id: string, to: string, claims: Claims = cashier) {
  return call(claims, 'public.advance_order($1, $2, $3::public.order_status)', [id, await version(id), to]);
}
/** A paid order taken all the way to Completed. 48,700 paise of eligible spend unless overridden. */
async function completedOrder(mobile: string, over: Record<string, unknown> = {}) {
  const o = await f.paid({ customer_mobile: mobile, ...over });
  await call(cashier, 'public.accept_order($1, $2)', [o.order_id, await version(o.order_id)]);
  for (const s of ['preparing', 'ready', 'completed']) await step(o.order_id, s);
  return o;
}

describe('earning the Lucky Draw token', () => {
  it('adds the pre-GST value of every completed order to the same mobile', async () => {
    const m = newMobile();
    await completedOrder(m);
    expect(await spendOf(m)).toBe(48700);
    await completedOrder(m);
    await completedOrder(m);
    expect(await spendOf(m)).toBe(3 * 48700);
    // Under ₹2,000 so far: no token yet.
    expect(await tokenOf(m)).toBeUndefined();
  });

  it('issues exactly one token, automatically, the moment cumulative spend reaches ₹2,000', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 175000); // ₹1,750 of earlier orders
    expect(await tokenOf(m)).toBeUndefined();
    await completedOrder(m, { subtotal_paise: 30000, loyalty_eligible_paise: 30000, lines: [line(30000)] });
    expect(await spendOf(m)).toBe(205000);
    const t = await tokenOf(m);
    expect(t).toMatchObject({ status: 'issued', serial: expect.any(Number) });
    expect(t.code).toMatch(/^SLB-\d{3}$/);
    expect(Number(t.spend_at_issue_paise)).toBe(205000);
  });

  it('the exact worked example from the rules: ₹700 + ₹650 + ₹400 + ₹300 earns SLB on the fourth order, and never again', async () => {
    const m = newMobile();
    for (const rupees of [700, 650, 400]) {
      await completedOrder(m, { subtotal_paise: rupees * 100, loyalty_eligible_paise: rupees * 100, lines: [line(rupees * 100)] });
      expect(await tokenOf(m)).toBeUndefined();
    }
    expect(await spendOf(m)).toBe(175000);
    await completedOrder(m, { subtotal_paise: 30000, loyalty_eligible_paise: 30000, lines: [line(30000)] });
    const first = await tokenOf(m);
    expect(first.status).toBe('issued');
    expect(await spendOf(m)).toBe(205000);

    // ₹5,000 and then ₹20,000 more: the spend keeps growing, the token stays the same one.
    await completedOrder(m, { subtotal_paise: 500000, loyalty_eligible_paise: 500000, lines: [line(500000)] });
    await completedOrder(m, { subtotal_paise: 2000000, loyalty_eligible_paise: 2000000, lines: [line(2000000)] });
    expect(await spendOf(m)).toBe(2705000);
    const all = await db.admin<any>(
      'select t.* from public.lucky_draw_tokens t join public.customers c on c.id = t.customer_id where c.mobile = $1',
      [m],
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.code).toBe(first.code);
  });

  it('GST is never counted: only the value of the drinks after discounts', async () => {
    const m = newMobile();
    // ₹1,900 of drinks + ₹342 GST = ₹2,242 paid, but only ₹1,900 is loyalty spend.
    await completedOrder(m, { subtotal_paise: 190000, loyalty_eligible_paise: 190000, tax_paise: 34200, lines: [line(190000)] });
    expect(Number((await row('select total_paise from public.orders where customer_mobile = $1 order by created_at desc limit 1', [m])).total_paise)).toBe(224200);
    expect(await spendOf(m)).toBe(190000);
    expect(await tokenOf(m)).toBeUndefined();
    // The next ₹150 tips them over.
    await completedOrder(m, { subtotal_paise: 15000, loyalty_eligible_paise: 15000, lines: [line(15000)] });
    expect(await spendOf(m)).toBe(205000);
    expect((await tokenOf(m)).status).toBe('issued');
  });

  it('numbers run SLB-001, SLB-002, … in order, one per customer', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = newMobile();
      await f.giveLoyalty(m, 200000);
      await completedOrder(m, { subtotal_paise: 10000, loyalty_eligible_paise: 10000, lines: [line(10000)] });
      codes.push((await tokenOf(m)).code);
    }
    const serials = codes.map((c) => Number(c.slice(4)));
    expect(serials).toEqual([serials[0], serials[0]! + 1, serials[0]! + 2]);
    const k = await f.campaign();
    expect(k.tokens_issued).toBe(serials.at(-1));
  });

  it('stops dead when the campaign runs out of tokens; loyalty spend still accumulates', async () => {
    const k = await f.campaign();
    await db.admin('update public.campaigns set tokens_issued = token_limit where id = $1', [k.id]);
    const m = newMobile();
    await f.giveLoyalty(m, 300000);
    await completedOrder(m);
    expect(await tokenOf(m)).toBeUndefined();
    expect(await spendOf(m)).toBe(348700);
    await db.admin('update public.campaigns set tokens_issued = $2 where id = $1', [k.id, k.tokens_issued]);
  });

  it('an order that was never completed earns nothing', async () => {
    const m = newMobile();
    await f.paid({ customer_mobile: m });
    expect(await spendOf(m)).toBe(0);
  });
});

describe('refunds, disputes and freezing', () => {
  it('a refund takes its own spend back out and flags a token that is no longer deserved', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 160000);
    const o = await completedOrder(m);
    expect(await spendOf(m)).toBe(208700);
    const t = await tokenOf(m);
    expect(t.status).toBe('issued');

    const req = await call(manager.claims(), `public.request_refund($1, 'full', null, $2)`, [o.order_id, 'Customer complained']);
    await db.admin(`update public.refunds set provider_refund_id = $2 where id = $1`, [req.refund_id, 'rfnd_loy1']);
    await f.svc(`select app.apply_refund_event('rfnd_loy1', $1, $2, true, null)`, [o.payId, 48700]);

    expect(await spendOf(m)).toBe(160000);
    // The entry is not snatched back automatically — a manager is told to look at it.
    expect((await tokenOf(m)).status).toBe('issued');
    expect(await db.admin(`select 1 from public.fraud_flags where rule = 'TOKEN_AFTER_REFUND'`)).toHaveLength(1);
  });

  it('a manager can void a token, with a reason; the number is retired, not reissued', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 200000);
    await completedOrder(m, { subtotal_paise: 10000, loyalty_eligible_paise: 10000, lines: [line(10000)] });
    const t = await tokenOf(m);
    const before = (await f.campaign()).tokens_issued;

    expect((await apiError(call(cashier, 'public.void_lucky_draw_token($1, $2)', [t.id, 'Refund abuse']))).code).toBe('FORBIDDEN');
    expect((await apiError(call(manager.claims(), 'public.void_lucky_draw_token($1, $2)', [t.id, 'x']))).code).toBe('VALIDATION_FAILED');
    await call(manager.claims(), 'public.void_lucky_draw_token($1, $2)', [t.id, 'Refund abuse']);
    expect(await tokenOf(m)).toMatchObject({ status: 'void', void_reason: 'Refund abuse' });
    expect((await apiError(call(manager.claims(), 'public.void_lucky_draw_token($1, $2)', [t.id, 'Again']))).code).toBe('INVALID_TRANSITION');
    // The count doesn't go down, so SLB-007 is never handed out twice.
    expect((await f.campaign()).tokens_issued).toBe(before);
    // And they can't earn a replacement, however much more they spend.
    await completedOrder(m, { subtotal_paise: 500000, loyalty_eligible_paise: 500000, lines: [line(500000)] });
    expect((await tokenOf(m)).status).toBe('void');
  });

  it('a frozen customer keeps ordering but earns nothing', async () => {
    const m = newMobile();
    const id = await f.giveLoyalty(m, 100000);
    expect((await apiError(call(cashier, 'public.set_customer_frozen($1, true, $2)', [id, 'Chargeback']))).code).toBe('FORBIDDEN');
    await call(manager.claims(), 'public.set_customer_frozen($1, true, $2)', [id, 'Chargeback']);
    await completedOrder(m);
    expect(await spendOf(m)).toBe(100000);
    const ctx = await f.svc<{ r: any }>('select app.offer_context($1, $2, null, null) as r', [db.branchId, m]);
    expect(ctx[0]!.r.loyalty).toMatchObject({ running: true, frozen: true, spend_paise: 100000 });
    await call(manager.claims(), 'public.set_customer_frozen($1, false, $2)', [id, 'Reviewed: bank error']);
    await completedOrder(m);
    expect(await spendOf(m)).toBe(148700);
  });
});

describe('manual corrections', () => {
  it('a manager can correct loyalty spend with a reason, and a big day needs the Owner', async () => {
    const m = newMobile();
    const id = await f.giveLoyalty(m, 0);
    expect((await apiError(call(cashier, 'public.adjust_loyalty($1, 1000, $2)', [id, 'Goodwill']))).code).toBe('FORBIDDEN');
    expect((await apiError(call(manager.claims(), 'public.adjust_loyalty($1, 1000, $2)', [id, 'x']))).code).toBe('VALIDATION_FAILED');
    expect((await apiError(call(manager.claims(), 'public.adjust_loyalty($1, 0, $2)', [id, 'Nothing']))).code).toBe('VALIDATION_FAILED');

    const ok = await call(manager.claims(), 'public.adjust_loyalty($1, 50000, $2)', [id, 'Counter order, paid in cash']);
    expect(ok).toMatchObject({ status: 'done', spend_paise: 50000 });
    expect(await spendOf(m)).toBe(50000);

    // The daily cap is 3: the fourth correction has to go to the Owner.
    await call(manager.claims(), 'public.adjust_loyalty($1, 10000, $2)', [id, 'Counter order two']);
    await call(manager.claims(), 'public.adjust_loyalty($1, 10000, $2)', [id, 'Counter order three']);
    const over = await call(manager.claims(), 'public.adjust_loyalty($1, 10000, $2)', [id, 'Counter order four']);
    expect(over.status).toBe('needs_owner');
    expect(await spendOf(m)).toBe(70000);
    await call(owner.claims(), 'public.decide_approval($1, true, null)', [over.approval_id]);
    expect(await spendOf(m)).toBe(80000);
  });

  it('a correction that crosses the line issues the token, exactly like an order would', async () => {
    const m = newMobile();
    const id = await f.giveLoyalty(m, 190000);
    const r = await call(owner.claims(), 'public.adjust_loyalty($1, 20000, $2)', [id, 'Missed counter order']);
    expect(r.token).toMatch(/^SLB-\d{3}$/);
    expect((await tokenOf(m)).status).toBe('issued');
  });

  it('spend can never be pushed below zero', async () => {
    const m = newMobile();
    const id = await f.giveLoyalty(m, 10000);
    await call(manager.claims(), 'public.adjust_loyalty($1, -50000, $2)', [id, 'Order was never made']);
    expect(await spendOf(m)).toBe(0);
  });
});

describe('the staff screens', () => {
  it('the overview counts what is issued, what is left and who is close', async () => {
    const o = await call(cashier, 'public.lucky_draw_overview()');
    expect(o.token_limit).toBe(500);
    expect(o.tokens_issued + o.tokens_left).toBe(500);
    expect(o.customers_with_tokens).toBeGreaterThan(0);
    expect(o.customers_close).toBeGreaterThanOrEqual(0);
    expect(Number(o.loyalty_spend_paise)).toBeGreaterThan(0);
  });

  it('the token list can be searched by number, name and mobile', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 200000, 'Ishita');
    await completedOrder(m, { subtotal_paise: 10000, loyalty_eligible_paise: 10000, lines: [line(10000)] });
    const t = await tokenOf(m);

    const all = await call(cashier, 'public.lucky_draw_tokens_list(null, 500)');
    expect(all.map((x: any) => x.code)).toContain(t.code);
    expect(await call(cashier, `public.lucky_draw_tokens_list($1, 100)`, [t.code.toLowerCase()])).toHaveLength(1);
    expect((await call(cashier, `public.lucky_draw_tokens_list($1, 100)`, [m.slice(3)]))[0].code).toBe(t.code);
    // Never the full mobile number, even here.
    expect(all[0].mobile_masked).toMatch(/^98xxxxx\d{3}$/);
  });

  it('the leaderboard shows who is closest without a token yet', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 175000, 'Nearly');
    const board = await call(cashier, 'public.loyalty_leaderboard(50)');
    const me = board.find((x: any) => x.customer_name === 'Nearly');
    expect(me).toMatchObject({ spend_paise: 175000, remaining_paise: 25000 });
    expect(board.every((x: any) => Number(x.spend_paise) < 200000 || !x.token)).toBe(true);
  });

  it('a number can be looked up for the draw', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 200000, 'Draw winner');
    await completedOrder(m, { subtotal_paise: 10000, loyalty_eligible_paise: 10000, lines: [line(10000)] });
    const t = await tokenOf(m);
    const v = await call(cashier, 'public.verify_token($1)', [t.code.toLowerCase()]);
    expect(v).toMatchObject({ valid: true, status: 'issued', customer: { mobile_masked: `98xxxxx${m.slice(-3)}` } });
    expect(await call(cashier, 'public.verify_token($1)', ['SLB-999'])).toEqual({ valid: false });
  });

  it('customer detail and search show the spend and the token', async () => {
    const m = newMobile();
    const id = await f.giveLoyalty(m, 200000, 'Meera');
    await completedOrder(m, { subtotal_paise: 10000, loyalty_eligible_paise: 10000, lines: [line(10000)] });

    const asCashier = await call(cashier, 'public.customer_detail($1)', [id]);
    expect(asCashier).toMatchObject({ loyalty_spend_paise: 210000, threshold_paise: 200000 });
    expect(asCashier.token.code).toMatch(/^SLB-\d{3}$/);
    expect(asCashier.ledger).toBeNull(); // the history is a manager's business
    const asManager = await call(manager.claims(), 'public.customer_detail($1)', [id]);
    expect(asManager.ledger.length).toBeGreaterThan(0);
    expect((await call(cashier, 'public.customer_search($1)', [m.slice(3)]))[0]).toMatchObject({ id, token: asCashier.token.code });
  });

  it('the tracker tells the customer where they stand once the order is done', async () => {
    const m = newMobile();
    await f.giveLoyalty(m, 100000);
    const o = await completedOrder(m);
    const [{ r }] = await f.svc<{ r: any }>('select app.order_rewards_public($1) as r', [o.public_token]);
    expect(r).toMatchObject({ spend_paise: 148700, threshold_paise: 200000, earned_paise: 48700, token: null });
    expect(r.tokens_left).toBeGreaterThan(0);
  });
});

describe('the loyalty history', () => {
  it('is append-only and hash-chained', async () => {
    expect((await f.svc<{ r: unknown }>('select app.verify_ledger_chain() as r'))[0]!.r).toBeNull();
    await expect(db.admin('update public.token_ledger set spend_delta_paise = 99 where id = (select min(id) from public.token_ledger)')).rejects.toThrow();
    await expect(db.admin('delete from public.token_ledger')).rejects.toThrow();
  });

  it('spots a tampered row', async () => {
    await db.admin(`alter table public.token_ledger disable trigger token_ledger_no_update`);
    const [first] = await db.admin<any>('select id from public.token_ledger order by id limit 1');
    await db.admin('update public.token_ledger set spend_delta_paise = spend_delta_paise + 1 where id = $1', [first!.id]);
    expect(Number((await f.svc<{ r: number }>('select app.verify_ledger_chain() as r'))[0]!.r)).toBe(Number(first!.id));
    await db.admin('update public.token_ledger set spend_delta_paise = spend_delta_paise - 1 where id = $1', [first!.id]);
    await db.admin(`alter table public.token_ledger enable trigger token_ledger_no_update`);
    expect((await f.svc<{ r: unknown }>('select app.verify_ledger_chain() as r'))[0]!.r).toBeNull();
  });
});

/** One order line worth `paise`, so a test can set its own order value. */
function line(paise: number) {
  return {
    product_name: 'Strawberry Splash',
    variant_name: 'Regular 350 ml',
    unit_price_paise: paise,
    promo_discount_paise: 0,
    qty: 1,
    line_total_paise: paise,
    prep_minutes: 4,
    options: [],
  };
}
