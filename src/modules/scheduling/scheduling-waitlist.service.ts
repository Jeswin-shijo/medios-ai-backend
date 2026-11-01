import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { appointmentStart, clinicNow, displayDate, parseIsoDay } from '../../common/utils/clinic-time';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import type { Actor } from '../beds/actor';
import { FollowUpDocument, FollowUpItem } from '../follow-ups/schemas/follow-up.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { UserRole } from '../users/schemas/user.schema';
import { FreedSlot, SchedulingAppointmentsService } from './scheduling-appointments.service';
import { FRONT_DESK_LEAD_MINUTES, FreeSlot, SchedulingDoctorsService } from './scheduling-doctors.service';
import { BumpedProcedure, SchedulingProceduresService } from './scheduling-procedures.service';
import { WaitItem, WaitItemDocument, WaitReason } from './schemas/wait-item.schema';

const BOOK_ROLES = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.STAFF];
const OFFER_COUNT = 2;
const MIN_MS = 60_000;
const AGE_MS = 24 * 3_600_000;
const GRID_MS = 15 * MIN_MS;
const isDuplicate = (e: any) => e?.code === 11000;
const OFFER_CHANGED = 'That time was just taken. The offered times have been refreshed.';

export interface WaitInput {
  kind: 'appointment' | 'procedure';
  refId: string;
  reason: WaitReason;
  priority: 'stat' | 'urgent' | 'routine';
  wantsEarlier?: boolean;
  /** For a `no-slot` follow-up item (refId is the follow-up record): the doctor and the day the follow-up was due. */
  doctorId?: string;
  dueDay?: string;
}

export interface WaitView {
  id: string;
  kind: 'appointment' | 'procedure';
  refId: string;
  reason: WaitReason;
  priority: 'stat' | 'urgent' | 'routine';
  patientUhid: string;
  patientName: string;
  doctorId?: string;
  original: Record<string, unknown>;
  offered: Record<string, unknown>[];
  wantsEarlier: boolean;
  status: 'open' | 'resolved' | 'cancelled';
  createdAt: Date;
  resolvedAt?: Date;
}

type Lean<T> = T & { _id: Types.ObjectId };

/** One list of appointments and procedures that need a new time, each with up to 2 offered slots. A person books the offer. */
@Injectable()
export class SchedulingWaitlistService implements OnModuleInit {
  private readonly log = new Logger(SchedulingWaitlistService.name);

  constructor(
    @InjectModel(WaitItem.name) private readonly items: Model<WaitItemDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly doctors: SchedulingDoctorsService,
    private readonly bookings: SchedulingAppointmentsService,
    private readonly procedures: SchedulingProceduresService,
  ) {}

  onModuleInit() {
    this.bookings.onFreed.push((slot) => this.onFreed(slot));
    this.bookings.onLeave.push((info) => this.onLeave(info));
    this.procedures.onBumped.push((bumped) => this.onBumped(bumped));
  }

  // ---------- adding ----------

  /** Puts one appointment or procedure on the list, once while it is open, with the next 2 slots offered. Returns the open item. */
  async add(input: WaitInput): Promise<WaitView> {
    if (!isValidObjectId(input.refId)) throw new NotFoundException('Nothing to reschedule was found.');
    const open = await this.items.findOne({ kind: input.kind, refId: input.refId, status: 'open' }).lean().exec();
    if (open) return this.view(open as Lean<WaitItem>);
    const base = await this.describe(input);
    const offered = await this.offersFor(base, input);
    try {
      const created = await this.items.create({
        kind: input.kind,
        refId: new Types.ObjectId(input.refId),
        reason: input.reason,
        priority: input.priority,
        wantsEarlier: !!input.wantsEarlier,
        status: 'open',
        offered,
        ...base,
      });
      return this.view(created.toObject() as Lean<WaitItem>);
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      const again = await this.items.findOne({ kind: input.kind, refId: input.refId, status: 'open' }).lean().exec();
      if (!again) throw e;
      return this.view(again as Lean<WaitItem>);
    }
  }

  async list(status: 'open' | 'resolved' | 'cancelled' = 'open'): Promise<WaitView[]> {
    const rows = await this.items.find({ status }).sort({ createdAt: 1, _id: 1 }).limit(500).lean().exec();
    return rows.map((r) => this.view(r as Lean<WaitItem>));
  }

  /** The front desk marks an appointment "wants an earlier slot": offers only slots before the current one (maybe none). */
  async markEarlierWanted(actor: Actor, appointmentId: string): Promise<WaitView> {
    this.requireBook(actor);
    const apt = isValidObjectId(appointmentId) ? await this.appointments.findById(appointmentId).lean().exec() : null;
    if (!apt) throw new NotFoundException('Appointment not found');
    if (apt.status !== 'Scheduled') throw new BadRequestException(`A ${apt.status.toLowerCase()} appointment can't be moved.`);
    const view = await this.add({ kind: 'appointment', refId: appointmentId, reason: 'earlier-wanted', priority: 'routine', wantsEarlier: true });
    if (view.wantsEarlier) return view;
    // An item for another reason is already open (leave, patient request): keep it, and let it take freed earlier slots.
    await this.items.updateOne({ _id: view.id, status: 'open' }, { $set: { wantsEarlier: true } }).exec();
    return { ...view, wantsEarlier: true };
  }

  // ---------- actions ----------

  /** Books offered slot `index` after the person has confirmed with the patient. A taken slot refreshes the offers and gives 409. */
  async bookOffered(actor: Actor, id: string, index: number): Promise<WaitView> {
    this.requireBook(actor);
    const item = await this.openItem(id);
    const pick = Number.isInteger(index) ? (item.offered as any[])[index] : undefined;
    if (!pick) throw new BadRequestException('Choose one of the offered times.');
    try {
      if (item.kind === 'procedure') await this.bookProcedure(item, pick);
      else if (item.reason === 'no-slot') await this.bookFollowUp(actor, item, pick);
      else await this.moveAppointment(actor, item, pick);
    } catch (e) {
      if (e instanceof ConflictException) {
        await this.refresh(item);
      }
      throw e;
    }
    return this.finish(item, 'resolved');
  }

  /** The next 2 slots after the latest offered one. */
  async findAnother(actor: Actor, id: string): Promise<WaitView> {
    this.requireBook(actor);
    const item = await this.openItem(id);
    const next = await this.offersFor(item, { kind: item.kind, refId: String(item.refId), reason: item.reason, priority: item.priority, wantsEarlier: item.wantsEarlier }, item.offered as any[]);
    const saved = await this.items.findOneAndUpdate({ _id: item._id, status: 'open' }, { $set: { offered: next } }, { new: true }).lean().exec();
    if (!saved) throw new ConflictException('That item has just changed. Please look again.');
    return this.view(saved as Lean<WaitItem>);
  }

  /** Cancels the appointment or procedure itself, with a reason, and closes the item. */
  async cancelBooking(actor: Actor, id: string, reason: string): Promise<WaitView> {
    this.requireBook(actor);
    const item = await this.openItem(id);
    if (item.kind === 'procedure') await this.procedures.cancel(actor, String(item.refId), reason);
    else if (item.reason === 'no-slot') {
      if (!String(reason ?? '').trim()) throw new BadRequestException('Please give a reason for the cancellation.');
    } else await this.bookings.cancel(actor, String(item.refId), reason);
    return this.finish(item, 'cancelled');
  }

  // ---------- listeners ----------

  /** A slot was freed: it goes first in the offers of the oldest open "earlier wanted" item of that doctor whose time is later. Never books. */
  async onFreed(slot: FreedSlot): Promise<void> {
    if (!slot.doctorId) return;
    const freedStart = appointmentStart(slot.date, slot.time).getTime();
    // Not offered if it is already past the booking floor, or taken again (a repeated cancel result, P6-a).
    if (freedStart < clinicNow().getTime() + FRONT_DESK_LEAD_MINUTES * MIN_MS) return;
    if (!(await this.doctors.isFree(slot.doctorId, slot.date, slot.time))) return;
    const candidates = await this.items
      .find({ kind: 'appointment', status: 'open', doctorId: slot.doctorId, $or: [{ reason: 'earlier-wanted' }, { wantsEarlier: true }] })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec();
    for (const c of candidates) {
      if (String(c.refId) === slot.id || (c as any).reason === 'no-slot') continue;
      const o = c.original as { date: string; time: string };
      if (appointmentStart(o.date, o.time).getTime() <= freedStart) continue;
      const mine = { date: slot.date, time: slot.time };
      const offered = [mine, ...(c.offered as { date: string; time: string }[]).filter((x) => !(x.date === slot.date && x.time === slot.time))].slice(0, OFFER_COUNT);
      await this.items.updateOne({ _id: c._id, status: 'open' }, { $set: { offered } }).exec();
      return;
    }
  }

  /** An emergency bumped a planned procedure (now back to requested): it goes on the list, once, with new times offered. */
  async onBumped(bumped: BumpedProcedure): Promise<void> {
    await this.add({ kind: 'procedure', refId: bumped.bookingId, reason: 'bumped', priority: bumped.priority });
  }

  /** Doctor leave was saved: every booked appointment on leave goes on the list, once. */
  async onLeave(info: { doctorId: string; appointments: any[] }): Promise<void> {
    for (const a of info.appointments) {
      try {
        await this.add({ kind: 'appointment', refId: String(a._id), reason: 'doctor-leave', priority: 'routine' });
      } catch (e) {
        this.log.warn(`Could not wait-list appointment ${a._id}: ${(e as Error).message}`);
      }
    }
  }

  // ---------- ageing ----------

  /** One alert per item open longer than 24 hours (never raised twice); alerts of items no longer open are completed. */
  async ageAlerts(): Promise<{ raised: number; completed: number }> {
    const old = await this.items.find({ status: 'open', createdAt: { $lte: new Date(Date.now() - AGE_MS) } }).lean().exec();
    let raised = 0;
    for (const i of old) {
      const res = await this.alerts
        .updateOne(
          { link: `scheduling-waitlist:${i._id}` },
          {
            $setOnInsert: {
              title: `Waiting for a new time: ${i.patientName}`,
              subtitle: `${i.kind === 'procedure' ? 'Procedure' : 'Appointment'} · ${this.reasonText(i.reason)} · open for more than 24 hours`,
              patientName: i.patientName,
              uhid: i.patientUhid,
              type: 'Follow-up',
              category: 'System',
              priority: 'Medium',
              status: 'Pending',
              dueDateTime: '',
            },
          },
          { upsert: true },
        )
        .exec();
      if (res.upsertedCount) raised++;
    }
    const pending = await this.alerts.find({ link: { $regex: '^scheduling-waitlist:' }, status: { $ne: 'Completed' } }).lean().exec();
    let completed = 0;
    for (const a of pending) {
      const itemId = String(a.link).split(':')[1];
      const still = isValidObjectId(itemId) ? await this.items.exists({ _id: itemId, status: 'open' }) : null;
      if (!still) {
        await this.completeAlert(itemId);
        completed++;
      }
    }
    return { raised, completed };
  }

  // ---------- helpers ----------

  private requireBook(actor: Actor) {
    if (!actor || !BOOK_ROLES.includes(actor.role)) throw new ForbiddenException('Only an admin, a doctor or the front desk can change the waitlist.');
  }

  private async openItem(id: string): Promise<Lean<WaitItem>> {
    const item = isValidObjectId(id) ? await this.items.findById(id).lean().exec() : null;
    if (!item) throw new NotFoundException('Waitlist item not found');
    if (item.status !== 'open') throw new ConflictException('That item is already closed.');
    return item as Lean<WaitItem>;
  }

  /** The patient, doctor and original time of what is being wait-listed. */
  private async describe(input: WaitInput): Promise<Pick<WaitItem, 'patient' | 'patientUhid' | 'patientName' | 'doctorId' | 'original'>> {
    if (input.kind === 'procedure') {
      const b = await this.procedures.waitSource(input.refId);
      return { patient: new Types.ObjectId(b.patientId), patientUhid: b.patientUhid, patientName: b.patientName, original: { start: b.original } };
    }
    if (input.reason === 'no-slot') {
      const f = await this.followUps.findById(input.refId).lean().exec();
      if (!f) throw new NotFoundException('Follow-up not found');
      const patient = await this.patients.findOne({ uhid: f.uhid }).lean().exec();
      if (!patient) throw new NotFoundException('Patient not found');
      return { patient: patient._id, patientUhid: f.uhid, patientName: f.patientName, doctorId: input.doctorId, original: { date: input.dueDay ?? '', time: '' } };
    }
    const apt = await this.appointments.findById(input.refId).lean().exec();
    if (!apt) throw new NotFoundException('Appointment not found');
    const patient = await this.patients.findOne({ uhid: apt.uhid }).lean().exec();
    if (!patient) throw new NotFoundException('Patient not found');
    const doctorId = apt.doctorId || String((await this.doctors.doctorForPatient(patient))._id);
    return { patient: patient._id, patientUhid: apt.uhid, patientName: apt.patientName, doctorId, original: { date: apt.date, time: apt.time } };
  }

  /** Up to 2 offers: after `after` (the latest of the old ones) for "find another"; earlier than the booked time for earlier-wanted. */
  private async offersFor(base: Pick<WaitItem, 'doctorId' | 'original'> | Lean<WaitItem>, input: WaitInput, after: any[] = []): Promise<any[]> {
    if (input.kind === 'procedure') {
      const latest = after.length ? Math.max(...after.map((o) => new Date(o.start).getTime())) : 0;
      return this.procedures.offers(input.refId, OFFER_COUNT, latest ? new Date(latest + GRID_MS) : undefined);
    }
    const doctorId = base.doctorId!;
    const o = base.original as { date: string; time: string };
    const earlier = !!input.wantsEarlier || input.reason === 'earlier-wanted';
    let from = clinicNow();
    if (input.reason === 'no-slot' && o.date) from = parseIsoDay(o.date);
    if (after.length) from = new Date(Math.max(...after.map((x) => appointmentStart(x.date, x.time).getTime())) + MIN_MS);
    const slots = await this.doctors.freeSlots(doctorId, from, OFFER_COUNT, input.reason === 'no-slot' ? undefined : input.refId);
    const picked = earlier ? slots.filter((s) => appointmentStart(s.date, s.time).getTime() < appointmentStart(o.date, o.time).getTime()) : slots;
    return picked.map((s: FreeSlot) => ({ date: s.date, time: s.time }));
  }

  private async refresh(item: Lean<WaitItem>) {
    try {
      const offered = await this.offersFor(item, { kind: item.kind, refId: String(item.refId), reason: item.reason, priority: item.priority, wantsEarlier: item.wantsEarlier });
      await this.items.updateOne({ _id: item._id, status: 'open' }, { $set: { offered } }).exec();
    } catch (e) {
      this.log.warn(`Could not refresh the offers: ${(e as Error).message}`);
    }
  }

  private async moveAppointment(actor: Actor, item: Lean<WaitItem>, pick: { date: string; time: string }) {
    try {
      const moved = await this.bookings.move(actor, String(item.refId), { date: pick.date, time: pick.time });
      if (moved.confirmation === 'Reschedule Requested') await this.appointments.updateOne({ _id: moved._id }, { $set: { confirmation: 'Unconfirmed' } }).exec();
    } catch (e) {
      if (e instanceof ConflictException) throw new ConflictException(OFFER_CHANGED);
      throw e;
    }
  }

  /** A follow-up with no slot at order time: book a new appointment and update the follow-up record. */
  private async bookFollowUp(actor: Actor, item: Lean<WaitItem>, pick: { date: string; time: string }) {
    const f = await this.followUps.findById(item.refId).lean().exec();
    if (!f) throw new NotFoundException('Follow-up not found');
    let apt: AppointmentDocument;
    try {
      apt = await this.bookings.book(actor, { patientId: String(item.patient), doctorId: item.doctorId!, date: pick.date, time: pick.time, type: 'Follow-up', condition: f.note ?? '' });
    } catch (e) {
      if (e instanceof ConflictException) throw new ConflictException(OFFER_CHANGED);
      throw e;
    }
    await this.followUps
      .updateOne({ _id: f._id }, { $set: { status: 'Scheduled', followUpDate: displayDate(parseIsoDay(pick.date)), followUpTime: pick.time, appointmentId: apt._id } })
      .exec();
  }

  private async bookProcedure(item: Lean<WaitItem>, pick: { start: Date | string; room: string }) {
    const id = String(item.refId);
    const b = await this.procedures.waitSource(id);
    if (b.status !== 'requested' && b.status !== 'cant-book') {
      throw new ConflictException('That procedure is no longer waiting for a time.');
    }
    await this.procedures.setEarliest(id, new Date(pick.start));
    const outcome = await this.procedures.tryBook(id);
    if (outcome !== 'booked') throw new ConflictException(OFFER_CHANGED);
  }

  private async finish(item: Lean<WaitItem>, status: 'resolved' | 'cancelled'): Promise<WaitView> {
    const saved = await this.items
      .findOneAndUpdate({ _id: item._id, status: 'open' }, { $set: { status, resolvedAt: new Date() } }, { new: true })
      .lean()
      .exec();
    await this.completeAlert(String(item._id));
    return this.view((saved ?? item) as Lean<WaitItem>);
  }

  private async completeAlert(itemId: string) {
    await this.alerts.updateOne({ link: `scheduling-waitlist:${itemId}` }, { $set: { status: 'Completed' } }).exec();
  }

  private reasonText(r: WaitReason): string {
    return { 'doctor-leave': 'doctor on leave', bumped: 'moved for an emergency', 'patient-request': 'patient asked to reschedule', 'earlier-wanted': 'wants an earlier time', 'no-slot': 'no free time in the window' }[r];
  }

  private view(r: Lean<WaitItem>): WaitView {
    return {
      id: String(r._id),
      kind: r.kind,
      refId: String(r.refId),
      reason: r.reason,
      priority: r.priority,
      patientUhid: r.patientUhid,
      patientName: r.patientName,
      doctorId: r.doctorId,
      original: r.original as any,
      offered: (r.offered ?? []) as any[],
      wantsEarlier: !!r.wantsEarlier,
      status: r.status,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    };
  }
}
