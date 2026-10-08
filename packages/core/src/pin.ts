/**
 * Staff PIN rules (Phase 4 R8, Phase 8 §3.1): exactly 4 digits and not trivially guessable.
 * Uniqueness per branch is enforced server-side with a keyed fingerprint.
 */
export type PinProblem = 'format' | 'repeated' | 'sequence' | 'year' | 'common';

// Frequently chosen PINs that aren't covered by the pattern rules below.
const COMMON = new Set(['1212', '6969', '1004', '2580', '0852', '1122', '4321', '7777', '1313', '2323']);

export function checkPin(pin: string): PinProblem | null {
  if (!/^\d{4}$/.test(pin)) return 'format';
  if (/^(\d)\1{3}$/.test(pin)) return 'repeated';

  const d = [...pin].map(Number) as [number, number, number, number];
  const ascending = d.every((n, i) => i === 0 || n === (d[i - 1]! + 1) % 10);
  const descending = d.every((n, i) => i === 0 || n === (d[i - 1]! + 9) % 10);
  if (ascending || descending) return 'sequence';

  const asNumber = Number(pin);
  if (asNumber >= 1950 && asNumber <= 2035) return 'year';
  if (COMMON.has(pin)) return 'common';
  return null;
}

export const PIN_PROBLEM_MESSAGE: Record<PinProblem, string> = {
  format: 'PIN must be exactly 4 digits.',
  repeated: 'PIN can’t be the same digit four times.',
  sequence: 'PIN can’t be a sequence like 1234 or 4321.',
  year: 'PIN can’t look like a year.',
  common: 'That PIN is too common. Choose another.',
};
