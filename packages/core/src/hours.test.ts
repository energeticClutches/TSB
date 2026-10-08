import { describe, expect, it } from 'vitest';
import { type DayHours, orderingStatus, parseHHMM } from './hours.ts';

/** Build a Date from an IST wall-clock time. */
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);

const everyDay = (opens: string, closes: string): DayHours[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens, closes }));

const shop = { hours: everyDay('11:00', '23:00'), lastOrderBufferMin: 15 };

describe('parseHHMM', () => {
  it('parses 24 h times', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('11:00')).toBe(660);
    expect(parseHHMM('23:59')).toBe(1439);
  });
  it.each(['24:00', '9:00', '11:60', 'noon'])('rejects %s', (v) => {
    expect(() => parseHHMM(v)).toThrow(RangeError);
  });
});

describe('orderingStatus: The Slush Bar, 11:00–23:00, last order 15 min before close', () => {
  it('is open mid-afternoon and reports the last-order time', () => {
    const s = orderingStatus(ist('2026-09-21T15:00:00'), shop);
    expect(s).toEqual({ open: true, lastOrderAt: ist('2026-09-21T22:45:00') });
  });

  it('opens exactly at 11:00', () => {
    expect(orderingStatus(ist('2026-09-21T11:00:00'), shop).open).toBe(true);
    const before = orderingStatus(ist('2026-09-21T10:59:00'), shop);
    expect(before).toEqual({ open: false, reason: 'closed', nextOpenAt: ist('2026-09-21T11:00:00') });
  });

  it('stops taking orders 15 minutes before close', () => {
    expect(orderingStatus(ist('2026-09-21T22:44:59'), shop).open).toBe(true);
    expect(orderingStatus(ist('2026-09-21T22:45:00'), shop)).toEqual({
      open: false,
      reason: 'last_orders_passed',
      nextOpenAt: ist('2026-09-22T11:00:00'),
    });
  });

  it('is closed after hours and points to tomorrow', () => {
    expect(orderingStatus(ist('2026-09-21T23:30:00'), shop)).toEqual({
      open: false,
      reason: 'closed',
      nextOpenAt: ist('2026-09-22T11:00:00'),
    });
  });

  it('handles windows that cross midnight on both sides', () => {
    const late = { hours: everyDay('18:00', '01:00'), lastOrderBufferMin: 0 };
    expect(orderingStatus(ist('2026-09-21T23:30:00'), late).open).toBe(true);
    expect(orderingStatus(ist('2026-09-22T00:30:00'), late).open).toBe(true); // yesterday's window
    expect(orderingStatus(ist('2026-09-22T01:00:00'), late).open).toBe(false);
  });

  it('handles a split day (afternoon break) and finds the earliest next opening', () => {
    const split = {
      hours: [
        { weekday: 1, opens: '17:00', closes: '23:00' },
        { weekday: 1, opens: '11:00', closes: '15:00' },
      ],
      lastOrderBufferMin: 15,
    };
    expect(orderingStatus(ist('2026-09-21T10:00:00'), split)).toEqual({
      open: false,
      reason: 'closed',
      nextOpenAt: ist('2026-09-21T11:00:00'),
    });
    expect(orderingStatus(ist('2026-09-21T15:30:00'), split)).toEqual({
      open: false,
      reason: 'closed',
      nextOpenAt: ist('2026-09-21T17:00:00'),
    });
  });

  it('respects a weekly day off', () => {
    const closedMonday = { hours: shop.hours.filter((h) => h.weekday !== 1), lastOrderBufferMin: 15 };
    // 2026-09-21 is a Monday
    expect(orderingStatus(ist('2026-09-21T15:00:00'), closedMonday)).toEqual({
      open: false,
      reason: 'closed',
      nextOpenAt: ist('2026-09-22T11:00:00'),
    });
  });

  it('respects a temporary closure and skips openings inside it', () => {
    const closure = { startsAt: ist('2026-09-21T14:00:00'), endsAt: ist('2026-09-22T12:00:00') };
    const s = orderingStatus(ist('2026-09-21T15:00:00'), { ...shop, closures: [closure] });
    expect(s).toEqual({ open: false, reason: 'temporarily_closed', nextOpenAt: ist('2026-09-23T11:00:00') });
  });

  it('reports no next opening when there are no hours at all', () => {
    expect(orderingStatus(ist('2026-09-21T15:00:00'), { hours: [], lastOrderBufferMin: 15 })).toEqual({
      open: false,
      reason: 'closed',
      nextOpenAt: null,
    });
  });
});
