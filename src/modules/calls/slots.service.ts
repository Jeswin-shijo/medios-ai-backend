import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { OpdService } from '../opd/opd.service';
import { OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { slotKeyOf } from '../scheduling/scheduling-appointments.service';
import { SchedulingDoctorsService } from '../scheduling/scheduling-doctors.service';
import { clinicNow, clockLabel, clockMinutes, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';
import { CallAgentSettings, parseSessions } from './call-agent-settings';
import { OfferedSlot } from './schemas/agent-call.schema';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SEARCH_DAYS = 14;
/** Earliest offer on the current day: the patient needs time to get there. */
const SAME_DAY_LEAD_MINUTES = 120;

/** The doctor columns and the slot guard every call-made appointment carries. */
export interface DoctorFields {
  doctorId: string;
  doctorName: string;
  departmentCode: string;
  slotKey: string;
}

/**
 * Finds open appointment slots. With active OP doctors it asks Scheduling for the doctor's own timetable; with none it
 * keeps the call agent's clinic sessions (one doctor, one patient per slot).
 */
@Injectable()
export class SlotsService {
  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    private readonly doctors?: SchedulingDoctorsService,
    private readonly opd?: OpdService,
    @InjectModel(Patient.name) private readonly patients?: Model<PatientDocument>,
  ) {}

  /**
   * The doctor whose timetable a call uses: the appointment's own doctor when it has one, else the patient's usual doctor
   * (or the default doctor). Null when there are no active OP doctors: the clinic sessions apply.
   */
  async doctorFor(who: { doctorId?: string; uhid?: string } = {}): Promise<OpDoctorDocument | null> {
    if (!this.doctors || !this.opd) return null;
    const fallback = await this.opd.defaultDoctor();
    if (!fallback) return null;
    if (who.doctorId) {
      const own = await this.opd.getDoctor(who.doctorId).catch(() => null);
      if (own?.active) return own;
    }
    const patient = who.uhid && this.patients ? await this.patients.findOne({ uhid: who.uhid }).lean().exec() : null;
    return patient ? this.doctors.doctorForPatient(patient) : fallback;
  }

  /** The doctor columns and slot key for an appointment at `date`/`time` with the doctor (nothing when there is no doctor). */
  fieldsFor(doctor: OpDoctorDocument | null, date: string, time: string): Partial<DoctorFields> {
    if (!doctor) return {};
    const id = String(doctor._id);
    return { doctorId: id, doctorName: doctor.name, departmentCode: doctor.departmentCode, slotKey: slotKeyOf(id, date, clockLabel(clockMinutes(time))) };
  }

  /**
   * The first `count` free slots from `from` onwards, one per day where possible so
   * the patient gets a real choice ("Sunday 10 AM or Monday 11:30 AM").
   */
  async findFree(cfg: CallAgentSettings, from: Date, count = 2, excludeAppointmentId?: string, doctorId?: string): Promise<OfferedSlot[]> {
    if (doctorId && this.doctors) return this.findFreeForDoctor(doctorId, from, count, excludeAppointmentId);
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

    return spread(days, count);
  }

  /** The doctor's own free slots, offered in the same spread: the first slot of each day, then later ones. */
  private async findFreeForDoctor(doctorId: string, from: Date, count: number, excludeAppointmentId?: string): Promise<OfferedSlot[]> {
    // The call agent's same-day lead: nothing sooner than two hours from now.
    const earliest = new Date(clinicNow().getTime() + SAME_DAY_LEAD_MINUTES * 60_000);
    const start = from.getTime() < earliest.getTime() ? earliest : from;
    const all = await this.doctors!.freeSlots(doctorId, start, MAX_DOCTOR_SLOTS, excludeAppointmentId);
    const days: { date: string; free: number[] }[] = [];
    for (const slot of all) {
      let day = days[days.length - 1];
      if (!day || day.date !== slot.date) {
        if (days.length >= count) break; // as before: only the first `count` days with a free slot
        day = { date: slot.date, free: [] };
        days.push(day);
      }
      day.free.push(clockMinutes(slot.time));
    }
    return spread(days, count);
  }

  /** Whether nobody else holds an overlapping slot (canceled appointments free theirs). */
  async isFree(cfg: CallAgentSettings, date: string, time: string, excludeAppointmentId?: string, doctorId?: string): Promise<boolean> {
    if (doctorId && this.doctors) return this.doctors.isFree(doctorId, date, time, excludeAppointmentId);
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

/** More slots than 14 days can hold, so the doctor's search is never cut short. */
const MAX_DOCTOR_SLOTS = 2000;

/** First free slot of each day, then later slots on those days if still short; sorted by date and time. */
function spread(days: { date: string; free: number[] }[], count: number): OfferedSlot[] {
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
