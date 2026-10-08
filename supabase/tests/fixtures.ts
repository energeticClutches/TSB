/** Paid-order fixtures for the staff-operation tests. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestDb } from './harness';

export async function loadDemoMenu(db: TestDb) {
  await db.pg.exec(readFileSync(join(import.meta.dirname, '..', 'seed', 'demo_menu.sql'), 'utf8'));
  const variants = await db.admin<{ name: string; product_id: string; variant_id: string }>(
    `select p.name, p.id as product_id, v.id as variant_id from public.products p
       join public.product_variants v on v.product_id = p.id and v.is_default`,
  );
  return Object.fromEntries(variants.map((v) => [v.name, { product_id: v.product_id, variant_id: v.variant_id }]));
}

let seq = 0;

export function orderFactory(db: TestDb, item: { product_id: string; variant_id: string }) {
  const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.as<T>('service_role', {}, sql, params);

  /** A checkout (hidden, unpaid). Two lines: 2× ₹149 and 1× ₹189 = ₹487. */
  async function checkout(over: Record<string, unknown> = {}) {
    seq += 1;
    const payload = {
      branch_id: db.branchId,
      idempotency_key: `ops-${seq}-${crypto.randomUUID()}`,
      request_hash: 'h',
      order_type: 'takeaway',
      customer_name: 'Aarav',
      customer_mobile: '+919812345678',
      subtotal_paise: 48700,
      promo_discount_paise: 0,
      order_discount_paise: 0,
      delivery_fee_paise: 0,
      tax_paise: 0,
      loyalty_eligible_paise: 48700,
      eta_minutes: 6,
      lines: [
        { ...item, product_name: 'Strawberry Splash', variant_name: 'Regular 350 ml', unit_price_paise: 14900, promo_discount_paise: 0,
          qty: 2, line_total_paise: 29800, prep_minutes: 4, options: [{ id: null, group: 'Toppings', name: 'Popping boba', price_paise: 0 }] },
        { ...item, product_name: 'Blue Lagoon', variant_name: 'Mega 500 ml', unit_price_paise: 18900, promo_discount_paise: 0,
          qty: 1, line_total_paise: 18900, prep_minutes: 4, options: [] },
      ],
      ...over,
    };
    const [{ r }] = (await svc<{ r: { order_id: string; public_token: string; total_paise: number } }>(
      'select app.create_order($1::jsonb) as r',
      [JSON.stringify(payload)],
    )) as [{ r: { order_id: string; public_token: string; total_paise: number } }];
    const rzp = `order_ops${seq}${crypto.randomUUID().slice(0, 6)}`;
    await svc('select app.attach_razorpay_order($1, $2)', [r.order_id, rzp]);
    return { ...r, rzp };
  }

  /** A paid order, now `pending` on the board. */
  async function paid(over: Record<string, unknown> = {}, amount?: number) {
    const o = await checkout(over);
    const payId = `pay_ops${seq}${crypto.randomUUID().slice(0, 6)}`;
    await svc('select app.apply_payment_captured($1, $2, $3, $4, $5, $6, $7)', [o.rzp, payId, amount ?? o.total_paise, 'INR', 'upi', 'h', 'aa***@okaxis']);
    return { ...o, payId };
  }

  /** A customer (created if new) with `paise` of loyalty spend already behind them. */
  async function giveLoyalty(mobile: string, paise: number, name = 'Aarav') {
    const [c] = await db.admin<{ id: string }>(
      `insert into public.customers (mobile, name) values ($1, $2) on conflict (mobile) do update set name = excluded.name returning id`,
      [mobile, name],
    );
    if (paise > 0) {
      await db.admin(
        `select app.ledger(k.id, $1, 'manual_loyalty_adjust', $2, null, null, 'test setup')
           from app.active_campaign($3) k`,
        [c!.id, paise, db.branchId],
      );
    }
    return c!.id;
  }

  /** The active campaign row. */
  async function campaign() {
    const [k] = await db.admin<{ id: string; threshold_paise: string; token_limit: number; tokens_issued: number }>(
      'select * from public.campaigns where branch_id = $1 and is_active',
      [db.branchId],
    );
    return k!;
  }

  return { checkout, paid, svc, giveLoyalty, campaign };
}
