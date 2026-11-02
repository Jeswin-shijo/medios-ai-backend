/** Whole rupees in Indian grouping: 123456 -> "₹1,23,456", -1234 -> "-₹1,234". Fractions are rounded. */
export function formatRupees(n: number): string {
  const whole = Math.round(n);
  const text = `₹${Math.abs(whole).toLocaleString('en-IN')}`;
  return whole < 0 ? `-${text}` : text;
}
