import { formatINR } from '@slush/core';
import { useEffect, useState } from 'react';
import { Header } from '../components/Chrome';
import { ApiError, type PublicReceipt, getApi } from '../lib/api';
import { Link } from '../lib/router';

const WHERE = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' } as const;

/**
 * The customer's copy of the receipt (Phase 7 §2.10). "Download" uses the browser's own
 * Print → Save as PDF, so no PDF library is shipped to phones.
 */
export function ReceiptPage({ token }: { token: string }) {
  const [receipt, setReceipt] = useState<PublicReceipt>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void getApi()
      .then((api) => api.receipt(token))
      .then(setReceipt, (e: unknown) => setError(e instanceof ApiError ? e.message : 'Couldn’t load the receipt. Please try again.'));
  }, [token]);

  return (
    <div className="min-h-dvh print:bg-white">
      <div className="print:hidden">
        <Header back={`/order/${token}`} title="Receipt" />
      </div>
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 pt-5 pb-10 print:p-0">
        {error && (
          <p role="alert" className="rounded-2xl bg-danger-tint px-4 py-3 text-sm text-danger">
            {error}{' '}
            <Link to={`/order/${token}`} className="font-bold underline">
              Back to your order
            </Link>
          </p>
        )}
        {!receipt && !error && <p className="py-10 text-center text-ink-muted">Loading…</p>}
        {receipt && <Paper r={receipt} />}
        {receipt && (
          <button type="button" onClick={() => window.print()} className="h-12 rounded-full bg-brand font-bold text-white shadow-glow print:hidden">
            Print or save as PDF
          </button>
        )}
      </main>
    </div>
  );
}

function Paper({ r }: { r: PublicReceipt }) {
  const s = r.snapshot;
  const t = s.totals;
  const offers = t.promo_discount_paise + t.order_discount_paise;
  const row = (label: string, paise: number, minus = false) =>
    paise ? (
      <div className="flex justify-between">
        <span>{label}</span>
        <span>
          {minus ? '−' : ''}
          {formatINR(paise)}
        </span>
      </div>
    ) : null;

  return (
    <article className="rounded-3xl bg-card p-6 font-mono text-[13px] leading-relaxed shadow-card print:rounded-none print:shadow-none">
      <header className="text-center">
        <p className="font-display text-xl font-black tracking-tight">{s.shop.header}</p>
        {s.shop.legal_name && <p>{s.shop.legal_name}</p>}
        <p>
          {s.shop.address} {s.shop.pincode}
        </p>
        {s.shop.gstin && <p>GSTIN {s.shop.gstin}</p>}
      </header>
      <hr className="my-3 border-dashed border-ink/40" />
      <p className="text-center font-bold">
        {r.is_tax_invoice ? 'Tax invoice' : 'Receipt'} {r.receipt_number}
      </p>
      <p className="text-center">
        {s.order.order_number} · Pickup #{s.order.pickup_number} · {s.order.order_type === 'dine_in' && s.order.table_label ? `Table ${s.order.table_label}` : WHERE[s.order.order_type]}
      </p>
      <p className="text-center">
        {new Date(s.order.paid_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} · {s.order.customer_name}
      </p>
      <hr className="my-3 border-dashed border-ink/40" />
      <ul className="flex flex-col gap-1">
        {s.items.map((i, n) => (
          <li key={n}>
            <div className="flex justify-between gap-3">
              <span>
                {i.qty} {i.name} {i.variant}
              </span>
              <span>{formatINR(i.line_total_paise)}</span>
            </div>
            {i.options.map((o) => (
              <p key={o.name} className="pl-3 text-ink-muted">
                +{o.name}
              </p>
            ))}
          </li>
        ))}
      </ul>
      <hr className="my-3 border-dashed border-ink/40" />
      {row('Subtotal', t.subtotal_paise)}
      {row('Offer', offers, true)}
      {row('Delivery', t.delivery_fee_paise)}
      {t.tax_paise ? row(`GST ${((t.gst_rate_bp ?? 0) / 100).toFixed(1)}%`, t.tax_paise) : null}
      <div className="mt-1 flex justify-between text-base font-bold">
        <span>Total</span>
        <span>{formatINR(t.total_paise)}</span>
      </div>
      {t.tax_included_paise > 0 && <p>Includes GST {formatINR(t.tax_included_paise)}</p>}
      <p className="mt-2">
        Paid by {(s.payment.method ?? 'UPI').toUpperCase()} ✓ {s.payment.reference && `(${s.payment.reference})`}
      </p>
      {r.refunded_paise > 0 && <p className="font-bold">Refunded {formatINR(r.refunded_paise)}</p>}
      {s.footer && (
        <>
          <hr className="my-3 border-dashed border-ink/40" />
          <p className="text-center">{s.footer}</p>
        </>
      )}
    </article>
  );
}
