import { formatINR } from '@slush/core';
import { cn } from '@slush/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from '../components/Chrome';
import { ApiError, type OrderStatus, type PublicOrder, getApi } from '../lib/api';
import { watchOrder } from '../lib/live';
import { forgetOrder } from '../lib/ordering';
import { Link, navigate } from '../lib/router';

const FINAL: OrderStatus[] = ['completed', 'delivered', 'cancelled', 'refunded', 'rejected'];
const when = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Payment confirmation, then the live tracker (Phase 6 C5 + C6). */
export function OrderPage({ token }: { token: string }) {
  const [order, setOrder] = useState<PublicOrder>();
  const [notFound, setNotFound] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const unpaidHint = new URLSearchParams(window.location.search).has('unpaid');
  const lastStatus = useRef<OrderStatus | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const o = await (await getApi()).order(token);
      if (lastStatus.current && lastStatus.current !== 'ready' && o.status === 'ready') navigator.vibrate?.([200, 100, 200]);
      lastStatus.current = o.status;
      setOrder(o);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_FOUND') {
        setNotFound(true);
        forgetOrder(token);
      }
    }
  }, [token]);

  // Ask the server (which asks Razorpay) whether the payment went through (API-4).
  const checkPayment = useCallback(async () => {
    setChecking(true);
    try {
      await (await getApi()).paymentCheck(token);
    } catch {
      /* the tracker below still shows the latest known state */
    }
    await refresh();
    setChecking(false);
  }, [token, refresh]);

  useEffect(() => {
    void checkPayment();
    const t = window.setTimeout(() => setStuck(true), 20_000);
    return () => window.clearTimeout(t);
  }, [checkPayment]);

  // While waiting for the payment confirmation, re-check every few seconds.
  useEffect(() => {
    if (order?.status !== 'awaiting_payment' || unpaidHint) return;
    const t = window.setInterval(() => void checkPayment(), 4_000);
    return () => window.clearInterval(t);
  }, [order?.status, unpaidHint, checkPayment]);

  useEffect(() => {
    if (!order || FINAL.includes(order.status) || order.status === 'awaiting_payment') return;
    return watchOrder(token, () => void refresh());
  }, [order, token, refresh]);

  const cancel = async () => {
    if (!window.confirm('Cancel this order? You’ll get a full refund to your UPI account.')) return;
    setCancelling(true);
    setError(undefined);
    try {
      await (await getApi()).cancel(token, 'Cancelled by customer');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Couldn’t cancel. Please ask at the counter.');
      await refresh();
    } finally {
      setCancelling(false);
    }
  };

  if (notFound) {
    return (
      <Shell>
        <Centered title="We couldn’t find that order">
          <Link to="/find" className="font-bold text-brand-ink underline">
            Find it with your mobile number
          </Link>
        </Centered>
      </Shell>
    );
  }
  if (!order) {
    return (
      <Shell>
        <Confirming />
      </Shell>
    );
  }

  if (order.status === 'awaiting_payment' || order.status === 'payment_expired') {
    const expired = order.status === 'payment_expired';
    return (
      <Shell>
        {unpaidHint || expired ? (
          <Centered title={expired ? 'This payment window has closed' : 'Payment not completed'}>
            <p className="text-ink-muted">No money was taken. If it was debited, it’s refunded automatically.</p>
            {!expired && (
              <button type="button" onClick={() => navigate('/checkout')} className="mt-4 h-12 rounded-full bg-brand px-6 font-bold text-white">
                Try paying again
              </button>
            )}
            <button type="button" disabled={checking} onClick={() => void checkPayment()} className="mt-2 h-12 rounded-full px-6 font-bold text-brand-ink">
              {checking ? 'Checking…' : 'I’ve paid: check again'}
            </button>
            <Link to="/menu" className="mt-2 text-sm text-ink-muted underline">
              Back to the menu
            </Link>
          </Centered>
        ) : (
          <>
            <Confirming />
            {stuck && (
              <div className="mx-auto max-w-sm px-4 text-center">
                <button type="button" disabled={checking} onClick={() => void checkPayment()} className="h-12 rounded-full border-2 border-brand px-6 font-bold text-brand-ink">
                  I’ve paid but it’s stuck
                </button>
              </div>
            )}
          </>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <Tracker token={token} order={order} onCancel={() => void cancel()} cancelling={cancelling} error={error} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh pb-10">
      <Header back="/menu" title="Your order" />
      {children}
    </div>
  );
}

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 py-16 text-center">
      <h1 className="font-display text-2xl font-black">{title}</h1>
      {children}
    </div>
  );
}

function Confirming() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-16 text-center" role="status">
      <div className="relative h-24 w-16 overflow-hidden rounded-b-2xl border-4 border-brand" aria-hidden>
        <div className="absolute inset-x-0 bottom-0 h-full origin-bottom animate-[fill-up_1.6s_ease-in-out_infinite_alternate] bg-brand/70" />
      </div>
      <h1 className="font-display text-2xl font-black">Confirming your payment…</h1>
      <p className="text-ink-muted">Please don’t close this page.</p>
    </div>
  );
}

const STEPS: { status: OrderStatus[]; label: (o: PublicOrder) => string }[] = [
  { status: ['pending'], label: () => 'Order received' },
  { status: ['confirmed'], label: () => 'Accepted by the shop' },
  { status: ['preparing'], label: () => 'Blending your order' },
  {
    status: ['ready'],
    label: (o) => (o.order_type === 'dine_in' ? `Ready · coming to Table ${o.table_label}` : o.order_type === 'delivery' ? 'Ready for delivery' : 'Ready · collect at the counter'),
  },
  { status: ['out_for_delivery'], label: () => 'Out for delivery' },
  { status: ['completed', 'delivered'], label: (o) => (o.order_type === 'delivery' ? 'Delivered' : 'Completed') },
];

function Tracker({ token, order: o, onCancel, cancelling, error }: { token: string; order: PublicOrder; onCancel: () => void; cancelling: boolean; error?: string | undefined }) {
  const steps = STEPS.filter((s) => o.order_type === 'delivery' || !s.status.includes('out_for_delivery'));
  const reachedAt = (s: (typeof STEPS)[number]) => o.timeline.find((t) => s.status.includes(t.status))?.at;
  const currentIndex = steps.findIndex((s) => s.status.includes(o.status));
  const stopped = o.status === 'cancelled' || o.status === 'rejected' || o.status === 'refunded';

  return (
    <main className="mx-auto max-w-lg px-4 pt-6">
      {o.status === 'ready' && (
        <div role="alert" className="mb-4 animate-[pop_0.4s_ease-out] rounded-3xl bg-brand p-5 text-center text-white shadow-glow">
          <p className="font-display text-3xl font-black">It’s ready! 🎉</p>
          <p className="font-bold">{o.order_type === 'dine_in' ? `Coming to Table ${o.table_label}` : `Collect at the counter · #${o.pickup_number}`}</p>
        </div>
      )}
      <section className="flex items-center gap-4 rounded-3xl bg-card p-5 shadow-card">
        <div className="grid size-24 shrink-0 place-items-center rounded-3xl bg-brand-tint text-center">
          <p className="text-[10px] font-bold tracking-widest text-brand-ink uppercase">Pickup</p>
          <p className="font-display text-4xl leading-none font-black text-brand-ink">#{o.pickup_number}</p>
        </div>
        <div className="min-w-0">
          <p className="font-display text-2xl font-black">{o.order_number}</p>
          <p className="text-sm text-ink-muted">
            {o.order_type === 'dine_in' ? `Table ${o.table_label}` : o.order_type === 'delivery' ? 'Delivery' : 'Takeaway'} · {o.customer.name}
          </p>
          <p className={cn('mt-1 text-sm font-bold', o.payment_status === 'successful' || o.total_paise === 0 ? 'text-success' : 'text-ink-muted')}>
            {o.total_paise === 0
              ? '✓ Nothing to pay'
              : o.payment_status === 'successful'
                ? `✓ Paid ${formatINR(o.total_paise)} via UPI`
                : o.payment_status === 'refunded'
                  ? `Refunded ${formatINR(o.total_paise)}`
                  : `Payment: ${o.payment_status}`}
          </p>
        </div>
      </section>

      {stopped ? (
        <section className="mt-4 rounded-3xl bg-danger-tint p-5 text-danger">
          <p className="font-display text-xl font-black">{o.status === 'rejected' ? 'Sorry, the shop couldn’t take this order' : 'Order cancelled'}</p>
          {o.reject_reason && <p className="mt-1 text-sm">{o.reject_reason}</p>}
          {o.refund && (
            <p className="mt-2 text-sm font-bold">
              Refund of {formatINR(o.refund.amount_paise)}: {o.refund.status === 'processed' ? 'completed' : 'on its way (usually 5–7 days)'}
            </p>
          )}
        </section>
      ) : (
        <ol className="mt-4 flex flex-col gap-0 rounded-3xl bg-card p-5 shadow-card" aria-label="Order progress">
          {steps.map((s, i) => {
            const at = reachedAt(s);
            const done = i < currentIndex || (i === currentIndex && FINAL.includes(o.status));
            const current = i === currentIndex && !done;
            return (
              <li key={s.label(o)} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'grid size-7 place-items-center rounded-full text-xs font-black',
                      done ? 'bg-success text-white' : current ? 'animate-pulse bg-brand text-white' : 'border-2 border-line text-ink-muted',
                    )}
                    aria-hidden
                  >
                    {done ? '✓' : i + 1}
                  </span>
                  {i < steps.length - 1 && <span className={cn('w-0.5 flex-1', done ? 'bg-success' : 'bg-line')} aria-hidden />}
                </div>
                <div className="pb-5">
                  <p className={cn('font-bold', !done && !current && 'text-ink-muted')}>
                    {s.label(o)} {current && <span className="sr-only">(current step)</span>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {at ? when(at) : ''}
                    {current && s.status.includes('preparing') && o.eta_minutes ? ` · about ${o.eta_minutes} min` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {o.status === 'pending' && <p className="mt-3 text-center text-sm text-ink-muted">Waiting for the shop to accept your order.</p>}

      <section className="mt-4 rounded-3xl bg-card p-5 shadow-card">
        <h2 className="font-display text-lg font-black">Your items</h2>
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {o.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>
                {it.qty}× {it.name} <span className="text-ink-muted">· {[it.variant, ...it.options].join(' · ')}</span>
              </span>
              <span className="shrink-0 font-bold">{formatINR(it.line_total_paise)}</span>
            </li>
          ))}
        </ul>
      </section>

      {o.loyalty && <LuckyDraw p={o.loyalty} />}

      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-danger-tint px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {o.can_cancel && (
          <button type="button" disabled={cancelling} onClick={onCancel} className="h-12 rounded-full border-2 border-danger font-bold text-danger">
            {cancelling ? 'Cancelling…' : 'Cancel order'}
          </button>
        )}
        {['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'delivered', 'refunded'].includes(o.status) && (
          <Link to={`/order/${token}/receipt`} className="grid h-12 place-items-center rounded-full border-2 border-brand font-bold text-brand-ink">
            View receipt
          </Link>
        )}
        <Link to="/menu" className="grid h-12 place-items-center rounded-full bg-brand font-bold text-white shadow-glow">
          Order something else
        </Link>
      </div>
    </main>
  );
}

/** Where this customer stands in the Lucky Draw, once the order is done (Phase 6 C6). */
function LuckyDraw({ p }: { p: NonNullable<PublicOrder['loyalty']> }) {
  const pct = Math.min(100, Math.round((p.spend_paise / p.threshold_paise) * 100));
  if (p.token) {
    return (
      <section className="mt-4 rounded-3xl bg-lagoon-tint p-5" aria-labelledby="reward-title">
        <h2 id="reward-title" className="font-display text-lg font-black text-lagoon-ink">🎉 Congratulations!</h2>
        <p className="text-sm text-lagoon-ink">You’ve earned your Lucky Draw token.</p>
        <p className="mt-3 font-display text-4xl font-black tracking-wider text-lagoon-ink">{p.token}</p>
        <p className="mt-2 text-sm text-lagoon-ink">
          Keep this number safe — it’s your entry in the draw. Later orders keep adding to your total, but everyone gets one token.
        </p>
      </section>
    );
  }
  return (
    <section className="mt-4 rounded-3xl bg-lagoon-tint p-5" aria-labelledby="reward-title">
      <h2 id="reward-title" className="font-display text-lg font-black text-lagoon-ink">🎟️ Your Lucky Draw</h2>
      {p.earned_paise > 0 && <p className="text-sm text-lagoon-ink">This order added {formatINR(p.earned_paise)}.</p>}
      {p.tokens_left === 0 ? (
        <p className="mt-2 text-sm font-bold text-lagoon-ink">All the Lucky Draw tokens have been given out. Thanks for ordering with us!</p>
      ) : (
        <>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-card" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress to your Lucky Draw token">
            <div className="h-full rounded-full bg-lagoon" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-sm font-bold text-lagoon-ink">
            {formatINR(p.spend_paise)} / {formatINR(p.threshold_paise)}
          </p>
          <p className="mt-1 text-sm text-lagoon-ink">
            {formatINR(Math.max(0, p.threshold_paise - p.spend_paise))} more to earn your Lucky Draw token!
          </p>
        </>
      )}
    </section>
  );
}
