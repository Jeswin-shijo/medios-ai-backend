import { parseIsoDay } from '../../common/utils/clinic-time';
import { OpSession } from '../opd/schemas/op-doctor.schema';
import { DEFAULT_SHIFTS, GRID_MINUTES, Shift } from './scheduling-catalogue';

// All dates are server-local clinic time. No UTC maths.

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The half-open window [start, end) of a shift dated `date`; a shift that ends at or before its start ends the next day. */
export function shiftWindow(
  date: string,
  shift: Shift,
  shifts: Record<Shift, { start: string; end: string }> = DEFAULT_SHIFTS,
): { start: Date; end: Date } {
  const def = shifts[shift];
  const s = toMinutes(def.start);
  const e = toMinutes(def.end);
  const start = parseIsoDay(date);
  start.setHours(0, s, 0, 0);
  const end = parseIsoDay(date);
  end.setDate(end.getDate() + (e <= s ? 1 : 0));
  end.setHours(0, e, 0, 0);
  return { start, end };
}

/** True when [from, to] sits inside the window; a point check covers(w, t, t) means start <= t < end. */
export function covers(w: { start: Date; end: Date }, from: Date, to: Date): boolean {
  return w.start.getTime() <= from.getTime() && to.getTime() <= w.end.getTime() && from.getTime() < w.end.getTime();
}

export interface DoctorSlotsInput {
  date: string;
  sessions: OpSession[];
  slotMinutes: number;
  leave: { from: string; to: string }[];
  takenMinutes: number[];
  notBefore: Date | null;
}

/** Whether a doctor with this leave is away on the clinic day `date` (YYYY-MM-DD): whole days, both ends included. */
export function onLeaveOn(leave: { from: string; to: string }[], date: string): boolean {
  return leave.some((l) => l.from <= date && date <= l.to);
}

/** Free slot starts (minutes since midnight) for a doctor on a day, sorted and unique. */
export function doctorSlots(input: DoctorSlotsInput): number[] {
  const { date, sessions, slotMinutes, leave, takenMinutes, notBefore } = input;
  if (onLeaveOn(leave, date)) return [];
  if (slotMinutes <= 0) return [];
  const day = parseIsoDay(date);
  const weekday = day.getDay();
  let floor = -Infinity;
  if (notBefore) {
    const nb = parseIsoDay(`${notBefore.getFullYear()}-${String(notBefore.getMonth() + 1).padStart(2, '0')}-${String(notBefore.getDate()).padStart(2, '0')}`);
    if (nb.getTime() > day.getTime()) return [];
    if (nb.getTime() === day.getTime()) floor = notBefore.getHours() * 60 + notBefore.getMinutes() + (notBefore.getSeconds() > 0 || notBefore.getMilliseconds() > 0 ? 1 : 0);
  }
  const taken = new Set(takenMinutes);
  const out = new Set<number>();
  for (const s of sessions) {
    if (!s.days.includes(weekday)) continue;
    const end = toMinutes(s.end);
    for (let t = toMinutes(s.start); t + slotMinutes <= end; t += slotMinutes) {
      if (t < floor || taken.has(t)) continue;
      out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Every 15-minute mark on the local clock with ceil15(from) <= s < to. */
export function gridStarts(from: Date, to: Date): Date[] {
  const at = (m: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, m, 0, 0);
  const sinceMidnight = (from.getTime() - at(0).getTime()) / 60000;
  const out: Date[] = [];
  for (let m = Math.ceil(sinceMidnight / GRID_MINUTES) * GRID_MINUTES; ; m += GRID_MINUTES) {
    const t = at(m);
    if (t.getTime() >= to.getTime()) break;
    out.push(t);
  }
  return out;
}
