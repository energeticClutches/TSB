import { Alert, Badge, Button, Card, EmptyState, Spinner } from '@slush/ui';
import { useState } from 'react';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { rpc, select } from '../lib/api';
import { messageOf } from '../lib/errors';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Approval {
  id: string;
  kind: string;
  summary: string;
  status: string;
  created_at: string;
  expires_at: string;
  requested_by: string;
  decision_note: string | null;
}
const KIND_LABEL: Record<string, string> = {
  price_drop_large: 'Big price drop',
  refund_over_limit: 'Refund over the limit',
  coupon_high_value: 'High-value coupon',
  manual_loyalty_over_cap: 'Extra spending correction',
};
const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** Owner sign-off for risky actions (Revision 2 R2). The fraud "Risk" screen joins this in M6. */
export function ApprovalsPage() {
  const staff = useStaff();
  const stepUp = useStepUp();
  const list = useAsync(async () => {
    const [rows, team] = await Promise.all([
      select<Approval[]>(staff.db.from('approval_requests').select('id, kind, summary, status, created_at, expires_at, requested_by, decision_note').order('created_at', { ascending: false }).limit(50)),
      select<{ id: string; name: string }[]>(staff.db.from('staff').select('id, name')),
    ]);
    return { rows, names: new Map(team.map((t) => [t.id, t.name])) };
  }, [staff.db]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const decide = async (a: Approval, approve: boolean) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await stepUp(() => rpc<string>(staff.db, 'decide_approval', { p_id: a.id, p_approve: approve, p_note: null }));
      setNotice(result === 'expired' ? 'That request had expired or the item changed in the meantime, so nothing was changed.' : approve ? 'Approved and applied.' : 'Declined.');
      list.reload();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  if (list.loading && !list.data) return <Spinner className="size-8 text-brand" />;
  if (list.error) return <Alert>{messageOf(list.error)}</Alert>;
  const now = Date.now();
  const pending = list.data!.rows.filter((r) => r.status === 'pending' && new Date(r.expires_at).getTime() > now);
  const history = list.data!.rows.filter((r) => !pending.includes(r));

  return (
    <>
      <PageHeader title="Approvals" description="Actions above your limits wait here for you. Requests expire after 48 hours." />
      <div className="flex flex-col gap-4">
        {notice && <Alert tone="success">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting for you" />
        ) : (
          pending.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Badge tone="warning">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                <p className="mt-1 font-bold">{a.summary}</p>
                <p className="text-sm text-ink-muted">
                  Requested by {list.data!.names.get(a.requested_by) ?? 'a staff member'} · {when.format(new Date(a.created_at))}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => void decide(a, false)}>
                  Decline
                </Button>
                <Button onClick={() => void decide(a, true)}>Approve</Button>
              </div>
            </Card>
          ))
        )}
        {history.length > 0 && (
          <Card className="p-0">
            <h2 className="px-5 pt-4 font-display text-lg font-extrabold">Recent decisions</h2>
            <ul className="divide-y divide-line">
              {history.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>{a.summary}</span>
                  <Badge tone={a.status === 'approved' ? 'success' : a.status === 'declined' ? 'danger' : 'neutral'} className="capitalize">
                    {a.status === 'pending' ? 'expired' : a.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
