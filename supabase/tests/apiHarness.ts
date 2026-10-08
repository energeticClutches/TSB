/** Runs the real Edge API handler against PGlite with a fake Razorpay and a fixed clock. */
import { type Db, type Deps, handle } from '../functions/api/handler.ts';
import { type Razorpay, RazorpayUnavailable, type RzpPayment, hmacHex } from '../functions/api/razorpay.ts';
import type { TestDb } from './harness';

export class FakeRazorpay implements Razorpay {
  keyId = 'rzp_test_fake';
  down = false;
  orders = new Map<string, { amount: number; receipt: string }>();
  payments = new Map<string, RzpPayment[]>();
  refunds: { id: string; payment_id: string; amount_paise: number; receipt: string }[] = [];
  private n = 0;
  /** Real Razorpay ids are globally unique; keep the fake's unique across tests too. */
  private uid = () => `${++this.n}${crypto.randomUUID().slice(0, 8)}`;

  async createOrder(input: { amount_paise: number; receipt: string }) {
    if (this.down) throw new RazorpayUnavailable('down');
    const id = `order_T${this.uid()}`;
    this.orders.set(id, { amount: input.amount_paise, receipt: input.receipt });
    return { id };
  }
  async fetchOrderPayments(orderId: string) {
    if (this.down) throw new RazorpayUnavailable('down');
    return this.payments.get(orderId) ?? [];
  }
  /** Everything this fake has "captured", for reconciliation runs. */
  async fetchPayments(from: number, to: number) {
    return [...this.payments.values()].flat().filter((p) => {
      const at = this.capturedAt.get(p.id) ?? this.now().getTime();
      return at >= from * 1000 && at <= to * 1000;
    });
  }
  /** When each payment was captured, on the same clock the API uses. */
  capturedAt = new Map<string, number>();
  now: () => Date = () => new Date();

  async refund(input: { payment_id: string; amount_paise: number; receipt: string }) {
    if (this.down) throw new RazorpayUnavailable('down');
    const id = `rfnd_T${this.uid()}`;
    this.refunds.push({ id, ...input });
    return { id };
  }
  /** Simulate the customer paying in their UPI app (not yet told to us). */
  pay(orderId: string, over: Partial<RzpPayment> = {}): RzpPayment {
    const order = this.orders.get(orderId)!;
    const p: RzpPayment = { id: `pay_T${this.uid()}`, order_id: orderId, amount: order.amount, currency: 'INR', status: 'captured', method: 'upi', vpa: 'rahul@okicici', ...over };
    this.payments.set(orderId, [...(this.payments.get(orderId) ?? []), p]);
    this.capturedAt.set(p.id, this.now().getTime());
    return p;
  }
}

export const WEBHOOK_SECRET = 'whsec_test';
export const SHOP_OPEN = new Date('2026-09-21T15:00:00+05:30');

export function makeApi(db: TestDb, over: Partial<Deps> = {}) {
  const razorpay = new FakeRazorpay();
  const clock = { now: SHOP_OPEN };
  razorpay.now = () => clock.now;
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const adapter: Db = {
    query: async (text, params = []) => (await db.pg.query(text, params)).rows as never,
    transaction: (fn) => db.pg.transaction((tx) => fn({ query: async (t, p = []) => (await tx.query(t, p)).rows as never })),
  };
  const deps: Deps = {
    db: adapter,
    supabaseUrl: 'https://test.supabase.co',
    signingKey: { kid: 'unused', privateJwk: {} },
    verifyKeys: [],
    inviteUser: async () => ({ id: crypto.randomUUID() }),
    razorpay,
    secrets: { razorpayKeySecret: 'rzp_secret', razorpayWebhookSecret: WEBHOOK_SECRET, identityPepper: 'pepper', jobSecret: 'job-secret' },
    verifyTurnstile: async (token) => token === 'ok',
    now: () => clock.now,
    log: (event, data) => logs.push({ event, data }),
    ...over,
  };

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; ip?: string; raw?: string } = {},
  ) => {
    const res = await handle(
      new Request(`https://x.supabase.co/functions/v1/api${path}`, {
        method,
        headers: {
          ...(opts.body !== undefined || opts.raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'cf-connecting-ip': opts.ip ?? '203.0.113.9',
          ...opts.headers,
        },
        ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      deps,
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };

  const webhook = async (event: string, entity: Record<string, unknown>, opts: { eventId?: string; badSignature?: boolean } = {}) => {
    const kind = event.startsWith('refund') ? 'refund' : 'payment';
    const raw = JSON.stringify({ event, payload: { [kind]: { entity } } });
    const sig = opts.badSignature ? 'deadbeef' : await hmacHex(WEBHOOK_SECRET, raw);
    return call('POST', '/v1/webhooks/razorpay', {
      raw,
      headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': opts.eventId ?? `evt_${crypto.randomUUID()}` },
    });
  };

  return { deps, razorpay, clock, logs, call, webhook };
}
