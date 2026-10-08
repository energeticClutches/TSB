import { formatINR } from '@slush/core';
import { Alert, Badge, Button, Dialog, Spinner, TextField, cn } from '@slush/ui';
import { useState } from 'react';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import {
  type OrderDetail,
  type OrderItem,
  type ReceiptData,
  STATUS_LABEL,
  formatDateTime,
  formatTime,
  nextStep,
  whereLabel,
} from '../lib/orders';
import { printKot, printReceipt } from '../lib/print';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

export function ItemLines({ items, prices = true, big = false }: { items: OrderItem[]; prices?: boolean; big?: boolean }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((i) => (
        <li key={i.id} className="flex justify-between gap-3">
          <div className="min-w-0">
            <p className={cn('font-bold', big && 'text-lg')}>
              {i.qty}× {i.name} <span className="font-semibold text-ink-muted">· {i.variant}</span>
            </p>
            {i.options.length > 0 && <p className="text-sm text-brand-ink">{i.options.map((o) => o.name).join(' · ')}</p>}
            {i.note && <p className="text-sm text-ink-muted">“{i.note}”</p>}
            {!!i.refunded_qty && <p className="text-xs font-bold text-danger">{i.refunded_qty} refunded</p>}
          </div>
          {prices && i.line_total_paise !== undefined && <span className="shrink-0 font-semibold">{formatINR(i.line_total_paise)}</span>}
        </li>
      ))}
    </ul>
  );
}

const REFUND_TONE = { requested: 'warning', approved: 'brand', processing: 'brand', processed: 'success', declined: 'neutral', failed: 'danger' } as const;

/** A4: everything about one order, plus the actions staff can take on it. */
export function OrderDrawer({ orderId, onClose, onChanged }: { orderId: string | null; onClose: () => void; onChanged?: () => void }) {
  const staff = useStaff();
  const detail = useAsync(() => (orderId ? rpc<OrderDetail>(staff.db, 'order_detail', { p_order_id: orderId }) : Promise.resolve(undefined)), [staff.db, orderId]);
  const [mobile, setMobile] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [dialog, setDialog] = useState<'refund' | 'back' | 'hold' | 'reject' | null>(null);
  const isManager = staff.role === 'owner' || staff.role === 'manager';

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
      detail.reload();
      onChanged?.();
    } catch (e) {
      setError(messageOf(e));
      detail.reload();
    } finally {
      setBusy(undefined);
    }
  };

  const o = detail.data;
  const step = o && !o.on_hold ? nextStep(o) : null;

  return (
    <Dialog open={Boolean(orderId)} onClose={onClose} title={o ? `${o.order_number} · #${o.pickup_number}` : 'Order'} wide>
      {!o ? (
        detail.error ? <Alert>{messageOf(detail.error)}</Alert> : <Spinner className="size-8 text-brand" />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{STATUS_LABEL[o.status]}</Badge>
            <Badge>{whereLabel(o)}</Badge>
            {o.receipt_number && <Badge>{o.receipt_number}</Badge>}
            {o.late_payment && <Badge tone="warning">Paid late</Badge>}
            <span className="text-sm text-ink-muted">Paid {formatDateTime(o.paid_at)}</span>
          </div>

          {o.on_hold && (
            <Alert tone="danger" title="On hold: needs a manager">
              {o.hold_reason ?? 'Flagged by a fraud check.'}
            </Alert>
          )}
          {o.reject_reason && <Alert tone="warning" title="Rejected">{o.reject_reason}</Alert>}
          {o.cancel_reason && <Alert tone="warning" title="Cancelled by the customer">{o.cancel_reason}</Alert>}
          {error && <Alert>{error}</Alert>}

          <div className="grid gap-5 md:grid-cols-2">
            <section>
              <h3 className="mb-2 text-xs font-black tracking-wider text-ink-muted uppercase">Items</h3>
              <ItemLines items={o.items} />
              {o.note && <p className="mt-3 rounded-2xl bg-warning-tint px-3 py-2 text-sm font-semibold text-warning">📝 {o.note}</p>}
              <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm">
                <Money label="Subtotal" paise={o.subtotal_paise} />
                <Money label="Offers" paise={-(o.promo_discount_paise + o.order_discount_paise)} />
                <Money label="Delivery" paise={o.delivery_fee_paise} />
                <Money label="GST" paise={o.tax_paise} />
                <div className="flex justify-between font-display text-lg font-black">
                  <dt>Total</dt>
                  <dd>{formatINR(o.total_paise)}</dd>
                </div>
              </dl>
            </section>

            <section className="flex flex-col gap-4 text-sm">
              <div>
                <h3 className="mb-1 text-xs font-black tracking-wider text-ink-muted uppercase">Customer</h3>
                <p className="font-bold">{o.customer_name}</p>
                <p className="flex items-center gap-2">
                  <span className="font-mono">{mobile ?? o.mobile_masked}</span>
                  {!mobile && (
                    <button
                      type="button"
                      className="text-xs font-bold text-brand-ink underline"
                      onClick={() => void act('reveal', async () => setMobile((await rpc<{ mobile: string }>(staff.db, 'reveal_customer_mobile', { p_order_id: o.id })).mobile))}
                    >
                      Show number (logged)
                    </button>
                  )}
                </p>
                {o.delivery_address && (
                  <p className="mt-1">
                    📍 {o.delivery_address}
                    {o.delivery_landmark && <span className="text-ink-muted"> · {o.delivery_landmark}</span>}
                  </p>
                )}
              </div>

              <div>
                <h3 className="mb-1 text-xs font-black tracking-wider text-ink-muted uppercase">Payment</h3>
                {o.payments.map((p) => (
                  <p key={p.id} className={cn(p.is_duplicate && 'text-ink-muted')}>
                    {formatINR(p.amount_paise)} · {(p.method ?? '').toUpperCase()} · <span className="capitalize">{p.status.replace('_', ' ')}</span>
                    {p.is_duplicate && ' · duplicate (auto-refunded)'}
                    <span className="block font-mono text-xs text-ink-muted">
                      {p.provider_payment_id}
                      {p.vpa_masked && ` · ${p.vpa_masked}`}
                    </span>
                  </p>
                ))}
              </div>

              {o.refunds.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-black tracking-wider text-ink-muted uppercase">Refunds</h3>
                  <ul className="flex flex-col gap-1.5">
                    {o.refunds.map((r) => (
                      <li key={r.id}>
                        <Badge tone={REFUND_TONE[r.status]} className="capitalize">{r.status}</Badge> {formatINR(r.amount_paise)} · {r.reason}
                        <span className="block text-xs text-ink-muted">
                          {r.is_automatic ? 'Automatic' : `Asked by ${r.requested_by ?? 'the system'}`}
                          {r.decided_by && ` · decided by ${r.decided_by}`}
                          {r.decision_note && ` · “${r.decision_note}”`}
                          {r.failure_reason && r.status === 'failed' && ` · ${r.failure_reason}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <h3 className="mb-1 text-xs font-black tracking-wider text-ink-muted uppercase">Timeline</h3>
                <ol className="flex flex-col gap-1">
                  {o.timeline.map((e, i) => (
                    <li key={i}>
                      <span className="text-ink-muted">{formatTime(e.at)}</span> {STATUS_LABEL[e.to]}
                      <span className="text-ink-muted"> · {e.staff ?? (e.actor === 'customer' ? 'customer' : 'system')}</span>
                      {e.reason && <span className="text-ink-muted"> · “{e.reason}”</span>}
                    </li>
                  ))}
                </ol>
              </div>

              {o.flags.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-black tracking-wider text-ink-muted uppercase">Risk checks</h3>
                  {o.flags.map((f, i) => (
                    <Badge key={i} tone={f.severity === 'block' ? 'danger' : f.severity === 'warn' ? 'warning' : 'neutral'} className="mr-1">
                      {f.rule.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {o.status === 'pending' && !o.on_hold && (
              <>
                <AcceptButton order={o} onDone={() => { detail.reload(); onChanged?.(); }} onError={setError} />
                <Button variant="secondary" onClick={() => setDialog('reject')}>Reject…</Button>
              </>
            )}
            {step && (
              <Button loading={busy === 'step'} onClick={() => void act('step', () => rpc(staff.db, 'advance_order', { p_order_id: o.id, p_version: o.version, p_to_status: step.to }))}>
                {step.label}
              </Button>
            )}
            {o.receipt_number && (
              <Button variant="secondary" loading={busy === 'receipt'} onClick={() => void act('receipt', async () => printReceipt(await rpc<ReceiptData>(staff.db, 'order_receipt', { p_order_id: o.id })))}>
                Print receipt
              </Button>
            )}
            {['confirmed', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) && (
              <Button variant="secondary" onClick={() => printKot(o, true)}>Reprint KOT</Button>
            )}
            {!['pending', 'rejected', 'cancelled', 'refunded'].includes(o.status) && (
              <Button variant="secondary" onClick={() => setDialog('refund')}>Request refund…</Button>
            )}
            {isManager && ['confirmed', 'preparing', 'ready', 'out_for_delivery'].includes(o.status) && (
              <Button variant="ghost" onClick={() => setDialog('back')}>Step back…</Button>
            )}
            {isManager && o.on_hold && <Button onClick={() => setDialog('hold')}>Review hold…</Button>}
          </div>

          <RefundDialog open={dialog === 'refund'} order={o} onClose={() => setDialog(null)} onDone={() => { setDialog(null); detail.reload(); onChanged?.(); }} />
          <ReasonDialog
            open={dialog === 'reject'}
            title={`Reject ${o.order_number}?`}
            intro="The customer is told the reason, and a full refund goes to a manager for approval."
            label="Reason (shown to the customer)"
            placeholder="e.g. Machine under repair"
            action="Reject order"
            danger
            onClose={() => setDialog(null)}
            onSubmit={(reason) => rpc(staff.db, 'reject_order', { p_order_id: o.id, p_version: o.version, p_reason: reason }).then(() => { setDialog(null); detail.reload(); onChanged?.(); })}
          />
          <ReasonDialog
            open={dialog === 'back'}
            title="Step back one status?"
            intro={`${STATUS_LABEL[o.status]} → previous step. This is logged.`}
            label="Why?"
            placeholder="e.g. Tapped Ready by mistake"
            action="Step back"
            onClose={() => setDialog(null)}
            onSubmit={(reason) => rpc(staff.db, 'revert_order_status', { p_order_id: o.id, p_version: o.version, p_reason: reason }).then(() => { setDialog(null); detail.reload(); onChanged?.(); })}
          />
          <ReasonDialog
            open={dialog === 'hold'}
            title="Release this order?"
            intro={`Held because: ${o.hold_reason ?? 'a fraud check'}. Only release it once you've checked the payment in the Razorpay dashboard.`}
            label="What did you check?"
            placeholder="e.g. Razorpay shows ₹487 captured"
            action="Release hold"
            onClose={() => setDialog(null)}
            onSubmit={(note) => rpc(staff.db, 'clear_order_hold', { p_order_id: o.id, p_note: note }).then(() => { setDialog(null); detail.reload(); onChanged?.(); })}
          />
        </div>
      )}
    </Dialog>
  );
}

function Money({ label, paise }: { label: string; paise: number }) {
  if (!paise) return null;
  return (
    <div className="flex justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd>{paise < 0 ? `−${formatINR(-paise)}` : formatINR(paise)}</dd>
    </div>
  );
}

/** Accept an order: the shop takes it on and the receipt number is issued. */
export function AcceptButton({
  order,
  onDone,
  onError,
  size = 'md',
}: {
  order: { id: string; version: number };
  onDone: () => void;
  onError: (message: string) => void;
  size?: 'sm' | 'md';
}) {
  const staff = useStaff();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await rpc(staff.db, 'accept_order', { p_order_id: order.id, p_version: order.version });
      onDone();
    } catch (e) {
      onError(messageOf(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size={size} loading={busy} onClick={() => void accept()}>
      ✓ Accept
    </Button>
  );
}

export function ReasonDialog({
  open,
  title,
  intro,
  label,
  placeholder,
  action,
  danger = false,
  extra,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  intro: string;
  label: string;
  placeholder: string;
  action: string;
  danger?: boolean;
  /** Extra controls above the reason box (e.g. what exactly to block). */
  extra?: React.ReactNode;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const close = () => {
    setText('');
    setError(undefined);
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(text.trim());
      setText('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close} title={title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-ink-muted">{intro}</p>
        {extra}
        <TextField label={label} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} maxLength={200} autoFocus error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy} disabled={text.trim().length < 3}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Request a refund: whole order, or chosen items. The server works out the amount. */
function RefundDialog({ open, order, onClose, onDone }: { open: boolean; order: OrderDetail; onClose: () => void; onDone: () => void }) {
  const staff = useStaff();
  const [kind, setKind] = useState<'full' | 'partial'>('partial');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ amount_paise: number; needs: 'manager' | 'owner' }>();

  const chosen = Object.entries(qty).filter(([, n]) => n > 0);
  const estimate = order.items.reduce((sum, i) => {
    const n = qty[i.id] ?? 0;
    return sum + (n && i.line_total_paise !== undefined ? Math.round(((i.line_total_paise - (i.promo_discount_paise ?? 0)) / i.qty) * n) : 0);
  }, 0);

  const close = () => {
    setQty({});
    setReason('');
    setError(undefined);
    setResult(undefined);
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await rpc(staff.db, 'request_refund', {
          p_order_id: order.id,
          p_kind: kind,
          p_items: kind === 'partial' ? chosen.map(([order_item_id, n]) => ({ order_item_id, qty: n })) : null,
          p_reason: reason.trim(),
        }),
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} title="Request a refund">
      {result ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success" title={`Refund of ${formatINR(result.amount_paise)} requested`}>
            {result.needs === 'owner' ? 'This one is above the limit, so the Owner has to approve it.' : 'A manager (not you) needs to approve it. The money then goes back to the customer’s UPI.'}
          </Alert>
          <Button onClick={() => { close(); onDone(); }}>Done</Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Refund type">
            {(['partial', 'full'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn('h-11 rounded-full border-2 font-bold', kind === k ? 'border-brand bg-brand-tint text-brand-ink' : 'border-line text-ink-muted')}
              >
                {k === 'partial' ? 'Some items' : 'Whole order'}
              </button>
            ))}
          </div>
          {kind === 'partial' && (
            <ul className="flex flex-col gap-2">
              {order.items.map((i) => {
                const max = i.qty - (i.refunded_qty ?? 0);
                const n = qty[i.id] ?? 0;
                return (
                  <li key={i.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line px-3 py-2">
                    <span className="min-w-0 text-sm">
                      <b>{i.name}</b> · {i.variant}
                      <span className="block text-xs text-ink-muted">{max} of {i.qty} can be refunded</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <button type="button" aria-label={`One less ${i.name}`} className="size-9 rounded-full border border-line font-bold disabled:opacity-40" disabled={n === 0} onClick={() => setQty({ ...qty, [i.id]: n - 1 })}>−</button>
                      <span className="w-5 text-center font-bold">{n}</span>
                      <button type="button" aria-label={`One more ${i.name}`} className="size-9 rounded-full border border-line font-bold disabled:opacity-40" disabled={n >= max} onClick={() => setQty({ ...qty, [i.id]: n + 1 })}>+</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-sm text-ink-muted">
            {kind === 'full' ? 'Everything not already refunded, including delivery.' : estimate ? `About ${formatINR(estimate)} (after any discounts; the system works out the exact amount).` : 'Choose the items to refund.'}
          </p>
          <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong flavour made" maxLength={300} error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={reason.trim().length < 3 || (kind === 'partial' && chosen.length === 0)}>
              Send for approval
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
