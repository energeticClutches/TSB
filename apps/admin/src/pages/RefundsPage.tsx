import { formatINR } from '@slush/core';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '@slush/ui';
import { useState } from 'react';
import { OrderDrawer, ReasonDialog } from '../components/OrderDrawer';
import { PageHeader } from '../components/Shell';
import { useStepUp } from '../components/StepUp';
import { edge, rpc } from '../lib/api';
import { messageOf } from '../lib/errors';
import { formatDateTime } from '../lib/orders';
import { useStaff } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface QueueItem {
  id: string;
  order_id: string;
  order_number: string;
  pickup_number: number;
  customer_name: string;
  kind: 'full' | 'partial';
  amount_paise: number;
  order_total_paise: number;
  reason: string;
  status: 'requested' | 'approved' | 'declined' | 'processing' | 'processed' | 'failed';
  needs_owner: boolean;
  is_automatic: boolean;
  requested_by_id: string | null;
  requested_by: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  failure_reason: string | null;
  items: { name: string; variant: string; qty: number }[];
}

const TONE = { requested: 'warning', approved: 'brand', processing: 'brand', processed: 'success', declined: 'neutral', failed: 'danger' } as const;
const LABEL = { requested: 'Waiting', approved: 'Approved', processing: 'With Razorpay', processed: 'Refunded', declined: 'Declined', failed: 'Failed' };

/** A7: refund requests → approve / decline (maker–checker), and retry failed ones. */
export function RefundsPage() {
  const staff = useStaff();
  const stepUp = useStepUp();
  const queue = useAsync(() => rpc<QueueItem[]>(staff.db, 'refund_queue'), [staff.db]);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string }>();
  const [declining, setDeclining] = useState<QueueItem | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  const send = async (item: QueueItem, path: 'decide' | 'retry', body: Record<string, unknown> = {}) => {
    setBusy(item.id);
    setMessage(undefined);
    try {
      const r = await stepUp(async () => edge<{ status: string; failure_reason?: string | null }>(`/admin/refunds/${item.id}/${path}`, { body, token: await staff.token() }));
      setMessage(
        r.status === 'failed'
          ? { tone: 'warning', text: `Approved, but Razorpay didn’t accept it yet (${r.failure_reason ?? 'try again'}). Use “Send again”.` }
          : r.status === 'declined'
            ? { tone: 'success', text: `Declined the refund for ${item.order_number}.` }
            : { tone: 'success', text: `${formatINR(item.amount_paise)} is on its way back to the customer (usually 5–7 working days for UPI).` },
      );
    } catch (e) {
      setMessage({ tone: 'danger', text: messageOf(e) });
    } finally {
      setBusy(undefined);
      queue.reload();
    }
  };

  const items = queue.data ?? [];
  const open = items.filter((i) => ['requested', 'approved', 'processing', 'failed'].includes(i.status));
  const recent = items.filter((i) => !open.includes(i)).reverse();

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Money only ever goes back to the UPI account that paid. Someone other than the person who asked must approve."
      />
      {message && <div className="mb-4"><Alert tone={message.tone}>{message.text}</Alert></div>}
      {queue.loading && !queue.data && <Spinner className="size-8 text-brand" />}
      {queue.error ? <Alert>{messageOf(queue.error)}</Alert> : null}
      {queue.data && open.length === 0 && <EmptyState title="No refunds waiting">Refund requests from the counter appear here.</EmptyState>}

      <div className="flex flex-col gap-3">
        {open.map((r) => {
          const mine = r.requested_by_id === staff.staffId;
          const ownerOnly = r.needs_owner && staff.role !== 'owner';
          return (
            <Card key={r.id} className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-2xl font-black">{formatINR(r.amount_paise)}</span>
                  <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                  <Badge>{r.kind === 'full' ? 'Whole order' : 'Some items'}</Badge>
                  {r.needs_owner && <Badge tone="danger">Owner approval</Badge>}
                </div>
                <p className="mt-1 text-sm">
                  <button type="button" className="font-bold text-brand-ink underline" onClick={() => setOpenOrder(r.order_id)}>
                    {r.order_number} · #{r.pickup_number}
                  </button>{' '}
                  · {r.customer_name} · order total {formatINR(r.order_total_paise)}
                </p>
                <p className="mt-1 text-sm">“{r.reason}”</p>
                {r.kind === 'partial' && <p className="text-sm text-ink-muted">{r.items.map((i) => `${i.qty}× ${i.name} (${i.variant})`).join(', ')}</p>}
                <p className="mt-1 text-xs text-ink-muted">
                  {r.is_automatic ? 'Automatic' : `Asked by ${r.requested_by ?? 'the system (order rejected)'}`} · {formatDateTime(r.created_at)}
                  {r.failure_reason && r.status === 'failed' && <span className="text-danger"> · {r.failure_reason}</span>}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {r.status === 'requested' &&
                  (mine ? (
                    <p className="max-w-48 text-sm text-ink-muted">You asked for this one, so someone else has to approve it.</p>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={() => setDeclining(r)} disabled={busy === r.id}>
                        Decline…
                      </Button>
                      <Button loading={busy === r.id} disabled={ownerOnly} onClick={() => void send(r, 'decide', { approve: true })}>
                        {ownerOnly ? 'Needs Owner approval' : 'Approve refund'}
                      </Button>
                    </>
                  ))}
                {(r.status === 'failed' || r.status === 'approved') && (
                  <Button variant="secondary" loading={busy === r.id} onClick={() => void send(r, 'retry')}>
                    Send again
                  </Button>
                )}
                {r.status === 'processing' && <p className="text-sm text-ink-muted">Waiting for Razorpay to confirm.</p>}
              </div>
            </Card>
          );
        })}
      </div>

      {recent.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 font-display text-lg font-extrabold">Last 2 days</h2>
          <Card className="p-0">
            <ul className="divide-y divide-line">
              {recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span>
                    <b>{r.order_number}</b> · {formatINR(r.amount_paise)} · {r.reason}
                    {r.decision_note && <span className="text-ink-muted"> · “{r.decision_note}”</span>}
                  </span>
                  <span className="flex items-center gap-2 text-ink-muted">
                    {r.decided_by && `by ${r.decided_by}`}
                    <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <ReasonDialog
        open={Boolean(declining)}
        title="Decline this refund?"
        intro="The customer keeps being charged. Your reason is saved with the request."
        label="Why?"
        placeholder="e.g. Customer took a replacement drink"
        action="Decline"
        danger
        onClose={() => setDeclining(null)}
        onSubmit={async (note) => {
          const item = declining!;
          setDeclining(null);
          await send(item, 'decide', { approve: false, note });
        }}
      />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={queue.reload} />
    </>
  );
}
