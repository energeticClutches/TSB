import { beforeAll, describe, expect, it } from 'vitest';
import { signJwt } from '../functions/api/jwt.ts';
import { makeApi } from './apiHarness';
import { loadDemoMenu, orderFactory } from './fixtures';
import { type Claims, type TestDb, createTestDb, makeManager, makeOwner, pinSession } from './harness';

let db: TestDb;
let api: ReturnType<typeof makeApi>;
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

  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'k' } as JsonWebKey;
  const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k' } as JsonWebKey;
  api = makeApi(db, { signingKey: { kid: 'k', privateJwk }, verifyKeys: [publicJwk], now: () => new Date() });
});

const token = (claims: Claims) => signJwt({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }, api.deps.signingKey);
const post = async (path: string, claims: Claims | null, body: unknown = {}) =>
  api.call('POST', path, { body, headers: claims ? { Authorization: `Bearer ${await token(claims)}` } : {} });

async function rejectedOrder() {
  const o = await f.paid();
  const [{ version }] = (await db.admin<{ version: number }>('select version from public.orders where id = $1', [o.order_id])) as [{ version: number }];
  const [{ r }] = (await db.as<{ r: { refund_id: string } }>('authenticated', cashier, `select public.reject_order($1, $2, 'Machine broken') as r`, [o.order_id, version])) as [
    { r: { refund_id: string } },
  ];
  return { ...o, refundId: r.refund_id };
}

describe('POST /v1/admin/refunds/:id/decide', () => {
  it('approves, sends the refund to Razorpay with the refund id as the key, then the webhook completes it', async () => {
    const o = await rejectedOrder();
    const res = await post(`/v1/admin/refunds/${o.refundId}/decide`, manager.claims(), { approve: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refund_id: o.refundId, status: 'processing', amount_paise: 48700 });
    const sent = api.razorpay.refunds.find((r) => r.receipt === o.refundId)!;
    expect(sent).toMatchObject({ payment_id: o.payId, amount_paise: 48700 });
    expect(res.body!.provider_refund_id).toBe(sent.id);

    const hook = await api.webhook('refund.processed', { id: sent.id, payment_id: o.payId, amount: 48700, status: 'processed' });
    expect(hook.status).toBe(200);
    const [order] = await db.admin<{ status: string }>('select status from public.orders where id = $1', [o.order_id]);
    expect(order!.status).toBe('refunded');
  });

  it('keeps the decision if Razorpay is down, marks it failed, and a retry sends it once', async () => {
    const o = await rejectedOrder();
    api.razorpay.down = true;
    const res = await post(`/v1/admin/refunds/${o.refundId}/decide`, manager.claims(), { approve: true });
    api.razorpay.down = false;
    expect(res.body).toMatchObject({ status: 'failed' });
    expect((await post(`/v1/admin/refunds/${o.refundId}/retry`, cashier)).body!.error.code).toBe('FORBIDDEN');
    const retry = await post(`/v1/admin/refunds/${o.refundId}/retry`, manager.claims());
    expect(retry.body).toMatchObject({ status: 'processing' });
    expect(api.razorpay.refunds.filter((r) => r.receipt === o.refundId)).toHaveLength(1);
    expect((await post(`/v1/admin/refunds/${o.refundId}/retry`, manager.claims())).body!.error.code).toBe('INVALID_TRANSITION');
  });

  it('declines without calling Razorpay', async () => {
    const o = await rejectedOrder();
    const res = await post(`/v1/admin/refunds/${o.refundId}/decide`, manager.claims(), { approve: false, note: 'Customer took a replacement' });
    expect(res.body).toMatchObject({ status: 'declined' });
    expect(api.razorpay.refunds.some((r) => r.receipt === o.refundId)).toBe(false);
  });

  it('returns the database’s rules as API errors', async () => {
    const o = await rejectedOrder();
    expect((await post(`/v1/admin/refunds/${o.refundId}/decide`, null, { approve: true })).status).toBe(401);
    expect((await post(`/v1/admin/refunds/${o.refundId}/decide`, cashier, { approve: true })).body!.error.code).toBe('FORBIDDEN');
    expect((await post(`/v1/admin/refunds/${o.refundId}/decide`, manager.claims(), {})).status).toBe(422);
    expect((await post('/v1/admin/refunds/not-a-uuid/decide', manager.claims(), { approve: true })).status).toBe(404);

    await db.admin(`update public.settings set value = '100' where key = 'refund_owner_approval_above_paise'`);
    try {
      const big = await rejectedOrder();
      const res = await post(`/v1/admin/refunds/${big.refundId}/decide`, manager.claims(), { approve: true });
      expect(res.status).toBe(202);
      expect(res.body!.error.code).toBe('NEEDS_OWNER_APPROVAL');
      expect((await post(`/v1/admin/refunds/${big.refundId}/decide`, owner.claims(3600), { approve: true })).body!.error.details).toEqual({ reason: 'step_up_required' });
      expect((await post(`/v1/admin/refunds/${big.refundId}/decide`, owner.claims(), { approve: true })).body).toMatchObject({ status: 'processing' });
    } finally {
      await db.admin(`update public.settings set value = '50000' where key = 'refund_owner_approval_above_paise'`);
    }
  });
});

describe('GET /v1/orders/:token/receipt', () => {
  it('is available once the shop accepts', async () => {
    const o = await f.paid();
    expect((await api.call('GET', `/v1/orders/${o.public_token}/receipt`)).status).toBe(404);
    const [{ version }] = (await db.admin<{ version: number }>('select version from public.orders where id = $1', [o.order_id])) as [{ version: number }];
    await db.as('authenticated', cashier, 'select public.accept_order($1, $2)', [o.order_id, version]);
    const res = await api.call('GET', `/v1/orders/${o.public_token}/receipt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.body).toMatchObject({ receipt_number: expect.stringMatching(/^SLB\//), refunded_paise: 0, snapshot: { totals: { total_paise: 48700 } } });
    expect(JSON.stringify(res.body)).not.toContain('9812345678');
  });
});
