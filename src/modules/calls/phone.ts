/**
 * Indian numbers in any common shape ("+91 98765 43210", "098765 43210",
 * "919876543210") → E.164 ("+919876543210"). Null when it is not a 10-digit
 * national number: dialling a guessed number reaches a stranger.
 */
export function toE164India(raw: string | undefined): string | null {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[1-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** "+91•••••43210", for logs. */
export const maskPhone = (e164: string) => `${e164.slice(0, 3)}•••••${e164.slice(-5)}`;
