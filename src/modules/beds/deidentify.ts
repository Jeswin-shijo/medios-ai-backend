export interface PatientIdentity {
  name: string;
  uhid: string;
  phone?: string;
  address?: string;
  email?: string;
}

const REMOVED = '[removed]';
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strips the patient's identity from free text before it leaves the server. */
export function deidentify(text: string, who: PatientIdentity): string {
  let out = text;

  // Longest, most specific values first so a name inside an address is removed with the address.
  if (who.email) out = out.replace(new RegExp(escapeRegex(who.email), 'gi'), REMOVED);
  out = out.replace(/\S+@\S+\.\S+/g, REMOVED);

  if (who.address?.trim()) out = out.replace(new RegExp(escapeRegex(who.address.trim()), 'gi'), REMOVED);

  if (who.uhid) out = out.replace(new RegExp(escapeRegex(who.uhid), 'gi'), REMOVED);
  out = out.replace(/\bMHK\d{9}\b/gi, REMOVED);

  // Phone: the known number with any spaces or dashes between digits, then any long digit run.
  const digits = (who.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 6) {
    out = out.replace(new RegExp(digits.split('').join('[\\s-]*'), 'g'), REMOVED);
  }
  out = out.replace(/\d[\d\s-]*\d/g, (run) => (run.replace(/\D/g, '').length >= 10 ? REMOVED : run));

  const name = who.name.trim();
  if (name) out = out.replace(new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi'), REMOVED);
  for (const token of name.split(/\s+/)) {
    if (token.length >= 3) out = out.replace(new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi'), REMOVED);
  }
  return out;
}
