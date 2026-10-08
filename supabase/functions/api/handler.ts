/**
 * Edge API router (docs/PHASE-7-API.md). Pure TypeScript: no Deno globals here, so the same
 * code runs in the Edge Function (index.ts) and in Node tests against PGlite.
 */
import { type Deps, type Handler } from './context.ts';
import { HttpError, errorResponse, json, randomToken } from './http.ts';
import { safeEqual } from './razorpay.ts';
import { deviceStaff, inviteManager, pairDevice, pinLogin } from './routes/auth.ts';
import { applyRazorpayPayment, cancelOrder, cartQuote, checkout, findOrder, menu, orderReceipt, orderStatus, paymentCheck, qr } from './routes/ordering.ts';
import { decideRefund, retryRefund } from './routes/staff.ts';
import { razorpayWebhook } from './routes/webhooks.ts';

export type { Db, Deps, Queryable } from './context.ts';

const health: Handler = async ({ deps }) => {
  await deps.db.query('select 1');
  return json({ ok: true });
};

const expirePayments: Handler = async ({ req, deps }) => {
  if (!safeEqual(req.headers.get('x-job-secret') ?? '', deps.secrets.jobSecret)) throw new HttpError('FORBIDDEN', 'Not allowed.');
  const [row] = await deps.db.query<{ n: number }>('select app.expire_unpaid_orders() as n');
  return json({ expired: row!.n });
};

/**
 * Every 10 minutes (and a full-day run at 03:00 IST): ask Razorpay what it captured in the
 * window, repair anything this database missed, then record the comparison (P1, S6).
 */
const reconcile: Handler = async ({ req, deps, url }) => {
  if (!safeEqual(req.headers.get('x-job-secret') ?? '', deps.secrets.jobSecret)) throw new HttpError('FORBIDDEN', 'Not allowed.');
  const hours = url.searchParams.get('window') === 'day' ? 24 : Number(url.searchParams.get('hours') ?? 2);
  const to = deps.now();
  const from = new Date(to.getTime() - Math.min(Math.max(hours, 1), 48) * 3600_000);
  const payments = await deps.razorpay.fetchPayments(Math.floor(from.getTime() / 1000), Math.ceil(to.getTime() / 1000));

  let fixed = 0;
  for (const p of payments) {
    if (p.status !== 'captured') continue;
    const [known] = await deps.db.query('select 1 from public.payments where provider_payment_id = $1', [p.id]);
    if (known) continue;
    await applyRazorpayPayment(deps, p); // the same "mark paid" path as the webhook
    fixed += 1;
  }
  const [branch] = await deps.db.query<{ id: string }>('select id from public.branches order by created_at limit 1');
  const [row] = await deps.db.query<{ r: Record<string, unknown> }>('select app.reconcile($1::jsonb) as r', [
    JSON.stringify({
      branch_id: branch!.id,
      window_start: from.toISOString(),
      window_end: to.toISOString(),
      fixed_count: fixed,
      payments: payments.map((p) => ({ id: p.id, amount: p.amount, status: p.status })),
    }),
  ]);
  // The pattern rules (one device, many mobiles, etc.) run on the same 10-minute beat (Phase 4 §10).
  const [flags] = await deps.db.query<{ n: number }>('select app.run_fraud_rules() as n');
  if (fixed > 0) deps.log('reconcile_fixed', { fixed });
  return json({ ...row!.r, flags_raised: flags!.n });
};

// Nightly (03:15 IST): re-run the pattern rules, tidy up, and report the integrity of both hash chains.
const nightly: Handler = async ({ req, deps }) => {
  if (!safeEqual(req.headers.get('x-job-secret') ?? '', deps.secrets.jobSecret)) throw new HttpError('FORBIDDEN', 'Not allowed.');
  const [row] = await deps.db.query<{ audit: number | null; ledger: number | null; flags: number; housekeeping: Record<string, number> }>(
    `select app.verify_audit_chain() as audit, app.verify_ledger_chain() as ledger,
            app.run_fraud_rules() as flags, app.housekeeping() as housekeeping`,
  );
  if (row!.audit !== null || row!.ledger !== null) deps.log('hash_chain_broken', { audit: row!.audit, ledger: row!.ledger });
  return json({
    audit_chain_ok: row!.audit === null,
    ledger_chain_ok: row!.ledger === null,
    flags_raised: row!.flags,
    housekeeping: row!.housekeeping,
  });
};

const ROUTES: [method: string, pattern: string, handler: Handler][] = [
  ['GET', '/v1/health', health],
  ['GET', '/v1/menu', menu],
  ['GET', '/v1/qr/:slug', qr],
  ['POST', '/v1/cart/quote', cartQuote],
  ['POST', '/v1/checkout', checkout],
  ['GET', '/v1/orders/:token', orderStatus],
  ['GET', '/v1/orders/:token/receipt', orderReceipt],
  ['POST', '/v1/orders/:token/payment-check', paymentCheck],
  ['POST', '/v1/orders/:token/cancel', cancelOrder],
  ['POST', '/v1/orders/find', findOrder],
  ['POST', '/v1/webhooks/razorpay', razorpayWebhook],
  ['POST', '/v1/auth/device/pair', pairDevice],
  ['GET', '/v1/auth/device/staff', deviceStaff],
  ['POST', '/v1/auth/pin-login', pinLogin],
  ['POST', '/v1/admin/staff', inviteManager],
  ['POST', '/v1/admin/refunds/:id/decide', decideRefund],
  ['POST', '/v1/admin/refunds/:id/retry', retryRefund],
  ['POST', '/v1/jobs/expire-payments', expirePayments],
  ['POST', '/v1/jobs/nightly', nightly],
  ['POST', '/v1/jobs/reconcile', reconcile],
];

function match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = path.split('/');
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    const pp = pattern.split('/');
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pp.every((seg, i) => {
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        return parts[i]!.length > 0;
      }
      return seg === parts[i];
    });
    // A literal route ("/v1/orders/find") must win over a parameter route ("/v1/orders/:token").
    if (ok) return { handler, params };
  }
  return null;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const requestId = `req_${randomToken(9)}`;
  const url = new URL(req.url);
  // Supabase serves this function under /functions/v1/api; accept both forms.
  const path = url.pathname.replace(/^\/functions\/v1\/api/, '').replace(/^\/api(?=\/v1)/, '');
  try {
    const hit = match(req.method, path);
    if (!hit) throw new HttpError('NOT_FOUND', 'Not found.');
    return await hit.handler({ req, deps, params: hit.params, url });
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e, requestId);
    deps.log('unhandled_error', { request_id: requestId, path, error: e instanceof Error ? e.message : String(e) });
    return errorResponse(new HttpError('INTERNAL', 'Something went wrong. Please try again.'), requestId);
  }
}
