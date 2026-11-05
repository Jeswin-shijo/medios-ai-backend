import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow, clockLabel, clockMinutes, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { OpdService } from '../opd/opd.service';
import { OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { UserRole } from '../users/schemas/user.schema';
import { doctorSlots, onLeaveOn } from './scheduling-time';
import { DoctorProfile, DoctorProfileDocument } from './schemas/doctor-profile.schema';

export const DEFAULT_SLOT_MINUTES = 15;
const SEARCH_DAYS = 14;
export const FRONT_DESK_LEAD_MINUTES = 15;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface LeaveRange {
  from: string;
  to: string;
  reason: string;
}

export interface FreeSlot {
  date: string;
  time: string;
  label: string;
}

/** Called when leave is saved, with the doctor and the booked appointments now on leave. */
export type LeaveListener = (info: { doctorId: string; appointments: any[] }) => void | Promise<void>;

const addDays = (day: string, n: number): string => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

const validDay = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !ISO_DAY.test(v) || isoDate(parseIsoDay(v)) !== v) {
    throw new BadRequestException(`${label} must be a date as YYYY-MM-DD`);
  }
  return v;
};

/** Appointments a person can still move off a leave day. */
const BOOKED = ['Scheduled'];

/** A doctor's slot length, leave and free slots. Scheduling's extras sit in DoctorProfile; sessions come from the OP doctor. */
@Injectable()
export class SchedulingDoctorsService {
  private readonly log = new Logger(SchedulingDoctorsService.name);
  /** Registered by the waitlist (Task 8). */
  readonly onLeave: LeaveListener[] = [];

  constructor(
    @InjectModel(DoctorProfile.name) private readonly profiles: Model<DoctorProfileDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    private readonly opd: OpdService,
  ) {}

  /** OP doctors (active only on request) with their slot length and leave. */
  async listWithProfiles(activeOnly = false) {
    const doctors = await this.opd.listDoctors({ activeOnly });
    const profiles = await this.profiles.find({ doctorId: { $in: doctors.map((d) => String(d.id)) } }).lean().exec();
    const byId = new Map(profiles.map((p) => [String(p.doctorId), p]));
    return doctors.map((d) => {
      const p = byId.get(String(d.id));
      return {
        id: String(d.id),
        name: d.name,
        departmentCode: d.departmentCode,
        room: d.room,
        active: d.active,
        userId: d.userId ?? null,
        slotMinutes: p?.slotMinutes ?? DEFAULT_SLOT_MINUTES,
        leave: (p?.leave ?? []).map((l) => ({ from: l.from, to: l.to, reason: l.reason ?? '' })),
      };
    });
  }

  /** Which of these doctors are on leave on the clinic day `date` (YYYY-MM-DD), in one read: the kiosk's doctor list asks (R27). */
  async doctorsOnLeave(date: string, doctorIds: string[]): Promise<Set<string>> {
    if (!doctorIds.length) return new Set();
    const profiles = await this.profiles.find({ doctorId: { $in: doctorIds } }).select('doctorId leave').lean().exec();
    return new Set(profiles.filter((p) => onLeaveOn(p.leave ?? [], date)).map((p) => String(p.doctorId)));
  }

  async profile(doctorId: string): Promise<{ slotMinutes: number; leave: LeaveRange[] }> {
    const doc = await this.profiles.findOne({ doctorId }).lean().exec();
    return {
      slotMinutes: doc?.slotMinutes ?? DEFAULT_SLOT_MINUTES,
      leave: (doc?.leave ?? []).map((l) => ({ from: l.from, to: l.to, reason: l.reason ?? '' })),
    };
  }

  /**
   * Saves the slot length and/or leave. Admin may change anyone; a doctor may change only the OP doctor linked to their own login.
   * Returns the appointments (Scheduled) now falling on leave.
   */
  async setProfile(
    actor: Actor,
    doctorId: string,
    changes: { slotMinutes?: number; leave?: { from: string; to: string; reason?: string }[] },
  ): Promise<{ slotMinutes: number; leave: LeaveRange[]; onLeave: AppointmentDocument[] }> {
    const doctor = await this.opd.getDoctor(doctorId);
    const isAdmin = actor?.role === UserRole.ADMIN;
    const isSelf = actor?.role === UserRole.DOCTOR && !!doctor.userId && doctor.userId === actor.id;
    if (!isAdmin && !isSelf) throw new ForbiddenException('Only an admin, or the doctor themselves, can change a doctor\'s leave.');
    const $set: Record<string, unknown> = {};
    if (changes.slotMinutes !== undefined) {
      if (!isAdmin) throw new ForbiddenException('Only an admin can change a doctor\'s slot length.');
      const n = changes.slotMinutes;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 5 || n > 60) throw new BadRequestException('Slot length must be a whole number of minutes from 5 to 60.');
      $set.slotMinutes = n;
    }
    if (changes.leave !== undefined) {
      if (!Array.isArray(changes.leave) || changes.leave.length > 100) throw new BadRequestException('Leave must be a list of date ranges.');
      $set.leave = changes.leave.map((l) => {
        const from = validDay(l?.from, 'Leave start');
        const to = validDay(l?.to, 'Leave end');
        if (to < from) throw new BadRequestException('Leave must end on or after the day it starts.');
        const reason = l.reason === undefined ? '' : String(l.reason).trim();
        if (reason.length > 120) throw new BadRequestException('A leave reason is at most 120 characters.');
        return { from, to, reason };
      });
    }
    if (Object.keys($set).length) await this.profiles.updateOne({ doctorId }, { $set }, { upsert: true }).exec();
    const saved = await this.profile(doctorId);
    const onLeave = changes.leave === undefined ? [] : await this.onLeaveNow(doctorId, saved.leave);
    if (changes.leave !== undefined) {
      for (const listener of this.onLeave) {
        try {
          await listener({ doctorId, appointments: onLeave });
        } catch (e) {
          this.log.warn(`A leave listener failed: ${(e as Error).message}`);
        }
      }
    }
    return { ...saved, onLeave };
  }

  /** Scheduled appointments of the doctor, today or later, that fall inside any leave range. */
  private async onLeaveNow(doctorId: string, leave: LeaveRange[]): Promise<AppointmentDocument[]> {
    if (!leave.length) return [];
    const today = isoDate(clinicNow());
    const found = await this.appointments
      .find({ doctorId, status: { $in: BOOKED }, date: { $gte: today }, $or: leave.map((l) => ({ date: { $gte: l.from, $lte: l.to } })) })
      .exec();
    return found.sort((a, b) => a.date.localeCompare(b.date) || clockMinutes(a.time) - clockMinutes(b.time));
  }

  /** Free slots in the next 14 days from `from` (never before `from`, nor before clinicNow + 15 minutes), earliest first. */
  async freeSlots(doctorId: string, from: Date, count: number, excludeId?: string): Promise<FreeSlot[]> {
    const doctor = await this.opd.getDoctor(doctorId);
    if (!doctor.active || count <= 0) return [];
    const { slotMinutes, leave } = await this.profile(doctorId);
    // The front-desk lead is a floor, so no slot is offered that book would refuse. Callers with a longer lead (calls) pass a later `from`.
    const floor = new Date(clinicNow().getTime() + FRONT_DESK_LEAD_MINUTES * 60_000);
    const notBefore = from.getTime() < floor.getTime() ? floor : from;
    const firstDay = isoDate(notBefore);
    const out: FreeSlot[] = [];
    for (let i = 0; i < SEARCH_DAYS && out.length < count; i++) {
      const date = addDays(firstDay, i);
      const taken = await this.takenMinutes(doctorId, date, excludeId);
      const minutes = doctorSlots({ date, sessions: doctor.sessions, slotMinutes, leave, takenMinutes: taken, notBefore });
      for (const t of minutes) {
        if (out.length >= count) break;
        out.push({ date, time: clockLabel(t), label: `${spokenDay(parseIsoDay(date))} at ${clockLabel(t)}` });
      }
    }
    return out;
  }

  /** Whether the time is a slot of the doctor's (inside a session, on the grid, not on leave) that nobody holds. */
  async isFree(doctorId: string, date: string, time: string, excludeId?: string): Promise<boolean> {
    const doctor = await this.opd.getDoctor(doctorId).catch(() => null);
    if (!doctor?.active) return false;
    const minutes = clockMinutes(time);
    if (minutes === Number.MAX_SAFE_INTEGER || !ISO_DAY.test(date)) return false;
    const { slotMinutes, leave } = await this.profile(doctorId);
    const taken = await this.takenMinutes(doctorId, date, excludeId);
    return doctorSlots({ date, sessions: doctor.sessions, slotMinutes, leave, takenMinutes: taken, notBefore: null }).includes(minutes);
  }

  /** Whether the time is one of the doctor's slots, whether or not it is taken. */
  async isSlot(doctorId: string, date: string, time: string): Promise<boolean> {
    const doctor = await this.opd.getDoctor(doctorId).catch(() => null);
    if (!doctor?.active) return false;
    const minutes = clockMinutes(time);
    if (minutes === Number.MAX_SAFE_INTEGER || !ISO_DAY.test(date)) return false;
    const { slotMinutes, leave } = await this.profile(doctorId);
    return doctorSlots({ date, sessions: doctor.sessions, slotMinutes, leave, takenMinutes: [], notBefore: null }).includes(minutes);
  }

  /** The patient's usual doctor: the active OP doctor named in the patient record (case-insensitive), else the default doctor. */
  async doctorForPatient(patient: { doctor?: string }): Promise<OpDoctorDocument> {
    const wanted = normaliseName(patient?.doctor ?? '');
    if (wanted) {
      const match = (await this.opd.listDoctors({ activeOnly: true })).find((d) => normaliseName(d.name) === wanted);
      if (match) return match;
    }
    const fallback = await this.opd.defaultDoctor();
    if (!fallback) throw new BadRequestException('No OP doctor is set up yet.');
    return fallback;
  }

  /** Minutes of the doctor's live (not canceled) appointments that day. */
  private async takenMinutes(doctorId: string, date: string, excludeId?: string): Promise<number[]> {
    const rows = await this.appointments
      .find({ doctorId, date, status: { $ne: 'Canceled' }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { time: 1 })
      .lean()
      .exec();
    return rows.map((r) => clockMinutes(r.time));
  }
}

/** "Dr. Shajin" and "shajin" are the same name. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/^\s*dr\b\.?\s*/, '').replace(/\s+/g, ' ').trim();
}
