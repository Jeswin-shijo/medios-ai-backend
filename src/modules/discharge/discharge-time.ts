import { BadRequestException } from '@nestjs/common';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';

// Plans, orders, ticks, gate passes and leaving times are on the clinic clock: server-local time, on the pinned
// CLINIC_DATE when one is set (see clinicNow). Clock due times, announcedAt and message times are real time.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a 24-hour time from 00:00 to 23:59. */
export const isHhmm = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

/** A clinic-clock moment as real time: shifted by the real clock's lead over the clinic clock (none when CLINIC_DATE is unset). */
export function toRealTime(clinic: Date): Date {
  return new Date(clinic.getTime() + (Date.now() - clinicNow().getTime()));
}

/** When the discharge window opens: the planned leaving time less the target, or the order time if that is later. */
export function windowStart(orderedAt: Date, plannedLeaveAt: Date, leaveMinutes: number): Date {
  return new Date(Math.max(orderedAt.getTime(), plannedLeaveAt.getTime() - leaveMinutes * 60_000));
}

/** A plan's target day (YYYY-MM-DD) against the clinic day of `now`. */
export function dayStatus(targetDay: string, now: Date): 'planned' | 'due-tomorrow' | 'due-today' | 'overdue' {
  const today = isoDate(now);
  const next = parseIsoDay(today);
  next.setDate(next.getDate() + 1);
  const tomorrow = isoDate(next);
  if (targetDay > tomorrow) return 'planned';
  if (targetDay === tomorrow) return 'due-tomorrow';
  if (targetDay === today) return 'due-today';
  return 'overdue';
}

/** A clinic day (YYYY-MM-DD) at a 24-hour time: "2026-09-27" + "11:00". */
export function atClinicTime(day: string, hhmm: string): Date {
  // parseIsoDay reads a missing day as today on the real clock, which is never meant here.
  if (!day) throw new BadRequestException('date must be YYYY-MM-DD, got ""');
  const at = parseIsoDay(day);
  const m = HHMM.exec(hhmm);
  if (!m) throw new BadRequestException(`time must be HH:MM (24-hour), got "${hhmm}"`);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return at;
}
