/**
 * Razorpay webhooks (docs/PHASE-7-API.md §3):
 * verify signature → record once → handle in the database → 200; on failure 500 so Razorpay retries.
 */
import type { Handler } from '../context.ts';
import { HttpError, json, sha256Hex } from '../http.ts';
import { type RzpPayment, verifyWebhookSignature } from '../razorpay.ts';
import { applyRazorpayPayment } from './ordering.ts';

interface WebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: RzpPayment };
    refund?: { entity?: { id: string; payment_id: string; amount: number; status: string } };
    dispute?: { entity?: { id: string; payment_id: string; amount?: number; status?: string } };
  };
}

export const razorpayWebhook: Handler = async ({ req, deps }) => {
  const raw = await req.text();
  const valid = await verifyWebhookSignature(raw, req.headers.get('x-razorpay-signature'), deps.secrets.razorpayWebhookSecret);
  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    throw new HttpError('BAD_REQUEST', 'Invalid JSON.');
  }
  const eventId = req.headers.get('x-razorpay-event-id') ?? `body_${await sha256Hex(raw)}`;
  const [row] = await deps.db.query<{ r: { id: number; processed: boolean } }>('select app.record_webhook($1, $2, $3, $4::jsonb, $5) as r', [
    'razorpay',
    eventId,
    body.event ?? 'unknown',
    raw,
    valid,
  ]);
  // Invalid signatures are stored for the audit trail but never acted on.
  if (!valid) throw new HttpError('SIGNATURE_INVALID', 'Signature check failed.');
  if (row!.r.processed) return json({ ok: true, replay: true });

  try {
    const payment = body.payload?.payment?.entity;
    const refund = body.payload?.refund?.entity;
    const dispute = body.payload?.dispute?.entity;
    switch (body.event) {
      case 'payment.captured':
      case 'order.paid':
      case 'payment.failed':
        if (payment) await applyRazorpayPayment(deps, payment);
        break;
      case 'refund.processed':
      case 'refund.failed':
        if (refund) {
          await deps.db.query('select app.apply_refund_event($1, $2, $3, $4, $5)', [
            refund.id,
            refund.payment_id,
            refund.amount,
            body.event === 'refund.processed',
            body.event === 'refund.failed' ? 'Refund failed at the bank' : null,
          ]);
        }
        break;
      // Chargebacks: freeze the customer, take back what the order earned, hold the order (C13, R6).
      case 'payment.dispute.created':
      case 'payment.dispute.won':
      case 'payment.dispute.lost':
      case 'payment.dispute.closed':
        if (dispute) {
          await deps.db.query('select app.apply_dispute($1, $2, $3)', [dispute.payment_id, dispute.id, body.event.split('.').pop()]);
        }
        break;
      default:
        break; // stored for the record, not acted on
    }
    await deps.db.query('select app.webhook_done($1, null)', [row!.r.id]);
    return json({ ok: true });
  } catch (e) {
    await deps.db.query('select app.webhook_done($1, $2)', [row!.r.id, e instanceof Error ? e.message.slice(0, 500) : 'error']);
    deps.log('webhook_failed', { event_id: eventId, event: body.event });
    throw e;
  }
};
