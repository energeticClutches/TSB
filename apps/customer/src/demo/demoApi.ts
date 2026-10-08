/**
 * Demo backend: the real pricing engine + a simulated kitchen, all in the browser.
 * No money moves and nothing leaves the phone. Only bundled when VITE_DEMO=true.
 */
import { type Coupon, distanceMetres, orderingStatus, priceCart, quoteFingerprint } from '@slush/core';
import { ApiError, type OrderStatus, type OrderingApi, type PublicOrder, type Quote } from '../lib/api';
import { load, save } from '../lib/storage';
import { demoMenu } from './demoMenu';

interface DemoOrder {
  token: string;
  mobile?: string;
  eligible?: number;
  counted?: boolean;
  number: string;
  pickup: number;
  paidAt: number | null;
  createdAt: number;
  cancelledAt: number | null;
  order: Omit<PublicOrder, 'status' | 'timeline' | 'payment_status' | 'can_cancel' | 'placed_at' | 'refund'>;
}

const KEY = 'slush-demo-orders';
const LOYALTY = 'slush-demo-loyalty';

// Demo shop pin (approximate; the real one comes from the owner, B6) and delivery rules.
const SHOP = { lat: 28.6923, lng: 76.9239 };
const DELIVERY = { radius_m: 5000, fee_paise: 3000, min_order_paise: 20000 };
const THRESHOLD = 200_000;
const TOKEN_LIMIT = 500;
const COUPONS: Record<string, Coupon> = {
  SLUSH10: { id: 'demo-slush10', code: 'SLUSH10', discount_type: 'percent', value: 1000, max_discount_paise: 5000, min_order_paise: 20000 },
  WELCOME50: { id: 'demo-welcome50', code: 'WELCOME50', discount_type: 'flat', value: 5000, max_discount_paise: null, min_order_paise: 30000 },
};
/**
 * Demo loyalty by mobile: spending counted so far, and the Lucky Draw number once earned.
 * 98765 43210 starts at ₹1,750 so the last step before a token can be tried in one order.
 */
type Loyal = { spend: number; token: string | null };
const loyalty = () => load<Record<string, Loyal>>(LOYALTY, { '9876543210': { spend: 175_000, token: null } });
const loyaltyOf = (m: string): Loyal => loyalty()[m] ?? { spend: 0, token: null };
const issued = () => Object.values(loyalty()).filter((l) => l.token).length;

/** Count an order's spending and, if that crosses the line, hand out the one token. */
function countLoyalty(mobile: string, paise: number) {
  if (!mobile || paise <= 0) return;
  const all = loyalty();
  const l = all[mobile] ?? { spend: 0, token: null };
  l.spend += paise;
  if (!l.token && l.spend >= THRESHOLD && issued() < TOKEN_LIMIT) {
    l.token = `SLB-${String(issued() + 1).padStart(3, '0')}`;
  }
  save(LOYALTY, { ...all, [mobile]: l });
}
const digits = (m: string | undefined) => (m ?? '').replace(/\D/g, '').slice(-10);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Simulated kitchen: accepted after 6 s, blending at 12 s, ready at 30 s, completed at 90 s.
const STEPS: [OrderStatus, number][] = [
  ['pending', 0],
  ['confirmed', 6_000],
  ['preparing', 12_000],
  ['ready', 30_000],
  ['completed', 90_000],
];

function view(o: DemoOrder): PublicOrder {
  if (!o.paidAt) {
    return { ...o.order, status: 'awaiting_payment', timeline: [], payment_status: 'pending', can_cancel: false, placed_at: null, refund: null };
  }
  const elapsed = Date.now() - o.paidAt;
  const reached = STEPS.filter(([, at]) => elapsed >= at);
  let timeline = reached.map(([status, at]) => ({ status, at: new Date(o.paidAt! + at).toISOString() }));
  let status = reached.at(-1)![0];
  let refund: PublicOrder['refund'] = null;
  if (o.cancelledAt) {
    timeline = [...timeline.filter((t) => new Date(t.at).getTime() <= o.cancelledAt!), { status: 'cancelled', at: new Date(o.cancelledAt).toISOString() }];
    status = 'cancelled';
    refund = { status: 'processing', amount_paise: o.order.total_paise };
  }
  let loyal: PublicOrder['loyalty'] = null;
  if (status === 'completed' && o.mobile) {
    // The real shop counts this when the order completes; the demo does it the first time it is seen.
    if (!o.counted) {
      countLoyalty(o.mobile, o.eligible ?? 0);
      update(o.token, { counted: true });
    }
    const l = loyaltyOf(o.mobile);
    loyal = { spend_paise: l.spend, threshold_paise: THRESHOLD, earned_paise: o.eligible ?? 0, token: l.token, tokens_left: TOKEN_LIMIT - issued() };
  }
  return {
    ...o.order,
    status,
    timeline,
    payment_status: o.cancelledAt ? 'refunded' : 'successful',
    can_cancel: status === 'pending',
    placed_at: new Date(o.paidAt).toISOString(),
    refund,
    loyalty: loyal,
  };
}

const orders = () => load<DemoOrder[]>(KEY, []);
const find = (token: string) => {
  const o = orders().find((x) => x.token === token);
  if (!o) throw new ApiError('NOT_FOUND', 'Order not found.', {}, 404);
  return o;
};
const update = (token: string, patch: Partial<DemoOrder>) => save(KEY, orders().map((o) => (o.token === token ? { ...o, ...patch } : o)));

function priceQuote(req: Parameters<OrderingApi['quote']>[0]): Quote {
  const mobile = digits(req.mobile);
  const l = mobile.length === 10 ? loyaltyOf(mobile) : { spend: 0, token: null };
  const code = req.coupon_code?.trim().toUpperCase();
  const coupon = code ? (COUPONS[code] ?? null) : null;
  const distance = req.order_type === 'delivery' && req.delivery ? distanceMetres(SHOP, req.delivery) : null;
  const r = priceCart({
    menu: demoMenu,
    lines: req.lines,
    now: new Date(),
    orderType: req.order_type,
    promotions: demoMenu.promotions ?? [],
    coupon,
    delivery: distance === null ? null : { distance_m: distance, ...DELIVERY },
  });
  const open = orderingStatus(new Date(), { hours: demoMenu.branch.hours, lastOrderBufferMin: demoMenu.branch.last_order_buffer_min });
  return {
    quote_hash: `qh_${quoteFingerprint(r).length}_${r.total_paise}`,
    lines: r.lines.map((l) => ({
      line_id: l.line_id,
      name: l.product_name,
      variant: l.variant_name,
      options: l.options.map((o) => o.name),
      qty: l.qty,
      unit_price_paise: l.unit_price_paise,
      promo_discount_paise: l.promo_discount_paise,
      line_total_paise: l.line_total_paise,
      problems: l.problems,
    })),
    subtotal_paise: r.subtotal_paise,
    promo_discount_paise: r.promo_discount_paise,
    order_discount_paise: r.order_discount_paise,
    delivery_fee_paise: r.delivery_fee_paise,
    tax_paise: r.tax_paise,
    total_paise: r.total_paise,
    eta_minutes: r.eta_minutes,
    problems: r.problems,
    ok: r.ok,
    delivery: distance === null ? null : { in_area: !r.problems.includes('out_of_delivery_area'), distance_m: distance, ...DELIVERY },
    // The demo is always "open" so it can be tried at any hour.
    ordering_open: true,
    next_open_at: open.open ? null : null,
    coupon: !code
      ? null
      : !coupon
        ? { code, status: 'invalid', message: 'That coupon code isn’t valid. Try SLUSH10 in the demo.' }
        : r.coupon_status === 'min_not_met'
          ? { code, status: 'min_not_met', message: `Add items worth ₹${(coupon.min_order_paise ?? 0) / 100} or more to use this coupon.` }
          : { code, status: 'applied', message: `${code} applied`, discount_paise: r.order_discount_paise },
    offer_label: null,
    offers_enabled: true,
    loyalty: {
      running: true,
      spend_paise: l.spend,
      threshold_paise: THRESHOLD,
      adds_paise: r.loyalty_eligible_paise,
      after_paise: l.spend + r.loyalty_eligible_paise,
      remaining_paise: Math.max(0, THRESHOLD - (l.spend + r.loyalty_eligible_paise)),
      token: l.token,
      tokens_left: TOKEN_LIMIT - issued(),
      earns_token: !l.token && issued() < TOKEN_LIMIT && l.spend + r.loyalty_eligible_paise >= THRESHOLD,
    },
  };
}

export const demoApi: OrderingApi = {
  demo: true,
  async menu() {
    await wait(250);
    return demoMenu;
  },
  async qr(slug) {
    await wait(150);
    if (slug === 'counter') return { branch_slug: 'bahadurgarh-s6', kind: 'counter', table_label: null, menu_version: 1 };
    if (slug === 'disabled') throw new ApiError('QR_DISABLED', 'This table’s code isn’t active. Please order at the counter.', {}, 410);
    const table = slug.replace(/^table-?/, '').toUpperCase() || '04';
    return { branch_slug: 'bahadurgarh-s6', kind: 'table', table_label: table.padStart(2, '0').slice(0, 12), menu_version: 1 };
  },
  async quote(req) {
    await wait(200);
    return priceQuote(req);
  },
  async checkout(req) {
    await wait(500);
    const q = priceQuote({ ...req, mobile: req.customer.mobile });
    if (q.coupon && q.coupon.status !== 'applied') throw new ApiError('COUPON_INVALID', q.coupon.message, { quote: q }, 422);
    if (q.problems.includes('out_of_delivery_area')) throw new ApiError('OUT_OF_DELIVERY_AREA', 'Sorry, we don’t deliver to that location yet.', {}, 422);
    if (q.problems.includes('below_delivery_minimum')) throw new ApiError('BELOW_MINIMUM', 'Add a little more to reach the delivery minimum.', {}, 422);
    if (!q.ok) throw new ApiError('ITEM_UNAVAILABLE', 'Something in your cart can’t be ordered right now.', { quote: q }, 409);
    const free = q.total_paise === 0;
    const all = orders();
    const token = `ot_demo${crypto.randomUUID().replace(/-/g, '').slice(0, 25)}`;
    const n = 1025 + all.length;
    const mobile = req.customer.mobile.replace(/\D/g, '').slice(-10);
    const order: DemoOrder = {
      token,
      mobile,
      eligible: q.loyalty.running ? q.loyalty.adds_paise : 0,
      number: `SL-${n}`,
      pickup: (all.length % 99) + 42,
      paidAt: free ? Date.now() : null,
      createdAt: Date.now(),
      cancelledAt: null,
      order: {
        order_number: `SL-${n}`,
        pickup_number: (all.length % 99) + 42,
        order_type: req.order_type,
        table_label: req.order_type === 'dine_in' ? '04' : null,
        on_hold: false,
        total_paise: q.total_paise,
        subtotal_paise: q.subtotal_paise,
        discount_paise: q.promo_discount_paise + q.order_discount_paise,
        delivery_fee_paise: q.delivery_fee_paise,
        tax_paise: 0,
        customer: { name: req.customer.name, mobile_masked: `${mobile.slice(0, 2)}xxxxx${mobile.slice(7)}` },
        items: q.lines.map((l) => ({ name: l.name, variant: l.variant, qty: l.qty, line_total_paise: l.line_total_paise, options: l.options })),
        eta_minutes: q.eta_minutes,
        payment_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        razorpay_order_id: `order_demo_${n}`,
        reject_reason: null,
      },
    };
    save(KEY, [...all, order].slice(-20));
    if (free) return { public_token: token, total_paise: 0, razorpay: null };
    return {
      public_token: token,
      total_paise: q.total_paise,
      razorpay: { key_id: 'demo', order_id: `order_demo_${n}`, amount: q.total_paise, currency: 'INR', name: 'The Slush Bar', prefill: { contact: mobile, name: req.customer.name } },
    };
  },
  async order(token) {
    await wait(150);
    return view(find(token));
  },
  async paymentCheck(token) {
    await wait(400);
    const o = find(token);
    const v = view(o);
    return { payment_status: v.payment_status, order_status: v.status, order_number: o.paidAt ? o.number : null };
  },
  async cancel(token) {
    await wait(300);
    const v = view(find(token));
    if (v.status !== 'pending') throw new ApiError('INVALID_TRANSITION', 'The shop has already accepted your order. Please speak to the counter.', {}, 409);
    update(token, { cancelledAt: Date.now() });
    return { status: 'cancelled' };
  },
  async receipt(token) {
    await wait(200);
    const o = find(token);
    const v = view(o);
    if (!o.paidAt || ['pending', 'cancelled'].includes(v.status)) {
      throw new ApiError('NOT_FOUND', 'Your receipt is ready once the shop accepts the order.', {}, 404);
    }
    const accepted = v.timeline.find((t) => t.status === 'confirmed')!.at;
    return {
      receipt_number: `SLB/2026-27/${String(o.pickup).padStart(6, '0')}`,
      is_tax_invoice: false,
      issued_at: accepted,
      refunded_paise: 0,
      snapshot: {
        shop: { header: 'THE SLUSH BAR', legal_name: null, address: 'Shop No. 140, Sector-6 Market, Bahadurgarh, Haryana', pincode: '124507', phone: null, gstin: null },
        order: { order_number: o.number, pickup_number: o.pickup, order_type: o.order.order_type, table_label: o.order.table_label, customer_name: o.order.customer.name, paid_at: new Date(o.paidAt).toISOString() },
        items: o.order.items.map((i) => ({ name: i.name, variant: i.variant, qty: i.qty, line_total_paise: i.line_total_paise, options: i.options.map((name) => ({ name })) })),
        totals: {
          subtotal_paise: o.order.subtotal_paise,
          promo_discount_paise: o.order.discount_paise,
          order_discount_paise: 0,
          delivery_fee_paise: o.order.delivery_fee_paise,
          tax_paise: o.order.tax_paise,
          tax_included_paise: 0,
          total_paise: o.order.total_paise,
          gst_rate_bp: null,
        },
        payment: { method: 'upi', vpa_masked: 'demo***@upi', reference: '…DEMO01' },
        footer: 'Cool down. Sip. Smile. Repeat.',
      },
    };
  },
  async find(mobile, orderNumber) {
    await wait(300);
    const digits = mobile.replace(/\D/g, '').slice(-10);
    const o = orders().find((x) => x.paidAt && x.number === orderNumber.toUpperCase() && x.order.customer.mobile_masked === `${digits.slice(0, 2)}xxxxx${digits.slice(7)}`);
    if (!o) throw new ApiError('NOT_FOUND', 'We couldn’t find that order. Check the number on your receipt.', {}, 404);
    return { public_token: o.token };
  },
};

/** Demo "UPI app": marks the order paid (no real payment). */
export function demoPay(token: string) {
  update(token, { paidAt: Date.now() });
}
