import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { clockLabel, clockMinutes, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';
import { CallAgentSettings, parseSessions } from './call-agent-settings';
import { OfferedSlot } from './schemas/agent-call.schema';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEARCH_DAYS = 14;
/** Earliest offer on the current day: the patient needs time to get there. */
const SAME_DAY_LEAD_MINUTES = 120;

/** Finds open appointment slots in the clinic's sessions (one doctor, one patient per slot). */
@Injectable()
export class SlotsService {
  constructor(@InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>) {}

  /**
   * The first `count` free slots from `from` onwards, one per day where possible so
   * the patient gets a real choice ("Sunday 10 AM or Monday 11:30 AM").
   */
  async findFree(cfg: CallAgentSettings, from: Date, count = 2, excludeAppointmentId?: string): Promise<OfferedSlot[]> {
    const sessions = parseSessions(cfg.clinicSessions);
    const days: { date: string; free: number[] }[] = [];
    const startDay = parseIsoDay(isoDate(from));
    const earliestToday = from.getHours() * 60 + from.getMinutes() + SAME_DAY_LEAD_MINUTES;

    for (let offset = 0; offset < SEARCH_DAYS && days.length < count; offset++) {
      const day = new Date(startDay);
      day.setDate(day.getDate() + offset);
      if (cfg.closedDays.includes(WEEKDAYS[day.getDay()])) continue;

      const date = isoDate(day);
      const taken = await this.takenMinutes(date, excludeAppointmentId);
      const free: number[] = [];
      for (const [open, close] of sessions) {
        for (let t = open; t + cfg.slotMinutes <= close; t += cfg.slotMinutes) {
          if (offset === 0 && t < earliestToday) continue;
          if (!taken.some((b) => Math.abs(b - t) < cfg.slotMinutes)) free.push(t);
        }
      }
      if (free.length) days.push({ date, free });
    }

    // First free slot of each day, then later slots on those days if still short.
    const picks: { date: string; minutes: number }[] = [];
    for (let round = 0; picks.length < count && days.some((d) => d.free.length > round); round++) {
      for (const d of days) {
        if (picks.length < count && d.free[round] !== undefined) picks.push({ date: d.date, minutes: d.free[round] });
      }
    }
    return picks
      .sort((a, b) => a.date.localeCompare(b.date) || a.minutes - b.minutes)
      .map(({ date, minutes }) => ({ date, time: clockLabel(minutes), label: `${spokenDay(parseIsoDay(date))} at ${clockLabel(minutes)}` }));
  }

  /** Whether nobody else holds an overlapping slot (canceled appointments free theirs). */
  async isFree(cfg: CallAgentSettings, date: string, time: string, excludeAppointmentId?: string): Promise<boolean> {
    const t = clockMinutes(time);
    return !(await this.takenMinutes(date, excludeAppointmentId)).some((b) => Math.abs(b - t) < cfg.slotMinutes);
  }

  /** Start minutes of the day's live appointments; each is assumed to last one slot. */
  private async takenMinutes(date: string, excludeAppointmentId?: string): Promise<number[]> {
    const filter: Record<string, unknown> = { date, status: { $ne: 'Canceled' } };
    if (excludeAppointmentId) filter._id = { $ne: excludeAppointmentId };
    const booked = await this.appointments.find(filter, { time: 1 }).lean().exec();
    return booked.map((a) => clockMinutes(a.time));
  }
}
