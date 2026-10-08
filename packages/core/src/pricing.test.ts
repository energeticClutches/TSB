import { describe, expect, it } from 'vitest';
import type { MenuProduct, MenuSnapshot } from './menu.ts';
import { type CartLineInput, type Coupon, type PricingInput, type Promotion, distanceMetres, priceCart, quoteFingerprint } from './pricing.ts';

const ist = (s: string) => new Date(`${s}+05:30`);
const NOON = ist('2026-09-21T12:00:00');

const slush = (id: string, name: string, price: number, over: Partial<MenuProduct> = {}): MenuProduct => ({
  id,
  category_id: 'slushes',
  kind: 'item',
  name,
  description: '',
  image: null,
  accent: null,
  featured: false,
  sold_out: false,
  prep_minutes: 4,
  windows: [],
  variants: [
    { id: `${id}-reg`, name: 'Regular', price_paise: price, default: true },
    { id: `${id}-mega`, name: 'Mega', price_paise: price + 4000, default: false },
  ],
  modifier_groups: [
    {
      id: 'ice',
      name: 'Ice level',
      kind: 'free_option',
      min: 1,
      max: 1,
      options: [
        { id: 'ice-light', name: 'Light', price_paise: 0, default: false, sold_out: false },
        { id: 'ice-std', name: 'Standard', price_paise: 0, default: true, sold_out: false },
      ],
    },
    {
      id: 'top',
      name: 'Toppings',
      kind: 'paid_addon',
      min: 0,
      max: 2,
      options: [
        { id: 'boba', name: 'Popping boba', price_paise: 3000, default: false, sold_out: false },
        { id: 'jelly', name: 'Jelly', price_paise: 2000, default: false, sold_out: true },
        { id: 'cream', name: 'Cream', price_paise: 2500, default: false, sold_out: false },
      ],
    },
  ],
  combo: [],
  ...over,
});

const pizza: MenuProduct = {
  ...slush('pizza', 'Farmhouse Pizza', 24900),
  category_id: 'pizzas',
  prep_minutes: 12,
  modifier_groups: [],
  variants: [{ id: 'pizza-8', name: '8 inch', price_paise: 24900, default: true }],
};

const menu: MenuSnapshot = {
  version: 1,
  branch: { slug: 'b', name: 'The Slush Bar', address: '', phone: null, hours: [], closures: [], last_order_buffer_min: 15, delivery_enabled: true },
  categories: [
    { id: 'slushes', name: 'Slushes', windows: [] },
    { id: 'pizzas', name: 'Pizzas', windows: [{ days_mask: 127, start: '11:00', end: '23:00' }] },
  ],
  products: [
    slush('straw', 'Strawberry Splash', 14900),
    slush('mango', 'Mango Mania', 13900),
    slush('kiwi', 'Kiwi Kick', 13900, { sold_out: true }),
    slush('late', 'Late Special', 9900, { windows: [{ days_mask: 127, start: '18:00', end: '23:00' }] }),
    pizza,
  ],
};

const line = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  line_id: over.line_id ?? 'l1',
  product_id: 'straw',
  variant_id: 'straw-reg',
  qty: 1,
  option_ids: ['ice-std'],
  ...over,
});

const price = (over: Partial<PricingInput>) => priceCart({ menu, now: NOON, orderType: 'dine_in', lines: [line()], ...over });

const happyHour = (over: Partial<Promotion> = {}): Promotion => ({
  id: 'hh',
  kind: 'happy_hour',
  label: '20% off slushes',
  discount_type: 'percent',
  value: 2000,
  max_discount_paise: null,
  min_order_paise: null,
  windows: [{ days_mask: 127, start: '11:00', end: '13:00' }],
  category_ids: ['slushes'],
  product_ids: [],
  ...over,
});
const coupon = (over: Partial<Coupon> = {}): Coupon => ({
  id: 'c1',
  code: 'SLUSH10',
  discount_type: 'percent',
  value: 1000,
  max_discount_paise: 5000,
  min_order_paise: null,
  ...over,
});
const firstOrderPromo: Promotion = { ...happyHour(), id: 'fo', kind: 'first_order', label: 'First order ₹50 off', discount_type: 'flat', value: 5000, windows: [], category_ids: [] };

describe('basic pricing', () => {
  it('PR-1: Regular ₹149 + boba ₹30, qty 2 = ₹358', () => {
    const r = price({ lines: [line({ qty: 2, option_ids: ['ice-std', 'boba'] })] });
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toMatchObject({ unit_price_paise: 17900, line_total_paise: 35800, product_name: 'Strawberry Splash', variant_name: 'Regular' });
    expect(r.total_paise).toBe(35800);
    expect(r.subtotal_paise).toBe(35800);
  });

  it('PR-2: the Mega size uses its own price and keeps add-ons', () => {
    const r = price({ lines: [line({ variant_id: 'straw-mega', option_ids: ['ice-light', 'boba'] })] });
    expect(r.total_paise).toBe(18900 + 3000);
    expect(r.lines[0]!.options.map((o) => o.name)).toEqual(['Light', 'Popping boba']);
  });

  it('PR-9: ignores any price the browser might send (only ids and qty are read)', () => {
    const tampered = { ...line(), unit_price_paise: 1, total_paise: 1 } as CartLineInput;
    expect(price({ lines: [tampered] }).total_paise).toBe(14900);
  });

  it('PR-15: the total always equals subtotal − discounts + fee + tax and is never negative', () => {
    const r = price({ lines: [line({ option_ids: ['ice-std', 'boba'] })], promotions: [happyHour()], coupon: coupon() });
    expect(r.total_paise).toBe(r.subtotal_paise - r.promo_discount_paise - r.order_discount_paise + r.delivery_fee_paise);
    expect(r.total_paise).toBeGreaterThanOrEqual(0);
  });

  it('estimates preparation time from the slowest item', () => {
    const r = price({ lines: [line(), line({ line_id: 'l2', product_id: 'pizza', variant_id: 'pizza-8', option_ids: [] })] });
    expect(r.eta_minutes).toBe(13);
    expect(price({ lines: [] }).eta_minutes).toBe(0);
  });
});

describe('problems (PR-10 to PR-12)', () => {
  it('flags sold-out, time-limited, unknown items and sizes', () => {
    expect(price({ lines: [line({ product_id: 'kiwi', variant_id: 'kiwi-reg' })] }).lines[0]!.problems).toEqual(['sold_out']);
    expect(price({ lines: [line({ product_id: 'late', variant_id: 'late-reg' })] }).lines[0]!.problems).toEqual(['not_available_now']);
    const unknown = price({ lines: [line({ product_id: 'ghost' })] });
    expect(unknown.lines[0]!.problems).toEqual(['unknown_item']);
    expect(unknown.ok).toBe(false);
    expect(price({ lines: [line({ variant_id: 'nope' })] }).lines[0]!.problems).toContain('unknown_size');
  });

  it('flags category time windows (pizzas before 11 AM)', () => {
    const r = priceCart({ menu, now: ist('2026-09-21T10:00:00'), orderType: 'takeaway', lines: [line({ product_id: 'pizza', variant_id: 'pizza-8', option_ids: [] })] });
    expect(r.lines[0]!.problems).toEqual(['not_available_now']);
  });

  it('PR-12: enforces required choices, limits, sold-out and foreign options', () => {
    expect(price({ lines: [line({ option_ids: [] })] }).lines[0]!.problems).toEqual(['choices_invalid']); // ice level missing
    expect(price({ lines: [line({ option_ids: ['ice-std', 'boba', 'cream', 'jelly'] })] }).lines[0]!.problems).toEqual(
      expect.arrayContaining(['choices_invalid', 'option_unavailable']),
    );
    expect(price({ lines: [line({ option_ids: ['ice-std', 'jelly'] })] }).lines[0]!.problems).toEqual(['option_unavailable']);
    expect(price({ lines: [line({ option_ids: ['ice-std', 'not-an-option'] })] }).lines[0]!.problems).toEqual(['option_unavailable']);
    expect(price({ lines: [line({ option_ids: ['ice-std', 'ice-std'] })] }).lines[0]!.problems).toContain('choices_invalid');
  });

  it('validates quantity, notes and cart size', () => {
    expect(price({ lines: [line({ qty: 0 })] }).lines[0]!.problems).toEqual(['bad_quantity']);
    expect(price({ lines: [line({ qty: 51 })] }).lines[0]!.line_total_paise).toBe(0);
    expect(price({ lines: [line({ qty: 1.5 })] }).lines[0]!.problems).toEqual(['bad_quantity']);
    expect(price({ lines: [line({ note: 'x'.repeat(121) })] }).lines[0]!.problems).toEqual(['note_too_long']);
    expect(price({ lines: [line({ note: '  paper straw  ' })] }).lines[0]!.note).toBe('paper straw');
    expect(price({ lines: [] }).problems).toEqual(['empty_cart']);
    const many = Array.from({ length: 31 }, (_, i) => line({ line_id: `l${i}` }));
    expect(price({ lines: many }).problems).toContain('too_many_lines');
  });
});

describe('offers', () => {
  it('PR-3: happy hour discounts only the targeted category, per unit', () => {
    const r = price({
      promotions: [happyHour()],
      lines: [line({ qty: 2 }), line({ line_id: 'l2', product_id: 'pizza', variant_id: 'pizza-8', option_ids: [] })],
    });
    expect(r.lines[0]!.promo_discount_paise).toBe(2980); // 20% of ₹149
    expect(r.lines[1]!.promo_discount_paise).toBe(0);
    expect(r.promo_discount_paise).toBe(5960);
  });

  it('happy hour only runs inside its window, supports product targets, "everything", and picks the best', () => {
    expect(priceCart({ menu, now: ist('2026-09-21T14:00:00'), orderType: 'dine_in', lines: [line()], promotions: [happyHour()] }).promo_discount_paise).toBe(0);
    expect(price({ promotions: [happyHour({ category_ids: [], product_ids: ['straw'] })] }).promo_discount_paise).toBe(2980);
    expect(price({ promotions: [happyHour({ category_ids: [], product_ids: [] })] }).promo_discount_paise).toBe(2980);
    expect(price({ promotions: [happyHour({ category_ids: [], product_ids: ['mango'] })] }).promo_discount_paise).toBe(0);
    const best = price({ promotions: [happyHour(), happyHour({ id: 'flat', discount_type: 'flat', value: 5000 })] });
    expect(best.promo_discount_paise).toBe(5000);
  });

  it('PR-4: coupon 10% capped at ₹50 on ₹800', () => {
    const r = price({ coupon: coupon(), lines: [line({ qty: 5, option_ids: ['ice-std', 'boba'] }), line({ line_id: 'l2', variant_id: 'straw-reg', qty: 1, option_ids: ['ice-std'] })] });
    expect(r.subtotal_paise).toBe(17900 * 5 + 14900);
    expect(r.order_discount_paise).toBe(5000);
    expect(r.coupon_status).toBe('applied');
    expect(r.order_discount_source).toEqual({ kind: 'coupon', id: 'c1', code: 'SLUSH10' });
  });

  it('PR-5: a coupon below its minimum gives nothing and says why', () => {
    const r = price({ coupon: coupon({ min_order_paise: 30000 }) });
    expect(r).toMatchObject({ coupon_status: 'min_not_met', order_discount_paise: 0, order_discount_source: null });
  });

  it('a flat coupon never makes the order negative', () => {
    expect(price({ coupon: coupon({ discount_type: 'flat', value: 99999, max_discount_paise: null }) }).total_paise).toBe(0);
  });

  it('PR-6: a coupon replaces the first-order offer; without a coupon the first-order offer applies', () => {
    const withCoupon = price({ coupon: coupon(), firstOrder: { eligible: true, promotion: firstOrderPromo } });
    expect(withCoupon.order_discount_source).toMatchObject({ kind: 'coupon' });
    const firstOnly = price({ firstOrder: { eligible: true, promotion: firstOrderPromo } });
    expect(firstOnly.order_discount_source).toEqual({ kind: 'first_order', id: 'fo' });
    expect(firstOnly.order_discount_paise).toBe(5000);
    expect(price({ firstOrder: { eligible: false, promotion: firstOrderPromo } }).order_discount_paise).toBe(0);
    expect(price({ firstOrder: { eligible: true, promotion: { ...firstOrderPromo, min_order_paise: 99999 } } }).order_discount_paise).toBe(0);
    // A coupon that misses its minimum falls back to the first-order offer.
    expect(price({ coupon: coupon({ min_order_paise: 99999 }), firstOrder: { eligible: true, promotion: firstOrderPromo } }).order_discount_source).toEqual({ kind: 'first_order', id: 'fo' });
  });

  it('coupons apply after happy hour', () => {
    const r = price({ promotions: [happyHour()], coupon: coupon({ max_discount_paise: null }) });
    expect(r.order_discount_paise).toBe(Math.round((14900 - 2980) * 0.1));
  });
});

describe('loyalty spend (Lucky Draw)', () => {
  it('TK-6 / TK-7: loyalty spend is what was paid for drinks — after discounts, before the delivery fee and GST', () => {
    const r = price({
      coupon: coupon({ discount_type: 'flat', value: 20000, max_discount_paise: null }),
      orderType: 'delivery',
      delivery: { distance_m: 1000, radius_m: 5000, fee_paise: 3000, min_order_paise: 0 },
      promotions: [happyHour()],
      tax: { enabled: true, rate_bp: 1800, inclusive: false },
      lines: [line({ qty: 4, option_ids: ['ice-std', 'boba'] })],
    });
    expect(r.loyalty_eligible_paise).toBe(17900 * 4 - r.promo_discount_paise - 20000);
    expect(r.total_paise).toBe(r.loyalty_eligible_paise + 3000 + r.tax_paise);
  });

  it('a coupon on an empty cart discounts nothing', () => {
    expect(price({ coupon: coupon(), lines: [] })).toMatchObject({ order_discount_paise: 0, loyalty_eligible_paise: 0, problems: ['empty_cart'] });
  });

  it('never goes below zero, and a free order earns nothing', () => {
    const r = price({ coupon: coupon({ discount_type: 'percent', value: 10000, max_discount_paise: null }), lines: [line()] });
    expect(r).toMatchObject({ total_paise: 0, loyalty_eligible_paise: 0 });
  });
});

describe('delivery (PR-13)', () => {
  const zone = { distance_m: 2000, radius_m: 5000, fee_paise: 3000, min_order_paise: 20000 };
  it('adds the fee inside the radius and enforces the minimum', () => {
    const r = price({ orderType: 'delivery', delivery: zone, lines: [line({ qty: 2 })] });
    expect(r.delivery_fee_paise).toBe(3000);
    expect(r.total_paise).toBe(29800 + 3000);
    expect(price({ orderType: 'delivery', delivery: zone }).problems).toEqual(['below_delivery_minimum']);
  });
  it('refuses outside the radius or without a location', () => {
    expect(price({ orderType: 'delivery', delivery: { ...zone, distance_m: 5001 } }).problems).toEqual(['out_of_delivery_area']);
    expect(price({ orderType: 'delivery', delivery: null }).problems).toEqual(['out_of_delivery_area']);
  });
  it('measures straight-line distance', () => {
    // Sector-6 Bahadurgarh → ~1.1 km north-east.
    expect(distanceMetres({ lat: 28.6921, lng: 76.9353 }, { lat: 28.7, lng: 76.942 })).toBeGreaterThan(1000);
    expect(distanceMetres({ lat: 28.6921, lng: 76.9353 }, { lat: 28.6921, lng: 76.9353 })).toBe(0);
  });
});

describe('tax (off today, built for GST later) and fingerprints', () => {
  it('adds GST on top when exclusive, and only reports it when inclusive', () => {
    const excl = price({ tax: { enabled: true, rate_bp: 500, inclusive: false } });
    expect(excl.tax_paise).toBe(745);
    expect(excl.total_paise).toBe(14900 + 745);
    const incl = price({ tax: { enabled: true, rate_bp: 500, inclusive: true } });
    expect(incl.total_paise).toBe(14900);
    expect(incl.tax_paise).toBe(14900 - Math.round(14900 / 1.05));
    expect(price({ tax: { enabled: false, rate_bp: 500, inclusive: false } }).tax_paise).toBe(0);
  });

  it('PR-14: the preview and the server agree, and any change alters the fingerprint', () => {
    const a = price({ lines: [line({ qty: 2 })] });
    expect(quoteFingerprint(a)).toBe(quoteFingerprint(price({ lines: [line({ qty: 2 })] })));
    const repriced = priceCart({
      menu: { ...menu, products: menu.products.map((p) => (p.id === 'straw' ? slush('straw', 'Strawberry Splash', 15900) : p)) },
      now: NOON,
      orderType: 'dine_in',
      lines: [line({ qty: 2 })],
    });
    expect(quoteFingerprint(repriced)).not.toBe(quoteFingerprint(a));
  });
});
