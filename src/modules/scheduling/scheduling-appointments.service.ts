import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Subscription } from 'rxjs';
import { appointmentStart, clinicNow, clockLabel, clockMinutes, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { AppointmentEvents } from '../appointments/appointment-events';
import { isDuplicateKey, releaseStaleSlot, slotKeyOf } from '../appointments/slot-key';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { OpdService } from '../opd/opd.service';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_SLOT_MINUTES, FRONT_DESK_LEAD_MINUTES, LeaveListener, SchedulingDoctorsService } from './scheduling-doctors.service';

const BOOK_ROLES = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.STAFF];
/** Statuses of an appointment a person may cancel or move. */
const CHANGEABLE = ['Scheduled', 'Checked In', 'Waiting'];
const JUST_TAKEN = 'That slot was just taken';

export interface BookInput {
  patientId: string;
  doctorId: string;
  date: string;
  time: string;
  type?: string;
  condition?: string;
  /** Minutes from now the start must be at least; a front-desk booking uses 15, the call agent passes its own. */
  leadMinutes?: number;
  bookedVia?: string;
  confirmation?: string;
}

export interface FreedSlot {
  id: string;
  doctorId: string;
  date: string;
  time: string;
}

export type FreedListener = (slot: FreedSlot) => void | Promise<void>;

export { slotKeyOf };
const isDuplicate = isDuplicateKey;

/** Books, moves and cancels appointments with a named doctor. A unique slotKey makes a double booking impossible. */
@Injectable()
export class SchedulingAppointmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SchedulingAppointmentsService.name);
  /** Registered by the waitlist (Task 8): a slot was freed by a cancel or a move. */
  readonly onFreed: FreedListener[] = [];

  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    private readonly doctors: SchedulingDoctorsService,
    private readonly opd: OpdService,
    private readonly events: AppointmentEvents,
  ) {}

  /** Leave listeners live on the doctors service, where leave is saved. */
  get onLeave(): LeaveListener[] {
    return this.doctors.onLeave;
  }

  private freedSub?: Subscription;

  async onModuleInit() {
    // A cancel made through the plain appointments API (PATCH status) reaches the same waitlist listeners.
    this.freedSub = this.events.slotFreed$.subscribe((slot) => {
      void this.slotFreed(slot);
    });
    try {
      await this.backfill();
    } catch (e) {
      this.log.warn(`Appointment backfill failed: ${(e as Error).message}`);
    }
  }

  onModuleDestroy() {
    this.freedSub?.unsubscribe();
  }

  async book(actor: Actor, input: BookInput): Promise<AppointmentDocument> {
    this.requireBook(actor);
    const patient = await this.patient(input.patientId);
    const doctor = await this.opd.getDoctor(input.doctorId);
    const { date, time } = this.normalise(input.date, input.time);
    await this.check(String(doctor._id), patient.uhid, date, time, input.leadMinutes ?? FRONT_DESK_LEAD_MINUTES);
    const key = slotKeyOf(String(doctor._id), date, time);
    await this.healStale(key);
    try {
      return await new this.appointments({
        uhid: patient.uhid,
        patientName: patient.name,
        age: patient.age,
        gender: patient.gender,
        avatar: patient.avatar ?? '',
        phone: patient.phone ?? '',
        date,
        time,
        type: input.type || 'Consultation',
        condition: input.condition ?? '',
        status: 'Scheduled',
        confirmation: input.confirmation ?? 'Unconfirmed',
        ...(input.confirmation === 'Confirmed' ? { confirmedAt: new Date() } : {}),
        bookedVia: input.bookedVia ?? '',
        tags: patient.conditions ?? [],
        doctorId: String(doctor._id),
        doctorName: doctor.name,
        departmentCode: doctor.departmentCode,
        slotKey: key,
      }).save();
    } catch (e) {
      if (isDuplicate(e)) throw new ConflictException(JUST_TAKEN);
      throw e;
    }
  }

  async move(actor: Actor, id: string, to: { date: string; time: string; doctorId?: string }): Promise<AppointmentDocument> {
    this.requireBook(actor);
    const apt = await this.find(id);
    if (apt.status !== 'Scheduled') throw new BadRequestException(`A ${apt.status.toLowerCase()} appointment can't be moved.`);
    const doctor = await this.opd.getDoctor(to.doctorId ?? apt.doctorId ?? String((await this.doctors.doctorForPatient({}))._id));
    const { date, time } = this.normalise(to.date, to.time);
    const key = slotKeyOf(String(doctor._id), date, time);
    if (apt.slotKey === key) return apt; // same slot: nothing to do
    await this.check(String(doctor._id), apt.uhid, date, time, FRONT_DESK_LEAD_MINUTES, String(apt._id));
    await this.healStale(key);
    const old = { id: String(apt._id), doctorId: apt.doctorId, date: apt.date, time: apt.time };
    let moved: AppointmentDocument | null;
    try {
      moved = await this.appointments
        .findOneAndUpdate(
          { _id: apt._id, status: 'Scheduled' },
          { $set: { date, time, doctorId: String(doctor._id), doctorName: doctor.name, departmentCode: doctor.departmentCode, slotKey: key } },
          { new: true },
        )
        .exec();
    } catch (e) {
      if (isDuplicate(e)) throw new ConflictException(JUST_TAKEN);
      throw e;
    }
    if (!moved) throw new ConflictException('That appointment just changed. Please look again.');
    if (old.doctorId) await this.slotFreed(old as FreedSlot);
    return moved;
  }

  async cancel(actor: Actor, id: string, reason: string): Promise<AppointmentDocument> {
    this.requireBook(actor);
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestException('Please give a reason for the cancellation.');
    if (why.length > 300) throw new BadRequestException('The reason is at most 300 characters.');
    const apt = await this.find(id);
    if (apt.status === 'Canceled') return apt;
    if (!CHANGEABLE.includes(apt.status)) throw new BadRequestException(`A ${apt.status.toLowerCase()} appointment can't be canceled.`);
    const changed = await this.appointments
      .findOneAndUpdate(
        { _id: apt._id, status: { $in: CHANGEABLE } },
        { $set: { status: 'Canceled', notes: apt.notes ? `${apt.notes}\nCanceled: ${why}` : `Canceled: ${why}` }, $unset: { slotKey: 1 } },
        { new: true },
      )
      .exec();
    if (!changed) throw new ConflictException('That appointment just changed. Please look again.');
    this.events.statusChanged({ id: String(changed._id), status: 'Canceled' });
    if (apt.doctorId) await this.slotFreed({ id: String(apt._id), doctorId: apt.doctorId, date: apt.date, time: apt.time });
    return changed;
  }

  /**
   * One-time repair, safe to repeat: appointments without a doctor get the default doctor; live appointments get their slot key
   * in time order (a clash is left without a key); canceled ones lose a stale key.
   */
  async backfill(): Promise<{ assigned: number; keyed: number }> {
    const fallback = await this.opd.defaultDoctor();
    let assigned = 0;
    if (fallback) {
      const res = await this.appointments.collection.updateMany(
        { $or: [{ doctorId: { $exists: false } }, { doctorId: null }, { doctorId: '' }] },
        { $set: { doctorId: String(fallback._id), doctorName: fallback.name, departmentCode: fallback.departmentCode } },
      );
      assigned = res.modifiedCount;
    }
    await this.appointments.collection.updateMany({ status: 'Canceled', slotKey: { $type: 'string' } }, { $unset: { slotKey: '' } });
    const unkeyed = await this.appointments
      .find({ status: { $ne: 'Canceled' }, doctorId: { $type: 'string', $ne: '' }, slotKey: { $not: { $type: 'string' } } })
      .lean()
      .exec();
    unkeyed.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        clockMinutes(a.time) - clockMinutes(b.time) ||
        new Date((a as any).createdAt ?? 0).getTime() - new Date((b as any).createdAt ?? 0).getTime() ||
        String(a._id).localeCompare(String(b._id)),
    );
    let keyed = 0;
    for (const a of unkeyed) {
      const minutes = clockMinutes(a.time);
      if (minutes === Number.MAX_SAFE_INTEGER) continue;
      try {
        await this.appointments.collection.updateOne({ _id: a._id }, { $set: { slotKey: slotKeyOf(a.doctorId!, a.date, clockLabel(minutes)) } });
        keyed++;
      } catch (e) {
        if (!isDuplicate(e)) throw e; // a clash: left without a key
      }
    }
    return { assigned, keyed };
  }

  // Helpers

  private requireBook(actor: Actor) {
    if (!actor || !BOOK_ROLES.includes(actor.role)) throw new ForbiddenException('Only an admin, a doctor or the front desk can change appointments.');
  }

  private async patient(id: string): Promise<PatientDocument> {
    const patient = await this.patients.findById(id).exec().catch(() => null);
    if (!patient) throw new NotFoundException('Patient not found');
    return patient;
  }

  private async find(id: string): Promise<AppointmentDocument> {
    const apt = await this.appointments.findById(id).exec().catch(() => null);
    if (!apt) throw new NotFoundException('Appointment not found');
    return apt;
  }

  /** The date as YYYY-MM-DD and the time in the stored "09:30 AM" form. */
  private normalise(date: string, time: string): { date: string; time: string } {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isoDate(parseIsoDay(date)) !== date) {
      throw new BadRequestException('The date must be YYYY-MM-DD.');
    }
    const minutes = clockMinutes(String(time ?? ''));
    if (minutes === Number.MAX_SAFE_INTEGER) throw new BadRequestException('The time must look like 09:30 AM.');
    return { date, time: clockLabel(minutes) };
  }

  /** The day's appointments, earliest first, optionally of one doctor. */
  async list(date: string, doctorId?: string): Promise<AppointmentDocument[]> {
    const day = this.normalise(date, '12:00 AM').date;
    const filter: Record<string, unknown> = { date: day };
    if (doctorId) filter.doctorId = doctorId;
    const rows = await this.appointments.find(filter).exec();
    return rows.sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
  }

  /** The rules of a booking, in the order a front desk meets them. */
  private async check(doctorId: string, uhid: string, date: string, time: string, leadMinutes: number, excludeId?: string) {
    if (!(await this.doctors.isSlot(doctorId, date, time))) throw new BadRequestException("That time isn't one of this doctor's slots.");
    if (appointmentStart(date, time).getTime() < clinicNow().getTime() + leadMinutes * 60_000) {
      throw new BadRequestException(`Please choose a time at least ${leadMinutes} minutes from now.`);
    }
    if (!(await this.doctors.isFree(doctorId, date, time, excludeId))) throw new ConflictException(JUST_TAKEN);
    await this.assertNoOverlap(doctorId, uhid, date, time, excludeId);
  }

  /** The same patient can't hold two appointments whose starts are closer than the longer of the two doctors' slots. */
  private async assertNoOverlap(doctorId: string, uhid: string, date: string, time: string, excludeId?: string) {
    const others = await this.appointments
      .find({ uhid, date, status: { $ne: 'Canceled' }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .lean()
      .exec();
    if (!others.length) return;
    const mine = (await this.doctors.profile(doctorId)).slotMinutes;
    const start = clockMinutes(time);
    for (const o of others) {
      const theirs = o.doctorId ? (await this.doctors.profile(o.doctorId)).slotMinutes : DEFAULT_SLOT_MINUTES;
      if (Math.abs(clockMinutes(o.time) - start) < Math.max(mine, theirs)) {
        throw new ConflictException('This patient already has an appointment at about that time.');
      }
    }
  }

  /** A canceled appointment (canceled by the call agent, which saves the document directly) may still hold the key: release it. */
  private async healStale(key: string) {
    await releaseStaleSlot(this.appointments, key);
  }

  /** Hands a freed slot to the listeners (the waitlist). Cancel, move and the call agent's cancels and reschedules all use it. */
  async slotFreed(slot: FreedSlot) {
    for (const listener of this.onFreed) {
      try {
        await listener(slot);
      } catch (e) {
        this.log.warn(`A slot-freed listener failed: ${(e as Error).message}`);
      }
    }
  }
}
