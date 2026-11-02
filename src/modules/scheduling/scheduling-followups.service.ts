import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { clinicNow, displayDate, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Case, CaseDocument } from '../coordinator/schemas/case.schema';
import { MessagesService } from '../coordinator/messages.service';
import { FollowUpDocument, FollowUpItem } from '../follow-ups/schemas/follow-up.schema';
import { OpdService } from '../opd/opd.service';
import { OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';

const CLINICAL_ROLES = [UserRole.ADMIN, UserRole.DOCTOR];
/** The window is day N through day N + 7. */
const WINDOW_DAYS = 7;
const NOTE_MAX = 300;

export interface FollowUpOrder {
  patientId: string;
  /** Book into this existing follow-up (a Pending, Overdue or Missed row) instead of creating a new one. */
  followUpId?: string;
  doctorId?: string;
  departmentCode?: string;
  inDays: number;
  note?: string;
}

export interface FollowUpOutcome {
  followUpId: string;
  /** 'booked' with an appointment, or 'waitlisted' when the week is full. */
  status: 'booked' | 'waitlisted';
  appointmentId?: string;
  date?: string;
  time?: string;
  waitItemId?: string;
}

const addDays = (day: string, n: number): string => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

/** A doctor orders "OPD with this doctor (or department) in N days"; the agent books the first free slot in day N to N + 7. */
@Injectable()
export class SchedulingFollowupsService {
  private readonly log = new Logger(SchedulingFollowupsService.name);

  constructor(
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    private readonly opd: OpdService,
    private readonly doctors: SchedulingDoctorsService,
    private readonly appointments: SchedulingAppointmentsService,
    private readonly waitlist: SchedulingWaitlistService,
    private readonly messages: MessagesService,
  ) {}

  async order(actor: Actor, input: FollowUpOrder): Promise<FollowUpOutcome> {
    if (!actor || !CLINICAL_ROLES.includes(actor.role)) throw new ForbiddenException('Only a doctor or an admin can order a follow-up.');
    const inDays = input?.inDays;
    if (typeof inDays !== 'number' || !Number.isInteger(inDays) || inDays < 1 || inDays > 365) {
      throw new BadRequestException('"In how many days" must be a whole number from 1 to 365.');
    }
    if (input.note !== undefined && typeof input.note !== 'string') throw new BadRequestException('The note must be text.');
    let note = (input.note ?? '').trim();
    if (note.length > NOTE_MAX) throw new BadRequestException(`The note is at most ${NOTE_MAX} characters.`);
    const patient = isValidObjectId(input.patientId) ? await this.patients.findById(input.patientId).exec() : null;
    if (!patient) throw new NotFoundException('Patient not found');
    const existing = input.followUpId !== undefined ? await this.existingRow(patient, input.followUpId) : null;
    if (existing && !note) note = existing.note ?? '';
    const doctor = await this.chooseDoctor(patient, input);

    const today = isoDate(clinicNow());
    const dayN = addDays(today, inDays);
    const lastDay = addDays(dayN, WINDOW_DAYS);
    const doctorId = String(doctor._id);
    const candidates = (await this.doctors.freeSlots(doctorId, parseIsoDay(dayN), 120)).filter((s) => s.date >= dayN && s.date <= lastDay);

    for (const slot of candidates) {
      let apt;
      try {
        apt = await this.appointments.book(actor, { patientId: String(patient._id), doctorId, date: slot.date, time: slot.time, type: 'Follow-up', condition: note });
      } catch (e) {
        // Taken a moment ago, or the patient already has something about then: try the next one.
        if (e instanceof ConflictException) continue;
        throw e;
      }
      let item: { _id: unknown };
      if (existing) {
        // The row keeps its type and note; it only gains the time, the doctor and the appointment.
        const res = await this.followUps
          .updateOne(
            { _id: existing._id, appointmentId: { $exists: false } },
            { $set: { status: 'Scheduled', followUpDate: displayDate(parseIsoDay(slot.date)), followUpTime: slot.time, assignedTo: doctor.name, appointmentId: apt._id } },
          )
          .exec();
        if (!res.modifiedCount) {
          await this.appointments.cancel(actor, String(apt._id), 'This follow-up was booked a moment ago');
          throw new ConflictException('This follow-up has just been booked.');
        }
        item = existing;
        await this.waitlist.settleForFollowUp(String(existing._id));
      } else {
        item = await this.followUps.create({
          uhid: patient.uhid,
          patientName: patient.name,
          age: patient.age,
          gender: patient.gender,
          avatar: patient.avatar ?? '',
          followUpDate: displayDate(parseIsoDay(slot.date)),
          followUpTime: slot.time,
          followUpType: 'Follow-up',
          status: 'Scheduled',
          assignedTo: doctor.name,
          note,
          appointmentId: apt._id,
        });
      }
      await this.announce(patient, String(apt._id), slot.date, slot.time, doctor.name);
      return { followUpId: String(item._id), status: 'booked', appointmentId: String(apt._id), date: slot.date, time: slot.time };
    }

    const item =
      existing ??
      (await this.followUps.create({
        uhid: patient.uhid,
        patientName: patient.name,
        age: patient.age,
        gender: patient.gender,
        avatar: patient.avatar ?? '',
        followUpDate: displayDate(parseIsoDay(dayN)),
        followUpTime: '',
        followUpType: 'Follow-up',
        status: 'Pending',
        assignedTo: doctor.name,
        note,
      }));
    const wait = await this.waitlist.add({ kind: 'appointment', refId: String(item._id), reason: 'no-slot', priority: 'routine', doctorId, dueDay: dayN });
    return { followUpId: String(item._id), status: 'waitlisted', waitItemId: wait.id };
  }

  /** The follow-up row to book into: it must be the patient's, not completed, and not booked already. */
  private async existingRow(patient: PatientDocument, id: unknown): Promise<FollowUpDocument> {
    const row = typeof id === 'string' && isValidObjectId(id) ? await this.followUps.findById(id).exec() : null;
    if (!row) throw new NotFoundException('Follow-up not found');
    if (row.uhid !== patient.uhid) throw new BadRequestException("That follow-up belongs to another patient.");
    if (row.status === 'Completed') throw new ConflictException('That follow-up is already completed.');
    if (row.appointmentId) throw new ConflictException('That follow-up already has an appointment.');
    return row;
  }

  /** The named doctor; else the first active OP doctor of the department (by name); else the patient's usual doctor. */
  private async chooseDoctor(patient: PatientDocument, input: FollowUpOrder): Promise<OpDoctorDocument> {
    if (input.doctorId) {
      const d = await this.opd.getDoctor(input.doctorId);
      if (!d.active) throw new BadRequestException('That doctor is not taking appointments.');
      return d;
    }
    if (input.departmentCode) {
      const list = (await this.opd.listDoctors({ activeOnly: true })).filter((d) => d.departmentCode === input.departmentCode);
      list.sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) throw new BadRequestException('No active doctor in that department.');
      return list[0];
    }
    return this.doctors.doctorForPatient(patient);
  }

  /** Goes to the patient's open case if there is one. A follow-up never opens a case. */
  private async announce(patient: PatientDocument, appointmentId: string, date: string, time: string, doctor: string) {
    try {
      const open = await this.cases.findOne({ patient: patient._id, state: 'open' }).lean().exec();
      if (!open) return;
      await this.messages.send({
        case: String(open._id),
        from: 'scheduling',
        to: ['coordinator'],
        type: 'scheduling.followup-booked',
        priority: 'low',
        summary: `Follow-up booked for ${displayDate(parseIsoDay(date))}, ${time}`,
        payload: { appointmentId, date, time, doctor },
        dedupeKey: `scheduling.followup-booked:${appointmentId}`,
      });
    } catch (e) {
      this.log.error(`Sending followup-booked failed: ${(e as Error).message}`);
    }
  }
}
