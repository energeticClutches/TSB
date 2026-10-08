import { formatINR } from '@slush/core';
import { Alert, Button, Card, SelectField, Spinner, TextField, cn } from '@slush/ui';
import { useState } from 'react';
import { BarChart, BarList, StatTile } from '../components/Charts';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

type Tab = 'sales' | 'products' | 'categories' | 'hours' | 'payments' | 'tokens' | 'customers';
const TABS: [Tab, string][] = [
  ['sales', 'Sales'],
  ['products', 'Items'],
  ['categories', 'Categories'],
  ['hours', 'Busy hours'],
  ['payments', 'Payments & refunds'],
  ['tokens', 'Lucky Draw'],
  ['customers', 'Customers'],
];

const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const rupees = (paise: number) => (paise / 100).toFixed(2);

/** One CSV cell: quoted, with quotes doubled, so commas and names can't break the file. */
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadCsv(name: string, headers: string[], rows: unknown[][]) {
  // The BOM makes Excel open ₹ and Indian names correctly.
  const csv = `﻿${[headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** A13: reports. Every tab has a picture, a table and a CSV download. */
export function ReportsPage() {
  const staff = useStaff();
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(istToday);
  const [grain, setGrain] = useState<'day' | 'hour' | 'month'>('day');

  const params = { from, to, ...(tab === 'sales' ? { grain } : {}) };
  const report = useAsync(() => rpc<any>(staff.db, `report_${tab}`, { p: params }), [staff.db, tab, from, to, grain]);

  const quick = (days: number, label: string) => (
    <Button
      size="sm"
      variant={from === daysAgo(days - 1) && to === istToday() ? 'primary' : 'secondary'}
      onClick={() => {
        setFrom(daysAgo(days - 1));
        setTo(istToday());
      }}
    >
      {label}
    </Button>
  );

  return (
    <>
      <PageHeader title="Reports" description="Every figure comes from paid orders. Rejected, cancelled and unpaid attempts are never counted as sales." />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} min={from} max={istToday()} onChange={(e) => setTo(e.target.value)} />
        <div className="flex gap-2 pb-1">
          {quick(1, 'Today')}
          {quick(7, '7 days')}
          {quick(30, '30 days')}
        </div>
        {tab === 'sales' && (
          <SelectField label="Group by" value={grain} onChange={(e) => setGrain(e.target.value as 'day' | 'hour' | 'month')}>
            <option value="day">Day</option>
            <option value="hour">Hour</option>
            <option value="month">Month</option>
          </SelectField>
        )}
      </div>

      <div className="mb-5 flex flex-wrap gap-2" role="tablist">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn('rounded-full px-4 py-2 text-sm font-bold', tab === k ? 'bg-brand text-white shadow-glow' : 'bg-card text-ink-muted')}
          >
            {label}
          </button>
        ))}
      </div>

      {report.loading && !report.data && <Spinner className="size-8 text-brand" />}
      {report.error ? <Alert>{messageOf(report.error)}</Alert> : null}
      {report.data && (
        <div className="flex flex-col gap-4">
          {tab === 'sales' && <Sales d={report.data} from={from} to={to} grain={grain} />}
          {tab === 'products' && <Products d={report.data} from={from} to={to} />}
          {tab === 'categories' && <Categories d={report.data} from={from} to={to} />}
          {tab === 'hours' && <Hours d={report.data} from={from} to={to} />}
          {tab === 'payments' && <Payments d={report.data} from={from} to={to} />}
          {tab === 'tokens' && <Tokens d={report.data} from={from} to={to} />}
          {tab === 'customers' && <Customers d={report.data} from={from} to={to} />}
        </div>
      )}
    </>
  );
}

function Download({ name, from, to, headers, rows }: { name: string; from: string; to: string; headers: string[]; rows: unknown[][] }) {
  return (
    <div className="flex justify-end">
      <Button size="sm" variant="secondary" onClick={() => downloadCsv(`slush-${name}-${from}-to-${to}.csv`, headers, rows)} disabled={rows.length === 0}>
        Download CSV
      </Button>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-ink-muted">Nothing in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs tracking-wider text-ink-muted uppercase">
          <tr>
            {headers.map((h, i) => (
              <th key={h} className={cn('px-3 py-2', i > 0 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={cn('px-3 py-2', j > 0 && 'text-right')}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Days with no sales still get a (zero) bar, so one busy day isn't one giant block. */
function padDays(rows: any[], from: string, to: string) {
  const out: { label: string; value: number; hint: string }[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const found = rows.find((r) => r.bucket === key);
    out.push({ label: key.slice(5), value: found?.gross_paise ?? 0, hint: `${key} · ${found?.orders ?? 0} orders` });
    if (out.length > 370) break;
  }
  return out;
}

function Sales({ d, from, to, grain }: { d: any; from: string; to: string; grain: string }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Sales" value={formatINR(d.total.gross_paise)} tone="brand" />
        <StatTile label="Orders" value={String(d.total.orders)} />
        <StatTile label="Discounts given" value={formatINR(d.total.discount_paise)} />
        <StatTile label="Refunded" value={formatINR(d.total.refund_paise)} sub={`Net ${formatINR(d.total.net_paise)}`} />
      </div>
      <Card>
        <BarChart
          title={`Sales by ${grain}`}
          rows={grain === 'day' ? padDays(d.rows, from, to) : d.rows.map((r: any) => ({ label: r.bucket.slice(-5), value: r.gross_paise, hint: r.bucket }))}
        />
      </Card>
      <Card>
        <Download
          name="sales"
          from={from}
          to={to}
          headers={['Period', 'Orders', 'Sales (₹)', 'Discounts (₹)', 'Refunds (₹)', 'Net (₹)', 'Average (₹)']}
          rows={d.rows.map((r: any) => [r.bucket, r.orders, rupees(r.gross_paise), rupees(r.discount_paise), rupees(r.refund_paise), rupees(r.net_paise), rupees(r.avg_paise)])}
        />
        <Table
          headers={['Period', 'Orders', 'Sales', 'Discounts', 'Refunds', 'Net', 'Average']}
          rows={d.rows.map((r: any) => [r.bucket, r.orders, formatINR(r.gross_paise), formatINR(r.discount_paise), formatINR(r.refund_paise), formatINR(r.net_paise), formatINR(r.avg_paise)])}
        />
      </Card>
    </>
  );
}

function Products({ d, from, to }: { d: any; from: string; to: string }) {
  return (
    <>
      <Card>
        <BarList title="Best sellers" rows={d.map((p: any) => ({ label: `${p.name} · ${p.variant}`, value: p.gross_paise }))} limit={10} />
      </Card>
      <Card>
        <Download
          name="items"
          from={from}
          to={to}
          headers={['Item', 'Size', 'Sold', 'Refunded', 'Sales (₹)']}
          rows={d.map((p: any) => [p.name, p.variant, p.qty, p.refunded_qty, rupees(p.gross_paise)])}
        />
        <Table
          headers={['Item', 'Size', 'Sold', 'Refunded', 'Sales']}
          rows={d.map((p: any) => [p.name, p.variant, p.qty, p.refunded_qty, formatINR(p.gross_paise)])}
        />
      </Card>
    </>
  );
}

function Categories({ d, from, to }: { d: any; from: string; to: string }) {
  return (
    <Card>
      <BarList title="Sales by category" rows={d.map((c: any) => ({ label: c.name, value: c.gross_paise }))} />
      <div className="mt-4">
        <Download name="categories" from={from} to={to} headers={['Category', 'Items sold', 'Sales (₹)']} rows={d.map((c: any) => [c.name, c.qty, rupees(c.gross_paise)])} />
        <Table headers={['Category', 'Items sold', 'Sales']} rows={d.map((c: any) => [c.name, c.qty, formatINR(c.gross_paise)])} />
      </div>
    </Card>
  );
}

function Hours({ d, from, to }: { d: any; from: string; to: string }) {
  const busiest = [...d].sort((a: any, b: any) => b.orders - a.orders)[0];
  return (
    <>
      {busiest && <StatTile label="Busiest hour" value={`${busiest.hour}:00–${busiest.hour + 1}:00`} sub={`${busiest.orders} orders · ${formatINR(busiest.gross_paise)}`} tone="brand" />}
      <Card>
        <BarChart title="Sales by hour of day" rows={d.map((h: any) => ({ label: String(h.hour), value: h.gross_paise, hint: `${h.hour}:00 · ${h.orders} orders` }))} />
      </Card>
      <Card>
        <Download name="hours" from={from} to={to} headers={['Hour', 'Orders', 'Sales (₹)']} rows={d.map((h: any) => [`${h.hour}:00`, h.orders, rupees(h.gross_paise)])} />
        <Table headers={['Hour', 'Orders', 'Sales']} rows={d.map((h: any) => [`${h.hour}:00`, h.orders, formatINR(h.gross_paise)])} />
      </Card>
    </>
  );
}

function Payments({ d, from, to }: { d: any; from: string; to: string }) {
  const refunded = d.refunds.filter((r: any) => r.status === 'processed').reduce((s: number, r: any) => s + r.amount_paise, 0);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Refunded" value={formatINR(refunded)} />
        <StatTile label="Failed attempts" value={String(d.failed)} sub="No money was taken" />
        <StatTile label="Double payments" value={String(d.duplicates)} sub="Refunded automatically" tone={d.duplicates > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Disputes" value={String(d.disputed)} tone={d.disputed > 0 ? 'danger' : 'neutral'} />
      </div>
      <Card>
        <h2 className="mb-3 text-sm font-bold">How customers paid</h2>
        <Table
          headers={['Method', 'Payments', 'Amount', 'Refunded']}
          rows={d.methods.map((m: any) => [m.method.toUpperCase(), m.count, formatINR(m.amount_paise), formatINR(m.refunded_paise)])}
        />
        <h2 className="mt-6 mb-3 text-sm font-bold">Refunds by state</h2>
        <Table headers={['State', 'Count', 'Amount']} rows={d.refunds.map((r: any) => [r.status, r.count, formatINR(r.amount_paise)])} />
        <div className="mt-4">
          <Download
            name="payments"
            from={from}
            to={to}
            headers={['Method', 'Payments', 'Amount (₹)', 'Refunded (₹)']}
            rows={d.methods.map((m: any) => [m.method, m.count, rupees(m.amount_paise), rupees(m.refunded_paise)])}
          />
        </div>
      </Card>
    </>
  );
}

function Tokens({ d, from, to }: { d: any; from: string; to: string }) {
  if (!d.running) return <Card>No Lucky Draw is running.</Card>;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Numbers given out" value={String(d.tokens_issued)} sub={`of ${d.token_limit}`} tone="brand" />
        <StatTile label="Still to give" value={String(d.tokens_left)} tone={d.tokens_left === 0 ? 'warning' : 'neutral'} />
        <StatTile label="Earned in this period" value={String(d.issued_in_range)} />
        <StatTile label="Customers building up" value={String(d.loyalty_customers)} sub={`${formatINR(d.loyalty_spend_paise)} counted`} />
      </div>
      <Card>
        <BarChart
          title="How far along customers are"
          rows={d.bands.map((b: any) => ({ label: b.label, value: b.customers, hint: `${b.customers} customer(s)` }))}
          format={(n) => String(n)}
        />
      </Card>
      <Card>
        <Table
          headers={['Measure', 'Value']}
          rows={[
            ['Numbers in the campaign', d.token_limit],
            ['Given out so far', d.tokens_issued],
            ['Still to give', d.tokens_left],
            ['Earned in this period', d.issued_in_range],
            ['Cancelled', d.voided],
            ['Spending needed to earn one', formatINR(d.threshold_paise)],
            ['Spending counted in this period', formatINR(d.earned_in_range_paise)],
            ['Spending counted in total', formatINR(d.loyalty_spend_paise)],
            ['Customers more than half way', d.close_to_token],
          ]}
        />
        <div className="mt-4">
          <Download
            name="lucky-draw"
            from={from}
            to={to}
            headers={['Measure', 'Value']}
            rows={[
              ['Numbers in the campaign', d.token_limit],
              ['Given out so far', d.tokens_issued],
              ['Still to give', d.tokens_left],
              ['Earned in this period', d.issued_in_range],
              ['Cancelled', d.voided],
              ['Spending counted in this period (₹)', rupees(d.earned_in_range_paise)],
              ['Spending counted in total (₹)', rupees(d.loyalty_spend_paise)],
            ]}
          />
        </div>
      </Card>
    </>
  );
}

function Customers({ d, from, to }: { d: any; from: string; to: string }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Customers who ordered" value={String(d.ordering)} tone="brand" />
        <StatTile label="First-time customers" value={String(d.new)} />
        <StatTile label="Ordered more than once" value={String(d.repeat)} />
      </div>
      <Card>
        <BarList title="Orders by type" rows={d.by_type.map((t: any) => ({ label: t.order_type.replace('_', '-'), value: t.gross_paise }))} />
      </Card>
      <Card>
        <h2 className="mb-3 text-sm font-bold">Top customers</h2>
        <Table headers={['Customer', 'Mobile', 'Orders', 'Spent']} rows={d.top.map((c: any) => [c.name ?? 'Customer', c.mobile_masked, c.orders, formatINR(c.spent_paise)])} />
        <div className="mt-4">
          <Download
            name="customers"
            from={from}
            to={to}
            headers={['Customer', 'Mobile (masked)', 'Orders', 'Spent (₹)']}
            rows={d.top.map((c: any) => [c.name ?? '', c.mobile_masked, c.orders, rupees(c.spent_paise)])}
          />
        </div>
      </Card>
    </>
  );
}
