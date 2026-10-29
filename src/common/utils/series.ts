const HOUR_MS = 3_600_000;

/** Rounded percentage change; null when there is no earlier value to compare with. */
export function trendPct(now: number, dayAgo: number | null): number | null {
  if (dayAgo === null || dayAgo === 0) return null;
  return Math.round(((now - dayAgo) / dayAgo) * 100);
}

export const hourOf = (d: Date): Date => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/** One value per hour for `hours` hours ending with the hour of `now`, oldest first. */
export function hourlySeries(snaps: { hour: Date; value: number }[], hours: number, now: Date): (number | null)[] {
  const byHour = new Map(snaps.map((s) => [hourOf(s.hour).getTime(), s.value]));
  const last = hourOf(now).getTime();
  return Array.from({ length: hours }, (_, i) => byHour.get(last - (hours - 1 - i) * HOUR_MS) ?? null);
}
