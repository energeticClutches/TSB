/**
 * Indian mobile numbers. Customers type 10 digits; we store E.164 (+91XXXXXXXXXX)
 * and show a masked form everywhere by default (Phase 6 D8, Phase 7 §1.2).
 */
const TEN_DIGITS = /^[6-9]\d{9}$/;

export type E164Mobile = `+91${string}`;

/** Accepts "98123 45678", "+91-9812345678", "09812345678". Returns null if not a valid Indian mobile. */
export function normalizeMobile(input: string): E164Mobile | null {
  let digits = input.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return TEN_DIGITS.test(digits) ? `+91${digits}` : null;
}

/** "+919812345678" → "98xxxxx678". */
export function maskMobile(mobile: E164Mobile | string): string {
  const digits = mobile.startsWith('+91') ? mobile.slice(3) : mobile;
  if (digits.length !== 10) return 'xxxxxxxxxx';
  return `${digits.slice(0, 2)}xxxxx${digits.slice(7)}`;
}
