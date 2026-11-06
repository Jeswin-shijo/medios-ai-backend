import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, displayDate, displayDateTime, displayTime, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Admission, AdmissionDocument, BedTransfer } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { Ward, WardDocument } from '../beds/schemas/ward.schema';
import { CasesService } from '../coordinator/cases.service';
import { DocumentsService } from '../documents/documents.service';
import { FollowUpDocument, FollowUpItem } from '../follow-ups/schemas/follow-up.schema';
import { testByKey } from '../lab/lab-catalogue';
import { LabLine, LabLineDocument, LabLineStatus, LabResultRow } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { ROUTE_LABEL, Route, medicineByKey } from '../pharmacy/pharmacy-catalogue';
import { PharmacyLine, PharmacyLineDocument, PharmacyLineStatus } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
import { procedureByKey } from '../scheduling/scheduling-catalogue';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { CourseFacts, DischargeAiService, TestFlag } from './discharge-ai';
import { DischargeKind, KIND_LABEL, SUMMARY_SECTIONS, SUMMARY_TITLE, SummarySection } from './discharge-catalogue';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeOrder, DischargeOrderDocument, OPEN_ORDER_STATES, OrderState, takeHomeOrderIds } from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';
import { CourseSource, DischargeSummary, DischargeSummaryDocument, SummaryCourse } from './schemas/discharge-summary.schema';

/** DIS_ORDER: who edits, signs and re-signs a summary. */
const ORDER_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.DOCTOR];
const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;
/** The longest text one section (or the course paragraph) may hold. */
const SECTION_MAX = 5000;
const SIGNED = 'discharge.summary-signed';
const ALREADY_SIGNED = 'The summary is signed. Use Edit and re-sign to change it.';
const SIGNED_ONCE = 'The summary is already signed.';
const NOT_SIGNED = 'The summary is not signed.';
const NOT_DRAFTED = 'The summary is not drafted yet.';
const CHANGED = 'The summary just changed. Review it and sign again.';
const STAFF_COURSE = 'The course paragraph was written by hand: change it in the editor.';
const AGAINST_ADVICE = 'Leaving against medical advice: the risks were explained.';
/** Take-home lines the patient does not leave with. */
const NOT_TAKEN: readonly PharmacyLineStatus[] = ['cancelled', 'stopped', 'rejected'];
/** A ward or ER medicine that reached the patient (a stopped line was issued first). */
const GIVEN: readonly PharmacyLineStatus[] = ['issued', 'stopped'];
/** A Lab test with nothing more to come. */
const LAB_ENDED: readonly LabLineStatus[] = ['released', 'cancelled'];
const FLAG_RANK: Record<TestFlag, number> = { critical: 0, abnormal: 1, normal: 2 };
const CONDITION_LABEL: Record<string, string> = { improved: 'Improved', stable: 'Stable', unchanged: 'Unchanged', deteriorated: 'Deteriorated' };
const FREQUENCY_WORDS: Record<string, string> = {
  OD: 'once a day', BD: 'twice a day', TDS: 'three times a day', QID: 'four times a day', HS: 'at bedtime', SOS: 'when needed', STAT: 'once',
};
/** The details line for the day the stay ends. */
const LEAVING_LABEL: Record<DischargeKind, string> = {
  home: 'Date of discharge', transfer: 'Date of transfer', 'against-advice': 'Date of leaving', died: 'Date of death',
};

/** The heading of each section, for the plain text, the print and the editor. */
export const SUMMARY_SECTION_LABEL: Record<SummarySection, string> = {
  details: 'Patient details',
  reason: 'Reason for admission',
  diagnosis: 'Final diagnosis',
  course: 'Course in hospital',
  procedures: 'Procedures done',
  results: 'Key results',
  condition: 'Condition at discharge',
  medicines: 'Medicines at discharge',
  followUp: 'Follow-up',
  warningSigns: 'Warning signs',
  receivingHospital: 'Receiving hospital',
  transferReason: 'Reason for transfer',
  timeOfDeath: 'Time of death',
  causeOfDeath: 'Cause of death',
};

/** One row of "Summaries to sign". Staff screens may show the patient's name. */
export interface SummaryRow {
  summaryId: string;
  orderId: string;
  planId: string;
  kind: DischargeKind;
  /** Discharge summary, transfer letter, against-advice note or death summary. */
  title: string;
  patient: { id: string; name: string; uhid: string };
  bedLabel: string;
  wardName: string;
  /** The admission's doctor, as its text. */
  doctor: string;
  /** Who gave the discharge order. */
  orderedBy: string;
  /** When the summary was first drafted: clinic clock, ISO. */
  draftedAt: string;
  /** Signed before, and unlocked for Edit and re-sign. */
  reopened: boolean;
  courseSource: CourseSource;
}

/**
 * The summary's plain text: each section that has text, under its heading, in the kind's order, the course paragraph
 * among them; then who signed and when. It is the signed Documents record's description.
 */
export function summaryText(
  kind: DischargeKind,
  sections: Record<string, string> | undefined,
  course: { text?: string } | undefined,
  signed?: { name: string; at: Date },
): string {
  const parts: string[] = [];
  for (const key of SUMMARY_SECTIONS(kind)) {
    const text = (key === 'course' ? course?.text : sections?.[key])?.trim();
    if (text) parts.push(`${SUMMARY_SECTION_LABEL[key]}\n${text}`);
  }
  if (signed) parts.push(`Signed by ${signed.name} on ${displayDateTime(signed.at)}`);
  return parts.join('\n\n');
}

type Id = Types.ObjectId;
type LeanOrder = DischargeOrder & { _id: Id };
type LeanSummary = DischargeSummary & { _id: Id; createdAt?: Date; updatedAt?: Date };
type LeanPlan = Pick<DischargePlan, 'patient' | 'patientName' | 'patientUhid' | 'bedLabel' | 'wardName' | 'doctor'> & { _id: Id; case?: Id };
type LeanAdmission = Pick<Admission, 'admittedAt' | 'doctor' | 'department' | 'notes' | 'bed'> & { _id: Id; transfers?: BedTransfer[] };
type LeanLabLine = { request: Id; test: string; status: LabLineStatus; results?: LabResultRow[]; releasedAt?: Date };
type MedicineLine = Pick<PharmacyLine, 'medicine' | 'freeName' | 'dose' | 'doseText' | 'unit' | 'route' | 'frequency' | 'durationDays'>;

/** A released test as the summary shows it. */
interface TestResult {
  name: string;
  /** From the Lab catalogue, so its name may go to the AI. */
  catalogued: boolean;
  flag: TestFlag;
  rows: LabResultRow[];
  releasedAt?: Date;
}

/** Everything a summary is drafted from, read once from the owners' records. */
interface StayRecord {
  order: LeanOrder;
  plan: LeanPlan | null;
  admission: LeanAdmission | null;
  patient: { name?: string; uhid?: string; age?: number; gender?: string } | null;
  warningSigns: string;
  /** The wards in the order the patient stayed in them. */
  wards: { type: string; ms: number }[];
  stayMs: number;
  /** Done on the stay's case, oldest first. */
  procedures: { name: string; catalogued: boolean; doneAt?: Date }[];
  /** Released on the stay's case: critical first, then abnormal, then normal. */
  tests: TestResult[];
  /** R34: the tests of the requests put off as "follow up later" that are still to come. */
  toCome: string[];
  /** The take-home lines the patient leaves with. */
  medicines: MedicineLine[];
  /** How many different medicines were given on the ward or in the ER. */
  given: number;
  followUp: { status: string; followUpDate?: string; followUpTime?: string; assignedTo?: string } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const by = (actor: Actor) => ({ id: actor.id, name: actor.name });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const time = (d?: Date) => (d ? new Date(d).getTime() : 0);
const isDuplicate = (e: unknown) => (e as { code?: number })?.code === DUPLICATE_KEY;

const stateRefusal = (state: OrderState | undefined): string =>
  state === 'cancelled' ? 'This discharge order was cancelled.' : state === 'left' ? 'The patient has already left.' : 'Discharge order not found';

/** A section's text from staff: trimmed, at most SECTION_MAX characters, or 400. */
function sectionText(v: unknown, key: string): string {
  if (typeof v !== 'string') throw new BadRequestException(`"${key}" must be text.`);
  const t = v.trim();
  if (t.length > SECTION_MAX) throw new BadRequestException(`"${key}" is at most ${SECTION_MAX} characters.`);
  return t;
}

/** The worst flag of a test's results, as the Lab Agent flags a release: critical, abnormal, else normal. */
const flagOf = (rows: LabResultRow[] = []): TestFlag =>
  rows.some((r) => r.critical) ? 'critical' : rows.some((r) => r.flag !== 'normal') ? 'abnormal' : 'normal';

/** "Haemoglobin 10.2 g/dL (low)"; the parameter's name is left out when it is the test's own. */
function resultRow(row: LabResultRow, named: boolean): string {
  const marks = [row.flag !== 'normal' ? row.flag : null, row.critical ? 'critical' : null].filter(Boolean);
  const value = `${row.value}${row.unit ? ` ${row.unit}` : ''}`;
  return `${named ? `${row.param} ` : ''}${value}${marks.length ? ` (${marks.join(', ')})` : ''}${row.comment ? `, ${row.comment}` : ''}`;
}

/** "Troponin I (critical), 24 Sep 2026: 0.9 ng/mL (high, critical)". */
function testLine(t: TestResult): string {
  const single = t.rows.length === 1 && t.rows[0].param === t.name;
  const when = t.releasedAt ? `, ${displayDate(new Date(t.releasedAt))}` : '';
  return `${t.name}${t.flag === 'normal' ? '' : ` (${t.flag})`}${when}: ${t.rows.map((r) => resultRow(r, !single)).join('; ')}`;
}

/** "Pantoprazole 40 mg, oral, once a day (OD), for 7 days". */
function medicineLine(l: MedicineLine): string {
  const name = l.medicine ? (medicineByKey(l.medicine)?.name ?? l.medicine) : (l.freeName ?? 'Unlisted medicine');
  const dose = l.dose !== null && l.dose !== undefined ? `${l.dose}${l.unit ? ` ${l.unit}` : ''}` : (l.doseText ?? '');
  const route = l.route ? (ROUTE_LABEL[l.route as Route] ?? l.route).toLowerCase() : '';
  const words = l.frequency ? FREQUENCY_WORDS[l.frequency] : undefined;
  const often = l.frequency ? (words ? `${words} (${l.frequency})` : l.frequency) : '';
  const forDays = l.durationDays ? `for ${plural(l.durationDays, 'day')}` : '';
  return [[name, dose].filter(Boolean).join(' '), route, often, forDays].filter(Boolean).join(', ');
}

/** "03 Oct 2026" for the follow-up order's ISO day; any other text as it is. */
const dayText = (day?: string): string | undefined => (day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? displayDate(parseIsoDay(day)) : day);

/**
 * The discharge summary (design 4.4): the discharge summary, transfer letter, against-advice note or death summary of
 * an order. The rules draft every section from the owners' records (Beds, Lab, Pharmacy, Scheduling, the patient and
 * the order); the AI writes only the "Course in hospital" paragraph, from coded facts (`CourseFacts`), and the
 * doctor's note for the summary (never sent to the AI) follows it. A doctor or an admin edits and signs it: signing
 * locks it, saves a Signed Documents record and a Timeline line, and tells the Coordinator, which stops the summary
 * clock. Edit and re-sign keeps the signed version and archives its document. Times are on the clinic clock.
 */
@Injectable()
export class DischargeSummaryService {
  private readonly logger = new Logger(DischargeSummaryService.name);

  /** The clinic clock (R7); a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly registration: DischargeRegistration,
    /** The checklist: the summary line follows the signature (it never depends on this service). */
    private readonly lines: DischargeLinesService,
    private readonly settings: DischargeSettingsService,
    private readonly cases: CasesService,
    private readonly ai: DischargeAiService,
    private readonly documents: DocumentsService,
    private readonly timeline: TimelineService,
    @InjectModel(DischargeSummary.name) private readonly summaries: Model<DischargeSummaryDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    /** Read only, each: the records the summary is drafted from. */
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
    @InjectModel(Ward.name) private readonly wards: Model<WardDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(LabRequest.name) private readonly labRequests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly labLines: Model<LabLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly pharmacyOrders: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    @InjectModel(ProcedureBooking.name) private readonly procedures: Model<ProcedureBookingDocument>,
  ) {}

  /**
   * The order's summary, drafted from the record the first time (the rules' sections and the AI's course paragraph).
   * Safe to call again at any time: while the order is open and the summary has never been signed, the sections
   * nobody edited follow the record again (a released result, a cancelled medicine, a booked follow-up); the course
   * paragraph and every edited section stay as they are, and a signed or re-opened summary is never touched. 404 for
   * an unknown order; 409 for an order no longer open that has no summary.
   */
  async draft(orderId: string): Promise<DischargeSummaryDocument> {
    const order = await this.orderOf(orderId);
    const existing = await this.summaries.findOne({ order: order._id }).lean<LeanSummary>().exec();
    if (existing) {
      await this.refreshDraft(existing, order);
      return this.reread(existing._id);
    }
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    const record = await this.record(order);
    const course = await this.courseOf(record);
    try {
      return await this.summaries.create({
        order: order._id, kind: order.kind, sections: this.sections(record), course, edited: [], draftedAt: this.clock(), versions: [],
      });
    } catch (e) {
      // Two drafts at once (the order and the summary view): the first one stands.
      if (isDuplicate(e)) {
        const first = await this.summaries.findOne({ order: order._id }).exec();
        if (first) return first;
      }
      throw e;
    }
  }

  /**
   * A doctor or an admin saves their edits: any of the kind's sections (not the course, which is its own field), as
   * text of at most 5000 characters. A section whose text changed is marked edited, so drafting again never
   * overwrites it; an edited course becomes the staff's (`source: 'staff'`). Refused once signed (409): Edit and
   * re-sign first. 403 for other roles; 400 for an unknown section; 404/409 for an unknown or closed order.
   */
  async save(actor: Actor, orderId: string, sections: Record<string, string>, course?: string): Promise<DischargeSummaryDocument> {
    this.mayEdit(actor);
    const order = await this.openOrder(orderId);
    if (!isObj(sections)) throw new BadRequestException('Send the sections to save.');
    const allowed = SUMMARY_SECTIONS(order.kind).filter((k) => k !== 'course') as string[];
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(sections)) {
      if (key === 'course') throw new BadRequestException('Send the course paragraph as "course", not as a section.');
      if (!allowed.includes(key)) throw new BadRequestException(`"${key}" is not a section of the ${SUMMARY_TITLE[order.kind].toLowerCase()}.`);
      next[key] = sectionText(value, key);
    }
    const courseText = course === undefined ? undefined : sectionText(course, 'course');
    const current = await this.current(order);
    if (current.signedAt) throw new ConflictException(ALREADY_SIGNED);

    const set: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const [key, text] of Object.entries(next)) {
      if ((current.sections?.[key] ?? '') === text) continue;
      set[`sections.${key}`] = text;
      changed.push(key);
    }
    if (courseText !== undefined && courseText !== (current.course?.text ?? '')) set.course = { text: courseText, source: 'staff' };
    if (!Object.keys(set).length) return this.reread(current._id);
    const update: Record<string, unknown> = { $set: set };
    if (changed.length) update.$addToSet = { edited: { $each: changed } };
    const res = await this.summaries.updateOne({ _id: current._id, signedAt: null }, update).exec();
    if (!res.matchedCount) throw new ConflictException(ALREADY_SIGNED);
    return this.reread(current._id);
  }

  /**
   * A doctor or an admin signs the summary as it is stored (A15): a Signed Documents record of its plain text
   * ("Discharge Summary", the kind's title, dated on the clinic clock as "DD Mon YYYY"), then the lock, which is taken
   * only over the summary as it was read, so an edit that lands meanwhile makes it 409 instead of signing unseen text.
   * Then a Timeline line ("<Title> signed", Admission), `discharge.summary-signed` (stopping the summary clock) and the
   * checklist read again. 409 when already signed; 404 before it is drafted; 403 for other roles.
   */
  async sign(actor: Actor, orderId: string): Promise<DischargeSummaryDocument> {
    this.mayEdit(actor);
    const order = await this.openOrder(orderId);
    const s = await this.summaries.findOne({ order: order._id }).lean<LeanSummary>().exec();
    if (!s) throw new NotFoundException(NOT_DRAFTED);
    if (s.signedAt) throw new ConflictException(SIGNED_ONCE);
    const now = this.clock();
    const [plan, admission, patient] = await Promise.all([this.planOf(order), this.admissionOf(order), this.patientOf(order)]);
    const uhid = patient?.uhid ?? plan?.patientUhid;
    if (!uhid) throw new ConflictException("The patient's record was not found.");
    const department = admission?.department ?? '';

    const doc = await this.documents.create({
      uhid,
      title: SUMMARY_TITLE[s.kind],
      category: 'Discharge Summary',
      description: summaryText(s.kind, s.sections, s.course, { name: actor.name, at: now }),
      status: 'Signed',
      signedBy: actor.name,
      author: actor.name,
      date: displayDate(now),
      signedOn: displayDateTime(now),
      department,
    });
    const documentId = String(doc._id);
    const locked = await this.summaries
      .findOneAndUpdate(
        { _id: s._id, signedAt: null, ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}) },
        { $set: { signedAt: now, signedBy: by(actor), documentId } },
        { new: true },
      )
      .lean<LeanSummary>()
      .exec();
    if (!locked) {
      // Signed or changed by someone else meanwhile: this signature did not happen, so neither does its document.
      await this.archive(documentId);
      const current = await this.summaries.findById(s._id).select('signedAt').lean<{ signedAt?: Date }>().exec();
      throw new ConflictException(current?.signedAt ? SIGNED_ONCE : CHANGED);
    }

    const signing = (locked.versions?.length ?? 0) + 1;
    const bedLabel = plan?.bedLabel ?? null;
    await this.timelineLine(locked, { uhid, department, bedLabel, actor, now, again: signing > 1, diagnosis: locked.sections?.diagnosis ?? order.diagnosis });
    await this.announceSigned(order, String(locked._id), bedLabel, signing);
    await this.refreshLines(order._id);
    return this.reread(locked._id);
  }

  /**
   * Edit and re-sign: a doctor or an admin unlocks a signed summary. The signed version is kept in `versions` (with
   * its document, and who unlocked it and when), its Documents record is archived (never deleted), and the summary is
   * unsigned, so the summary line waits again and the next signing makes a new document and is announced again. From
   * then on the summary is the doctor's own: drafting again no longer changes it. 409 when not signed.
   */
  async unlock(actor: Actor, orderId: string): Promise<DischargeSummaryDocument> {
    this.mayEdit(actor);
    const order = await this.openOrder(orderId);
    const s = await this.summaries.findOne({ order: order._id }).lean<LeanSummary>().exec();
    if (!s) throw new NotFoundException(NOT_DRAFTED);
    if (!s.signedAt || !s.signedBy) throw new ConflictException(NOT_SIGNED);
    const version = {
      sections: s.sections ?? {},
      course: s.course,
      signedBy: s.signedBy,
      signedAt: s.signedAt,
      ...(s.documentId ? { documentId: s.documentId } : {}),
      unlockedBy: by(actor),
      unlockedAt: this.clock(),
    };
    // Only over the signature as it was read: two unlocks at once keep the version once.
    const unlocked = await this.summaries
      .findOneAndUpdate({ _id: s._id, signedAt: s.signedAt }, { $push: { versions: version }, $unset: { signedAt: 1, signedBy: 1, documentId: 1 } }, { new: true })
      .lean<LeanSummary>()
      .exec();
    if (!unlocked) throw new ConflictException(NOT_SIGNED);
    if (s.documentId) await this.archive(s.documentId);
    await this.orders
      .updateOne({ _id: order._id }, { $pull: { announced: SIGNED } })
      .exec()
      .catch((e: Error) => this.logger.warn(`Discharge order ${String(order._id)}: ${SIGNED} not marked as due again (${e.message})`));
    await this.refreshLines(order._id);
    return this.reread(unlocked._id);
  }

  /**
   * The AI writes the course paragraph again from the record (the "Redraft" button), for an unsigned summary whose
   * course staff have not written. With the AI off or its answer refused, it is the rules' paragraph (R13). 409 when
   * signed or written by hand; 403 for other roles.
   */
  async redraftCourse(actor: Actor, orderId: string): Promise<DischargeSummaryDocument> {
    this.mayEdit(actor);
    const order = await this.openOrder(orderId);
    const s = await this.summaries.findOne({ order: order._id }).lean<LeanSummary>().exec();
    if (!s) return this.draft(orderId);
    if (s.signedAt) throw new ConflictException(ALREADY_SIGNED);
    if (s.course?.source === 'staff') throw new ConflictException(STAFF_COURSE);
    const course = await this.courseOf(await this.record(order));
    const res = await this.summaries.updateOne({ _id: s._id, signedAt: null, 'course.source': { $ne: 'staff' } }, { $set: { course } }).exec();
    if (!res.matchedCount) {
      const current = await this.summaries.findById(s._id).select('signedAt').lean<{ signedAt?: Date }>().exec();
      throw new ConflictException(current?.signedAt ? ALREADY_SIGNED : STAFF_COURSE);
    }
    return this.reread(s._id);
  }

  /** "Summaries to sign": the unsigned summaries of orders still in progress, oldest draft first. */
  async toSign(): Promise<SummaryRow[]> {
    const open = await this.orders
      .find({ state: { $in: OPEN_ORDER_STATES } })
      .select('plan orderedBy')
      .lean<{ _id: Id; plan: Id; orderedBy?: { name?: string } }[]>()
      .exec();
    if (!open.length) return [];
    const orderOf = new Map(open.map((o) => [String(o._id), o]));
    const [summaries, plans] = await Promise.all([
      this.summaries
        .find({ order: { $in: open.map((o) => o._id) }, signedAt: null })
        .sort({ draftedAt: 1, _id: 1 })
        .select('order kind course versions draftedAt createdAt')
        .lean<LeanSummary[]>()
        .exec(),
      this.plans
        .find({ _id: { $in: open.map((o) => o.plan) } })
        .select('patient patientName patientUhid bedLabel wardName doctor')
        .lean<LeanPlan[]>()
        .exec(),
    ]);
    const planOf = new Map(plans.map((p) => [String(p._id), p]));
    return summaries.flatMap((s) => {
      const o = orderOf.get(String(s.order));
      const p = o ? planOf.get(String(o.plan)) : undefined;
      if (!o || !p) return [];
      return [
        {
          summaryId: String(s._id),
          orderId: String(o._id),
          planId: String(p._id),
          kind: s.kind,
          title: SUMMARY_TITLE[s.kind],
          patient: { id: String(p.patient), name: p.patientName, uhid: p.patientUhid },
          bedLabel: p.bedLabel,
          wardName: p.wardName,
          doctor: p.doctor ?? '',
          orderedBy: o.orderedBy?.name ?? '',
          draftedAt: new Date(s.draftedAt ?? s.createdAt ?? 0).toISOString(),
          reopened: (s.versions?.length ?? 0) > 0,
          courseSource: s.course?.source,
        },
      ];
    });
  }

  // ---------- drafting ----------

  /** The sections nobody edited follow the record, while the order is open and the summary has never been signed. */
  private async refreshDraft(s: LeanSummary, order: LeanOrder): Promise<void> {
    if (s.signedAt || s.versions?.length || !OPEN_ORDER_STATES.includes(order.state)) return;
    const fresh = this.sections(await this.record(order));
    const edited = new Set(s.edited ?? []);
    const set: Record<string, string> = {};
    for (const [key, text] of Object.entries(fresh)) {
      if (!edited.has(key) && (s.sections?.[key] ?? null) !== text) set[`sections.${key}`] = text;
    }
    const keys = Object.keys(set).map((k) => k.slice('sections.'.length));
    if (!keys.length) return;
    // Only while those sections are still nobody's edit and nothing was signed meanwhile.
    await this.summaries.updateOne({ _id: s._id, signedAt: null, 'versions.0': { $exists: false }, edited: { $nin: keys } }, { $set: set }).exec();
  }

  /** The rules' text of each section of the kind (the course is its own field). */
  private sections(r: StayRecord): Record<string, string> {
    const kinds = SUMMARY_SECTIONS(r.order.kind);
    const out: Record<string, string> = {};
    for (const key of kinds) {
      if (key === 'course') continue;
      out[key] = this.section(key, r, kinds.includes('followUp'));
    }
    return out;
  }

  private section(key: SummarySection, r: StayRecord, hasFollowUp: boolean): string {
    const o = r.order;
    switch (key) {
      case 'details':
        return this.details(r);
      case 'reason':
        return (r.admission?.notes ?? '').trim();
      case 'diagnosis':
        return o.diagnosis ?? '';
      case 'procedures':
        return r.procedures.length ? r.procedures.map((p) => (p.doneAt ? `${p.name} (${displayDate(new Date(p.doneAt))})` : p.name)).join('\n') : 'None';
      case 'results': {
        const lines = r.tests.map(testLine);
        // R34: with no follow-up section (a transfer letter), results still to come are named here.
        if (!hasFollowUp && r.toCome.length) lines.push(`Results still to come: ${r.toCome.join(', ')}`);
        return lines.length ? lines.join('\n') : 'None';
      }
      case 'condition': {
        const c = o.condition ? (CONDITION_LABEL[o.condition] ?? o.condition) : '';
        if (o.kind !== 'against-advice') return c;
        return c ? `${c}. ${AGAINST_ADVICE}` : AGAINST_ADVICE;
      }
      case 'medicines':
        return r.medicines.length ? r.medicines.map(medicineLine).join('\n') : 'None';
      case 'followUp': {
        const text = this.followUpText(r);
        // R34: the results put off as "follow up later" that are still to come.
        return r.toCome.length ? `${text}\nResults to review at follow-up: ${r.toCome.join(', ')}` : text;
      }
      case 'warningSigns':
        return r.warningSigns;
      case 'receivingHospital':
        return o.receivingHospital ?? '';
      case 'transferReason':
        return o.transferReason ?? '';
      case 'timeOfDeath':
        return o.timeOfDeath ? displayDateTime(new Date(o.timeOfDeath)) : '';
      case 'causeOfDeath':
        return o.causeOfDeath ?? '';
      default:
        return '';
    }
  }

  /** Name, UHID, age and sex, the admission and leaving dates, the ward and bed, the consultant and the department. */
  private details(r: StayRecord): string {
    const o = r.order;
    const age = r.patient?.age;
    const ageSex = [age !== undefined && age !== null ? `${age} years` : null, r.patient?.gender || null].filter(Boolean).join(', ');
    const leaving = o.kind === 'died' && o.timeOfDeath ? o.timeOfDeath : o.plannedLeaveAt;
    const lines: [string, string | null | undefined][] = [
      ['Name', r.patient?.name ?? r.plan?.patientName],
      ['UHID', r.patient?.uhid ?? r.plan?.patientUhid],
      ['Age and sex', ageSex],
      ['Date of admission', r.admission ? displayDate(new Date(r.admission.admittedAt)) : null],
      [LEAVING_LABEL[o.kind], leaving ? displayDate(new Date(leaving)) : null],
      ['Ward and bed', [r.plan?.wardName, r.plan?.bedLabel].filter(Boolean).join(', ')],
      ['Consultant', r.admission?.doctor || r.plan?.doctor],
      ['Department', r.admission?.department],
    ];
    return lines
      .filter(([, v]) => v)
      .map(([label, v]) => `${label}: ${v}`)
      .join('\n');
  }

  /** The booked day, time and doctor; or the waitlist; or none needed (or none booked, on an optional line). */
  private followUpText(r: StayRecord): string {
    const o = r.order;
    if (o.noFollowUp) return 'None needed';
    if (!o.followUp) return 'None booked';
    const item = r.followUp;
    const waitlisted = item ? item.status === 'Pending' : o.followUp.status === 'waitlisted';
    if (waitlisted) return 'On the waitlist: the desk will call with a time';
    const date = item?.followUpDate || dayText(o.followUp.date);
    const at = item?.followUpTime || o.followUp.time;
    const text = [date, at ? `at ${at}` : null, item?.assignedTo ? `with ${item.assignedTo}` : null].filter(Boolean).join(' ') || 'Booked';
    return item && item.status !== 'Scheduled' ? `${text} (${item.status.toLowerCase()})` : text;
  }

  /** The coded facts the AI is given: no name, UHID, id, date or typed text. Only catalogue names go out. */
  private facts(r: StayRecord): CourseFacts {
    const tests = new Map<string, TestFlag>();
    // Worst first: the first time a test's name comes is its worst flag.
    for (const t of r.tests) if (t.catalogued && !tests.has(t.name)) tests.set(t.name, t.flag);
    return {
      kind: r.order.kind,
      wards: r.wards.map((w) => ({ type: w.type, days: Math.round(w.ms / DAY_MS) })),
      procedures: [...new Set(r.procedures.filter((p) => p.catalogued).map((p) => p.name))],
      tests: [...tests].map(([name, flag]) => ({ name, flag })),
      medicineCount: r.given,
      condition: r.order.kind === 'died' ? null : (r.order.condition ?? null),
      stayDays: Math.round(r.stayMs / DAY_MS),
    };
  }

  /**
   * The course paragraph: the AI's (or its sample, or the rules' when it is off or refused, R13), then the doctor's
   * note for the summary, which never goes to the AI.
   */
  private async courseOf(r: StayRecord): Promise<SummaryCourse> {
    const res = await this.ai.course(this.facts(r));
    const source: CourseSource = res.source === 'ai' ? (res.sample ? 'ai-sample' : 'ai') : 'rules';
    const note = (r.order.note ?? '').trim();
    return { text: note ? `${res.text}\n\n${note}` : res.text, source };
  }

  /** Reads everything the summary is drafted from. Case-linked records use the order's case, else the plan's, else the patient's (R24). */
  private async record(order: LeanOrder): Promise<StayRecord> {
    const [plan, admission, patient, config] = await Promise.all([this.planOf(order), this.admissionOf(order), this.patientOf(order), this.settings.get()]);
    const caseId = await this.caseOf(order, plan);
    const end = order.kind === 'died' && order.timeOfDeath ? new Date(order.timeOfDeath) : new Date(order.plannedLeaveAt);
    const [stay, procedures, lab, medicines, given, followUp] = await Promise.all([
      this.wardStays(admission, end),
      this.doneProcedures(caseId),
      this.labResults(caseId, order),
      this.takeHomeLines(order),
      this.givenCount(caseId),
      this.followUpItem(order),
    ]);
    return {
      order, plan, admission, patient, warningSigns: config.warningSigns, wards: stay.wards, stayMs: stay.ms, procedures,
      tests: lab.tests, toCome: lab.toCome, medicines, given, followUp,
    };
  }

  /** The stay's wards in order, from the admission and its moves between beds, to the planned leaving (or the death). */
  private async wardStays(admission: LeanAdmission | null, end: Date): Promise<{ wards: { type: string; ms: number }[]; ms: number }> {
    if (!admission) return { wards: [], ms: 0 };
    const start = time(admission.admittedAt);
    const stop = Math.max(start, end.getTime());
    const moves = [...(admission.transfers ?? [])].sort((a, b) => time(a.at) - time(b.at));
    const spans: { bed: string; ms: number }[] = [];
    let bed = String(moves.length ? moves[0].fromBed : admission.bed);
    let from = start;
    for (const t of moves) {
      const at = Math.min(Math.max(time(t.at), from), stop);
      spans.push({ bed, ms: at - from });
      bed = String(t.toBed);
      from = at;
    }
    spans.push({ bed, ms: stop - from });
    const bedIds = [...new Set(spans.map((s) => s.bed))].filter((i) => isValidObjectId(i));
    const beds = bedIds.length ? await this.beds.find({ _id: { $in: bedIds } }).select('ward').lean<{ _id: Id; ward: Id }[]>().exec() : [];
    const wardOf = new Map(beds.map((b) => [String(b._id), String(b.ward)]));
    const wardIds = [...new Set(wardOf.values())];
    const wards = wardIds.length ? await this.wards.find({ _id: { $in: wardIds } }).select('type').lean<{ _id: Id; type: string }[]>().exec() : [];
    const typeOf = new Map(wards.map((w) => [String(w._id), w.type]));
    const out: { type: string; ms: number }[] = [];
    for (const s of spans) {
      const type = typeOf.get(wardOf.get(s.bed) ?? '');
      // A move recorded at the same moment, or a bed or ward no longer on record, says nothing about the stay.
      if (!type || s.ms <= 0) continue;
      const last = out[out.length - 1];
      if (last?.type === type) last.ms += s.ms;
      else out.push({ type, ms: s.ms });
    }
    return { wards: out, ms: stop - start };
  }

  /** Procedures done on the stay's case, oldest first, by name. */
  private async doneProcedures(caseId: string | null): Promise<StayRecord['procedures']> {
    if (!caseId) return [];
    const done = await this.procedures
      .find({ case: new Types.ObjectId(caseId), status: 'done' })
      .sort({ doneAt: 1, _id: 1 })
      .select('procedure doneAt')
      .lean<{ procedure: string; doneAt?: Date }[]>()
      .exec();
    return done.map((p) => {
      const def = procedureByKey(p.procedure);
      return { name: def?.name ?? p.procedure, catalogued: !!def, doneAt: p.doneAt };
    });
  }

  /** Released tests on the stay's case (critical, then abnormal, then normal), and the ones put off still to come. */
  private async labResults(caseId: string | null, order: LeanOrder): Promise<{ tests: TestResult[]; toCome: string[] }> {
    if (!caseId) return { tests: [], toCome: [] };
    const requests = await this.labRequests.find({ case: new Types.ObjectId(caseId) }).select('_id').lean<{ _id: Id }[]>().exec();
    if (!requests.length) return { tests: [], toCome: [] };
    const lines = await this.labLines
      .find({ request: { $in: requests.map((q) => q._id) } })
      .sort({ _id: 1 })
      .select('request test status results releasedAt')
      .lean<LeanLabLine[]>()
      .exec();
    const label = (test: string) => testByKey(test)?.label ?? test;
    const tests = lines
      .filter((l) => l.status === 'released')
      .map((l) => ({ name: label(l.test), catalogued: !!testByKey(l.test), flag: flagOf(l.results), rows: l.results ?? [], releasedAt: l.releasedAt }))
      .sort((a, b) => FLAG_RANK[a.flag] - FLAG_RANK[b.flag] || time(a.releasedAt) - time(b.releasedAt));
    const later = new Set((order.followUpLater ?? []).map(String));
    const toCome = [...new Set(lines.filter((l) => later.has(String(l.request)) && !LAB_ENDED.includes(l.status)).map((l) => label(l.test)))];
    return { tests, toCome };
  }

  /** The take-home medicines the patient leaves with: every take-home order's lines, less those cancelled, stopped or rejected. */
  private async takeHomeLines(order: LeanOrder): Promise<MedicineLine[]> {
    const ids = takeHomeOrderIds(order).filter((i) => isValidObjectId(i));
    if (!ids.length) return [];
    return this.pharmacyLines
      .find({ order: { $in: ids.map((i) => new Types.ObjectId(i)) }, status: { $nin: NOT_TAKEN } })
      .sort({ _id: 1 })
      .select('medicine freeName dose doseText unit route frequency durationDays')
      .lean<MedicineLine[]>()
      .exec();
  }

  /** How many different medicines were given on the ward or in the ER on the stay's case (never a take-home or OPD one). */
  private async givenCount(caseId: string | null): Promise<number> {
    if (!caseId) return 0;
    const stayOrders = await this.pharmacyOrders
      .find({ case: new Types.ObjectId(caseId), setting: { $in: ['ER', 'Ward'] }, takeHome: { $ne: true } })
      .select('_id')
      .lean<{ _id: Id }[]>()
      .exec();
    if (!stayOrders.length) return 0;
    const lines = await this.pharmacyLines
      .find({ order: { $in: stayOrders.map((o) => o._id) }, status: { $in: GIVEN } })
      .select('medicine freeName')
      .lean<{ medicine: string | null; freeName?: string }[]>()
      .exec();
    return new Set(lines.map((l) => l.medicine ?? `free:${(l.freeName ?? '').trim().toLowerCase()}`)).size;
  }

  private async followUpItem(order: LeanOrder): Promise<StayRecord['followUp']> {
    const id = order.followUp?.followUpId;
    if (!id || !isValidObjectId(id)) return null;
    return this.followUps.findById(id).select('status followUpDate followUpTime assignedTo').lean<NonNullable<StayRecord['followUp']>>().exec();
  }

  // ---------- signing ----------

  /** The patient's Timeline line: "<Title> signed", under Admission (A9), on the clinic clock. A failure is logged. */
  private async timelineLine(
    s: LeanSummary,
    at: { uhid: string; department: string; bedLabel: string | null; actor: Actor; now: Date; again: boolean; diagnosis: string },
  ): Promise<void> {
    try {
      await this.timeline.create({
        uhid: at.uhid,
        date: displayDate(at.now),
        time: displayTime(at.now),
        category: 'Admission',
        title: `${SUMMARY_TITLE[s.kind]} signed`,
        subtitle: [KIND_LABEL[s.kind], at.bedLabel, at.again ? 'signed again after changes' : null].filter(Boolean).join(' · '),
        doctor: at.actor.name,
        department: at.department,
        status: 'Completed',
        details: { diagnosis: at.diagnosis },
      });
    } catch (e) {
      this.logger.warn(`Summary ${String(s._id)}: Timeline line not written (${(e as Error).message})`);
    }
  }

  /**
   * `discharge.summary-signed` on the order's own case (the summary clock's start and stop carry the same case), under
   * a key of its own for each signing, so a re-sign within the Coordinator's minute is not dropped. Recorded in the
   * order's `announced` once it went; a failed send is left for the one-minute pass.
   */
  private async announceSigned(order: LeanOrder, summaryId: string, bedLabel: string | null, signing: number): Promise<void> {
    const orderId = String(order._id);
    if (!bedLabel) {
      this.logger.warn(`Discharge order ${orderId}: summary signed, but its plan has no bed label: ${SIGNED} not sent`);
      return;
    }
    const sent = await this.registration.send(
      SIGNED,
      order.case ? String(order.case) : null,
      { orderId, summaryId, bedLabel, kind: order.kind },
      `${bedLabel}: Summary signed (${KIND_LABEL[order.kind]})`,
      { dedupeKey: `${SIGNED}:${orderId}:${signing}` },
    );
    if (!sent) return;
    await this.orders
      .updateOne({ _id: order._id }, { $addToSet: { announced: SIGNED } })
      .exec()
      .catch((e: Error) => this.logger.warn(`Discharge order ${orderId}: ${SIGNED} not recorded as sent (${e.message})`));
  }

  /** Archives a document that is no longer the summary's. A failure is logged: the summary's own state matters more. */
  private async archive(documentId: string): Promise<void> {
    try {
      await this.documents.archive(documentId);
    } catch (e) {
      this.logger.warn(`Document ${documentId}: not archived (${(e as Error).message})`);
    }
  }

  /** The checklist read again (the summary line follows the signature, R5). A failure is logged; the minute pass refreshes it. */
  private async refreshLines(orderId: Id): Promise<void> {
    try {
      await this.lines.refresh(String(orderId));
    } catch (e) {
      this.logger.warn(`Discharge order ${String(orderId)}: checklist not refreshed (${(e as Error).message})`);
    }
  }

  // ---------- helpers ----------

  private mayEdit(actor: Actor): void {
    if (!actor || !ORDER_ROLES.includes(actor.role)) throw new ForbiddenException('Only a doctor or an admin can do this.');
  }

  private async orderOf(orderId: string): Promise<LeanOrder> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).lean<LeanOrder>().exec() : null;
    if (!order) throw new NotFoundException('Discharge order not found');
    return order;
  }

  /** An order still in progress, else 404 or 409. */
  private async openOrder(orderId: string): Promise<LeanOrder> {
    const order = await this.orderOf(orderId);
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    return order;
  }

  /** The order's summary, drafted first when there is none yet. */
  private async current(order: LeanOrder): Promise<LeanSummary> {
    const s = await this.summaries.findOne({ order: order._id }).lean<LeanSummary>().exec();
    if (s) return s;
    const drafted = await this.draft(String(order._id));
    return drafted.toObject() as LeanSummary;
  }

  private planOf(order: LeanOrder): Promise<LeanPlan | null> {
    return this.plans.findById(order.plan).select('case patient patientName patientUhid bedLabel wardName doctor').lean<LeanPlan>().exec();
  }

  private admissionOf(order: LeanOrder): Promise<LeanAdmission | null> {
    return this.admissions.findById(order.admission).select('admittedAt doctor department notes bed transfers').lean<LeanAdmission>().exec();
  }

  private patientOf(order: LeanOrder): Promise<StayRecord['patient']> {
    return this.patients.findById(order.patient).select('name uhid age gender').lean<NonNullable<StayRecord['patient']>>().exec();
  }

  /** R24: the order's case, else its plan's, else the patient's open case (or newest); null when there is none. */
  private async caseOf(order: LeanOrder, plan: LeanPlan | null): Promise<string | null> {
    if (order.case) return String(order.case);
    if (plan?.case) return String(plan.case);
    const c = await this.cases.forPatient(String(order.patient));
    return c ? String(c._id) : null;
  }

  private async reread(id: Id): Promise<DischargeSummaryDocument> {
    const s = await this.summaries.findById(id).exec();
    if (!s) throw new NotFoundException('Discharge summary not found');
    return s;
  }
}
