import { OpSession } from './schemas/op-doctor.schema';

export type AvailabilityState = 'now' | 'busy' | 'later' | 'done' | 'off';

export interface Availability {
  state: AvailabilityState;
  label: string;
  bookable: boolean;
  /** 'HH:mm', set when state is 'later' */
  startsAt?: string;
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** '16:00' -> '4:00 PM' */
export function shortTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Whether a doctor can be seen now, later today, or not today, from today's OP sessions and the queue length. */
export function doctorAvailability(
  sessions: OpSession[],
  now: Date,
  waiting: number,
  avgConsultMinutes: number,
): Availability {
  const today = sessions
    .filter((s) => s.days.includes(now.getDay()))
    .sort((a, b) => minutes(a.start) - minutes(b.start));
  if (!today.length) return { state: 'off', label: 'Not in today', bookable: false };

  const t = now.getHours() * 60 + now.getMinutes();
  if (today.some((s) => t >= minutes(s.start) && t < minutes(s.end))) {
    if (waiting <= 1) return { state: 'now', label: 'Available now', bookable: true };
    const wait = Math.ceil((waiting * avgConsultMinutes) / 5) * 5;
    return { state: 'busy', label: `About ${wait} min wait`, bookable: true };
  }
  const next = today.find((s) => minutes(s.start) > t);
  if (next) {
    return { state: 'later', label: `From ${shortTime(next.start)}`, bookable: true, startsAt: next.start };
  }
  return { state: 'done', label: 'Finished for today', bookable: false };
}
