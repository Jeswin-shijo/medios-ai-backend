import { BadRequestException } from '@nestjs/common';

// Clinical records store human-readable dates ("26 Sep 2026", "09:30 AM"), while
// appointments are keyed by ISO day ("2026-09-26"). These helpers produce both from
// server time; set TZ (e.g. Asia/Kolkata) so "today" matches the hospital's day.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** "26 Sep 2026" */
export const displayDate = (d: Date = new Date()) =>
  `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** "09:30 AM" */
export const displayTime = (d: Date = new Date()) =>
  `${pad(d.getHours() % 12 || 12)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;

/** "26 Sep 2026, 09:30 AM" */
export const displayDateTime = (d: Date = new Date()) => `${displayDate(d)}, ${displayTime(d)}`;

/** "2026-09-26" */
export const isoDate = (d: Date = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Parses an optional `YYYY-MM-DD` query value as a local day; defaults to today. */
export function parseIsoDay(value?: string): Date {
  if (!value) return new Date();
  const m = ISO_DAY.exec(value);
  if (!m) throw new BadRequestException(`date must be YYYY-MM-DD, got "${value}"`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Minutes since midnight for "09:30 AM"; unparseable times sort last. */
export function clockMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const hours = (Number(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return hours * 60 + Number(m[2]);
}

/**
 * The current moment on the clinic's day. Development pins CLINIC_DATE to the seed's
 * day (like the web app's VITE_CLINIC_DATE) so "today" and "tomorrow" line up with
 * the demo schedule; the time of day is always real. Unset, this is plain `new Date()`.
 */
export function clinicNow(): Date {
  const now = new Date();
  const pinned = ISO_DAY.exec(process.env.CLINIC_DATE ?? '');
  if (pinned) now.setFullYear(Number(pinned[1]), Number(pinned[2]) - 1, Number(pinned[3]));
  return now;
}

/** The local moment an appointment starts: "2026-09-27" + "10:30 AM". */
export function appointmentStart(date: string, time: string): Date {
  const day = parseIsoDay(date);
  const minutes = clockMinutes(time);
  day.setMinutes(minutes === Number.MAX_SAFE_INTEGER ? 0 : minutes);
  return day;
}

/** "10:30 AM" from minutes since midnight. */
export const clockLabel = (minutes: number) =>
  `${pad(Math.floor(minutes / 60) % 12 || 12)}:${pad(minutes % 60)} ${minutes < 12 * 60 ? 'AM' : 'PM'}`;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Sunday, 27 September": how a voice agent should say a date. */
export const spokenDay = (d: Date) => `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
