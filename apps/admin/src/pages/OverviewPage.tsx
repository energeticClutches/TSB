import { DEFAULT_SETTINGS, type Settings, crossCheckSettings, formatINR } from '@slush/core';
import { Badge, Card, EmptyState, Spinner } from '@slush/ui';
import { Link } from 'react-router';
import { BarChart, BarList, Delta, Meter, StatTile } from '../components/Charts';
import { PageHeader } from '../components/Shell';
import { rpc, select } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Dashboard {
  today: { orders: number; gross_paise: number; refund_paise: number; avg_paise: number };
  yesterday: { orders: number; gross_paise: number };
  live: { pending: number; in_kitchen: number; ready: number; on_hold: number };
  failed_payments: number;
  hours: { hour: number; orders: number; gross_paise: number }[];
  products: { name: string; variant: string; qty: number; gross_paise: number }[];
  customers: { new: number; ordering: number; repeat: number };
  tokens: { running: boolean; token_limit: number; tokens_issued: number; tokens_left: number; issued_in_range: number; close_to_token: number; threshold_paise: number };
  attention: { refund_requests: number | null; refund_failures: number | null; held_orders: number; approvals: number | null; fraud_flags: number | null };
}

/** Whole trading day, so one busy hour doesn't become one giant bar. */
function hourRows(hours: { hour: number; orders: number; gross_paise: number }[]) {
  const first = Math.min(10, ...hours.map((h) => h.hour));
  const last = Math.max(23, ...hours.map((h) => h.hour));
  return Array.from({ length: last - first + 1 }, (_, i) => {
    const hour = first + i;
    const found = hours.find((h) => h.hour === hour);
    return { label: `${hour}`, value: found?.gross_paise ?? 0, hint: `${hour}:00–${hour + 1}:00 · ${found?.orders ?? 0} orders` };
  });
}

/** A2: today at a glance, with the setup checklist until the shop is ready. */
export function OverviewPage() {
  const staff = useStaff();
  const data = useAsync(async () => {
    const [dash, settings, hours, team, qr] = await Promise.all([
      rpc<Dashboard>(staff.db, 'dashboard_today'),
      select<{ key: string; value: unknown }[]>(staff.db.from('settings').select('key, value')),
      select<{ id: string }[]>(staff.db.from('business_hours').select('id')),
      select<{ role: string }[]>(staff.db.from('staff_branch_roles').select('role')),
      select<{ id: string }[]>(staff.db.from('qr_codes').select('id').eq('is_active', true)),
    ]);
    const s = { ...DEFAULT_SETTINGS, ...Object.fromEntries(settings.map((r) => [r.key, r.value])) } as Settings;
    return { dash, s, hours: hours.length, team, qr: qr.length };
  }, [staff.db]);

  if (data.loading && !data.data) return <Spinner className="size-8 text-brand" />;
  if (data.error) return <EmptyState title="Couldn’t load the dashboard">{messageOf(data.error)}</EmptyState>;
  const { dash: d, s, hours, team, qr } = data.data!;
  const pinStaff = team.filter((t) => t.role === 'cashier' || t.role === 'kitchen').length;
  const steps = [
    { done: hours > 0, label: 'Opening hours set', to: '/hours' },
    { done: pinStaff > 0, label: 'Counter / kitchen staff added', to: '/staff' },
    { done: qr > 0, label: 'Table QR codes created and printed', to: '/qr' },
    { done: Boolean(s.legal_name), label: 'Legal name for receipts', to: '/settings' },
  ];
  const todo = steps.filter((x) => !x.done);
  const attention = [
    { n: d.attention.refund_requests ?? 0, label: 'refund request', to: '/refunds' },
    { n: d.attention.refund_failures ?? 0, label: 'failed refund', to: '/refunds' },
    { n: d.attention.held_orders, label: 'order on hold', to: '/board' },
    { n: d.attention.fraud_flags ?? 0, label: 'risk flag', to: '/risk' },
    { n: d.attention.approvals ?? 0, label: 'approval for you', to: '/approvals' },
  ].filter((a) => a.n > 0);

  return (
    <>
      <PageHeader title={`Hello, ${staff.name.split(' ')[0]}`} description="Today at The Slush Bar. Figures update as orders come in." />

      {attention.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {attention.map((a) => (
            <Link key={a.label} to={a.to}>
              <Badge tone={a.label.includes('hold') || a.label.includes('failed') ? 'danger' : 'warning'}>
                ⚠ {a.n} {a.label}
                {a.n === 1 ? '' : 's'} →
              </Badge>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sales today" value={formatINR(d.today.gross_paise)} tone="brand" sub={<Delta now={d.today.gross_paise} before={d.yesterday.gross_paise} label="yesterday" />} />
        <StatTile label="Orders" value={String(d.today.orders)} sub={<Delta now={d.today.orders} before={d.yesterday.orders} label="yesterday" />} />
        <StatTile label="Average order" value={formatINR(d.today.avg_paise)} sub={d.today.refund_paise > 0 ? `${formatINR(d.today.refund_paise)} refunded` : 'No refunds today'} />
        <StatTile
          label="Right now"
          value={`${d.live.pending + d.live.in_kitchen + d.live.ready}`}
          tone={d.live.on_hold > 0 ? 'danger' : 'neutral'}
          sub={`${d.live.pending} new · ${d.live.in_kitchen} in the kitchen · ${d.live.ready} ready`}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <BarChart title="Sales by hour today" rows={hourRows(d.hours)} />
        </Card>
        <Card>
          <BarList title="Top items today" rows={d.products.map((p) => ({ label: `${p.name} · ${p.variant}`, value: p.gross_paise }))} />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-bold">Customers today</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="font-display text-2xl font-black">{d.customers.ordering}</p>
              <p className="text-xs text-ink-muted">ordered</p>
            </div>
            <div>
              <p className="font-display text-2xl font-black">{d.customers.new}</p>
              <p className="text-xs text-ink-muted">first time</p>
            </div>
            <div>
              <p className="font-display text-2xl font-black">{d.customers.repeat}</p>
              <p className="text-xs text-ink-muted">ordered twice</p>
            </div>
          </div>
          {d.failed_payments > 0 && <p className="mt-3 text-sm text-ink-muted">{d.failed_payments} payment attempt(s) failed today. No money was taken.</p>}
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-bold">Lucky Draw</h2>
          {d.tokens.running ? (
            <div className="flex flex-col gap-3">
              <Meter
                label="Numbers given out"
                value={d.tokens.tokens_issued}
                max={d.tokens.token_limit}
                right={`${d.tokens.tokens_issued} of ${d.tokens.token_limit}`}
              />
              <p className="text-sm text-ink-muted">
                {d.tokens.issued_in_range} earned today · {d.tokens.close_to_token} customer(s) more than half way · {formatINR(d.tokens.threshold_paise)} earns a number
              </p>
              <Link to="/lucky-draw" className="text-sm font-bold text-brand-ink underline">
                See the draw →
              </Link>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No Lucky Draw is running.</p>
          )}
        </Card>
      </div>

      {todo.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-xl font-extrabold">Setup checklist</h2>
          <ul className="mt-3 divide-y divide-line">
            {steps.map((step) => (
              <li key={step.label} className="flex items-center justify-between gap-4 py-3">
                <span className="flex items-center gap-3">
                  <span aria-hidden className={step.done ? 'text-success' : 'text-ink-muted'}>
                    {step.done ? '✓' : '○'}
                  </span>
                  {step.label}
                </span>
                {step.done ? (
                  <Badge tone="success">Done</Badge>
                ) : staff.role === 'owner' ? (
                  <Link to={step.to} className="text-sm font-bold text-brand-ink underline">
                    Set up
                  </Link>
                ) : (
                  <Badge tone="warning">Owner to do</Badge>
                )}
              </li>
            ))}
          </ul>
          {crossCheckSettings(s).warnings.map((w) => (
            <p key={w} className="mt-4 rounded-2xl bg-warning-tint px-4 py-3 text-sm text-warning">
              {w}
            </p>
          ))}
        </Card>
      )}
    </>
  );
}

export function ComingSoon({ title, milestone, children }: { title: string; milestone: string; children: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title={`Arrives in ${milestone}`}>{children}</EmptyState>
    </>
  );
}
