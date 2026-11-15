import { SupportConfig } from './support-catalogue';

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The given day (server-local) at HH:MM, `dayOffset` days on. */
const atTime = (from: Date, hhmm: string, dayOffset = 0): Date => {
  const d = new Date(from);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(Math.floor(minutesOf(hhmm) / 60), minutesOf(hhmm) % 60, 0, 0);
  return d;
};

/**
 * `minutes` of working time after `from`, counting only the daily window workStart to workEnd (server-local time of day).
 * Before the window it jumps to workStart; at or after workEnd it jumps to the next day's workStart.
 */
export function addWorkingMinutes(from: Date, minutes: number, workStart: string, workEnd: string): Date {
  let cur = new Date(from);
  let left = Math.max(0, minutes);
  const startMin = minutesOf(workStart);
  const endMin = minutesOf(workEnd);
  if (endMin <= startMin) return new Date(from.getTime() + left * 60000);
  for (let guard = 0; guard < 4000; guard++) {
    const m = cur.getHours() * 60 + cur.getMinutes() + cur.getSeconds() / 60;
    if (m < startMin) {
      cur = atTime(cur, workStart);
      continue;
    }
    if (m >= endMin) {
      cur = atTime(cur, workStart, 1);
      continue;
    }
    const room = endMin - m;
    if (left <= room) return new Date(cur.getTime() + left * 60000);
    left -= room;
    cur = atTime(cur, workStart, 1);
  }
  return cur;
}

/** When quiet hours next end for a moment inside them (the window may cross midnight), else null. */
export function quietUntil(at: Date, quietStart: string, quietEnd: string): Date | null {
  const s = minutesOf(quietStart);
  const e = minutesOf(quietEnd);
  if (s === e) return null;
  const m = at.getHours() * 60 + at.getMinutes();
  if (s < e) return m >= s && m < e ? atTime(at, quietEnd) : null;
  if (m >= s) return atTime(at, quietEnd, 1);
  if (m < e) return atTime(at, quietEnd);
  return null;
}

/** Urgent, clinical and complaint tickets are due `urgentMinutes` after opening at any hour; the rest count `normalHours` of working time. */
export function ticketDueAt(openedAt: Date, t: { priority: string; ticketType: string }, cfg: SupportConfig): Date {
  const fast = t.priority === 'urgent' || t.ticketType === 'clinical' || t.ticketType === 'complaint';
  if (fast) return new Date(openedAt.getTime() + cfg.urgentMinutes * 60000);
  return addWorkingMinutes(openedAt, cfg.normalHours * 60, cfg.workStart, cfg.workEnd);
}

/** 0 is "ground floor", n is "floor n"; an unknown floor is empty. */
export function floorText(floor?: number | null): string {
  if (floor === null || floor === undefined || !Number.isFinite(floor)) return '';
  return floor === 0 ? 'ground floor' : `floor ${floor}`;
}
