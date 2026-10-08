import { formatINR, rupeesToPaise } from '@slush/core';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Spinner, TextField } from '@slush/ui';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { OrderDrawer, ReasonDialog } from '../components/OrderDrawer';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { STATUS_LABEL, type OrderStatus, formatDateTime } from '../lib/orders';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface SearchRow {
  id: string;
  name: string | null;
  mobile_masked: string;
  order_count: number;
  last_order_at: string | null;
  loyalty_spend_paise: number;
  token: string | null;
  frozen: boolean;
}

interface Detail {
  id: string;
  name: string | null;
  mobile_masked: string;
  first_order_at: string | null;
  last_order_at: string | null;
  order_count: number;
  total_spent_paise: number;
  loyalty_spend_paise: number;
  threshold_paise: number;
  tokens_left: number;
  frozen: boolean;
  frozen_reason: string | null;
  token: { id: string; code: string; status: 'issued' | 'void'; issued_at: string; spend_at_issue_paise: number; void_reason: string | null } | null;
  ledger:
    | { id: number; type: string; spend_delta_paise: number; spend_after_paise: number; order_number: string | null; staff: string | null; reason: string | null; at: string }[]
    | null;
  orders: { id: string; order_number: string; status: OrderStatus; total_paise: number; paid_at: string }[];
  flags: { rule: string; severity: 'info' | 'warn' | 'block'; status: string; at: string }[] | null;
}

const LEDGER_LABEL: Record<string, string> = {
  loyalty_earned: 'Spent on an order',
  loyalty_reversed: 'Taken back (refund)',
  token_issued: 'Lucky Draw number earned',
  token_voided: 'Lucky Draw number cancelled',
  manual_loyalty_adjust: 'Corrected by hand',
};

/** A10: customer lookup (Cashier) and profile with their Lucky Draw standing (Manager+). */
export function CustomersPage() {
  const { id } = useParams();
  return id ? <CustomerProfile id={id} /> : <CustomerSearch />;
}

function CustomerSearch() {
  const staff = useStaff();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const results = useAsync(() => (query ? rpc<SearchRow[]>(staff.db, 'customer_search', { p_q: query }) : Promise.resolve([])), [staff.db, query]);
  return (
    <>
      <PageHeader title="Customers" description="Search by the full 10-digit mobile number or by name. Numbers are always shown masked." />
      <form
        className="mb-5 flex max-w-xl items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <div className="flex-1">
          <TextField label="Mobile or name" value={q} onChange={(e) => setQ(e.target.value)} placeholder="98765 43210 or Riya" />
        </div>
        <Button type="submit" disabled={q.trim().length < 2}>
          Search
        </Button>
      </form>
      {results.loading && query && <Spinner className="size-8 text-brand" />}
      {results.error ? <Alert>{messageOf(results.error)}</Alert> : null}
      {query && results.data?.length === 0 && <EmptyState title="No customers found">Check the number, or try part of the name.</EmptyState>}
      <div className="flex flex-col gap-2">
        {results.data?.map((c) => (
          <Link key={c.id} to={`/customers/${c.id}`} className="block">
            <Card className="flex flex-wrap items-center justify-between gap-3 transition hover:ring-2 hover:ring-brand">
              <span>
                <b>{c.name ?? 'Customer'}</b> <span className="font-mono text-sm text-ink-muted">{c.mobile_masked}</span>
                {c.frozen && <Badge tone="danger" className="ml-2">Frozen</Badge>}
                <span className="block text-sm text-ink-muted">
                  {c.order_count} orders · last {formatDateTime(c.last_order_at) || '—'}
                </span>
              </span>
              <span className="text-sm font-bold text-lagoon-ink">
                {c.token ? <span className="font-mono">{c.token}</span> : `${formatINR(c.loyalty_spend_paise)} so far`}
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

function CustomerProfile({ id }: { id: string }) {
  const staff = useStaff();
  const stepUp = useStepUp();
  const isManager = staff.role === 'owner' || staff.role === 'manager';
  const detail = useAsync(() => rpc<Detail>(staff.db, 'customer_detail', { p_customer_id: id }), [staff.db, id]);
  const [dialog, setDialog] = useState<'freeze' | 'unfreeze' | 'adjust' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string }>();
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  if (!detail.data) return detail.error ? <Alert>{messageOf(detail.error)}</Alert> : <Spinner className="size-8 text-brand" />;
  const c = detail.data;
  const pct = Math.min(100, Math.round((c.loyalty_spend_paise / c.threshold_paise) * 100));
  const remaining = Math.max(0, c.threshold_paise - c.loyalty_spend_paise);

  return (
    <>
      <Link to="/customers" className="mb-3 inline-block text-sm font-bold text-brand-ink underline">
        ← All customers
      </Link>
      <PageHeader
        title={c.name ?? 'Customer'}
        description={`${c.mobile_masked} · first order ${formatDateTime(c.first_order_at) || '—'} · ${c.order_count} orders · ${formatINR(c.total_spent_paise)} spent`}
        action={
          isManager && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setDialog('adjust')}>Correct spending…</Button>
              <Button variant={c.frozen ? 'primary' : 'ghost'} onClick={() => setDialog(c.frozen ? 'unfreeze' : 'freeze')}>
                {c.frozen ? 'Unfreeze…' : 'Freeze…'}
              </Button>
            </div>
          )
        }
      />
      {message && <div className="mb-4"><Alert tone={message.tone}>{message.text}</Alert></div>}
      {c.frozen && (
        <div className="mb-4">
          <Alert title="Frozen">This customer can still order, but their spending doesn't count towards the Lucky Draw. Reason: {c.frozen_reason}</Alert>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-lagoon-tint">
          <p className="text-sm font-bold text-lagoon-ink">Lucky Draw number</p>
          {c.token ? (
            <>
              <p className="font-display text-4xl font-black text-lagoon-ink">{c.token.code}</p>
              <p className="text-sm text-lagoon-ink">
                {c.token.status === 'void' ? `Cancelled: ${c.token.void_reason}` : `Earned ${formatDateTime(c.token.issued_at)}`}
              </p>
            </>
          ) : (
            <>
              <p className="font-display text-4xl font-black text-lagoon-ink">—</p>
              <p className="text-sm text-lagoon-ink">{c.tokens_left > 0 ? `${formatINR(remaining)} more to earn one` : 'All the numbers have gone'}</p>
            </>
          )}
        </Card>
        <Card className="md:col-span-2">
          <p className="text-sm font-bold">Spending that counts (GST and delivery not included)</p>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-lagoon" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {formatINR(c.loyalty_spend_paise)} of {formatINR(c.threshold_paise)}
            {c.token && ' · they already have their one number; spending keeps being recorded'}
          </p>
        </Card>
      </div>

      <div className="mt-6 grid gap-4">
        <Card>
          <h2 className="mb-2 font-display text-lg font-extrabold">Recent orders</h2>
          {c.orders.length === 0 && <p className="text-sm text-ink-muted">No orders at this shop.</p>}
          <ul className="divide-y divide-line text-sm">
            {c.orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 py-2">
                <button type="button" className="font-bold text-brand-ink underline" onClick={() => setOpenOrder(o.id)}>
                  {o.order_number}
                </button>
                <span className="text-ink-muted">{formatDateTime(o.paid_at)} · {STATUS_LABEL[o.status]} · {formatINR(o.total_paise)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {c.ledger && (
        <Card className="mt-6 overflow-x-auto p-0">
          <h2 className="px-5 pt-5 font-display text-lg font-extrabold">Lucky Draw history</h2>
          <p className="px-5 text-xs text-ink-muted">Every change, permanent and tamper-evident.</p>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="border-y border-line text-xs tracking-wider text-ink-muted uppercase">
              <tr>
                <th className="px-5 py-2">When</th>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2 text-right">Spending</th>
                <th className="px-5 py-2">By / why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {c.ledger.map((l) => (
                <tr key={l.id}>
                  <td className="px-5 py-2 whitespace-nowrap">{formatDateTime(l.at)}</td>
                  <td className="px-3 py-2">
                    {LEDGER_LABEL[l.type] ?? l.type}
                    {l.order_number && <span className="text-ink-muted"> · {l.order_number}</span>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {l.spend_delta_paise !== 0 && <span className={l.spend_delta_paise > 0 ? 'text-success' : 'text-danger'}>{l.spend_delta_paise > 0 ? '+' : '−'}{formatINR(Math.abs(l.spend_delta_paise))} </span>}
                    <span className="text-ink-muted">= {formatINR(l.spend_after_paise)}</span>
                  </td>
                  <td className="px-5 py-2 text-ink-muted">
                    {l.staff ?? 'system'}
                    {l.reason && ` · “${l.reason}”`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {c.flags && c.flags.length > 0 && (
        <Card className="mt-6">
          <h2 className="mb-2 font-display text-lg font-extrabold">Risk checks</h2>
          {c.flags.map((f, i) => (
            <Badge key={i} tone={f.severity === 'block' ? 'danger' : f.severity === 'warn' ? 'warning' : 'neutral'} className="mr-1">
              {f.rule.replace(/_/g, ' ').toLowerCase()} · {f.status}
            </Badge>
          ))}
        </Card>
      )}

      <ReasonDialog
        open={dialog === 'freeze' || dialog === 'unfreeze'}
        title={dialog === 'freeze' ? 'Freeze this customer?' : 'Unfreeze this customer?'}
        intro={dialog === 'freeze' ? 'They can still order, but their spending stops counting towards the Lucky Draw. Use for chargebacks or suspected abuse.' : 'Their spending counts again.'}
        label="Reason (saved in the audit log)"
        placeholder={dialog === 'freeze' ? 'e.g. UPI chargeback on SL-1042' : 'e.g. Bank confirmed it was an error'}
        action={dialog === 'freeze' ? 'Freeze' : 'Unfreeze'}
        danger={dialog === 'freeze'}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          await rpc(staff.db, 'set_customer_frozen', { p_customer_id: c.id, p_frozen: dialog === 'freeze', p_reason: reason });
          setDialog(null);
          detail.reload();
        }}
      />
      <AdjustDialog
        open={dialog === 'adjust'}
        spendPaise={c.loyalty_spend_paise}
        onClose={() => setDialog(null)}
        onSubmit={async (rupees, reason) => {
          const r = await stepUp(() =>
            rpc<{ status: 'done' | 'needs_owner'; token?: string | null }>(staff.db, 'adjust_loyalty', {
              p_customer_id: c.id,
              p_spend_delta: rupeesToPaise(rupees),
              p_reason: reason,
            }),
          );
          setDialog(null);
          setMessage(
            r.status === 'needs_owner'
              ? { tone: 'warning', text: 'That’s over today’s limit for corrections, so it has been sent to the Owner for approval.' }
              : { tone: 'success', text: `Done.${r.token ? ` That took them over the line: Lucky Draw number ${r.token}.` : ''}` },
          );
          detail.reload();
        }}
      />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={detail.reload} />
    </>
  );
}

function AdjustDialog({
  open,
  spendPaise,
  onClose,
  onSubmit,
}: {
  open: boolean;
  spendPaise: number;
  onClose: () => void;
  onSubmit: (rupees: number, reason: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState('0');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const p = Number.parseFloat(amount || '0');
  const valid = Number.isFinite(p) && p !== 0 && reason.trim().length >= 3;
  const close = () => {
    setAmount('0');
    setReason('');
    setError(undefined);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Correct spending">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          onSubmit(p, reason.trim())
            .then(close)
            .catch((err: unknown) => setError(messageOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <p className="text-sm text-ink-muted">
          For spending the app missed — a counter order paid in cash, say. Use a minus sign to take some off. More corrections than today’s
          limit go to the Owner. Everything is recorded with your name, and it can take them over the line into the draw.
        </p>
        <TextField label="Amount in ₹ (+ / −)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.-]/g, '').slice(0, 7))} />
        <p className="text-sm text-ink-muted">Counting now: {formatINR(spendPaise)}</p>
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Paid at the counter in cash, bill 214" maxLength={200} error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!valid}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
