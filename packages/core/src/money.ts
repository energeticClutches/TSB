/**
 * Money is always whole paise (Phase 4, principle 1). ₹149.00 === 14900.
 * These helpers are the only place rupees and paise are converted.
 */
export type Paise = number;

export function assertPaise(value: number): asserts value is Paise {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money must be a whole number of paise, got ${value}`);
  }
}

export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError(`Invalid rupee amount: ${rupees}`);
  const paise = Math.round(rupees * 100);
  assertPaise(paise);
  return paise;
}

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});
const inrExact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "₹149" for whole rupees, "₹149.50" otherwise. Indian digit grouping ("₹24,850"). */
export function formatINR(paise: Paise): string {
  assertPaise(paise);
  return paise % 100 === 0 ? inrWhole.format(paise / 100) : inrExact.format(paise / 100);
}

/** Percentage stored in basis points (1000 = 10%). Rounds half away from zero to whole paise. */
export function percentOf(paise: Paise, basisPoints: number): Paise {
  assertPaise(paise);
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError(`Basis points must be an integer 0–10000, got ${basisPoints}`);
  }
  const raw = (paise * basisPoints) / 10_000;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}
