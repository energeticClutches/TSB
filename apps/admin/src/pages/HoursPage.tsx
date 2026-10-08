import { Alert, Badge, Button, Card, Dialog, Spinner, Switch, TextField } from '@slush/ui';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { rpc, select } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
interface DayRow {
  open: boolean;
  opens: string;
  closes: string;
}
interface Closure {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
}

const fmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export function HoursPage() {
  const staff = useStaff();
  return (
    <>
      <PageHeader title="Hours & closures" description="Customers can browse the menu any time, but can only order during these hours." />
      <div className="flex flex-col gap-4">
        {staff.role === 'owner' && <WeeklyHours />}
        <Closures />
      </div>
    </>
  );
}

function WeeklyHours() {
  const staff = useStaff();
  const stepUp = useStepUp();
  const loaded = useAsync(
    () => select<{ weekday: number; opens_at: string; closes_at: string }[]>(staff.db.from('business_hours').select('weekday, opens_at, closes_at')),
    [staff.db],
  );
  const [days, setDays] = useState<DayRow[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setDays(
      DAYS.map((_, weekday) => {
        const row = loaded.data!.find((h) => h.weekday === weekday);
        return row ? { open: true, opens: row.opens_at.slice(0, 5), closes: row.closes_at.slice(0, 5) } : { open: false, opens: '11:00', closes: '23:00' };
      }),
    );
  }, [loaded.data]);

  const update = (i: number, patch: Partial<DayRow>) => setDays((d) => d.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const copyToAll = (i: number) => setDays((d) => d.map(() => ({ ...d[i]! })));

  const save = async () => {
    setError(undefined);
    setNotice(undefined);
    const bad = days.findIndex((d) => d.open && d.opens === d.closes);
    if (bad >= 0) return setError(`${DAYS[bad]}: opening and closing times can’t be the same.`);
    setBusy(true);
    try {
      const hours = days.flatMap((d, weekday) => (d.open ? [{ weekday, opens: d.opens, closes: d.closes }] : []));
      await stepUp(() => rpc(staff.db, 'set_business_hours', { p_hours: hours }));
      setNotice('Opening hours saved.');
      loaded.reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (loaded.loading && !loaded.data) return <Spinner className="size-8 text-brand" />;
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-extrabold">Weekly hours</h2>
          <p className="text-sm text-ink-muted">A closing time earlier than opening means it closes after midnight.</p>
        </div>
        <Button onClick={() => void save()} loading={busy}>
          Save hours
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      <ul className="mt-2 divide-y divide-line">
        {days.map((d, i) => (
          <li key={DAYS[i]} className="flex flex-wrap items-center gap-4 py-3">
            <div className="w-40">
              <Switch checked={d.open} onChange={(open) => update(i, { open })} label={DAYS[i]!} description={d.open ? 'Open' : 'Closed all day'} />
            </div>
            {d.open && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  Opens
                  <input type="time" value={d.opens} onChange={(e) => update(i, { opens: e.target.value })} className="h-10 rounded-xl border border-line px-3" />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  Closes
                  <input type="time" value={d.closes} onChange={(e) => update(i, { closes: e.target.value })} className="h-10 rounded-xl border border-line px-3" />
                </label>
                <Button size="sm" variant="ghost" onClick={() => copyToAll(i)}>
                  Copy to all days
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Closures() {
  const staff = useStaff();
  const list = useAsync(
    () =>
      select<Closure[]>(
        staff.db.from('store_closures').select('id, starts_at, ends_at, reason').gte('ends_at', new Date().toISOString()).order('starts_at'),
      ),
    [staff.db],
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  const remove = async (id: string) => {
    setError(undefined);
    try {
      await rpc(staff.db, 'remove_store_closure', { p_closure_id: id });
      list.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-extrabold">Temporary closures</h2>
          <p className="text-sm text-ink-muted">Holidays, power cuts, private events. Ordering pauses during these times.</p>
        </div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Close the shop…
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {list.loading && !list.data ? (
        <Spinner className="size-6 text-brand" />
      ) : list.data?.length ? (
        <ul className="divide-y divide-line">
          {list.data.map((c) => {
            const now = Date.now();
            const active = new Date(c.starts_at).getTime() <= now && new Date(c.ends_at).getTime() > now;
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-bold">
                    {c.reason} {active && <Badge tone="danger">Closed now</Badge>}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {fmt.format(new Date(c.starts_at))} → {fmt.format(new Date(c.ends_at))}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void remove(c.id)}>
                  {active ? 'Reopen now' : 'Cancel'}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">No closures planned.</p>
      )}
      <AddClosure open={open} onClose={() => setOpen(false)} onAdded={list.reload} />
    </Card>
  );
}

function toLocalInput(d: Date) {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.toISOString().slice(0, 16);
}

function AddClosure({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const staff = useStaff();
  const [starts, setStarts] = useState(() => toLocalInput(new Date()));
  const [ends, setEnds] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3_600_000)));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await rpc(staff.db, 'add_store_closure', {
        p_starts_at: new Date(`${starts}:00+05:30`).toISOString(),
        p_ends_at: new Date(`${ends}:00+05:30`).toISOString(),
        p_reason: reason,
      });
      onAdded();
      onClose();
      setReason('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Close the shop" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField label="From (IST)" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} required />
        <TextField label="Until (IST)" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} required />
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Diwali holiday" maxLength={200} required />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" block loading={busy}>
          Close ordering for this time
        </Button>
      </form>
    </Dialog>
  );
}

