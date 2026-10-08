/**
 * Business hours in India Standard Time (UTC+05:30, no daylight saving).
 * The menu is always browsable; checkout is allowed only inside a window and before
 * `closes - lastOrderBufferMin` (Phase 1 FR-3). A window whose close is at or before its open
 * crosses midnight (e.g. 18:00–01:00).
 */
export interface DayHours {
  /** 0 = Sunday … 6 = Saturday (IST calendar day on which the window opens). */
  weekday: number;
  /** "HH:MM", 24 h */
  opens: string;
  closes: string;
}

export interface Closure {
  startsAt: Date;
  endsAt: Date;
}

export interface HoursConfig {
  hours: readonly DayHours[];
  closures?: readonly Closure[];
  lastOrderBufferMin: number;
}

export type OrderingStatus =
  | { open: true; lastOrderAt: Date }
  | { open: false; reason: 'closed' | 'last_orders_passed' | 'temporarily_closed'; nextOpenAt: Date | null };

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

export function parseHHMM(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new RangeError(`Time must be HH:MM (24 h), got "${value}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** UTC epoch ms of IST midnight for the IST calendar day containing `at`. */
function istMidnight(at: number): number {
  return Math.floor((at + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

function istWeekday(istMidnightMs: number): number {
  return new Date(istMidnightMs + IST_OFFSET_MS).getUTCDay();
}

interface Window {
  start: number;
  end: number;
}

function windowsForDay(dayStart: number, hours: readonly DayHours[]): Window[] {
  const weekday = istWeekday(dayStart);
  return hours
    .filter((h) => h.weekday === weekday)
    .map((h) => {
      const opens = parseHHMM(h.opens);
      const closes = parseHHMM(h.closes);
      const start = dayStart + opens * 60_000;
      const end = dayStart + closes * 60_000 + (closes <= opens ? DAY_MS : 0);
      return { start, end };
    });
}

function inClosure(at: number, closures: readonly Closure[]): boolean {
  return closures.some((c) => at >= c.startsAt.getTime() && at < c.endsAt.getTime());
}

export function orderingStatus(now: Date, config: HoursConfig): OrderingStatus {
  const t = now.getTime();
  const closures = config.closures ?? [];
  const buffer = config.lastOrderBufferMin * 60_000;
  const today = istMidnight(t);

  const candidates = [...windowsForDay(today - DAY_MS, config.hours), ...windowsForDay(today, config.hours)];
  const current = candidates.find((w) => t >= w.start && t < w.end);

  const nextOpenAt = (): Date | null => {
    for (let day = 0; day <= 7; day++) {
      const starts = windowsForDay(today + day * DAY_MS, config.hours)
        .map((w) => w.start)
        .filter((s) => s > t && !inClosure(s, closures))
        .sort((a, b) => a - b);
      if (starts[0] !== undefined) return new Date(starts[0]);
    }
    return null;
  };

  if (inClosure(t, closures)) return { open: false, reason: 'temporarily_closed', nextOpenAt: nextOpenAt() };
  if (!current) return { open: false, reason: 'closed', nextOpenAt: nextOpenAt() };
  const lastOrderAt = current.end - buffer;
  if (t >= lastOrderAt) return { open: false, reason: 'last_orders_passed', nextOpenAt: nextOpenAt() };
  return { open: true, lastOrderAt: new Date(lastOrderAt) };
}
