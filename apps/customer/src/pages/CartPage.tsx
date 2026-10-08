import { type MenuSnapshot, type OrderType, formatINR, priceCart } from '@slush/core';
import { cn } from '@slush/ui';
import { useMemo, useState } from 'react';
import { Header } from '../components/Chrome';
import { ProductSheet } from '../components/ProductSheet';
import { type CartLine, cart, useCart } from '../lib/cart';
import { allowedOrderTypes, loadOrderType, saveOrderType, useOrderingContext } from '../lib/ordering';
import { Link, navigate } from '../lib/router';

export const ORDER_TYPE_LABEL: Record<OrderType, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };

export function CartPage({ menu }: { menu: MenuSnapshot }) {
  const lines = useCart();
  const ctx = useOrderingContext();
  const allowed = allowedOrderTypes(ctx, menu.branch.delivery_enabled);
  const [orderType, setOrderType] = useState<OrderType>(() => loadOrderType(allowed));
  const [editing, setEditing] = useState<CartLine>();
  const preview = useMemo(() => priceCart({ menu, lines, now: new Date(), orderType, promotions: menu.promotions ?? [] }), [menu, lines, orderType]);
  const productOf = (l: CartLine) => menu.products.find((p) => p.id === l.product_id) ?? null;

  const choose = (t: OrderType) => {
    setOrderType(t);
    saveOrderType(t);
  };

  if (lines.length === 0) {
    return (
      <div className="min-h-dvh">
        <Header back="/menu" title="Your order" />
        <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-20 text-center">
          <p className="text-5xl" aria-hidden>
            🥤
          </p>
          <p className="font-display text-2xl font-black">Your cart is empty</p>
          <p className="text-ink-muted">Pick a slush to cool down.</p>
          <Link to="/menu" className="mt-2 rounded-full bg-brand px-6 py-3 font-bold text-white shadow-glow">
            Back to the menu
          </Link>
        </div>
      </div>
    );
  }

  const problems = preview.lines.filter((l) => l.problems.length);

  return (
    <div className="min-h-dvh pb-32">
      <Header back="/menu" title="Your order" />
      <main className="mx-auto max-w-lg px-4 pt-4">
        {problems.length > 0 && (
          <p role="alert" className="mb-3 rounded-2xl bg-danger-tint px-4 py-3 text-sm text-danger">
            {problems.length === 1 ? 'One item' : `${problems.length} items`} can’t be ordered right now. Remove or change {problems.length === 1 ? 'it' : 'them'} to continue.
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {preview.lines.map((l) => {
            const line = lines.find((x) => x.line_id === l.line_id)!;
            return (
              <li key={l.line_id} className={cn('rounded-3xl bg-card p-4 shadow-card', l.problems.length && 'ring-2 ring-danger')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-lg leading-tight font-extrabold">{l.product_name || 'Item no longer on the menu'}</p>
                    <p className="text-sm text-ink-muted">{[l.variant_name, ...l.options.map((o) => o.name)].filter(Boolean).join(' · ')}</p>
                    {l.note && <p className="mt-1 text-sm italic text-ink-muted">“{l.note}”</p>}
                    {l.problems.length > 0 && <p className="mt-1 text-sm font-bold text-danger">{problemText(l.problems[0]!)}</p>}
                  </div>
                  <p className="shrink-0 font-bold">{formatINR(l.line_total_paise)}</p>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <button type="button" onClick={() => setEditing(line)} disabled={!productOf(line)} className="text-sm font-bold text-brand-ink underline disabled:opacity-40">
                    Edit
                  </button>
                  <div className="flex items-center rounded-full border-2 border-line">
                    <button type="button" aria-label="One less" onClick={() => cart.setQty(l.line_id, line.qty - 1)} className="grid size-10 place-items-center text-lg font-bold">
                      {line.qty === 1 ? '🗑' : '−'}
                    </button>
                    <span className="w-6 text-center font-black">{line.qty}</span>
                    <button type="button" aria-label="One more" onClick={() => cart.setQty(l.line_id, line.qty + 1)} className="grid size-10 place-items-center text-lg font-bold">
                      +
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <section className="mt-6" aria-labelledby="how">
          <h2 id="how" className="font-display text-lg font-black">
            How do you want it?
          </h2>
          <div className="mt-2 flex gap-2">
            {allowed.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={orderType === t}
                onClick={() => choose(t)}
                className={cn('flex-1 rounded-2xl border-2 px-3 py-3 text-sm font-bold', orderType === t ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line bg-card')}
              >
                {ORDER_TYPE_LABEL[t]}
                {t === 'dine_in' && ctx.tableLabel ? ` · T${ctx.tableLabel}` : ''}
              </button>
            ))}
          </div>
        </section>

        <dl className="mt-6 flex flex-col gap-1 rounded-3xl bg-card p-4 shadow-card">
          <Row label="Item total" value={formatINR(preview.subtotal_paise)} />
          {preview.promo_discount_paise > 0 && <Row label="Happy hour" value={`− ${formatINR(preview.promo_discount_paise)}`} />}
          <Row label="To pay" value={formatINR(preview.subtotal_paise - preview.promo_discount_paise)} strong />
          <p className="text-xs text-ink-muted">Final price is confirmed at checkout.</p>
        </dl>
      </main>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 pt-3 backdrop-blur">
        <button
          type="button"
          disabled={problems.length > 0}
          onClick={() => navigate('/checkout')}
          className="mx-auto block h-14 w-full max-w-lg rounded-full bg-brand font-display text-lg font-black text-white shadow-glow disabled:opacity-40"
        >
          Continue · {formatINR(preview.subtotal_paise - preview.promo_discount_paise)}
        </button>
      </div>
      <ProductSheet product={editing ? productOf(editing) : null} editing={editing} onClose={() => setEditing(undefined)} />
    </div>
  );
}

export function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between', strong && 'mt-1 border-t border-line pt-2 font-display text-lg font-black')}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function problemText(p: string): string {
  return (
    {
      sold_out: 'Sold out right now',
      not_available_now: 'Not available at this time',
      unknown_item: 'No longer on the menu',
      unknown_size: 'That size is no longer available',
      option_unavailable: 'One of the add-ons ran out',
      choices_invalid: 'Please choose the options again',
      bad_quantity: 'Check the quantity',
      note_too_long: 'The note is too long',
    } as Record<string, string>
  )[p] ?? 'Can’t be ordered right now';
}
