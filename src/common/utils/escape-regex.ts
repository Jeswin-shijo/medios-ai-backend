/**
 * Turns user search text into a literal regex pattern, so input such as `.*` or
 * `(a+)+` cannot change the query or trigger catastrophic backtracking.
 * Repeated query params arrive as arrays; they are joined, and length is capped.
 */
export const escapeRegex = (value: unknown, maxLength = 100): string =>
  String(Array.isArray(value) ? value.join(' ') : value ?? '')
    .slice(0, maxLength)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
