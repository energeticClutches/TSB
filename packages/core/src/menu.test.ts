import { describe, expect, it } from 'vitest';
import { type MenuProduct, describeWindows, inWindows, istClock, priceFrom, productAvailability } from './menu.ts';

const ist = (s: string) => new Date(`${s}+05:30`);
const product = (over: Partial<MenuProduct> = {}): MenuProduct => ({
  id: 'p',
  category_id: 'c',
  kind: 'item',
  name: 'Strawberry Splash',
  description: '',
  image: null,
  accent: null,
  featured: false,
  sold_out: false,
  prep_minutes: 4,
  windows: [],
  variants: [
    { id: 'v1', name: 'Regular', price_paise: 14900, default: true },
    { id: 'v2', name: 'Mega', price_paise: 18900, default: false },
  ],
  modifier_groups: [],
  combo: [],
  ...over,
});

describe('time windows (IST)', () => {
  it('reads the IST clock', () => {
    expect(istClock(ist('2026-09-21T16:05:00'))).toEqual({ weekday: 1, minutes: 965 });
  });

  it('treats no windows as always available', () => {
    expect(inWindows([], ist('2026-09-21T03:00:00'))).toBe(true);
  });

  it('respects start/end and weekdays', () => {
    const pizzas = [{ days_mask: 127, start: '16:00', end: '23:00' }];
    expect(inWindows(pizzas, ist('2026-09-21T15:59:00'))).toBe(false);
    expect(inWindows(pizzas, ist('2026-09-21T16:00:00'))).toBe(true);
    expect(inWindows(pizzas, ist('2026-09-21T23:00:00'))).toBe(false);
    const weekendsOnly = [{ days_mask: 0b1000001, start: '11:00', end: '23:00' }];
    expect(inWindows(weekendsOnly, ist('2026-09-21T15:00:00'))).toBe(false); // Monday
    expect(inWindows(weekendsOnly, ist('2026-09-20T15:00:00'))).toBe(true); // Sunday
  });

  it('handles windows crossing midnight, counted from the day they start', () => {
    const lateFriday = [{ days_mask: 1 << 5, start: '22:00', end: '02:00' }];
    expect(inWindows(lateFriday, ist('2026-09-25T23:00:00'))).toBe(true); // Friday night
    expect(inWindows(lateFriday, ist('2026-09-26T01:00:00'))).toBe(true); // Saturday early = Friday's window
    expect(inWindows(lateFriday, ist('2026-09-26T23:00:00'))).toBe(false); // Saturday night
    expect(inWindows(lateFriday, ist('2026-09-25T01:00:00'))).toBe(false); // Friday early = Thursday's window
  });
});

describe('availability and prices', () => {
  it('reports sold out first, then time windows', () => {
    const now = ist('2026-09-21T12:00:00');
    expect(productAvailability(product(), undefined, now)).toBe('available');
    expect(productAvailability(product({ sold_out: true }), undefined, now)).toBe('sold_out');
    expect(productAvailability(product({ windows: [{ days_mask: 127, start: '16:00', end: '23:00' }] }), undefined, now)).toBe('not_now');
    expect(productAvailability(product(), { id: 'c', name: 'Pizzas', windows: [{ days_mask: 127, start: '16:00', end: '23:00' }] }, now)).toBe('not_now');
  });

  it('shows the lowest size price', () => {
    expect(priceFrom(product())).toEqual({ paise: 14900, varies: true });
    expect(priceFrom(product({ variants: [product().variants[0]!] }))).toEqual({ paise: 14900, varies: false });
  });

  it('describes windows in 12-hour time', () => {
    expect(describeWindows([])).toBe('');
    expect(describeWindows([{ days_mask: 127, start: '16:00', end: '23:30' }])).toBe('4 PM–11:30 PM');
    expect(describeWindows([{ days_mask: 127, start: '00:00', end: '12:00' }])).toBe('12 AM–12 PM');
  });
});
