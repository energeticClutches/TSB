import { describe, expect, it } from 'vitest';
import { assertPaise, formatINR, percentOf, rupeesToPaise } from './money.ts';

describe('money', () => {
  it('converts rupees to whole paise', () => {
    expect(rupeesToPaise(149)).toBe(14_900);
    expect(rupeesToPaise(149.5)).toBe(14_950);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30); // float noise is rounded away
  });

  it('rejects non-finite rupees', () => {
    expect(() => rupeesToPaise(Number.NaN)).toThrow(RangeError);
    expect(() => rupeesToPaise(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects fractional or unsafe paise', () => {
    expect(() => assertPaise(1.5)).toThrow(RangeError);
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => assertPaise(14_900)).not.toThrow();
  });

  it('formats with Indian grouping', () => {
    expect(formatINR(14_900)).toBe('₹149');
    expect(formatINR(2_485_000)).toBe('₹24,850');
    expect(formatINR(14_950)).toBe('₹149.50');
    expect(formatINR(0)).toBe('₹0');
  });

  it('computes percentages in basis points, rounding to whole paise', () => {
    expect(percentOf(80_000, 1_000)).toBe(8_000); // 10% of ₹800
    expect(percentOf(14_900, 1_500)).toBe(2_235); // 15% of ₹149 = ₹22.35 (PR-14)
    expect(percentOf(333, 5_000)).toBe(167); // 166.5 rounds half away from zero
    expect(percentOf(-333, 5_000)).toBe(-167);
    expect(percentOf(14_900, 0)).toBe(0);
    expect(percentOf(14_900, 10_000)).toBe(14_900);
  });

  it('rejects out-of-range basis points', () => {
    expect(() => percentOf(100, -1)).toThrow(RangeError);
    expect(() => percentOf(100, 10_001)).toThrow(RangeError);
    expect(() => percentOf(100, 1.5)).toThrow(RangeError);
  });
});
