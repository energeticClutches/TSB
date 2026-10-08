/** Where the customer is ordering from (table / counter / web) and their recent orders. */
import type { OrderType } from '@slush/core';
import { useSyncExternalStore } from 'react';
import { env } from './env';
import { load, save } from './storage';

export interface OrderingContext {
  branchSlug: string;
  qrSlug: string | null;
  kind: 'table' | 'counter' | 'web';
  tableLabel: string | null;
}

const CTX_KEY = 'slush-ctx';
let ctx: OrderingContext = load<OrderingContext>(CTX_KEY, { branchSlug: env.branchSlug, qrSlug: null, kind: 'web', tableLabel: null }, 'session');
const listeners = new Set<() => void>();

export function setOrderingContext(next: OrderingContext) {
  ctx = next;
  save(CTX_KEY, next, 'session');
  listeners.forEach((l) => l());
}

export function useOrderingContext(): OrderingContext {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => ctx,
  );
}

// ---------------------------------------------------------------- remembered orders

export interface RememberedOrder {
  token: string;
  placedAt: string;
}
const ORDERS_KEY = 'slush-orders';

export function rememberOrder(token: string) {
  const list = load<RememberedOrder[]>(ORDERS_KEY, []).filter((o) => o.token !== token);
  save(ORDERS_KEY, [{ token, placedAt: new Date().toISOString() }, ...list].slice(0, 10));
}

/** Orders from the last 12 hours, for the "Your active order" pill (Phase 6 C6). */
export function recentOrders(): RememberedOrder[] {
  const cutoff = Date.now() - 12 * 3_600_000;
  return load<RememberedOrder[]>(ORDERS_KEY, []).filter((o) => new Date(o.placedAt).getTime() > cutoff);
}

export function forgetOrder(token: string) {
  save(ORDERS_KEY, load<RememberedOrder[]>(ORDERS_KEY, []).filter((o) => o.token !== token));
}

// ---------------------------------------------------------------- chosen order type


const TYPE_KEY = 'slush-order-type';

/** Which order types this entry point allows (mirrors the server rules in the checkout API). */
export function allowedOrderTypes(c: OrderingContext, deliveryEnabled: boolean): OrderType[] {
  if (c.kind === 'table') return ['dine_in', 'takeaway'];
  if (c.kind === 'counter') return ['takeaway'];
  return deliveryEnabled ? ['takeaway', 'delivery'] : ['takeaway'];
}

export function loadOrderType(allowed: OrderType[]): OrderType {
  const saved = load<OrderType | null>(TYPE_KEY, null, 'session');
  return saved && allowed.includes(saved) ? saved : allowed[0]!;
}

export function saveOrderType(t: OrderType) {
  save(TYPE_KEY, t, 'session');
}

export interface SavedCustomer {
  name: string;
  mobile: string;
}
/** Remembered on this phone only, to skip typing next time (Phase 6 C4). */
export const savedCustomer = () => load<SavedCustomer>('slush-customer', { name: '', mobile: '' });
export const rememberCustomer = (c: SavedCustomer) => save('slush-customer', c);
