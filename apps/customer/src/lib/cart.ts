/** The cart lives on the phone, so a refresh or a closed tab never loses it (Phase 2 §1.1). */
import type { CartLineInput } from '@slush/core';
import { useSyncExternalStore } from 'react';
import { env } from './env';
import { load, save } from './storage';

export type CartLine = CartLineInput & { note: string };

const KEY = `slush-cart:${env.branchSlug}`;
let lines: CartLine[] = load<CartLine[]>(KEY, []);
const listeners = new Set<() => void>();

function set(next: CartLine[]) {
  lines = next;
  save(KEY, next.length ? next : null);
  listeners.forEach((l) => l());
}

const sameConfig = (a: CartLine, b: Omit<CartLine, 'line_id' | 'qty'>) =>
  a.product_id === b.product_id &&
  a.variant_id === b.variant_id &&
  a.note === b.note &&
  [...a.option_ids].sort().join() === [...b.option_ids].sort().join();

export const cart = {
  add(line: Omit<CartLine, 'line_id'>) {
    const existing = lines.find((l) => sameConfig(l, line));
    if (existing) set(lines.map((l) => (l === existing ? { ...l, qty: Math.min(50, l.qty + line.qty) } : l)));
    else set([...lines, { ...line, line_id: crypto.randomUUID().slice(0, 8) }]);
  },
  setQty(lineId: string, qty: number) {
    set(qty <= 0 ? lines.filter((l) => l.line_id !== lineId) : lines.map((l) => (l.line_id === lineId ? { ...l, qty: Math.min(50, qty) } : l)));
  },
  replace(lineId: string, line: Omit<CartLine, 'line_id'>) {
    set(lines.map((l) => (l.line_id === lineId ? { ...line, line_id: lineId } : l)));
  },
  remove(lineId: string) {
    set(lines.filter((l) => l.line_id !== lineId));
  },
  /** Drop lines the server says can't be ordered any more (FR-14 "something changed"). */
  removeMany(lineIds: string[]) {
    set(lines.filter((l) => !lineIds.includes(l.line_id)));
  },
  clear() {
    set([]);
  },
};

export function useCart(): CartLine[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lines,
  );
}
