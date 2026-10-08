import { Logo, Spinner, cn } from '@slush/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { type KitchenOrder, minutesSince, useLiveOrders, useNow, whereLabel } from '../lib/orders';
import { useSession, useStaff } from '../lib/session';
import { chime, unlockAudio } from '../lib/sound';

/**
 * A5: the kitchen screen. Full-screen and dark, oldest first, huge type, choices in yellow.
 * No prices and no phone numbers: the database view doesn't even return them.
 */
export function KitchenPage() {
  const staff = useStaff();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const live = useLiveOrders<KitchenOrder>(staff.db, staff.branchId, 'kitchen_orders');
  const now = useNow(15_000);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  // Chime when the counter accepts a new order.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const orders = live.data?.orders;
    if (!orders) return;
    if (seen.current && orders.some((o) => !seen.current!.has(o.id))) chime();
    seen.current = new Set(orders.map((o) => o.id));
  }, [live.data]);

  const move = async (o: KitchenOrder) => {
    setBusy(o.id);
    setError(undefined);
    try {
      await rpc(staff.db, 'advance_order', { p_order_id: o.id, p_version: o.version, p_to_status: o.status === 'confirmed' ? 'preparing' : 'ready' });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
      void live.reload();
    }
  };

  const leave = () => void signOut().then(() => navigate(staff.kind === 'pin' ? '/device' : '/login', { replace: true }));

  // No 5-minute idle lock here (a quiet kitchen would miss orders, and this screen shows no
  // prices or phone numbers), but the PIN session still ends at its expiry time.
  useEffect(() => {
    if (staff.kind !== 'pin') return;
    const id = window.setTimeout(leave, Math.max(0, new Date(staff.expiresAt).getTime() - Date.now()));
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff]);

  const orders = live.data?.orders ?? [];
  const lateAfter = live.data?.late_after_min ?? 5;

  return (
    <div className="min-h-dvh bg-night text-white" onPointerDown={unlockAudio}>
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <div className="flex items-center gap-3">
          <Logo size={36} />
          <h1 className="font-display text-xl font-black">Kitchen</h1>
          <span className="rounded-full bg-white/10 px-3 py-1 text-sm font-bold">{orders.length} to make</span>
          <span className={cn('text-xs font-bold', live.connected ? 'text-kiwi' : 'text-white/50')}>{live.connected ? '● Live' : '○ Updating every 15 s'}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {staff.role !== 'kitchen' && (
            <Link to="/board" className="font-bold text-white/70 underline">
              Back to admin
            </Link>
          )}
          <span className="text-white/70">
            Signed in: <b className="text-white">{staff.name}</b>
          </span>
          <button type="button" onClick={leave} className="rounded-full border border-white/30 px-4 py-1.5 font-bold hover:bg-white/10">
            {staff.kind === 'pin' ? 'Switch' : 'Sign out'}
          </button>
        </div>
      </header>

      {error && <p role="alert" className="bg-danger px-5 py-2 font-bold">{error}</p>}
      {!live.data && (live.error ? <p className="p-6 text-lg">{messageOf(live.error)}</p> : <Spinner className="m-8 size-10 text-white" />)}
      {live.data && orders.length === 0 && (
        <div className="grid min-h-[60vh] place-items-center text-center">
          <div>
            <p className="font-display text-4xl font-black text-white/80">All caught up ✨</p>
            <p className="mt-2 text-white/50">New orders appear here as soon as the counter accepts them.</p>
          </div>
        </div>
      )}

      <main className="grid gap-4 p-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {orders.map((o) => {
          const waited = minutesSince(o.confirmed_at, now);
          const late = waited >= lateAfter;
          const starting = o.status === 'confirmed';
          return (
            <article
              key={o.id}
              className={cn('flex flex-col rounded-3xl bg-night-card p-5 ring-2', late ? 'ring-mango' : starting ? 'ring-white/10' : 'ring-lagoon')}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-display text-5xl font-black">#{o.pickup_number}</span>
                <span className={cn('text-lg font-bold', late ? 'text-mango' : 'text-white/60')}>{waited} min</span>
              </div>
              <p className="text-lg font-bold text-white/80">{whereLabel(o)}</p>
              <ul className="mt-4 flex flex-1 flex-col gap-3">
                {o.items.map((i) => (
                  <li key={i.id}>
                    <p className="font-display text-2xl leading-tight font-black uppercase">
                      {i.qty}× {i.name}
                    </p>
                    <p className="text-lg font-bold text-mango uppercase">
                      {[i.variant, ...i.options.map((x) => x.name)].join(' · ')}
                    </p>
                    {i.note && <p className="text-lg text-white/80">» {i.note}</p>}
                  </li>
                ))}
              </ul>
              {o.note && <p className="mt-3 rounded-2xl bg-white/10 px-3 py-2 text-lg font-bold">📝 {o.note}</p>}
              <button
                type="button"
                disabled={busy === o.id}
                onClick={() => void move(o)}
                className={cn(
                  'mt-4 h-16 rounded-2xl font-display text-2xl font-black transition active:scale-[0.98] disabled:opacity-50',
                  starting ? 'bg-white text-night' : 'bg-kiwi text-night',
                )}
              >
                {starting ? 'START ▶' : 'READY ✓'}
              </button>
            </article>
          );
        })}
      </main>
    </div>
  );
}
