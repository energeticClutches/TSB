import { formatINR } from '@slush/core';
import { Alert, Badge, Button, Spinner, cn } from '@slush/ui';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AcceptButton, ItemLines, OrderDrawer, ReasonDialog } from '../components/OrderDrawer';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { type BoardOrder, type OrderStatus, minutesSince, nextStep, useLiveOrders, useNow, whereLabel } from '../lib/orders';
import { useStaff } from '../lib/session';
import { buzz, chime, unlockAudio } from '../lib/sound';
import { useAsync } from '../lib/useAsync';

const COLUMNS: { status: OrderStatus; title: string; accent: string }[] = [
  { status: 'pending', title: 'New', accent: 'border-brand' },
  { status: 'confirmed', title: 'Confirmed', accent: 'border-lagoon' },
  { status: 'preparing', title: 'Preparing', accent: 'border-mango' },
  { status: 'ready', title: 'Ready', accent: 'border-success' },
  { status: 'out_for_delivery', title: 'Out for delivery', accent: 'border-jamun' },
];

const SOUND_KEY = 'slush-board-sound';
const REPEAT_MS = 30_000;

/** A3: the counter's live board (Phase 6). */
export function BoardPage() {
  const staff = useStaff();
  const live = useLiveOrders<BoardOrder>(staff.db, staff.branchId, 'live_orders');
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [rejecting, setRejecting] = useState<BoardOrder | null>(null);
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const isManager = staff.role === 'owner' || staff.role === 'manager';
  const alerts = useAsync(
    () => rpc<{ refund_requests: number | null; refund_failures: number | null; held_orders: number }>(staff.db, 'staff_alerts'),
    [staff.db, live.data],
  );

  // Chime for new orders, repeating every 30 s until someone touches the screen (Phase 6 A3).
  const seen = useRef<Set<string> | null>(null);
  const unacknowledged = useRef(false);
  const heldSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const orders = live.data?.orders;
    if (!orders) return;
    const pending = orders.filter((o) => o.status === 'pending');
    if (seen.current) {
      const fresh = pending.filter((o) => !seen.current!.has(o.id));
      if (fresh.length) {
        unacknowledged.current = true;
        if (sound) chime();
      }
      const newlyHeld = orders.filter((o) => o.on_hold && !heldSeen.current.has(o.id));
      if (newlyHeld.length && sound) buzz();
    }
    seen.current = new Set(pending.map((o) => o.id));
    heldSeen.current = new Set(orders.filter((o) => o.on_hold).map((o) => o.id));
    if (!pending.length) unacknowledged.current = false;
  }, [live.data, sound]);
  useEffect(() => {
    const id = window.setInterval(() => unacknowledged.current && sound && chime(), REPEAT_MS);
    return () => window.clearInterval(id);
  }, [sound]);

  const toggleSound = () => {
    unlockAudio();
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
    } catch {
      /* per-device preference only */
    }
    if (next) chime();
  };

  const advance = async (o: BoardOrder, to: OrderStatus) => {
    setError(undefined);
    try {
      await rpc(staff.db, 'advance_order', { p_order_id: o.id, p_version: o.version, p_to_status: to });
    } catch (e) {
      setError(messageOf(e));
    }
    void live.reload();
  };

  if (!live.data) {
    return live.error ? <Alert>{messageOf(live.error)}</Alert> : <Spinner className="size-8 text-brand" />;
  }
  const orders = live.data.orders;
  const lateAfter = live.data.late_after_min;
  const hasDelivery = orders.some((o) => o.status === 'out_for_delivery' || o.order_type === 'delivery');
  const columns = COLUMNS.filter((c) => c.status !== 'out_for_delivery' || hasDelivery);

  return (
    <div
      onPointerDown={() => {
        unacknowledged.current = false;
        unlockAudio();
      }}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-3xl font-black tracking-tight">Live orders</h1>
          <span className={cn('flex items-center gap-1.5 text-xs font-bold', live.connected ? 'text-success' : 'text-ink-muted')}>
            <span className={cn('size-2 rounded-full', live.connected ? 'bg-success' : 'bg-line')} />
            {live.connected ? 'Live' : 'Updating every 15 s'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isManager && !!alerts.data?.refund_requests && (
            <Link to="/refunds"><Badge tone="warning">{alerts.data.refund_requests} refund request(s) →</Badge></Link>
          )}
          {isManager && !!alerts.data?.refund_failures && (
            <Link to="/refunds"><Badge tone="danger">{alerts.data.refund_failures} refund(s) failed →</Badge></Link>
          )}
          <Button size="sm" variant="secondary" onClick={toggleSound} aria-pressed={sound}>
            {sound ? '🔔 Sound on' : '🔕 Sound off'}
          </Button>
          <Link to="/sold-out" className="inline-flex h-9 items-center rounded-full border-2 border-brand px-4 text-sm font-bold text-brand-ink hover:bg-brand-tint">
            Sold out…
          </Link>
        </div>
      </div>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(240px, 1fr))`, overflowX: 'auto' }}>
        {columns.map((col) => {
          const list = orders.filter((o) => o.status === col.status);
          return (
            <section key={col.status} aria-label={col.title} className="flex min-w-0 flex-col gap-3">
              <h2 className="flex items-center gap-2 font-display text-sm font-black tracking-wider text-ink-muted uppercase">
                {col.title}
                <span className="rounded-full bg-card px-2 py-0.5 text-ink shadow-card">{list.length}</span>
                {col.status === 'pending' && list.length > 0 && <span aria-hidden>🔔</span>}
              </h2>
              {list.length === 0 && <p className="rounded-3xl border-2 border-dashed border-line px-4 py-6 text-center text-sm text-ink-muted">Nothing here</p>}
              {list.map((o) => {
                const since = o.status === 'pending' ? o.paid_at : o.status === 'confirmed' ? o.confirmed_at : o.status === 'preparing' ? o.preparing_at : o.ready_at;
                const age = minutesSince(o.paid_at, now);
                const late = (o.status === 'pending' || o.status === 'confirmed') && minutesSince(since, now) >= lateAfter;
                const step = nextStep(o);
                return (
                  <article
                    key={o.id}
                    className={cn(
                      'overflow-hidden rounded-3xl border-l-8 bg-card shadow-card transition',
                      col.accent,
                      late && 'animate-pulse ring-4 ring-warning/60',
                      o.on_hold && 'ring-4 ring-danger/60',
                    )}
                  >
                    {o.on_hold && <p className="bg-danger px-4 py-1.5 text-xs font-black text-white">⚠ REVIEW: {o.hold_reason ?? 'held by a fraud check'}</p>}
                    <button type="button" onClick={() => setOpenId(o.id)} className="block w-full px-4 pt-3 text-left" aria-label={`Open order ${o.order_number}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-display text-3xl font-black text-brand-ink">#{o.pickup_number}</span>
                        <span className="text-xs font-bold text-ink-muted">{o.order_number}</span>
                      </div>
                      <p className="text-sm font-bold">
                        {whereLabel(o)} · {age < 1 ? 'just now' : `${age} min`} · {o.customer_name}
                      </p>
                      <div className="mt-2 text-sm">
                        <ItemLines items={o.items} prices={false} />
                      </div>
                      {o.note && <p className="mt-2 rounded-xl bg-warning-tint px-2.5 py-1.5 text-xs font-semibold text-warning">📝 {o.note}</p>}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {o.requires_mobile_check && <Badge tone="lagoon">🪙 Verify mobile</Badge>}
                        {o.late_payment && <Badge tone="warning">Paid late</Badge>}
                        {o.order_type === 'delivery' && <Badge>🛵 {o.delivery_address}</Badge>}
                        <Badge>{formatINR(o.total_paise)}</Badge>
                      </div>
                    </button>
                    <div className="flex gap-2 px-4 pt-3 pb-4">
                      {o.status === 'pending' ? (
                        o.on_hold ? (
                          <Button size="sm" variant="secondary" block onClick={() => setOpenId(o.id)}>
                            {isManager ? 'Review…' : 'Ask a manager'}
                          </Button>
                        ) : (
                          <>
                            <AcceptButton size="sm" order={o} onDone={() => void live.reload()} onError={setError} />
                            <Button size="sm" variant="ghost" onClick={() => setRejecting(o)} aria-label={`Reject order ${o.order_number}`}>
                              ✕ Reject
                            </Button>
                          </>
                        )
                      ) : step ? (
                        <Button size="sm" block onClick={() => void advance(o, step.to)}>
                          {step.label} →
                        </Button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>

      <OrderDrawer orderId={openId} onClose={() => setOpenId(null)} onChanged={() => void live.reload()} />
      <ReasonDialog
        open={Boolean(rejecting)}
        title={rejecting ? `Reject ${rejecting.order_number}?` : 'Reject'}
        intro="The customer is told the reason, and a full refund goes to a manager for approval."
        label="Reason (shown to the customer)"
        placeholder="e.g. Machine under repair"
        action="Reject order"
        danger
        onClose={() => setRejecting(null)}
        onSubmit={async (reason) => {
          await rpc(staff.db, 'reject_order', { p_order_id: rejecting!.id, p_version: rejecting!.version, p_reason: reason });
          setRejecting(null);
          void live.reload();
        }}
      />
    </div>
  );
}
