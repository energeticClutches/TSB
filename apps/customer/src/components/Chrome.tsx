import { type MenuSnapshot, formatINR, orderingStatus, priceCart } from '@slush/core';
import { Logo } from '@slush/ui';
import { useMemo } from 'react';
import { useCart } from '../lib/cart';
import { useOrderingContext } from '../lib/ordering';
import { Link } from '../lib/router';

export function contextLabel(kind: 'table' | 'counter' | 'web', table: string | null): string {
  if (kind === 'table') return `Table ${table}`;
  if (kind === 'counter') return 'Takeaway';
  return 'Order online';
}

export function Header({ back, title, hasOrders }: { back?: string; title?: string; hasOrders?: boolean }) {
  const ctx = useOrderingContext();
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-lg items-center gap-3 px-4">
        {back ? (
          <Link to={back} aria-label="Back" className="grid size-10 place-items-center rounded-full bg-card text-lg shadow-card">
            ←
          </Link>
        ) : (
          <Logo size={36} />
        )}
        <p className="min-w-0 flex-1 truncate font-display text-lg font-black tracking-tight">{title ?? 'THE SLUSH BAR'}</p>
        {hasOrders && (
          <Link to="/orders" className="rounded-full bg-card px-3 py-1.5 text-xs font-bold text-brand-ink shadow-card">
            Track order
          </Link>
        )}
        <span className="rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-white">{contextLabel(ctx.kind, ctx.tableLabel)}</span>
      </div>
    </header>
  );
}

/** Sticky pink cart bar (Phase 6 C1). Totals here are a preview; the server decides the price. */
export function CartBar({ menu }: { menu: MenuSnapshot }) {
  const lines = useCart();
  const ctx = useOrderingContext();
  const preview = useMemo(
    () => priceCart({ menu, lines, now: new Date(), orderType: ctx.kind === 'table' ? 'dine_in' : 'takeaway' }),
    [menu, lines, ctx.kind],
  );
  const count = lines.reduce((s, l) => s + l.qty, 0);
  if (count === 0) return null;
  return (
    <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 px-4 pt-2">
      <Link
        to="/cart"
        className="mx-auto flex h-14 max-w-lg animate-[pop_0.25s_ease-out] items-center justify-between rounded-full bg-brand px-6 text-white shadow-float"
      >
        <span className="font-bold">
          {count} {count === 1 ? 'item' : 'items'} · {formatINR(preview.subtotal_paise - preview.promo_discount_paise)}
        </span>
        <span className="font-display font-black">View cart →</span>
      </Link>
    </div>
  );
}

export function ClosedBanner({ menu }: { menu: MenuSnapshot }) {
  const status = orderingStatus(new Date(), {
    hours: menu.branch.hours,
    closures: menu.branch.closures.map((c) => ({ startsAt: new Date(c.starts_at), endsAt: new Date(c.ends_at) })),
    lastOrderBufferMin: menu.branch.last_order_buffer_min,
  });
  if (status.open) return null;
  const next = status.nextOpenAt
    ? new Intl.DateTimeFormat('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(status.nextOpenAt)
    : null;
  const title = status.reason === 'temporarily_closed' ? 'We’re closed for a short while' : status.reason === 'last_orders_passed' ? 'Last orders have been taken' : 'We’re closed right now';
  return (
    <div role="status" className="mx-4 mt-3 rounded-2xl bg-brand px-4 py-3 text-white shadow-glow">
      <p className="font-display font-black">{title}</p>
      <p className="text-sm text-white/90">Browse the menu anytime{next ? ` · Ordering opens ${next}` : ''}.</p>
    </div>
  );
}
