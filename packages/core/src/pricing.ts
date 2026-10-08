/**
 * The pricing engine. The customer app uses it for the live preview; the checkout Edge
 * Function uses the SAME code as the authority (docs/PHASE-5-ARCHITECTURE.md §5). Prices sent
 * by a browser are never trusted: the server re-runs this against the live menu (FR-14).
 *
 * Rules (approved):
 *  - subtotal = menu value of every line (size + paid add-ons) × qty, before any discount.
 *  - Happy hour is item-level; if several apply to a line, the best one wins.
 *  - At most ONE order-level discount: a coupon replaces the first-order offer (Phase 4 decision 5).
 *  - Loyalty spend = what the customer actually paid for the drinks: subtotal minus every discount,
 *    excluding the delivery fee and GST (FR-28). It feeds the Lucky Draw, and is never paid with.
 */
import { type MenuModifierGroup, type MenuProduct, type MenuSnapshot, type TimeWindow, inWindows, productAvailability } from './menu.ts';
import { type Paise, percentOf } from './money.ts';

export type OrderType = 'dine_in' | 'takeaway' | 'delivery';

export interface CartLineInput {
  line_id: string;
  product_id: string;
  variant_id: string;
  qty: number;
  option_ids: string[];
  note?: string | undefined;
}

export interface DiscountRule {
  discount_type: 'percent' | 'flat';
  /** Basis points for percent (1000 = 10%), paise for flat. */
  value: number;
  max_discount_paise: Paise | null;
  min_order_paise: Paise | null;
}

export interface Promotion extends DiscountRule {
  id: string;
  kind: 'happy_hour' | 'first_order';
  label: string;
  windows: TimeWindow[];
  category_ids: string[];
  product_ids: string[];
}

export interface Coupon extends DiscountRule {
  id: string;
  code: string;
}

export interface PricingInput {
  menu: MenuSnapshot;
  lines: CartLineInput[];
  now: Date;
  orderType: OrderType;
  promotions?: Promotion[];
  /** Already checked server-side for dates and usage limits; pricing checks the minimum order. */
  coupon?: Coupon | null;
  firstOrder?: { eligible: boolean; promotion: Promotion | null };
  delivery?: { distance_m: number; radius_m: number; fee_paise: Paise; min_order_paise: Paise } | null;
  tax?: { enabled: boolean; rate_bp: number; inclusive: boolean };
}

export type LineProblem =
  | 'unknown_item'
  | 'sold_out'
  | 'not_available_now'
  | 'unknown_size'
  | 'option_unavailable'
  | 'choices_invalid'
  | 'bad_quantity'
  | 'note_too_long';

export type OrderProblem = 'empty_cart' | 'too_many_lines' | 'out_of_delivery_area' | 'below_delivery_minimum';

export interface PricedLine {
  line_id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  qty: number;
  options: { id: string; group: string; name: string; price_paise: Paise }[];
  note: string;
  /** Size + paid add-ons for ONE unit, at menu price. */
  unit_price_paise: Paise;
  /** Happy-hour discount per unit. */
  promo_discount_paise: Paise;
  /** Menu value of the whole line: unit_price × qty. */
  line_total_paise: Paise;
  prep_minutes: number;
  problems: LineProblem[];
}

export interface PriceResult {
  lines: PricedLine[];
  subtotal_paise: Paise;
  promo_discount_paise: Paise;
  order_discount_paise: Paise;
  order_discount_source: { kind: 'coupon'; id: string; code: string } | { kind: 'first_order'; id: string } | null;
  coupon_status: 'none' | 'applied' | 'min_not_met' | 'replaced_nothing';
  delivery_fee_paise: Paise;
  tax_paise: Paise;
  total_paise: Paise;
  /** Counts towards the customer's Lucky Draw loyalty spend: drinks only, after discounts, before GST. */
  loyalty_eligible_paise: Paise;
  eta_minutes: number;
  problems: OrderProblem[];
  /** True when every line and the order itself can be checked out. */
  ok: boolean;
}

export const MAX_LINES = 30;
export const MAX_QTY = 50;
export const MAX_NOTE = 120;

function ruleDiscount(rule: DiscountRule, base: Paise): Paise {
  if (base <= 0) return 0;
  const raw = rule.discount_type === 'percent' ? percentOf(base, rule.value) : rule.value;
  const capped = rule.max_discount_paise !== null ? Math.min(raw, rule.max_discount_paise) : raw;
  return Math.max(0, Math.min(capped, base));
}

function validateOptions(product: MenuProduct, optionIds: string[]): { options: PricedLine['options']; problems: LineProblem[] } {
  const problems: LineProblem[] = [];
  const options: PricedLine['options'] = [];
  const unique = new Set(optionIds);
  if (unique.size !== optionIds.length) problems.push('choices_invalid');

  const byId = new Map<string, { group: MenuModifierGroup; option: MenuModifierGroup['options'][number] }>();
  for (const group of product.modifier_groups) for (const option of group.options) byId.set(option.id, { group, option });

  for (const id of unique) {
    const hit = byId.get(id);
    if (!hit) {
      problems.push('option_unavailable');
      continue;
    }
    if (hit.option.sold_out) problems.push('option_unavailable');
    options.push({ id, group: hit.group.name, name: hit.option.name, price_paise: hit.option.price_paise });
  }
  for (const group of product.modifier_groups) {
    const chosen = group.options.filter((o) => unique.has(o.id)).length;
    if (chosen < group.min || chosen > group.max) problems.push('choices_invalid');
  }
  return { options, problems: [...new Set(problems)] };
}

export function priceCart(input: PricingInput): PriceResult {
  const { menu, now } = input;
  const products = new Map(menu.products.map((p) => [p.id, p]));
  const categories = new Map(menu.categories.map((c) => [c.id, c]));

  // Best active happy hour per line.
  const happyHours = (input.promotions ?? []).filter((p) => p.kind === 'happy_hour' && inWindows(p.windows, now));
  const bestPromo = (product: MenuProduct, unit: Paise): Paise =>
    happyHours
      .filter((p) => (p.category_ids.length === 0 && p.product_ids.length === 0) || p.category_ids.includes(product.category_id) || p.product_ids.includes(product.id))
      .reduce((best, p) => Math.max(best, ruleDiscount({ ...p, min_order_paise: null }, unit)), 0);

  const lines: PricedLine[] = input.lines.map((line) => {
    const product = products.get(line.product_id);
    const note = (line.note ?? '').trim();
    const base = {
      line_id: line.line_id,
      product_id: line.product_id,
      variant_id: line.variant_id,
      qty: line.qty,
      note,
    };
    if (!product) {
      return { ...base, product_name: '', variant_name: '', options: [], unit_price_paise: 0, promo_discount_paise: 0, line_total_paise: 0, prep_minutes: 0, problems: ['unknown_item'] };
    }
    const problems: LineProblem[] = [];
    const availability = productAvailability(product, categories.get(product.category_id), now);
    if (availability === 'sold_out') problems.push('sold_out');
    if (availability === 'not_now') problems.push('not_available_now');

    const variant = product.variants.find((v) => v.id === line.variant_id);
    if (!variant) problems.push('unknown_size');
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) problems.push('bad_quantity');
    if (note.length > MAX_NOTE) problems.push('note_too_long');

    const { options, problems: optionProblems } = validateOptions(product, line.option_ids);
    problems.push(...optionProblems);

    const unit = (variant?.price_paise ?? 0) + options.reduce((sum, o) => sum + o.price_paise, 0);
    const qty = problems.includes('bad_quantity') ? 0 : line.qty;
    return {
      ...base,
      product_name: product.name,
      variant_name: variant?.name ?? '',
      options,
      unit_price_paise: unit,
      promo_discount_paise: bestPromo(product, unit),
      line_total_paise: unit * qty,
      prep_minutes: product.prep_minutes,
      problems,
    };
  });

  const problems: OrderProblem[] = [];
  if (lines.length === 0) problems.push('empty_cart');
  if (lines.length > MAX_LINES) problems.push('too_many_lines');

  const subtotal = lines.reduce((s, l) => s + l.line_total_paise, 0);
  const promo = lines.reduce((s, l) => s + l.promo_discount_paise * l.qty, 0);
  const merch = subtotal - promo;

  // One order-level discount: coupon, else first-order.
  let orderDiscount = 0;
  let source: PriceResult['order_discount_source'] = null;
  let couponStatus: PriceResult['coupon_status'] = 'none';
  if (input.coupon) {
    if (input.coupon.min_order_paise !== null && merch < input.coupon.min_order_paise) couponStatus = 'min_not_met';
    else {
      orderDiscount = ruleDiscount(input.coupon, merch);
      source = { kind: 'coupon', id: input.coupon.id, code: input.coupon.code };
      couponStatus = 'applied';
    }
  }
  if (!source && input.firstOrder?.eligible && input.firstOrder.promotion) {
    const fo = input.firstOrder.promotion;
    if (fo.min_order_paise === null || merch >= fo.min_order_paise) {
      orderDiscount = ruleDiscount(fo, merch);
      source = { kind: 'first_order', id: fo.id };
    }
  }

  // Delivery.
  let deliveryFee = 0;
  if (input.orderType === 'delivery') {
    const d = input.delivery;
    if (!d || d.distance_m > d.radius_m) problems.push('out_of_delivery_area');
    else {
      if (merch < d.min_order_paise) problems.push('below_delivery_minimum');
      deliveryFee = d.fee_paise;
    }
  }

  const merchAfterDiscount = merch - orderDiscount;
  const beforeTax = merchAfterDiscount + deliveryFee;
  let tax = 0;
  if (input.tax?.enabled) {
    tax = input.tax.inclusive
      ? beforeTax - Math.round((beforeTax * 10_000) / (10_000 + input.tax.rate_bp)) // informational; already inside prices
      : percentOf(beforeTax, input.tax.rate_bp);
  }
  const total = beforeTax + (input.tax?.enabled && !input.tax.inclusive ? tax : 0);

  // ETA: the slowest item plus 1 minute per extra line (queue load is added server-side).
  const prep = lines.reduce((m, l) => Math.max(m, l.prep_minutes), 0);
  const eta = lines.length ? prep + Math.max(0, lines.length - 1) : 0;

  return {
    lines,
    subtotal_paise: subtotal,
    promo_discount_paise: promo,
    order_discount_paise: orderDiscount,
    order_discount_source: source,
    coupon_status: couponStatus,
    delivery_fee_paise: deliveryFee,
    tax_paise: tax,
    total_paise: total,
    loyalty_eligible_paise: Math.max(0, merchAfterDiscount),
    eta_minutes: eta,
    problems,
    ok: problems.length === 0 && lines.every((l) => l.problems.length === 0),
  };
}

/** Stable fingerprint of what the customer agreed to pay, to detect changes at checkout. */
export function quoteFingerprint(r: PriceResult): string {
  return [
    r.total_paise,
    r.subtotal_paise,
    r.promo_discount_paise,
    r.order_discount_paise,
    r.delivery_fee_paise,
    ...r.lines.map((l) => `${l.line_id}:${l.unit_price_paise}:${l.promo_discount_paise}:${l.qty}`),
  ].join('|');
}

/** Straight-line distance in metres between two points (Phase 5 A5: radius is not road distance). */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
