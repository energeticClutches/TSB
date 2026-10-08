import { Alert, Card, Spinner } from '@slush/ui';
import { PageHeader } from '../components/Shell';
import { select } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Row {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  created_at: string;
  staff_id: string | null;
  actor_type: string;
}

const LABELS: Record<string, string> = {
  'settings.updated': 'Changed a setting',
  'hours.updated': 'Changed opening hours',
  'closure.added': 'Closed the shop temporarily',
  'closure.removed': 'Removed a closure',
  'staff.created': 'Added a staff member',
  'staff.pin_reset': 'Reset a PIN',
  'staff.pin_locked': 'PIN locked after 5 wrong tries',
  'staff.deactivated': 'Deactivated a staff member',
  'device.created': 'Added a device',
  'device.paired': 'Paired a device',
  'device.revoked': 'Revoked a device',
};
const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' });

export function AuditPage() {
  const staff = useStaff();
  const data = useAsync(async () => {
    const [rows, team] = await Promise.all([
      select<Row[]>(staff.db.from('audit_logs').select('id, action, entity_type, entity_id, before, after, reason, created_at, staff_id, actor_type').order('id', { ascending: false }).limit(200)),
      select<{ id: string; name: string }[]>(staff.db.from('staff').select('id, name')),
    ]);
    return { rows, names: new Map(team.map((t) => [t.id, t.name])) };
  }, [staff.db]);

  return (
    <>
      <PageHeader title="Audit log" description="Every important change: who, what and when. Entries can’t be edited or deleted." />
      {data.loading && !data.data ? (
        <Spinner className="size-8 text-brand" />
      ) : data.error ? (
        <Alert>{messageOf(data.error)}</Alert>
      ) : (
        <Card className="p-0">
          <ol className="divide-y divide-line">
            {data.data!.rows.map((r) => (
              <li key={r.id} className="grid gap-1 px-5 py-3 sm:grid-cols-[180px_1fr]">
                <time className="text-sm text-ink-muted" dateTime={r.created_at}>
                  {when.format(new Date(r.created_at))}
                </time>
                <div>
                  <p className="font-semibold">
                    {LABELS[r.action] ?? r.action}
                    {r.entity_type === 'setting' && <span className="font-normal text-ink-muted"> · {r.entity_id}</span>}
                  </p>
                  <p className="text-sm text-ink-muted">
                    By {r.staff_id ? (data.data!.names.get(r.staff_id) ?? 'a staff member') : 'the system'}
                    {r.before !== null && r.after !== null && (
                      <>
                        {' '}
                        · <code>{JSON.stringify(r.before)}</code> → <code>{JSON.stringify(r.after)}</code>
                      </>
                    )}
                    {r.reason && <> · “{r.reason}”</>}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
