import { type MenuProduct, formatINR } from '@slush/core';
import { cn } from '@slush/ui';
import { useEffect, useId, useMemo, useState } from 'react';
import { type CartLine, cart } from '../lib/cart';
import { ProductImage } from './CupArt';

export function defaultOptionIds(product: MenuProduct): string[] {
  return product.modifier_groups.flatMap((g) => g.options.filter((o) => o.default && !o.sold_out).map((o) => o.id));
}

/** Can ADD be one tap? True when every required choice has a default (Phase 6 D6). */
export function canQuickAdd(product: MenuProduct): boolean {
  const defaults = new Set(defaultOptionIds(product));
  return product.modifier_groups.every((g) => g.options.filter((o) => defaults.has(o.id)).length >= g.min);
}

/** Bottom sheet to choose size, choices and add-ons (Phase 6 C2). */
export function ProductSheet({ product, editing, onClose }: { product: MenuProduct | null; editing?: CartLine | undefined; onClose: () => void }) {
  const titleId = useId();
  const [variantId, setVariantId] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!product) return;
    setVariantId(editing?.variant_id ?? product.variants.find((v) => v.default)?.id ?? product.variants[0]!.id);
    setOptions(editing?.option_ids ?? defaultOptionIds(product));
    setQty(editing?.qty ?? 1);
    setNote(editing?.note ?? '');
    setTried(false);
  }, [product, editing]);

  useEffect(() => {
    if (!product) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [product, onClose]);

  const unit = useMemo(() => {
    if (!product) return 0;
    const v = product.variants.find((x) => x.id === variantId)?.price_paise ?? 0;
    const add = product.modifier_groups.flatMap((g) => g.options).filter((o) => options.includes(o.id)).reduce((s, o) => s + o.price_paise, 0);
    return v + add;
  }, [product, variantId, options]);

  if (!product) return null;

  const missing = product.modifier_groups.filter((g) => g.options.filter((o) => options.includes(o.id)).length < g.min);
  const toggle = (groupId: string, optionId: string) => {
    const group = product.modifier_groups.find((g) => g.id === groupId)!;
    setOptions((cur) => {
      const inGroup = cur.filter((id) => group.options.some((o) => o.id === id));
      if (cur.includes(optionId)) return group.min === 1 && group.max === 1 ? cur : cur.filter((id) => id !== optionId);
      if (group.max === 1) return [...cur.filter((id) => !inGroup.includes(id)), optionId];
      if (inGroup.length >= group.max) return cur;
      return [...cur, optionId];
    });
  };

  const submit = () => {
    setTried(true);
    if (missing.length) {
      document.getElementById(`group-${missing[0]!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // Menu order, so the cart reads naturally and identical choices merge into one line.
    const ordered = product.modifier_groups.flatMap((g) => g.options.map((o) => o.id)).filter((id) => options.includes(id));
    const line = { product_id: product.id, variant_id: variantId, qty, option_ids: ordered, note: note.trim() };
    if (editing) cart.replace(editing.line_id, line);
    else cart.add(line);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[var(--radius-sheet)] bg-card shadow-dialog">
        <div className="relative shrink-0">
          <ProductImage image={product.image} accent={product.accent} name={product.name} className="h-52 w-full overflow-hidden" />
          <div className="absolute top-2 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-white/80" aria-hidden />
          <button type="button" onClick={onClose} aria-label="Close" className="absolute top-3 right-3 grid size-10 place-items-center rounded-full bg-white/90 text-ink shadow-card" autoFocus>
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-4">
          <h2 id={titleId} className="font-display text-2xl font-black tracking-tight">
            {product.name}
          </h2>
          {product.description && <p className="mt-1 text-ink-muted">{product.description}</p>}

          {product.variants.length > 1 && (
            <section className="mt-5" aria-label="Size">
              <h3 className="mb-2 text-sm font-bold tracking-wide text-ink-muted uppercase">Size</h3>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    aria-pressed={variantId === v.id}
                    onClick={() => setVariantId(v.id)}
                    className={cn('rounded-full border-2 px-4 py-2.5 text-sm font-bold transition active:scale-95', variantId === v.id ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line')}
                  >
                    {v.name} · {formatINR(v.price_paise)}
                  </button>
                ))}
              </div>
            </section>
          )}

          {product.modifier_groups.map((g) => {
            const chosen = g.options.filter((o) => options.includes(o.id)).length;
            const bad = tried && chosen < g.min;
            return (
              <section key={g.id} id={`group-${g.id}`} className="mt-5">
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="text-sm font-bold tracking-wide text-ink-muted uppercase">{g.name}</h3>
                  <span className={cn('text-xs font-bold', bad ? 'text-danger' : 'text-ink-muted')}>
                    {g.min > 0 ? (g.min === g.max ? 'Required' : `Pick ${g.min}–${g.max}`) : g.max > 1 ? `Up to ${g.max}` : 'Optional'}
                  </span>
                </div>
                <div className={cn('flex flex-wrap gap-2', g.kind === 'paid_addon' && 'flex-col')}>
                  {g.options.map((o) => {
                    const on = options.includes(o.id);
                    return g.kind === 'free_option' ? (
                      <button
                        key={o.id}
                        type="button"
                        disabled={o.sold_out}
                        aria-pressed={on}
                        onClick={() => toggle(g.id, o.id)}
                        className={cn('rounded-full border-2 px-4 py-2 text-sm font-semibold transition active:scale-95 disabled:opacity-40', on ? 'border-brand bg-brand text-white' : 'border-line')}
                      >
                        {o.name}
                      </button>
                    ) : (
                      <label key={o.id} className={cn('flex min-h-12 items-center justify-between gap-3 rounded-2xl border-2 px-4', on ? 'border-brand bg-brand-tint' : 'border-line', o.sold_out && 'opacity-40')}>
                        <span className="flex items-center gap-3 font-semibold">
                          <input type="checkbox" checked={on} disabled={o.sold_out} onChange={() => toggle(g.id, o.id)} className="size-5 accent-[var(--color-brand)]" />
                          {o.name} {o.sold_out && <span className="text-xs text-danger">Sold out</span>}
                        </span>
                        <span className="text-sm text-ink-muted">+{formatINR(o.price_paise)}</span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <section className="mt-5">
            <label htmlFor={`${titleId}-note`} className="mb-2 block text-sm font-bold tracking-wide text-ink-muted uppercase">
              Note for this item <span className="font-normal normal-case">(optional)</span>
            </label>
            <input
              id={`${titleId}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 120))}
              placeholder="e.g. no straw"
              className="h-12 w-full rounded-2xl border border-line px-4 text-base outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
            />
          </section>
        </div>
        <div className="safe-bottom flex shrink-0 items-center gap-3 border-t border-line bg-card px-5 pt-3">
          <div className="flex items-center rounded-full border-2 border-line">
            <button type="button" aria-label="One less" onClick={() => setQty((q) => Math.max(1, q - 1))} className="grid size-11 place-items-center text-xl font-bold">
              −
            </button>
            <span className="w-6 text-center font-display text-lg font-black" aria-live="polite">
              {qty}
            </span>
            <button type="button" aria-label="One more" onClick={() => setQty((q) => Math.min(50, q + 1))} className="grid size-11 place-items-center text-xl font-bold">
              +
            </button>
          </div>
          <button type="button" onClick={submit} className="h-13 flex-1 rounded-full bg-brand font-display text-lg font-black text-white shadow-glow transition active:scale-[0.98]">
            {editing ? 'Update' : 'Add'} · {formatINR(unit * qty)}
          </button>
        </div>
      </div>
    </div>
  );
}
