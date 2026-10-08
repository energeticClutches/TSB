import { type MenuProduct, type MenuSnapshot, describeWindows, formatINR, priceFrom, productAvailability } from '@slush/core';
import { cn } from '@slush/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CartBar, ClosedBanner, Header } from '../components/Chrome';
import { ProductImage } from '../components/CupArt';
import { ProductSheet, canQuickAdd, defaultOptionIds } from '../components/ProductSheet';
import { cart, useCart } from '../lib/cart';
import { env } from '../lib/env';
import { recentOrders } from '../lib/ordering';

export function MenuPage({ menu, offline }: { menu: MenuSnapshot; offline: boolean }) {
  const lines = useCart();
  const [open, setOpen] = useState<MenuProduct | null>(null);
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState(menu.categories[0]?.id);
  const tabsRef = useRef<HTMLDivElement>(null);
  const now = new Date();

  const categories = useMemo(() => new Map(menu.categories.map((c) => [c.id, c])), [menu]);
  const featured = menu.products.filter((p) => p.featured);
  const q = query.trim().toLowerCase();
  const filtered = q ? menu.products.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q)) : menu.products;
  const inCart = (productId: string) => lines.filter((l) => l.product_id === productId).reduce((s, l) => s + l.qty, 0);

  // Scroll-spy for the sticky category tabs.
  useEffect(() => {
    if (q) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveCat(visible.target.id.replace('cat-', ''));
      },
      { rootMargin: '-120px 0px -60% 0px' },
    );
    menu.categories.forEach((c) => {
      const el = document.getElementById(`cat-${c.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [menu, q]);

  useEffect(() => {
    tabsRef.current?.querySelector(`[data-cat="${activeCat}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [activeCat]);

  const quickAdd = (p: MenuProduct) => {
    if (!canQuickAdd(p)) return setOpen(p);
    const variant = p.variants.find((v) => v.default) ?? p.variants[0]!;
    cart.add({ product_id: p.id, variant_id: variant.id, qty: 1, option_ids: defaultOptionIds(p), note: '' });
  };
  const decrement = (p: MenuProduct) => {
    const last = [...lines].reverse().find((l) => l.product_id === p.id);
    if (last) cart.setQty(last.line_id, last.qty - 1);
  };

  return (
    <div className="min-h-dvh pb-28">
      <Header hasOrders={recentOrders().length > 0} />
      {env.demo && (
        <p className="bg-ink px-4 py-1.5 text-center text-xs font-semibold text-white">Demo menu · payments are simulated, no money moves</p>
      )}
      {offline && (
        <p role="status" className="mx-4 mt-3 rounded-2xl bg-warning-tint px-4 py-2 text-sm text-warning">
          You’re offline. Showing the menu from your last visit.
        </p>
      )}
      <ClosedBanner menu={menu} />

      {featured.length > 0 && !q && (
        <section className="mt-4" aria-labelledby="iconic">
          <h2 id="iconic" className="mx-auto max-w-lg px-4 font-display text-xl font-black tracking-tight">
            Meet the Iconic Slushes
          </h2>
          <div className="no-scrollbar mx-auto flex max-w-lg snap-x gap-3 overflow-x-auto px-4 pt-3 pb-2">
            {featured.map((p) => {
              const availability = productAvailability(p, categories.get(p.category_id), now);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setOpen(p)}
                  disabled={availability !== 'available'}
                  className="w-36 shrink-0 snap-start overflow-hidden rounded-3xl bg-card text-left shadow-card transition active:scale-[0.97] disabled:opacity-50"
                  style={{ borderTop: `4px solid ${p.accent ?? '#E6007A'}` }}
                >
                  <ProductImage image={p.image} accent={p.accent} name={p.name} className="h-36 w-full overflow-hidden" />
                  <div className="p-3">
                    <p className="font-display leading-tight font-extrabold">{p.name}</p>
                    <p className="mt-1 text-sm font-bold text-brand-ink">{formatINR(priceFrom(p).paise)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="sticky top-14 z-20 mt-3 bg-surface/95 backdrop-blur">
        <div className="mx-auto max-w-lg px-4 pt-1 pb-2">
          <label className="flex h-11 items-center gap-2 rounded-full border border-line bg-card px-4">
            <span aria-hidden className="text-ink-muted">
              ⌕
            </span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search slushes, pizzas…" aria-label="Search the menu" className="w-full bg-transparent text-base outline-none" />
          </label>
          {!q && (
            <div ref={tabsRef} className="no-scrollbar mt-2 flex gap-2 overflow-x-auto" role="tablist" aria-label="Menu categories">
              {menu.categories.map((c) => (
                <button
                  key={c.id}
                  data-cat={c.id}
                  role="tab"
                  aria-selected={activeCat === c.id}
                  type="button"
                  onClick={() => document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth' })}
                  className={cn('shrink-0 rounded-full px-4 py-2 text-sm font-bold transition', activeCat === c.id ? 'bg-brand text-white' : 'bg-card text-ink-muted shadow-card')}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-lg px-4">
        {q && filtered.length === 0 && <p className="py-10 text-center text-ink-muted">Nothing matches “{query}”.</p>}
        {(q ? [{ id: 'search', name: 'Results', windows: [] }] : menu.categories).map((c) => {
          const products = q ? filtered : menu.products.filter((p) => p.category_id === c.id);
          if (!products.length) return null;
          return (
            <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-36 pt-5" aria-labelledby={`h-${c.id}`}>
              <h2 id={`h-${c.id}`} className="font-display text-xl font-black tracking-tight">
                {c.name}
                {c.windows.length > 0 && <span className="ml-2 text-sm font-semibold text-ink-muted">{describeWindows(c.windows)}</span>}
              </h2>
              <ul className="mt-2 divide-y divide-line">
                {products.map((p) => (
                  <MenuRow key={p.id} product={p} availability={productAvailability(p, categories.get(p.category_id), now)} qty={inCart(p.id)} onOpen={() => setOpen(p)} onAdd={() => quickAdd(p)} onRemove={() => decrement(p)} />
                ))}
              </ul>
            </section>
          );
        })}
      </main>

      <CartBar menu={menu} />
      <ProductSheet product={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function MenuRow({
  product: p,
  availability,
  qty,
  onOpen,
  onAdd,
  onRemove,
}: {
  product: MenuProduct;
  availability: ReturnType<typeof productAvailability>;
  qty: number;
  onOpen: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const price = priceFrom(p);
  const unavailable = availability !== 'available';
  return (
    <li className={cn('flex gap-3 py-4', unavailable && 'opacity-55')}>
      <button type="button" onClick={onOpen} disabled={unavailable} className="min-w-0 flex-1 text-left">
        <p className="font-display text-lg leading-tight font-extrabold">{p.name}</p>
        {p.description && <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{p.description}</p>}
        <p className="mt-2 text-sm font-bold">
          {price.varies ? 'from ' : ''}
          {formatINR(price.paise)}
          {availability === 'sold_out' && <span className="ml-2 rounded-full bg-danger-tint px-2 py-0.5 text-xs text-danger">Sold out</span>}
          {availability === 'not_now' && <span className="ml-2 rounded-full bg-lagoon-tint px-2 py-0.5 text-xs text-lagoon-ink">🕓 {describeWindows(p.windows) || 'Later today'}</span>}
        </p>
      </button>
      <div className="relative w-28 shrink-0">
        <ProductImage image={p.image} accent={p.accent} name={p.name} className="h-24 w-28 overflow-hidden rounded-2xl" />
        {!unavailable &&
          (qty > 0 ? (
            <div className="absolute -bottom-3 left-1/2 flex h-10 -translate-x-1/2 items-center rounded-full bg-brand text-white shadow-glow">
              <button type="button" onClick={onRemove} aria-label={`One less ${p.name}`} className="grid size-10 place-items-center text-lg font-black">
                −
              </button>
              <span className="w-5 text-center font-black" aria-live="polite">
                {qty}
              </span>
              <button type="button" onClick={onAdd} aria-label={`One more ${p.name}`} className="grid size-10 place-items-center text-lg font-black">
                +
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Add ${p.name}`}
              className="absolute -bottom-3 left-1/2 h-10 w-24 -translate-x-1/2 rounded-full border-2 border-brand bg-card font-display font-black text-brand-ink shadow-card transition active:scale-95"
            >
              ADD
            </button>
          ))}
      </div>
    </li>
  );
}
