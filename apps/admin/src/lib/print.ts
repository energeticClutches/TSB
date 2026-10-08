import { formatINR } from '@slush/core';
import { type OrderItem, type OrderType, type ReceiptData, formatDateTime, formatTime, whereLabel } from './orders';

/**
 * 80 mm thermal printing (Phase 6 A18). The page is printed from a hidden frame, so the counter
 * PC's default printer (set to the thermal printer) prints it with one click. Every value is
 * escaped: names and notes come from customers.
 */
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
  @page { size: 80mm auto; margin: 3mm; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 74mm; font: 12px/1.35 ui-monospace, "Cascadia Mono", Consolas, monospace; color: #000; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
  .big { font-size: 20px; font-weight: 800; } .huge { font-size: 30px; font-weight: 900; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 1px 0; }
  .opt { padding-left: 10px; } .note { border: 1px solid #000; padding: 4px; margin-top: 6px; }
`;

function printHtml(title: string, body: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`);
  doc.close();
  const done = () => window.setTimeout(() => frame.remove(), 1000);
  frame.contentWindow!.addEventListener('afterprint', done);
  window.setTimeout(() => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    done();
  }, 50);
}

const TYPE_UPPER: Record<OrderType, string> = { dine_in: 'DINE-IN', takeaway: 'TAKEAWAY', delivery: 'DELIVERY' };

export function printReceipt(r: ReceiptData) {
  const s = r.snapshot;
  const t = s.totals;
  const rupees = (p: number) => formatINR(p).replace('₹', '');
  const lines = s.items
    .map(
      (i) => `<tr><td>${i.qty} ${esc(i.name)} ${esc(i.variant)}</td><td class="r">${rupees(i.line_total_paise ?? 0)}</td></tr>` +
        i.options.map((o) => `<tr><td class="opt">+${esc(o.name)}</td><td></td></tr>`).join(''),
    )
    .join('');
  const row = (label: string, paise: number, minus = false) =>
    paise ? `<tr><td>${label}</td><td class="r">${minus ? '−' : ''}${rupees(paise)}</td></tr>` : '';
  const body = `
    <div class="c big">${esc(s.shop.header)}</div>
    ${s.shop.legal_name ? `<div class="c">${esc(s.shop.legal_name)}</div>` : ''}
    <div class="c">${esc(s.shop.address)}${s.shop.pincode ? ` ${esc(s.shop.pincode)}` : ''}</div>
    ${s.shop.phone ? `<div class="c">Ph ${esc(s.shop.phone)}</div>` : ''}
    ${s.shop.gstin ? `<div class="c">GSTIN ${esc(s.shop.gstin)}</div>` : ''}
    <hr>
    <div class="c b">${r.is_tax_invoice ? 'TAX INVOICE' : 'RECEIPT'} ${esc(r.receipt_number)}</div>
    <div class="c">${esc(s.order.order_number)} · #${esc(s.order.pickup_number)} · ${esc(whereLabel(s.order))}</div>
    <div class="c">${esc(formatDateTime(s.order.paid_at))} · ${esc(s.order.customer_name)}</div>
    <hr>
    <table>${lines}</table>
    <hr>
    <table>
      ${row('Subtotal', t.subtotal_paise)}
      ${row('Offer', t.promo_discount_paise + t.order_discount_paise, true)}
      ${row('Delivery', t.delivery_fee_paise)}
      ${t.tax_paise ? row(`GST ${((t.gst_rate_bp ?? 0) / 100).toFixed(1)}%`, t.tax_paise) : ''}
      <tr class="big"><td>Total</td><td class="r">₹${rupees(t.total_paise)}</td></tr>
    </table>
    ${t.tax_included_paise ? `<div>Includes GST ₹${rupees(t.tax_included_paise)}</div>` : ''}
    <div>Paid ${esc((s.payment.method ?? 'online').toUpperCase())} ✓ ${s.payment.reference ? `(${esc(s.payment.reference)})` : ''}</div>
    ${s.payment.vpa_masked ? `<div>${esc(s.payment.vpa_masked)}</div>` : ''}
    <hr>
    ${s.footer ? `<div class="c">${esc(s.footer)}</div>` : ''}
  `;
  printHtml(r.receipt_number, body);
}

export interface KotOrder {
  order_number: string;
  pickup_number: number;
  order_type: OrderType;
  table_label: string | null;
  note: string | null;
  confirmed_at?: string | null;
  items: OrderItem[];
}

/** Kitchen ticket: big item names, choices, the note. No prices, no phone number. */
export function printKot(o: KotOrder, reprint = false) {
  const items = o.items
    .map(
      (i) => `<div class="b" style="font-size:16px;margin-top:4px">${i.qty}× ${esc(i.name.toUpperCase())}</div>
        <div class="opt">${esc(i.variant.toUpperCase())}</div>
        ${i.options.map((opt) => `<div class="opt">${esc(opt.name.toUpperCase())}</div>`).join('')}
        ${i.note ? `<div class="opt">» ${esc(i.note)}</div>` : ''}`,
    )
    .join('');
  const body = `
    <div class="c"><span class="huge">KOT #${esc(o.pickup_number)}</span></div>
    <div class="c b">${esc(o.order_number)} · ${esc(o.order_type === 'dine_in' && o.table_label ? `TABLE ${o.table_label}` : TYPE_UPPER[o.order_type])}</div>
    <div class="c">${esc(formatTime(o.confirmed_at ?? new Date().toISOString()))}${reprint ? ' · REPRINT' : ''}</div>
    <hr>${items}
    ${o.note ? `<div class="note b">NOTE: ${esc(o.note)}</div>` : ''}
  `;
  printHtml(`KOT ${o.order_number}`, body);
}
