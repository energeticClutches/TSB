/** Staff actions that need a secret (Razorpay refunds): docs/PHASE-7-API.md §5. */
import { type Claims, type Deps, type Handler, type Queryable, UUID, requireStaffToken, viaDb } from '../context.ts';
import { HttpError, json, readJson } from '../http.ts';
import { submitRefund } from './ordering.ts';

/** Run database calls as the signed-in staff member, so the database's own role rules apply. */
async function asStaff<T>(deps: Deps, claims: Claims, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return deps.db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return viaDb(() => fn(tx));
  });
}

type Submission = { refund_id: string; provider_payment_id: string | null; amount_paise: number; status?: string };

async function sendAndReport(deps: Deps, s: Submission) {
  await submitRefund(deps, s);
  const [r] = await deps.db.query<{ status: string; provider_refund_id: string | null; failure_reason: string | null }>(
    'select status, provider_refund_id, failure_reason from public.refunds where id = $1',
    [s.refund_id],
  );
  return json({ refund_id: s.refund_id, amount_paise: s.amount_paise, ...r });
}

function refundId(params: Record<string, string>): string {
  if (!UUID.test(params.id ?? '')) throw new HttpError('NOT_FOUND', 'Refund not found.');
  return params.id!;
}

// POST /v1/admin/refunds/:id/decide  { approve, note }
// Approve → the database checks role, maker–checker, Owner limit + fresh 2FA; then Razorpay
// is asked to refund with the refund id as its idempotency key (so a retry never pays twice).
export const decideRefund: Handler = async ({ req, deps, params }) => {
  const claims = await requireStaffToken(req, deps);
  const id = refundId(params);
  const body = await readJson(req);
  if (typeof body.approve !== 'boolean') throw new HttpError('VALIDATION_FAILED', 'Choose approve or decline.');
  const note = typeof body.note === 'string' ? body.note.slice(0, 300) : null;
  const [row] = await asStaff(deps, claims, (tx) => tx.query<{ r: Submission }>('select public.decide_refund($1, $2, $3) as r', [id, body.approve, note]));
  const decided = row!.r;
  if (decided.status !== 'approved') return json({ refund_id: id, status: decided.status, amount_paise: decided.amount_paise });
  return sendAndReport(deps, decided);
};

// POST /v1/admin/refunds/:id/retry: send an approved or failed refund to Razorpay again.
export const retryRefund: Handler = async ({ req, deps, params }) => {
  const claims = await requireStaffToken(req, deps);
  const id = refundId(params);
  const [row] = await asStaff(deps, claims, (tx) => tx.query<{ r: Submission }>('select public.refund_for_submission($1) as r', [id]));
  return sendAndReport(deps, row!.r);
};
