import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Digits only, last ten (Indian mobile without +91 or a leading 0); '' when fewer than ten digits. */
export function last10(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/** '••••• 43210': the last five digits only; '' when there is no phone. */
export function maskPhone(phone: string): string {
  const number = last10(phone);
  return number ? `••••• ${number.slice(-5)}` : '';
}

/** OP-YYYYMMDD-NNNN from a clinic day (YYYY-MM-DD) and a running number. */
export function formatOpNumber(day: string, n: number): string {
  return `OP-${day.replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
}

/** G-024, G2-007; numbers past 999 keep all their digits. */
export function formatTokenLabel(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

/** Four-digit code the patient quotes at the desk. */
export function paymentCode(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

/** Random URL-safe secret (base64url). */
export function newSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
