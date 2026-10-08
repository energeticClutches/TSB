import { formatINR } from '@slush/core';
import { Alert, Badge, Button, Card, EmptyState, SelectField, Spinner, TextField } from '@slush/ui';
import { useState } from 'react';
import { OrderDrawer } from '../components/OrderDrawer';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { type OrderStatus, type OrderType, STATUS_LABEL, TYPE_LABEL, formatDateTime, whereLabel } from '../lib/orders';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface HistoryRow {
  id: string;
  order_number: string;
  pickup_number: number;
  order_type: OrderType;
  status: OrderStatus;
  table_label: string | null;
  customer_name: string;
  mobile_masked: string;
  total_paise: number;
  paid_at: string;
  payment_status: string | null;
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** A6: order history. Cashiers see today only (enforced by the database). */
export function OrdersPage() {
  const staff = useStaff();
  const isCashier = staff.role === 'cashier';
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const filters = { from, to, page, ...(status && { status }), ...(type && { order_type: type }), ...(query && { q: query }) };
  const history = useAsync(
    () => rpc<{ rows: HistoryRow[]; total: number; page: number; page_size: number }>(staff.db, 'order_history', { p: filters }),
    [staff.db, JSON.stringify(filters)],
  );
  const pages = history.data ? Math.max(1, Math.ceil(history.data.total / history.data.page_size)) : 1;

  return (
    <>
      <PageHeader title="Orders" description={isCashier ? 'Today’s paid orders. Search by pickup number, order number, name or mobile.' : 'Every paid order. Search by pickup number, order number, name or mobile.'} />
      <form
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_repeat(4,auto)]"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
      >
        <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="42, SL-1025, Riya or 98765…" />
        {!isCashier && (
          <>
            <TextField label="From" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
            <TextField label="To" type="date" value={to} min={from} max={today()} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          </>
        )}
        <SelectField label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All</option>
          {(Object.keys(STATUS_LABEL) as OrderStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </SelectField>
        <SelectField label="Type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">All</option>
          {(Object.keys(TYPE_LABEL) as OrderType[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </SelectField>
      </form>

      {history.error ? <Alert>{messageOf(history.error)}</Alert> : null}
      {history.loading && !history.data && <Spinner className="size-8 text-brand" />}
      {history.data && history.data.rows.length === 0 && <EmptyState title="No orders found">Try another date or search.</EmptyState>}
      {history.data && history.data.rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs tracking-wider text-ink-muted uppercase">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Where</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {history.data.rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-brand-tint/40" onClick={() => setOpenId(r.id)}>
                  <td className="px-4 py-3">
                    <button type="button" className="font-bold text-brand-ink" onClick={() => setOpenId(r.id)}>
                      {r.order_number}
                    </button>
                    <span className="ml-2 text-ink-muted">#{r.pickup_number}</span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(r.paid_at)}</td>
                  <td className="px-4 py-3">
                    {r.customer_name}
                    <span className="block font-mono text-xs text-ink-muted">{r.mobile_masked}</span>
                  </td>
                  <td className="px-4 py-3">{whereLabel(r)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={r.status === 'completed' || r.status === 'delivered' ? 'success' : ['rejected', 'cancelled', 'refunded'].includes(r.status) ? 'danger' : 'brand'}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                    {r.payment_status === 'partially_refunded' && <Badge tone="warning" className="ml-1">Part refunded</Badge>}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{formatINR(r.total_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
            <span className="text-ink-muted">
              {history.data.total} order{history.data.total === 1 ? '' : 's'}
            </span>
            <span className="flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</Button>
              <span>Page {page} of {pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older →</Button>
            </span>
          </div>
        </Card>
      )}
      <OrderDrawer orderId={openId} onClose={() => setOpenId(null)} onChanged={history.reload} />
    </>
  );
}
