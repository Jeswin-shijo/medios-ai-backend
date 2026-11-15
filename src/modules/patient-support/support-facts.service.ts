import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { clinicNow, displayDate, displayTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { Ward, WardDocument } from '../beds/schemas/ward.schema';
import { toE164India } from '../calls/phone';
import { Case, CaseDocument } from '../coordinator/schemas/case.schema';
import { DischargeOrder, DischargeOrderDocument } from '../discharge/schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from '../discharge/schemas/discharge-plan.schema';
import { ErVisit, ErVisitDocument } from '../er/schemas/er-visit.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { TimelineService } from '../timeline/timeline.service';
import { CARDIAC_PROCEDURES, isCardiacDiagnosis } from './support-catalogue';
import { SUP_READ } from './support-roles';
import { floorText } from './support-time';

export interface SupportContactView {
  patientId: string;
  preferredLanguage: 'en' | 'ta';
  contacts: { id: string; name: string; relation: string; phone: string }[];
  updatesTo: string;
  consent: { messages: boolean; calls: boolean; recordedAt?: Date; recordedByName?: string; via?: string };
  phone: string;
}

export interface SaveContactInput {
  preferredLanguage?: string;
  contacts?: { id?: string; name?: string; relation?: string; phone?: string }[];
  updatesTo?: string;
  /** An index into the submitted `contacts` list, for a contact that has no id yet. */
  updatesToIndex?: number;
  consent?: { messages: boolean; calls: boolean };
  via?: 'desk' | 'ward';
}

/** A mobile number as a person types it: spaces and dashes ignored, optionally +91 or 91 in front. */
const validMobile = (raw: string): boolean => /^(?:\+?91)?[6-9]\d{9}$/.test(raw.replace(/[\s-]/g, ''));
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Who a family update goes to, whether they agreed, and the facts about a patient the agent reads (a death, the care group, the bed). */
@Injectable()
export class SupportFactsService {
  private readonly logger = new Logger(SupportFactsService.name);

  constructor(
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
    @InjectModel(Ward.name) private readonly wards: Model<WardDocument>,
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(ErVisit.name) private readonly erVisits: Model<ErVisitDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    private readonly timelineService: TimelineService
  ) {}

  private async patientOf(patientId: string): Promise<any> {
    const p = isValidObjectId(patientId) ? await this.patients.findById(patientId).lean() : null;
    if (!p) throw new NotFoundException('Patient not found.');
    return p;
  }

  private view(p: any): SupportContactView {
    const c = p.consent;
    return {
      patientId: String(p._id),
      preferredLanguage: p.preferredLanguage ?? 'en',
      contacts: (p.contacts ?? []).map((x: any) => ({ id: String(x._id), name: x.name, relation: x.relation, phone: x.phone })),
      updatesTo: p.updatesTo ?? 'self',
      consent: {
        messages: c?.messages === true,
        calls: c?.calls === true,
        recordedAt: c?.recordedAt,
        recordedByName: c?.recordedByName,
        via: c?.via
      },
      phone: p.phone
    };
  }

  async contactOf(patientId: string): Promise<SupportContactView> {
    return this.view(await this.patientOf(patientId));
  }

  async saveContact(actor: Actor, patientId: string, input: SaveContactInput): Promise<SupportContactView> {
    if (!actor || !SUP_READ.includes(actor.role)) throw new ForbiddenException('Only a doctor, a nurse, the front desk or an admin can do this.');
    const p = await this.patientOf(patientId);
    const before = this.view(p);
    const set: Record<string, unknown> = {};
    const changes: string[] = [];

    if (input.preferredLanguage !== undefined) {
      if (input.preferredLanguage !== 'en' && input.preferredLanguage !== 'ta') throw new BadRequestException('The language must be English or Tamil.');
      if (input.preferredLanguage !== before.preferredLanguage) {
        set.preferredLanguage = input.preferredLanguage;
        changes.push('language');
      }
    }

    let contacts = p.contacts ?? [];
    if (input.contacts !== undefined) {
      if (!Array.isArray(input.contacts)) throw new BadRequestException('Contacts must be a list.');
      if (input.contacts.length > 5) throw new BadRequestException('At most 5 contacts.');
      const known = new Set((p.contacts ?? []).map((x: any) => String(x._id)));
      contacts = input.contacts.map((c) => {
        const name = str(c?.name);
        const relation = str(c?.relation);
        const phone = str(c?.phone);
        if (!name || name.length > 80) throw new BadRequestException('Each contact needs a name (up to 80 letters).');
        if (!relation || relation.length > 40) throw new BadRequestException(`Say how ${name} is related (up to 40 letters).`);
        if (!validMobile(phone)) throw new BadRequestException(`Enter a 10-digit mobile number for ${name}.`);
        if (c.id !== undefined && !known.has(String(c.id))) throw new BadRequestException(`${name} is not one of this patient's contacts.`);
        return { _id: c.id !== undefined ? new Types.ObjectId(String(c.id)) : new Types.ObjectId(), name, relation, phone };
      });
      const same =
        JSON.stringify(contacts.map((c: any) => [String(c._id), c.name, c.relation, c.phone])) ===
        JSON.stringify((p.contacts ?? []).map((c: any) => [String(c._id), c.name, c.relation, c.phone]));
      if (!same) {
        set.contacts = contacts;
        changes.push('contacts');
      }
    }

    if (input.updatesTo !== undefined && input.updatesToIndex !== undefined) throw new BadRequestException('Give updatesTo or updatesToIndex, not both.');
    let updatesTo: string | undefined;
    if (input.updatesToIndex !== undefined) {
      const c = Number.isInteger(input.updatesToIndex) ? (contacts as any[])[input.updatesToIndex] : undefined;
      if (!c) throw new BadRequestException('Updates must go to the patient or to one of the contacts.');
      updatesTo = String(c._id);
    } else if (input.updatesTo !== undefined) {
      if (input.updatesTo !== 'self' && !(contacts as any[]).some((c) => String(c._id) === input.updatesTo))
        throw new BadRequestException('Updates must go to the patient or to one of the contacts.');
      updatesTo = input.updatesTo;
    } else if (before.updatesTo !== 'self' && !(contacts as any[]).some((c) => String(c._id) === before.updatesTo)) {
      updatesTo = 'self'; // the chosen contact was removed
    }
    if (updatesTo !== undefined && updatesTo !== before.updatesTo) {
      set.updatesTo = updatesTo;
      changes.push('who gets updates');
    }

    if (input.consent !== undefined) {
      const messages = input.consent.messages === true;
      const calls = input.consent.calls === true;
      if (messages !== before.consent.messages || calls !== before.consent.calls) {
        set.consent = {
          messages,
          calls,
          recordedAt: clinicNow(),
          recordedBy: actor.id,
          recordedByName: actor.name,
          via: input.via === 'ward' ? 'ward' : 'desk'
        };
        changes.push('consent');
      }
    }

    if (changes.length) {
      await this.patients.updateOne({ _id: p._id }, { $set: set });
      await this.timeline({ patientUhid: p.uhid }, `Contact and consent updated by ${actor.name}`, `Changed: ${changes.join(', ')}.`);
    }
    return this.contactOf(patientId);
  }

  /** Where a family update goes, and who it is for. `to` is E.164, or null when there is no usable number or the contact is gone. */
  recipientOf(patient: PatientDocument): { to: string | null; label: string } {
    const p: any = patient;
    const target = p.updatesTo ?? 'self';
    if (target === 'self') return { to: toE164India(p.phone), label: 'Self' };
    const c = (p.contacts ?? []).find((x: any) => String(x._id) === String(target));
    if (!c) return { to: null, label: 'Contact removed' };
    return { to: toE164India(c.phone), label: `${c.relation} (${c.name})` };
  }

  /** A death is read from three places (A11): the patient, an ER visit, a discharge order or plan. */
  async isDeceased(patientId: string): Promise<boolean> {
    if (!isValidObjectId(patientId)) return false;
    const pid = new Types.ObjectId(patientId);
    if (await this.patients.exists({ _id: pid, status: 'Deceased' })) return true;
    if (await this.erVisits.exists({ patient: pid, 'disposition.kind': 'died' })) return true;
    if (await this.orders.exists({ patient: pid, kind: 'died', state: { $ne: 'cancelled' } })) return true;
    return !!(await this.plans.exists({ patient: pid, completedKind: 'died' }));
  }

  /** The care group: the first match wins. With a case it looks only at that case, else at the patient's records, newest first. */
  async careGroup(patientId: string, caseId: string | null): Promise<'general' | 'cardiac'> {
    const scope = caseId ? { case: new Types.ObjectId(caseId) } : { patient: new Types.ObjectId(patientId) };
    if (await this.bookings.exists({ ...scope, procedure: { $in: CARDIAC_PROCEDURES as readonly string[] }, status: { $ne: 'cancelled' } })) return 'cardiac';
    if (await this.erVisits.exists({ ...scope, pathways: { $elemMatch: { key: 'chest-pain', cancelled: null } } })) return 'cardiac';

    let admission: any = null;
    if (caseId) {
      const c = await this.cases.findById(caseId).lean();
      const id = c?.refs?.admissionId;
      admission = id && isValidObjectId(id) ? await this.admissions.findById(id).lean() : null;
    } else {
      admission = await this.admissions
        .findOne({ patient: new Types.ObjectId(patientId) })
        .sort({ createdAt: -1 })
        .lean();
    }
    if (admission?.department === 'Cardiology') return 'cardiac';

    const orders = await this.orders.find(scope).sort({ createdAt: -1 }).lean();
    if (orders.some((o: any) => isCardiacDiagnosis(String(o.diagnosis ?? '')))) return 'cardiac';
    return 'general';
  }

  async bedFacts(admissionId: string): Promise<{ ward: string; bed: string; floor: string; sample: boolean } | null> {
    if (!isValidObjectId(admissionId)) return null;
    const a: any = await this.admissions.findById(admissionId).lean();
    const bed: any = a?.bed ? await this.beds.findById(a.bed).lean() : null;
    if (!a || !bed) return null;
    const ward: any = await this.wards.findById(bed.ward).lean();
    return { ward: ward?.name ?? '', bed: bed.label, floor: floorText(ward?.floor), sample: a.sample === true };
  }

  /** A line on the patient's Timeline. A failure is logged, never thrown. */
  async timeline(patient: { patientUhid: string }, title: string, subtitle: string): Promise<void> {
    try {
      const now = clinicNow();
      await this.timelineService.create({
        uhid: patient.patientUhid,
        date: displayDate(now),
        time: displayTime(now),
        category: 'Communication',
        title,
        subtitle,
        status: 'Completed'
      });
    } catch (e) {
      this.logger.warn(`Timeline line not written: ${(e as Error).message}`);
    }
  }
}
