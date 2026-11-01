import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { appointmentStart, clinicNow, displayDate, displayTime, isoDate } from '../../common/utils/clinic-time';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { EscalationsService } from '../coordinator/escalations.service';
import { OpDoctor, OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { procedureByKey, roomByKey, Skill } from './scheduling-catalogue';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { DOCTOR_SKILLS, SchedulingRosterService } from './scheduling-roster.service';
import { ProcedureBooking, ProcedureBookingDocument } from './schemas/procedure-booking.schema';
import { RoomBlock, RoomBlockDocument } from './schemas/room-block.schema';
import { StaffMember, StaffMemberDocument } from './schemas/staff-member.schema';
import { WaitItem, WaitItemDocument } from './schemas/wait-item.schema';

export type ConflictKind = 'doctor-overlap' | 'room-blocked' | 'leave' | 'running-late' | 'late-start' | 'roster-gap';

export interface ConflictView {
  kind: ConflictKind;
  ref: string;
  /** Names a doctor, room, time or PR number; never a patient. */
  text: string;
  /** ISO time the conflict is about. */
  at: string;
}

/** Minutes after its time that a Waiting or Checked In appointment makes its doctor "running late". */
export const RUNNING_LATE_MINUTES = 45;
/** Minutes after its start that a procedure still `booked` is a late start. */
export const LATE_START_MINUTES = 30;
const MIN_MS = 60_000;

const KIND_LABEL: Record<ConflictKind, string> = {
  'doctor-overlap': 'Doctor double-booked',
  'room-blocked': 'Room blocked over a booking',
  leave: 'Doctor on leave over bookings',
  'running-late': 'Doctor running late',
  'late-start': 'Procedure late to start',
  'roster-gap': 'Duty title with no one on duty',
};

/** Appointments that still hold the doctor's time. */
const LIVE_APPOINTMENT = ['Scheduled', 'Checked In', 'Waiting', 'In Consultation'];
const WAITING = ['Waiting', 'Checked In'];

interface Span {
  id: string;
  doctorKey: string;
  doctorName: string;
  start: Date;
  end: Date;
  label: string;
}

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * The six fixed conflict rules of spec 4.8. Each live conflict keeps exactly one open alert
 * `scheduling-conflict:<kind>:<ref>`, which closes itself once the cause is gone. Texts never hold a patient name.
 */
@Injectable()
export class SchedulingConflictsService {
  private readonly logger = new Logger(SchedulingConflictsService.name);

  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(RoomBlock.name) private readonly blocks: Model<RoomBlockDocument>,
    @InjectModel(OpDoctor.name) private readonly opDoctors: Model<OpDoctorDocument>,
    @InjectModel(StaffMember.name) private readonly staff: Model<StaffMemberDocument>,
    @InjectModel(WaitItem.name) private readonly waitItems: Model<WaitItemDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly doctors: SchedulingDoctorsService,
    private readonly roster: SchedulingRosterService,
    private readonly escalations: EscalationsService,
  ) {}

  /** Finds the live conflicts, keeps one open alert for each and completes the alerts whose cause is gone. */
  async sweep(): Promise<ConflictView[]> {
    const now = clinicNow();
    const today = isoDate(now);
    const opds = await this.opDoctors.find({ active: true }).lean().exec();
    const found = [
      ...(await this.overlaps(now, opds)),
      ...(await this.blockedRooms(now)),
      ...(await this.leaveConflicts(today, opds)),
      ...(await this.runningLate(now, today, opds)),
      ...(await this.lateStarts(now, today)),
      ...(await this.rosterGaps(now)),
    ];
    const links = found.map((c) => this.link(c));
    for (const c of found) await this.keepAlert(c);
    await this.alerts
      .updateMany({ link: { $regex: '^scheduling-conflict:', $nin: links }, status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } })
      .exec();
    return found;
  }

  private link(c: ConflictView): string {
    return `scheduling-conflict:${c.kind}:${c.ref}`;
  }

  private async keepAlert(c: ConflictView): Promise<void> {
    const set = { title: c.text, subtitle: KIND_LABEL[c.kind], patientName: '', uhid: '', type: 'System', category: 'System', priority: 'Medium', status: 'Pending', dueDateTime: '' };
    try {
      await this.alerts.updateOne({ link: this.link(c) }, { $set: set }, { upsert: true }).exec();
    } catch (e) {
      // A second pass wrote the same alert at the same moment: the unique link keeps it to one.
      if ((e as { code?: number }).code !== 11000) this.logger.error(`Writing a conflict alert failed: ${(e as Error).message}`);
    }
  }

  private when(d: Date, now: Date): string {
    return isoDate(d) === isoDate(now) ? displayTime(d) : `${displayTime(d)} on ${displayDate(d)}`;
  }

  // ---------- 1. a doctor in two places ----------

  private async overlaps(now: Date, opds: (OpDoctor & { _id: unknown })[]): Promise<ConflictView[]> {
    const spans: Span[] = [];
    const byDoctor = new Map(opds.map((d) => [String(d._id), d]));
    const apts = await this.appointments
      .find({ status: { $in: LIVE_APPOINTMENT }, date: { $gte: isoDate(now) }, doctorId: { $in: [...byDoctor.keys()] } })
      .lean()
      .exec();
    const slot = new Map<string, number>();
    for (const a of apts) {
      const doctorId = a.doctorId as string;
      if (!slot.has(doctorId)) slot.set(doctorId, (await this.doctors.profile(doctorId)).slotMinutes);
      const start = appointmentStart(a.date, a.time);
      const end = new Date(start.getTime() + (slot.get(doctorId) as number) * MIN_MS);
      if (end.getTime() <= now.getTime()) continue;
      const d = byDoctor.get(doctorId)!;
      spans.push({ id: String(a._id), doctorKey: d.userId ? `u:${d.userId}` : `d:${doctorId}`, doctorName: d.name, start, end, label: `an appointment at ${this.when(start, now)}` });
    }

    const procs = await this.bookings
      .find({ status: { $in: ['booked', 'in-progress'] }, end: { $gt: now }, 'team.0': { $exists: true } })
      .lean()
      .exec();
    const staffIds = [...new Set(procs.flatMap((p) => p.team.map((t) => t.staffId).filter((s): s is string => !!s)))];
    const people = new Map((await this.staff.find({ _id: { $in: staffIds } }).lean().exec()).map((s) => [String(s._id), s]));
    const opdUsers = new Set(opds.map((d) => d.userId).filter((u): u is string => !!u));
    for (const p of procs) {
      if (!p.start || !p.end) continue;
      const name = procedureByKey(p.procedure)?.name ?? p.procedure;
      for (const t of p.team) {
        const person = t.staffId ? people.get(t.staffId) : undefined;
        if (!person) continue;
        const isDoctor = person.skills.some((s) => DOCTOR_SKILLS.includes(s as Skill)) || (!!person.userId && opdUsers.has(person.userId));
        if (!isDoctor) continue;
        spans.push({
          id: String(p._id),
          doctorKey: person.userId ? `u:${person.userId}` : `s:${person._id}`,
          doctorName: person.name,
          start: new Date(p.start),
          end: new Date(p.end),
          label: `${p.number} (${name}, ${this.when(new Date(p.start), now)})`,
        });
      }
    }

    const out: ConflictView[] = [];
    const seen = new Set<string>();
    const byKey = new Map<string, Span[]>();
    for (const s of spans) byKey.set(s.doctorKey, [...(byKey.get(s.doctorKey) ?? []), s]);
    for (const [key, list] of byKey) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (a.id === b.id || !(a.start < b.end && b.start < a.end)) continue;
          const [x, y] = pair(a.id, b.id);
          const ref = `${key}:${x}:${y}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          const first = a.start <= b.start ? a : b;
          const second = first === a ? b : a;
          out.push({ kind: 'doctor-overlap', ref, text: `${a.doctorName} is booked twice at once: ${first.label} and ${second.label}`, at: new Date(Math.max(a.start.getTime(), b.start.getTime())).toISOString() });
        }
      }
    }
    return out;
  }

  // ---------- 2. a room blocked over bookings ----------

  private async blockedRooms(now: Date): Promise<ConflictView[]> {
    const blocks = await this.blocks.find({ to: { $gt: now } }).lean().exec();
    if (!blocks.length) return [];
    const procs = await this.bookings
      .find({ status: { $in: ['booked', 'in-progress'] }, room: { $in: [...new Set(blocks.map((b) => b.room))] }, end: { $gt: now } })
      .lean()
      .exec();
    const out: ConflictView[] = [];
    for (const blk of blocks) {
      for (const p of procs) {
        if (p.room !== blk.room || !p.start || !p.end || !(new Date(p.start) < blk.to && blk.from < new Date(p.end))) continue;
        const room = roomByKey(blk.room)?.name ?? blk.room;
        out.push({
          kind: 'room-blocked',
          ref: `${blk._id}:${p._id}`,
          text: `${room} is blocked from ${this.when(blk.from, now)} to ${this.when(blk.to, now)}, over ${p.number} at ${this.when(new Date(p.start), now)}`,
          at: new Date(p.start).toISOString(),
        });
      }
    }
    return out;
  }

  // ---------- 3. leave over bookings that are not on the waitlist ----------

  private async leaveConflicts(today: string, opds: (OpDoctor & { _id: unknown })[]): Promise<ConflictView[]> {
    const out: ConflictView[] = [];
    for (const d of opds) {
      const doctorId = String(d._id);
      const { leave } = await this.doctors.profile(doctorId);
      const ranges = leave.filter((l) => l.to >= today);
      if (!ranges.length) continue;
      const apts = await this.appointments
        .find({ doctorId, status: 'Scheduled', date: { $gte: today }, $or: ranges.map((l) => ({ date: { $gte: l.from, $lte: l.to } })) })
        .lean()
        .exec();
      if (!apts.length) continue;
      const listed = new Set(
        (await this.waitItems.find({ kind: 'appointment', status: 'open', refId: { $in: apts.map((a) => a._id) } }).select('refId').lean().exec()).map((w) => String(w.refId)),
      );
      for (const a of apts) {
        if (listed.has(String(a._id))) continue;
        const start = appointmentStart(a.date, a.time);
        out.push({ kind: 'leave', ref: String(a._id), text: `${d.name} is on leave on ${displayDate(start)}, but the appointment at ${a.time} is not on the waitlist`, at: start.toISOString() });
      }
    }
    return out;
  }

  // ---------- 4. a doctor running late ----------

  private async runningLate(now: Date, today: string, opds: (OpDoctor & { _id: unknown })[]): Promise<ConflictView[]> {
    const apts = await this.appointments.find({ date: today, status: { $in: WAITING } }).lean().exec();
    const late = apts.filter((a) => appointmentStart(a.date, a.time).getTime() + RUNNING_LATE_MINUTES * MIN_MS <= now.getTime());
    const byDoctor = new Map<string, typeof late>();
    for (const a of late) if (a.doctorId) byDoctor.set(a.doctorId, [...(byDoctor.get(a.doctorId) ?? []), a]);
    const names = new Map(opds.map((d) => [String(d._id), d.name]));
    const out: ConflictView[] = [];
    for (const [doctorId, list] of byDoctor) {
      const earliest = new Date(Math.min(...list.map((a) => appointmentStart(a.date, a.time).getTime())));
      const name = names.get(doctorId) ?? list[0].doctorName ?? 'A doctor';
      out.push({
        kind: 'running-late',
        ref: doctorId,
        text: `${name} is running late: ${list.length} patient${list.length === 1 ? '' : 's'} waiting ${RUNNING_LATE_MINUTES}+ minutes past their time (since ${displayTime(earliest)})`,
        at: earliest.toISOString(),
      });
    }
    return out;
  }

  // ---------- 5. a procedure not started ----------

  private async lateStarts(now: Date, today: string): Promise<ConflictView[]> {
    const due = new Date(now.getTime() - LATE_START_MINUTES * MIN_MS);
    const procs = await this.bookings.find({ status: 'booked', start: { $lte: due } }).lean().exec();
    const out: ConflictView[] = [];
    for (const p of procs) {
      if (!p.start || isoDate(new Date(p.start)) !== today) continue;
      const name = procedureByKey(p.procedure)?.name ?? p.procedure;
      const room = (p.room && roomByKey(p.room)?.name) || p.room || 'its room';
      out.push({ kind: 'late-start', ref: String(p._id), text: `${p.number}: ${name} has not started; it was booked for ${displayTime(new Date(p.start))} in ${room}`, at: new Date(p.start).toISOString() });
    }
    return out;
  }

  // ---------- 6. a duty title nobody holds ----------

  private async rosterGaps(now: Date): Promise<ConflictView[]> {
    const out: ConflictView[] = [];
    for (const t of await this.escalations.titles()) {
      if (t.holderNames.length) continue;
      if (await this.roster.titleHolders(t.key, now)) continue;
      out.push({ kind: 'roster-gap', ref: t.key, text: `No one is rostered as ${t.label} now, and it has no fixed holder`, at: now.toISOString() });
    }
    return out;
  }
}
