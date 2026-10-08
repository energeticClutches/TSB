import { Alert, Badge, Button, Card, EmptyState, Spinner, TextField, cn } from '@slush/ui';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/Shell';
import { rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { env } from '../lib/env';
import { type StandeeInfo, download, printStandees, qrSvg, qrUrl, standeePng } from '../lib/standee';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface QrRow {
  id: string;
  slug: string;
  kind: 'table' | 'counter';
  table_label: string | null;
  is_active: boolean;
  created_at: string;
  orders_30d: number;
}

const info = (q: QrRow): StandeeInfo => ({ slug: q.slug, kind: q.kind, title: q.kind === 'table' ? `TABLE ${q.table_label}` : 'COUNTER' });

/** A14: QR codes. Each code carries a random slug, so nobody can guess another table's link. */
export function QrPage() {
  const staff = useStaff();
  const list = useAsync(() => rpc<QrRow[]>(staff.db, 'list_qr_codes'), [staff.db]);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
      list.reload();
    } catch (e) {
      setError(e instanceof Error && !('code' in e) ? e.message : messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };

  const rows = list.data ?? [];
  const active = rows.filter((q) => q.is_active);

  return (
    <>
      <PageHeader
        title="QR codes"
        description="Print a standee for each table and one for the counter. Switching a code off stops it working at once; make a new one if a standee is lost."
        action={
          active.length > 0 && (
            <Button variant="secondary" loading={busy === 'print'} onClick={() => void run('print', () => printStandees(active.map(info)))}>
              Print all ({active.length})
            </Button>
          )
        }
      />
      <Card className="mb-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run('table', async () => {
              await rpc(staff.db, 'create_qr', { p_kind: 'table', p_table_label: label });
              setLabel('');
            });
          }}
        >
          <div className="w-40">
            <TextField label="Table name" value={label} onChange={(e) => setLabel(e.target.value.toUpperCase())} placeholder="e.g. 05" maxLength={12} />
          </div>
          <Button type="submit" loading={busy === 'table'} disabled={!label.trim()}>
            + Add table
          </Button>
          <Button variant="secondary" loading={busy === 'counter'} onClick={() => void run('counter', () => rpc(staff.db, 'create_qr', { p_kind: 'counter', p_table_label: null }))}>
            + Counter / takeaway code
          </Button>
        </form>
        <p className="mt-3 text-xs text-ink-muted">
          Codes open <span className="font-mono">{env.orderUrl}/t/…</span>. Set the final web address before printing.
        </p>
      </Card>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {list.loading && !list.data && <Spinner className="size-8 text-brand" />}
      {list.error ? <Alert>{messageOf(list.error)}</Alert> : null}
      {list.data && rows.length === 0 && <EmptyState title="No QR codes yet">Add your tables above, then print their standees.</EmptyState>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((q) => (
          <Standee key={q.id} q={q} busy={busy} run={run} />
        ))}
      </div>
    </>
  );
}

function Standee({ q, busy, run }: { q: QrRow; busy: string | undefined; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const staff = useStaff();
  const svg = useMemo(() => qrSvg(qrUrl(q.slug)), [q.slug]);
  const s = info(q);
  return (
    <Card className={cn('flex flex-col gap-3', !q.is_active && 'opacity-60')}>
      <div className="rounded-3xl bg-gradient-to-b from-brand to-brand-ink px-5 py-5 text-center text-white">
        <p className="font-display text-sm font-black tracking-wide">THE SLUSH BAR</p>
        <p className="font-display text-xs font-black text-mango">SCAN · ORDER · SIP</p>
        <div className="mx-auto mt-3 w-40 rounded-2xl bg-white p-3 text-ink" aria-label={`QR code for ${s.title}`} dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="mt-3 font-display text-2xl font-black">{s.title}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          {q.is_active ? <Badge tone="success">Active</Badge> : <Badge>Switched off</Badge>}{' '}
          <span className="text-ink-muted">
            {q.orders_30d} order{q.orders_30d === 1 ? '' : 's'} in 30 days
          </span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={busy === `png-${q.id}`} onClick={() => void run(`png-${q.id}`, async () => download(await standeePng(s), `slush-${s.title.toLowerCase().replace(/\s+/g, '-')}.png`))}>
          Download PNG
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === `toggle-${q.id}`}
          onClick={() => void run(`toggle-${q.id}`, () => rpc(staff.db, 'set_qr_active', { p_qr_id: q.id, p_active: !q.is_active }))}
        >
          {q.is_active ? 'Switch off' : 'Switch on'}
        </Button>
      </div>
    </Card>
  );
}
