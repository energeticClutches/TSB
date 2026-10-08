import { formatINR } from '@slush/core';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '@slush/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { OrderDrawer, ReasonDialog } from '../components/OrderDrawer';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { formatDateTime } from '../lib/orders';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Flag {
  id: number;
  rule: string;
  severity: 'info' | 'warn' | 'block';
  status: 'open' | 'cleared' | 'confirmed';
  details: Record<string, unknown>;
  created_at: string;
  order_id: string | null;
  order_number: string | null;
  customer_id: string | null;
  customer: string | null;
  staff: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

interface Risk {
  flags: Flag[];
  open_count: number;
  blocked: { id: string; kind: string; masked: string | null; scope: string; reason: string; expires_at: string | null; created_at: string; by: string | null }[];
  approvals: { id: string; kind: string; summary: string; created_at: string; requested_by: string | null }[];
  reconciliation: {
    at: string;
    status: string;
    window_start: string;
    window_end: string;
    provider_count: number;
    db_count: number;
    provider_paise: number;
    db_paise: number;
    mismatches: { kind: string; payment_id: string }[];
    fixed: number;
  } | null;
  chains: { audit_ok: boolean; ledger_ok: boolean } | null;
  disputes: number;
}

/** Plain-English explanation of each automatic check (Phase 4 §10). */
const RULES: Record<string, string> = {
  AMOUNT_MISMATCH: 'The amount paid didn’t match the order total, so the order was held.',
  DUPLICATE_PAYMENT: 'The customer paid twice for one order. The extra payment was refunded automatically.',
  LATE_PAYMENT: 'The payment arrived after the 30-minute window had closed.',
  TOKEN_AFTER_REFUND: 'A refund left this customer below the amount that earned their Lucky Draw number. Decide whether to cancel it.',
  LATE_PAYMENT_COUPON: 'A late payment came in but the coupon slot was already used by someone else.',
  REFUND_FAILED: 'Razorpay couldn’t send a refund back. Try sending it again from the Refunds screen.',
  REFUND_VOLUME: 'A staff member asked for more refunds today than the daily limit.',
  RECON_MISMATCH: 'The 10-minute check found a difference between Razorpay and our records.',
  DISPUTE_OPENED: 'A customer’s bank opened a dispute (chargeback). The customer is frozen until reviewed.',
  MULTI_MOBILE_DEVICE: 'One phone placed orders with more than three different mobile numbers that earn tokens.',
  MULTI_MOBILE_VPA: 'One UPI account paid for more than three different mobile numbers that earn tokens.',
  TOKEN_EARNED_NEW_VPA: 'A Lucky Draw number was earned on an order paid from a UPI account never seen for that number.',
  FAST_COMPLETE: 'An order that counts towards the Lucky Draw was marked completed less than a minute after it was accepted.',
  PRICE_FLIP: 'A price was changed and put back within a day, with orders placed in between.',
};

/** Plain words for the evidence a rule recorded (the raw record stays in the database). */
function evidence(details: Record<string, unknown>): string {
  const bits: string[] = [];
  const n = (k: string) => (typeof details[k] === 'number' ? (details[k] as number) : null);
  if (n('mobiles')) bits.push(`${n('mobiles')} different mobile numbers`);
  if (details.vpa) bits.push(`UPI ${String(details.vpa)}`);
  if (n('amount_paise')) bits.push(`${formatINR(n('amount_paise')!)}`);
  if (n('expected') && n('captured')) bits.push(`expected ${formatINR(n('expected')!)}, paid ${formatINR(n('captured')!)}`);
  if (n('requests_today')) bits.push(`${n('requests_today')} refund requests today`);
  if (Array.isArray(details.mismatches)) bits.push(`${(details.mismatches as unknown[]).length} payments don't match`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

const SEVERITY: Record<string, { tone: 'danger' | 'warning' | 'neutral'; label: string }> = {
  block: { tone: 'danger', label: 'Stopped' },
  warn: { tone: 'warning', label: 'Check this' },
  info: { tone: 'neutral', label: 'For information' },
};

/** A12: Risk & approvals. */
export function RiskPage() {
  const staff = useStaff();
  const data = useAsync(() => rpc<Risk>(staff.db, 'risk_overview'), [staff.db]);
  const [showAll, setShowAll] = useState(false);
  const [reviewing, setReviewing] = useState<{ flag: Flag; outcome: 'cleared' | 'confirmed' } | null>(null);
  const [blocking, setBlocking] = useState<{ flag: Flag; kind: 'mobile' | 'vpa' | 'device' } | null>(null);
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  if (!data.data) return data.error ? <Alert>{messageOf(data.error)}</Alert> : <Spinner className="size-8 text-brand" />;
  const d = data.data;
  const flags = showAll ? d.flags : d.flags.filter((f) => f.status === 'open');
  const recon = d.reconciliation;

  return (
    <>
      <PageHeader
        title="Risk & checks"
        description="Automatic checks run on every order and every 10 minutes. Nothing here stops the shop working: it’s for you to look at."
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={d.open_count > 0 ? 'bg-warning-tint' : ''}>
          <p className="text-xs font-bold tracking-wider text-ink-muted uppercase">Needs a look</p>
          <p className="font-display text-3xl font-black">{d.open_count}</p>
        </Card>
        <Card className={d.disputes > 0 ? 'bg-danger-tint' : ''}>
          <p className="text-xs font-bold tracking-wider text-ink-muted uppercase">Bank disputes</p>
          <p className="font-display text-3xl font-black">{d.disputes}</p>
        </Card>
        <Card>
          <p className="text-xs font-bold tracking-wider text-ink-muted uppercase">Money check</p>
          {recon ? (
            <>
              <p className={`font-display text-2xl font-black ${recon.status === 'needs_review' ? 'text-danger' : 'text-success'}`}>
                {recon.status === 'ok' ? 'All matched' : recon.status === 'fixed' ? `${recon.fixed} repaired` : `${recon.mismatches.length} to check`}
              </p>
              <p className="text-sm text-ink-muted">
                {formatDateTime(recon.at)} · {recon.provider_count} payments at Razorpay ({formatINR(recon.provider_paise)}) vs {recon.db_count} here (
                {formatINR(recon.db_paise)})
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Runs every 10 minutes once the shop is live.</p>
          )}
        </Card>
        <Card>
          <p className="text-xs font-bold tracking-wider text-ink-muted uppercase">Tamper check</p>
          {d.chains ? (
            <p className={`font-display text-2xl font-black ${d.chains.audit_ok && d.chains.ledger_ok ? 'text-success' : 'text-danger'}`}>
              {d.chains.audit_ok && d.chains.ledger_ok ? '✓ Intact' : '⚠ Broken'}
            </p>
          ) : (
            <p className="text-sm text-ink-muted">Only the Owner sees this.</p>
          )}
          <p className="text-sm text-ink-muted">History of changes and Lucky Draw history</p>
        </Card>
      </div>

      {d.approvals.length > 0 && (
        <Card className="mt-4">
          <h2 className="mb-2 font-display text-lg font-extrabold">Waiting for the Owner</h2>
          <ul className="divide-y divide-line text-sm">
            {d.approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {a.summary} <span className="text-ink-muted">· asked by {a.requested_by ?? 'staff'} · {formatDateTime(a.created_at)}</span>
                </span>
                {staff.role === 'owner' && (
                  <Link to="/approvals" className="font-bold text-brand-ink underline">
                    Decide →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-extrabold">Automatic checks</h2>
        <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show only open' : 'Show reviewed too'}
        </Button>
      </div>
      {flags.length === 0 && <EmptyState title="Nothing to look at">Every automatic check is happy.</EmptyState>}
      <div className="flex flex-col gap-3">
        {flags.map((f) => {
          const sev = SEVERITY[f.severity] ?? SEVERITY.info!;
          return (
            <Card key={f.id} className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={sev.tone}>{sev.label}</Badge>
                  <b className="font-mono text-xs">{f.rule}</b>
                  {f.status !== 'open' && <Badge tone={f.status === 'cleared' ? 'success' : 'danger'}>{f.status === 'cleared' ? 'Cleared' : 'Confirmed'}</Badge>}
                  <span className="text-sm text-ink-muted">{formatDateTime(f.created_at)}</span>
                </p>
                <p className="mt-1 text-sm">{RULES[f.rule] ?? 'An automatic check raised this.'}</p>
                <p className="mt-1 text-sm text-ink-muted">
                  {f.order_number && (
                    <button type="button" className="font-bold text-brand-ink underline" onClick={() => setOpenOrder(f.order_id)}>
                      {f.order_number}
                    </button>
                  )}
                  {f.customer && ` · ${f.customer}`}
                  {f.staff && ` · staff: ${f.staff}`}
                  {evidence(f.details)}
                </p>
                {f.reviewed_at && (
                  <p className="mt-1 text-xs text-ink-muted">
                    Reviewed by {f.reviewed_by} on {formatDateTime(f.reviewed_at)}
                    {f.review_note && ` · “${f.review_note}”`}
                  </p>
                )}
              </div>
              {f.status === 'open' && (
                <div className="flex flex-wrap gap-2">
                  {f.order_id && (
                    <Button size="sm" variant="ghost" onClick={() => setBlocking({ flag: f, kind: 'mobile' })}>
                      Block…
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setReviewing({ flag: f, outcome: 'confirmed' })}>
                    It was real
                  </Button>
                  <Button size="sm" onClick={() => setReviewing({ flag: f, outcome: 'cleared' })}>
                    All fine
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <h2 className="mt-8 mb-3 font-display text-lg font-extrabold">Blocked</h2>
      {d.blocked.length === 0 ? (
        <EmptyState title="Nobody is blocked">Block a number, UPI account or phone from a flagged order above.</EmptyState>
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-line">
            {d.blocked.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span>
                  <b>{b.masked ?? b.kind}</b> <span className="text-ink-muted">({b.kind})</span> ·{' '}
                  {b.scope === 'all' ? 'can’t order online' : b.scope === 'offers' ? 'no coupons or offers' : 'no reward tokens'}
                  <span className="block text-xs text-ink-muted">
                    {b.reason} · by {b.by ?? 'staff'} · {formatDateTime(b.created_at)}
                    {b.expires_at && ` · until ${formatDateTime(b.expires_at)}`}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setUnblocking(b.id)}>
                  Unblock…
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ReasonDialog
        open={Boolean(reviewing)}
        title={reviewing?.outcome === 'cleared' ? 'Mark as fine?' : 'Confirm this was real?'}
        intro={
          reviewing?.outcome === 'cleared'
            ? 'Use this when you’ve checked and there’s nothing wrong.'
            : 'Use this when it really was a problem. The flag stays on the customer’s record.'
        }
        label="What did you find?"
        placeholder="e.g. Regular customer, family uses one phone"
        action={reviewing?.outcome === 'cleared' ? 'All fine' : 'It was real'}
        danger={reviewing?.outcome === 'confirmed'}
        onClose={() => setReviewing(null)}
        onSubmit={async (note) => {
          try {
            await rpc(staff.db, 'review_fraud_flag', { p_flag_id: reviewing!.flag.id, p_outcome: reviewing!.outcome, p_note: note });
            setReviewing(null);
            data.reload();
          } catch (e) {
            setError(messageOf(e));
            setReviewing(null);
          }
        }}
      />
      <BlockDialog
        flag={blocking?.flag ?? null}
        onClose={() => setBlocking(null)}
        onDone={() => {
          setBlocking(null);
          data.reload();
        }}
        onError={setError}
      />
      <ReasonDialog
        open={Boolean(unblocking)}
        title="Remove this block?"
        intro="They’ll be able to order online again straight away."
        label="Why?"
        placeholder="e.g. Sorted out with the customer"
        action="Unblock"
        onClose={() => setUnblocking(null)}
        onSubmit={async (reason) => {
          await rpc(staff.db, 'unblock_identity', { p_id: unblocking, p_reason: reason });
          setUnblocking(null);
          data.reload();
        }}
      />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={data.reload} />
    </>
  );
}

function BlockDialog({ flag, onClose, onDone, onError }: { flag: Flag | null; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const staff = useStaff();
  const [kind, setKind] = useState<'mobile' | 'vpa' | 'device'>('mobile');
  const [scope, setScope] = useState<'all' | 'offers' | 'tokens'>('all');
  if (!flag) return null;
  return (
    <ReasonDialog
      open
      title="Block this customer"
      intro="Blocking uses a scrambled copy of the number, UPI id or phone id: the raw value is never stored."
      label="Reason (saved in the audit log)"
      placeholder="e.g. Three chargebacks in a week"
      action="Block"
      danger
      onClose={onClose}
      onSubmit={async (reason) => {
        try {
          await rpc(staff.db, 'block_identity', { p_order_id: flag.order_id, p_kind: kind, p_scope: scope, p_reason: reason });
          onDone();
        } catch (e) {
          onError(messageOf(e));
          onClose();
        }
      }}
      extra={
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-bold">
            What
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="h-12 rounded-2xl border border-line bg-card px-3">
              <option value="mobile">Their mobile number</option>
              <option value="vpa">Their UPI account</option>
              <option value="device">Their phone</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-bold">
            Stops them from
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="h-12 rounded-2xl border border-line bg-card px-3">
              <option value="all">ordering online at all</option>
              <option value="offers">using coupons and offers</option>
              <option value="tokens">earning towards the Lucky Draw</option>
            </select>
          </label>
        </div>
      }
    />
  );
}
