/**
 * The public menu snapshot (docs/PHASE-7-API.md §2.2), as produced by app.menu_snapshot().
 * Shared by the customer app, the admin preview and the server-side pricing engine.
 */
import type { Paise } from './money.ts';
import type { Promotion } from './pricing.ts';

export interface TimeWindow {
  /** Bit 0 = Sunday … bit 6 = Saturday (IST calendar). 127 = every day. */
  days_mask: number;
  /** "HH:MM"; end earlier than start means the window crosses midnight. */
  start: string;
  end: string;
}

export interface MenuOption {
  id: string;
  name: string;
  price_paise: Paise;
  default: boolean;
  sold_out: boolean;
}

export interface MenuModifierGroup {
  id: string;
  name: string;
  kind: 'paid_addon' | 'free_option';
  min: number;
  max: number;
  options: MenuOption[];
}

export interface MenuVariant {
  id: string;
  name: string;
  price_paise: Paise;
  default: boolean;
}

export interface MenuProduct {
  id: string;
  category_id: string;
  kind: 'item' | 'combo';
  name: string;
  description: string;
  image: string | null;
  accent: string | null;
  featured: boolean;
  sold_out: boolean;
  prep_minutes: number;
  windows: TimeWindow[];
  variants: MenuVariant[];
  modifier_groups: MenuModifierGroup[];
  combo: { product_id: string; variant_id: string | null; qty: number }[];
}

export interface MenuCategory {
  id: string;
  name: string;
  windows: TimeWindow[];
}

export interface MenuSnapshot {
  version: number;
  branch: {
    slug: string;
    name: string;
    address: string;
    phone: string | null;
    hours: { weekday: number; opens: string; closes: string }[];
    closures: { starts_at: string; ends_at: string }[];
    last_order_buffer_min: number;
    delivery_enabled: boolean;
  };
  categories: MenuCategory[];
  products: MenuProduct[];
  /** Live happy hours (added by the menu API; the time-of-day window is checked when pricing). */
  promotions?: Promotion[];
}

const IST_OFFSET_MIN = 330;

/** IST weekday (0 = Sunday) and minutes since IST midnight. */
export function istClock(at: Date): { weekday: number; minutes: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  return { weekday: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when there are no windows, or `at` falls inside one (handles windows crossing midnight). */
export function inWindows(windows: readonly TimeWindow[], at: Date): boolean {
  if (windows.length === 0) return true;
  const { weekday, minutes } = istClock(at);
  const yesterday = (weekday + 6) % 7;
  return windows.some((w) => {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    const onDay = (d: number) => (w.days_mask & (1 << d)) !== 0;
    if (start < end) return onDay(weekday) && minutes >= start && minutes < end;
    // Crosses midnight: the evening part belongs to today, the early-morning part to yesterday's window.
    return (onDay(weekday) && minutes >= start) || (onDay(yesterday) && minutes < end);
  });
}

export type Availability = 'available' | 'sold_out' | 'not_now';

/** Can this product be ordered right now? */
export function productAvailability(product: MenuProduct, category: MenuCategory | undefined, at: Date): Availability {
  if (product.sold_out) return 'sold_out';
  if (!inWindows(product.windows, at) || (category && !inWindows(category.windows, at))) return 'not_now';
  return 'available';
}

/** Human-readable "from 4 PM" hint for the next opening of a time-limited item. */
export function describeWindows(windows: readonly TimeWindow[]): string {
  if (windows.length === 0) return '';
  const fmt = (hhmm: string) => {
    const h = Number(hhmm.slice(0, 2));
    const m = hhmm.slice(3, 5);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === '00' ? `${h12} ${suffix}` : `${h12}:${m} ${suffix}`;
  };
  return windows.map((w) => `${fmt(w.start)}–${fmt(w.end)}`).join(', ');
}

/** Lowest price among a product's sizes, and whether sizes differ ("from ₹149"). */
export function priceFrom(product: MenuProduct): { paise: Paise; varies: boolean } {
  const prices = product.variants.map((v) => v.price_paise);
  const min = Math.min(...prices);
  return { paise: min, varies: prices.some((p) => p !== min) };
}
