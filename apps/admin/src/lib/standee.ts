import qrcode from 'qrcode-generator';
import { env } from './env';

/** The URL a table's QR code opens: the customer site's QR entry route with the random slug. */
export const qrUrl = (slug: string) => `${env.orderUrl}/t/${encodeURIComponent(slug)}`;

function matrix(text: string) {
  // Level M survives a scratched or slightly wet standee while staying easy to scan.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

/** Crisp SVG for on-screen previews and printing. */
export function qrSvg(text: string): string {
  return matrix(text).createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

export interface StandeeInfo {
  slug: string;
  title: string; // "TABLE 04" or "COUNTER"
  kind: 'table' | 'counter';
}

const PINK = '#E6007A';
const PINK_DEEP = '#B90061';
const INK = '#1F1A2E';

/**
 * A6 standee (105 × 148 mm) at 300 dpi as a PNG, in the poster's style: pink, bold type,
 * "Scan · Order · Sip". Drawn on a canvas so it downloads without any server.
 */
export async function standeePng(info: StandeeInfo): Promise<Blob> {
  await document.fonts?.ready;
  const W = 1240;
  const H = 1748;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, PINK);
  bg.addColorStop(1, PINK_DEEP);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // Playful bubbles like the poster.
  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (const [x, y, r] of [[120, 180, 90], [1130, 300, 140], [80, 1540, 120], [1150, 1620, 80], [980, 90, 50]] as const) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  const display = "900 {size}px 'Outfit Variable', 'Outfit', system-ui, sans-serif";
  const font = (size: number) => display.replace('{size}', String(size));
  g.textAlign = 'center';
  g.fillStyle = '#fff';
  g.font = font(96);
  g.fillText('THE SLUSH BAR', W / 2, 210);
  g.font = font(64);
  g.fillStyle = '#FFE14D';
  g.fillText('SCAN · ORDER · SIP', W / 2, 320);

  // White card with the QR code.
  const box = 860;
  const bx = (W - box) / 2;
  const by = 400;
  g.fillStyle = '#fff';
  roundRect(g, bx, by, box, box, 64);
  g.fill();
  const qr = matrix(qrUrl(info.slug));
  const n = qr.getModuleCount();
  const cell = Math.floor((box - 120) / n);
  const size = cell * n;
  const ox = bx + (box - size) / 2;
  const oy = by + (box - size) / 2;
  g.fillStyle = INK;
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) g.fillRect(ox + col * cell, oy + r * cell, cell, cell);
    }
  }

  g.fillStyle = '#fff';
  g.font = font(150);
  g.fillText(info.title, W / 2, by + box + 190);
  g.font = "600 44px 'Plus Jakarta Sans Variable', system-ui, sans-serif";
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillText(info.kind === 'table' ? 'Pay by UPI on your phone · we bring it to your table' : 'Pay by UPI on your phone · we call your number', W / 2, by + box + 290);
  g.fillText('Shop 140, Sector-6 Market, Bahadurgarh', W / 2, H - 90);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the standee.'))), 'image/png'));
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Print every standee, one per A6 page (the print dialog can put 4 on an A4 sheet). */
export async function printStandees(list: StandeeInfo[]) {
  const images = await Promise.all(list.map(async (s) => URL.createObjectURL(await standeePng(s))));
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups for this site to print the standees.');
  w.document.write(
    `<!doctype html><title>QR standees</title><style>@page{size:105mm 148mm;margin:0}body{margin:0}img{display:block;width:105mm;height:148mm;page-break-after:always}</style>` +
      images.map((src) => `<img src="${src}" alt="">`).join(''),
  );
  w.document.close();
  await Promise.all([...w.document.images].map((img) => img.decode().catch(() => undefined)));
  w.focus();
  w.print();
}
