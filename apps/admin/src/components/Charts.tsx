import { formatINR } from '@slush/core';
import { cn } from '@slush/ui';
import type { ReactNode } from 'react';

/**
 * Small, dependency-free charts for the dashboard and reports. Every chart is ONE series
 * (a magnitude), so it uses one hue; identity never depends on colour. Each carries a
 * screen-reader table so the numbers are readable without seeing the bars.
 */

export function StatTile({ label, value, sub, tone = 'neutral' }: { label: string; value: string; sub?: ReactNode; tone?: 'neutral' | 'brand' | 'warning' | 'danger' }) {
  const tones = { neutral: 'bg-card', brand: 'bg-brand-tint', warning: 'bg-warning-tint', danger: 'bg-danger-tint' };
  return (
    <div className={cn('rounded-3xl p-5 shadow-card', tones[tone])}>
      <p className="text-xs font-bold tracking-wider text-ink-muted uppercase">{label}</p>
      <p className="mt-1 font-display text-3xl font-black tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-sm text-ink-muted">{sub}</p>}
    </div>
  );
}

/** Change against a comparison period, in words as well as an arrow. */
export function Delta({ now, before, label }: { now: number; before: number; label: string }) {
  if (!before) return <span className="text-ink-muted">No {label} to compare</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const up = pct >= 0;
  return (
    <span className={up ? 'text-success' : 'text-danger'}>
      {up ? '▲' : '▼'} {Math.abs(pct)}% vs {label}
    </span>
  );
}

interface Datum {
  label: string;
  value: number;
  hint?: string;
}

function SrTable({ caption, rows, format }: { caption: string; rows: Datum[]; format: (n: number) => string }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td>{format(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Vertical bars for a time series (sales by hour). The tallest bar is labelled. */
export function BarChart({ title, rows, format = formatINR, height = 160 }: { title: string; rows: Datum[]; format?: (n: number) => string; height?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-sm font-bold">{title}</figcaption>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">Nothing yet.</p>
      ) : (
        <>
          <div className="flex items-end gap-1" style={{ height }} role="img" aria-label={`${title}. ${rows.map((r) => `${r.label}: ${format(r.value)}`).join(', ')}`}>
            {rows.map((r) => (
              <div key={r.label} className="group relative flex flex-1 flex-col items-center justify-end gap-1" title={`${r.hint ?? r.label}: ${format(r.value)}`}>
                {r.value === max && <span className="text-[11px] font-bold text-ink-muted">{format(r.value)}</span>}
                <div
                  className="w-full rounded-t bg-brand transition group-hover:bg-brand-ink"
                  style={{ height: `${Math.max(2, (r.value / max) * (height - 24))}px` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex gap-1 text-[10px] text-ink-muted">
            {rows.map((r) => (
              <span key={r.label} className="flex-1 text-center">
                {r.label}
              </span>
            ))}
          </div>
        </>
      )}
      <SrTable caption={title} rows={rows} format={format} />
    </figure>
  );
}

/** Horizontal ranked bars (top products). Every row is labelled: no legend needed. */
export function BarList({ title, rows, format = formatINR, limit = 8 }: { title: string; rows: Datum[]; format?: (n: number) => string; limit?: number }) {
  const shown = rows.slice(0, limit);
  const max = Math.max(1, ...shown.map((r) => r.value));
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-sm font-bold">{title}</figcaption>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-hidden>
          {shown.map((r) => (
            <li key={r.label}>
              <div className="flex justify-between gap-3 text-sm">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 font-semibold">{format(r.value)}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-line/60">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <SrTable caption={title} rows={shown} format={format} />
    </figure>
  );
}

/** "1,450 of 2,000" style progress, used for the Lucky Draw. */
export function Meter({ label, value, max, right }: { label: string; value: number; max: number; right?: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        {right && <span className="font-semibold">{right}</span>}
      </div>
      <div className="mt-1 h-2 rounded-full bg-line/60" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-lagoon" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
