import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId, mongo } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { MessagesService } from '../coordinator/messages.service';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { PatientsService } from '../patients/patients.service';
import { PatientCardsService } from '../queue/patient-cards.service';
import { BED_PRIORITY, COLOUR_RANK, COMPLAINTS, PATHWAYS, ComplaintKey, PathwayKey, StepKey, TriageColour } from './er-rules';
import { ErBaysService } from './er-bays.service';
import { ErExpected, ErExpectedDocument } from './schemas/er-expected.schema';
import { ER_DISPOSITIONS, ER_MODES, ErDispositionKind, ErMode, ErStatus, ErVisit, ErVisitDocument, OPEN_ER_STATUSES } from './schemas/er-visit.schema';

const DUPLICATE_KEY = 11000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const GENDERS = ['Male', 'Female', 'Other'] as const;
type Gender = (typeof GENDERS)[number];
const PLACEHOLDER_WORD: Record<Gender, string> = { Male: 'male', Female: 'female', Other: 'person' };

export interface ArriveInput {
  patientId?: string;
  uhid?: string;
  cardId?: string;
  emergency?: { gender: Gender; approxAge: number; description: string };
  mode: ErMode;
  complaint: ComplaintKey;
  complaintText?: string;
  expectedId?: string;
}

export interface AddExpectedInput {
  complaint: string;
  ageSex: string;
  mode: ErMode;
  etaMinutes: number;
  phone?: string;
  patientId?: string;
}

export interface ErVisitView {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  mode: ErMode;
  complaint: ComplaintKey;
  complaintText: string;
  arrivedAt: string;
  /** The confirmed triage colour, or null while untriaged. */
  colour: TriageColour | null;
  triage: {
    suggested: string;
    reasons: string[];
    colour: string;
    byName: string;
    at: string;
    changeReason?: string;
    history: { colour: string; byName: string; at: string; reason?: string; kind: 'triage' | 'retriage' }[];
  } | null;
  vitalsId: string | null;
  vitals: { spo2?: number; bpSystolic?: number; bpDiastolic?: number; heartRate?: number; respiratoryRate?: number; temperature?: number } | null;
  painScore: number | null;
  bayId: string | null;
  bayName: string | null;
  status: ErStatus;
  pathways: { key: PathwayKey; startedBy: 'rules' | 'staff'; startedByName?: string; cancelled: { byName: string; reason: string; at: string } | null }[];
  steps: { key: StepKey; doneAt: string | null; byName: string | null }[];
  doctorSeenAt: string | null;
  disposition: { kind: ErDispositionKind; byName: string; at: string; notes: string } | null;
  leftAt: string | null;
  leftReason: string | null;
  handoverNote: string | null;
  caseId: string;
  createdAt: string;
  /** Read from the visit's Patient. Never a phone or address. */
  patientAge: number | null;
  patientGender: string | null;
  /** True while the Patient record is a placeholder; looked up, so it clears when staff fill the details in. */
  detailsPending: boolean;
  /** The case's er-* Coordinator clocks that still need action: running, or expired and not yet stopped. Empty once the visit has left. */
  clocks: ErClockView[];
  /** Any listed clock has expired, or is running past its due time. */
  overdue: boolean;
}

export interface ErClockView {
  key: string;
  label: string;
  state: 'running' | 'expired';
  dueAt: string;
}

export interface ErVisitExtras {
  patientAge: number | null;
  patientGender: string | null;
  detailsPending: boolean;
  clocks: ErClockView[];
  overdue: boolean;
}

const NO_EXTRAS: ErVisitExtras = { patientAge: null, patientGender: null, detailsPending: false, clocks: [], overdue: false };

/** What the page shows for a Coordinator clock key. Mirrors the labels the ER agent registers. */
export function clockLabel(key: string): string {
  if (key === 'er-triage') return 'Triage';
  if (key === 'er-doctor') return 'Doctor review';
  const step = key.replace(/^er-step-/, '');
  for (const p of Object.values(PATHWAYS)) {
    const found = p.steps.find((x) => x.key === step);
    if (found) return found.label;
  }
  return key;
}

export interface ErExpectedView {
  id: string;
  complaint: string;
  ageSex: string;
  mode: ErMode;
  etaMinutes: number;
  expectedAt: string;
  phone: string | null;
  patientId: string | null;
  state: 'waiting' | 'arrived' | 'expired';
}

const VITAL_KEYS = ['spo2', 'bpSystolic', 'bpDiastolic', 'heartRate', 'respiratoryRate', 'temperature'] as const;
/** Named keys only: a Mongoose subdocument has other fields too. */
const pickVitals = (v: any) => Object.fromEntries(VITAL_KEYS.filter((k) => typeof v[k] === 'number').map((k) => [k, v[k]]));

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

/** The plain mapping; `extras` come from `ErVisitsService.toViews`, which looks up the patient and the clocks. */
export function toVisitView(v: any, extras: ErVisitExtras = NO_EXTRAS): ErVisitView {
  return {
    id: String(v._id),
    number: v.number,
    patientId: String(v.patient),
    patientUhid: v.patientUhid,
    patientName: v.patientName,
    mode: v.mode,
    complaint: v.complaint,
    complaintText: v.complaintText ?? '',
    arrivedAt: iso(v.arrivedAt)!,
    colour: (v.triage?.colour as TriageColour) ?? null,
    triage: v.triage
      ? { suggested: v.triage.suggested, reasons: v.triage.reasons ?? [], colour: v.triage.colour, byName: v.triage.byName, at: iso(v.triage.at)!, ...(v.triage.changeReason ? { changeReason: v.triage.changeReason } : {}),
          history: (v.triage.history ?? []).map((h: any) => ({ colour: h.colour, byName: h.byName, at: iso(h.at)!, ...(h.reason ? { reason: h.reason } : {}), kind: h.kind })),
        }
      : null,
    vitalsId: v.vitalsId ?? null,
    vitals: v.vitals ? pickVitals(v.vitals) : null,
    painScore: v.painScore ?? null,
    bayId: v.bay ? String(v.bay) : null,
    bayName: v.bayName ?? null,
    status: v.status,
    pathways: (v.pathways ?? []).map((p: any) => ({
      key: p.key,
      startedBy: p.startedBy,
      ...(p.startedByName ? { startedByName: p.startedByName } : {}),
      cancelled: p.cancelled ? { byName: p.cancelled.byName, reason: p.cancelled.reason, at: iso(p.cancelled.at)! } : null,
    })),
    steps: (v.steps ?? []).map((s: any) => ({ key: s.key, doneAt: iso(s.doneAt), byName: s.byName ?? null })),
    doctorSeenAt: iso(v.doctorSeenAt),
    disposition: v.disposition ? { kind: v.disposition.kind, byName: v.disposition.byName, at: iso(v.disposition.at)!, notes: v.disposition.notes ?? '' } : null,
    leftAt: iso(v.leftAt),
    leftReason: v.leftReason ?? null,
    handoverNote: v.handoverNote ?? null,
    caseId: String(v.case),
    createdAt: iso(v.createdAt)!,
    ...extras,
  };
}

const toExpectedView = (e: any): ErExpectedView => ({
  id: String(e._id),
  complaint: e.complaint,
  ageSex: e.ageSex,
  mode: e.mode,
  etaMinutes: e.etaMinutes,
  expectedAt: iso(e.expectedAt)!,
  phone: e.phone ?? null,
  patientId: e.patient ? String(e.patient) : null,
  state: e.state,
});

/** Untriaged first, then red to green, then the earlier arrival. */
const boardOrder = (a: any, b: any) => {
  const rank = (v: any) => (v.triage?.colour ? COLOUR_RANK[v.triage.colour as TriageColour] : -1);
  return rank(a) - rank(b) || new Date(a.arrivedAt).getTime() - new Date(b.arrivedAt).getTime();
};

/** ER visits: arrival, the placeholder patient for an unknown person, and the expected-arrivals list. */
@Injectable()
export class ErVisitsService {
  private readonly logger = new Logger(ErVisitsService.name);

  constructor(
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    @InjectModel(ErExpected.name) private readonly expected: Model<ErExpectedDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    @InjectModel(Patient.name) private readonly patientModel: Model<PatientDocument>,
    private readonly patients: PatientsService,
    private readonly cards: PatientCardsService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly bays: ErBaysService,
    @InjectModel(Clock.name) private readonly clockModel: Model<ClockDocument>,
  ) {}

  /**
   * The views for some visits, with the patient's age, sex and details-pending flag and the live er clocks.
   * Two queries in all (patients by id, clocks by case), however many visits there are.
   */
  async toViews(visits: any[]): Promise<ErVisitView[]> {
    if (!visits.length) return [];
    const open = visits.filter((v) => v.status !== 'left');
    const [patients, clocks] = await Promise.all([
      this.patientModel.find({ _id: { $in: visits.map((v) => v.patient) } }).select('age gender detailsPending').lean().exec(),
      open.length
        ? this.clockModel
            .find({ case: { $in: open.map((v) => v.case) }, def: /^er-/, $or: [{ state: 'running' }, { state: 'expired', stoppedAt: { $exists: false } }] })
            .sort({ dueAt: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);
    const byPatient = new Map(patients.map((p: any) => [String(p._id), p]));
    const byCase = new Map<string, any[]>();
    for (const c of clocks as any[]) byCase.set(String(c.case), [...(byCase.get(String(c.case)) ?? []), c]);
    const now = Date.now();
    return visits.map((v) => {
      const p: any = byPatient.get(String(v.patient));
      const mine = v.status === 'left' ? [] : (byCase.get(String(v.case)) ?? []);
      return toVisitView(v, {
        patientAge: typeof p?.age === 'number' ? p.age : null,
        patientGender: p?.gender ?? null,
        detailsPending: p?.detailsPending === true,
        clocks: mine.map((c) => ({ key: c.def, label: clockLabel(c.def), state: c.state, dueAt: iso(c.dueAt)! })),
        overdue: mine.some((c) => c.state === 'expired' || new Date(c.dueAt).getTime() < now),
      });
    });
  }

  private async toView(visit: any): Promise<ErVisitView> {
    return (await this.toViews([visit]))[0];
  }

  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: 'er' }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `ER-${String(c.last).padStart(4, '0')}`;
  }

  private openVisit(patient: Types.ObjectId) {
    return this.visits.findOne({ patient, status: { $in: [...OPEN_ER_STATUSES] } }).exec();
  }

  async arrive(actor: Actor, input: ArriveInput): Promise<ErVisitView> {
    const complaint = COMPLAINTS.find((c) => c.key === input.complaint);
    if (!complaint) throw new BadRequestException('Pick what the patient came in with');
    if (!ER_MODES.includes(input.mode)) throw new BadRequestException('"mode" must be walk-in, ambulance or referred');
    const ways = [input.patientId, input.uhid, input.cardId, input.emergency].filter((w) => w !== undefined && w !== null && w !== '');
    if (ways.length !== 1) throw new BadRequestException('Give exactly one of patientId, uhid, cardId or emergency');
    if (input.expectedId !== undefined && !isValidObjectId(input.expectedId)) throw new BadRequestException('"expectedId" is not a valid id');

    let number: string | null = null;
    let patient: { _id: Types.ObjectId; uhid: string; name: string };
    let complaintText = (input.complaintText ?? '').trim();

    if (input.emergency) {
      const e = input.emergency;
      if (!GENDERS.includes(e.gender)) throw new BadRequestException('Gender must be Male, Female or Other');
      if (typeof e.approxAge !== 'number' || !Number.isFinite(e.approxAge) || e.approxAge < 0 || e.approxAge > 120) {
        throw new BadRequestException('Give the approximate age, 0 to 120');
      }
      const description = (e.description ?? '').trim();
      if (!description) throw new BadRequestException('Describe the patient so staff can recognise them');
      // The placeholder's name carries the visit number, so the number comes first.
      // A lost race or a failure can skip a number, as cases do.
      number = await this.nextNumber();
      patient = await this.patients.create({
        name: `Unknown ${PLACEHOLDER_WORD[e.gender]}, ${number}`,
        age: e.approxAge,
        gender: e.gender,
        phone: '',
        detailsPending: true,
      } as any);
      // The Patient record has no free-text field, so the description is kept on the visit.
      if (!complaintText) complaintText = description;
    } else {
      patient = await this.resolve(input);
      const open = await this.openVisit(patient._id);
      if (open) return this.toView(await this.announce(open, input.expectedId));
      number = await this.nextNumber();
    }

    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(patient._id),
      patientUhid: patient.uhid,
      patientName: patient.name,
      kind: 'er',
      priority: 'medium',
      openedBy: 'er',
    });

    let visit: ErVisitDocument;
    try {
      visit = await this.visits.create({
        number,
        patient: patient._id,
        patientUhid: patient.uhid,
        patientName: patient.name,
        mode: input.mode,
        complaint: input.complaint,
        complaintText,
        arrivedAt: clinicNow(),
        status: 'waiting-triage',
        case: theCase._id,
      });
    } catch (err) {
      if (err instanceof mongo.MongoServerError && err.code === DUPLICATE_KEY && 'patient' in (err.keyPattern ?? {})) {
        // The same patient arrived at the same moment: the other call made the visit.
        const open = await this.openVisit(patient._id);
        if (open) return this.toView(await this.announce(open, input.expectedId));
      }
      throw err;
    }
    return this.toView(await this.announce(visit, input.expectedId));
  }

  /**
   * Sends er.arrived for a visit the Coordinator has not heard about yet, then records that it did.
   * A retry after a failed send comes through here again; the message dedupe covers two at once.
   */
  private async announce(visit: ErVisitDocument, expectedId?: string): Promise<ErVisitDocument> {
    if (!visit.announcedAt) {
      const label = COMPLAINTS.find((c) => c.key === visit.complaint)?.label ?? visit.complaint;
      await this.messages.send({
        case: String(visit.case),
        from: 'er',
        to: ['coordinator'],
        type: 'er.arrived',
        priority: 'medium',
        summary: `${visit.number} arrived: ${label} (${visit.mode})`,
        payload: { visitId: String(visit._id), visitNumber: visit.number, complaint: label },
      });
      visit.announcedAt = new Date();
      await this.visits.updateOne({ _id: visit._id }, { announcedAt: visit.announcedAt }).exec();
    }
    if (expectedId) {
      // Bookkeeping: it must never block the message.
      try {
        await this.expected.updateOne({ _id: expectedId, state: 'waiting' }, { state: 'arrived' }).exec();
      } catch (e) {
        this.logger.error(`Could not mark expected arrival ${expectedId} as arrived: ${(e as Error).message}`);
      }
    }
    return visit;
  }

  private async resolve(input: ArriveInput): Promise<PatientDocument> {
    let patient: PatientDocument | null;
    if (input.patientId) {
      if (!isValidObjectId(input.patientId)) throw new BadRequestException('"patientId" is not a valid id');
      patient = await this.patientModel.findById(input.patientId).exec();
    } else {
      const uhid = input.uhid ?? (await this.cards.findUhid(input.cardId!));
      patient = await this.patientModel.findOne({ uhid: uhid.trim() }).exec();
    }
    if (!patient) throw new NotFoundException('Patient not found');
    return patient;
  }

  async addExpected(actor: Actor, input: AddExpectedInput): Promise<ErExpectedView> {
    const complaint = (input.complaint ?? '').trim();
    if (!complaint) throw new BadRequestException('Say what the patient is coming in with');
    if (!ER_MODES.includes(input.mode)) throw new BadRequestException('"mode" must be walk-in, ambulance or referred');
    if (typeof input.etaMinutes !== 'number' || !Number.isFinite(input.etaMinutes) || input.etaMinutes < 0 || input.etaMinutes > 24 * 60) {
      throw new BadRequestException('"etaMinutes" must be between 0 and 1440');
    }
    let patient: Types.ObjectId | undefined;
    if (input.patientId) {
      if (!isValidObjectId(input.patientId) || !(await this.patientModel.exists({ _id: input.patientId }).exec())) {
        throw new NotFoundException('Patient not found');
      }
      patient = new Types.ObjectId(input.patientId);
    } else if (input.phone?.trim()) {
      const matches = await this.patientModel.find({ phone: input.phone.trim() }).select('_id').limit(2).lean().exec();
      if (matches.length === 1) patient = matches[0]._id as Types.ObjectId;
    }
    const doc = await this.expected.create({
      complaint,
      ageSex: (input.ageSex ?? '').trim(),
      mode: input.mode,
      etaMinutes: input.etaMinutes,
      expectedAt: new Date(clinicNow().getTime() + input.etaMinutes * MIN_MS),
      phone: input.phone?.trim() || undefined,
      patient,
      state: 'waiting',
      byName: actor.name,
    });
    await this.messages.send({
      from: 'er',
      to: ['coordinator'],
      type: 'er.expected',
      priority: 'medium',
      summary: `Expected in about ${input.etaMinutes} min: ${complaint} (${input.mode})`,
      payload: { expectedId: String(doc._id), complaint },
    });
    return toExpectedView(doc);
  }

  /** Removes a card that is still waiting. An arrived or expired card is history and stays. */
  async deleteExpected(id: string): Promise<void> {
    const res = isValidObjectId(id) ? await this.expected.deleteOne({ _id: id, state: 'waiting' }).exec() : null;
    if (!res?.deletedCount) throw new NotFoundException('Expected arrival not found');
  }

  /** Both times are on the clinic clock: the scheduler passes `clinicNow()`. */
  async expireExpected(now: Date): Promise<number> {
    const res = await this.expected.updateMany({ state: 'waiting', expectedAt: { $lt: new Date(now.getTime() - 2 * HOUR_MS) } }, { state: 'expired' }).exec();
    return res.modifiedCount;
  }

  async get(id: string): Promise<ErVisitView> {
    const visit = isValidObjectId(id) ? await this.visits.findById(id).lean().exec() : null;
    if (!visit) throw new NotFoundException('ER visit not found');
    return this.toView(visit);
  }

  /** Saves the handover note the nurse edited. A left visit is closed to changes. */
  async saveHandover(visitId: string, note: string): Promise<ErVisitView> {
    const text = (note ?? '').trim();
    if (text.length > 2000) throw new BadRequestException('The handover note can have at most 2000 characters');
    const updated = isValidObjectId(visitId)
      ? await this.visits.findOneAndUpdate({ _id: visitId, status: { $ne: 'left' } }, { $set: { handoverNote: text } }, { new: true }).exec()
      : null;
    if (updated) return this.toView(updated);
    const exists = isValidObjectId(visitId) && (await this.visits.exists({ _id: visitId }).exec());
    if (exists) throw new ConflictException('This patient has left the ER.');
    throw new NotFoundException('ER visit not found');
  }

  async board(): Promise<{ visits: ErVisitView[]; expected: ErExpectedView[] }> {
    const [visits, expected] = await Promise.all([
      this.visits.find({ status: { $in: [...OPEN_ER_STATUSES] } }).lean().exec(),
      this.expected.find({ state: 'waiting' }).sort({ expectedAt: 1 }).lean().exec(),
    ]);
    return { visits: await this.toViews(visits.sort(boardOrder)), expected: expected.map(toExpectedView) };
  }

  /**
   * The doctor's decision. `admit` waits for a bed (the bay is kept); every other kind sends the
   * patient out of the ER, from any open status, because a patient can leave before triage or
   * while waiting for a bed. Each change is one guarded update, so a repeat or a race is refused.
   */
  async dispose(actor: Actor, visitId: string, kind: ErDispositionKind, notes?: string): Promise<ErVisitView> {
    if (!ER_DISPOSITIONS.includes(kind)) throw new BadRequestException('"kind" must be admit, home, transfer, left-against-advice or died');
    const visit = isValidObjectId(visitId) ? await this.visits.findById(visitId).exec() : null;
    if (!visit) throw new NotFoundException('ER visit not found');
    const at = clinicNow();
    const disposition = { kind, byName: actor.name, at, notes: (notes ?? '').trim() };

    if (kind === 'admit') {
      const updated = await this.visits
        .findOneAndUpdate({ _id: visit._id, status: { $in: ['waiting-doctor', 'in-treatment'] } }, { $set: { status: 'waiting-bed', disposition } }, { new: true })
        .exec();
      if (!updated) {
        const now = await this.visits.findById(visit._id).select('status').lean().exec();
        if (now?.status === 'left') throw new ConflictException('This patient has left the ER.');
        if (now?.status === 'waiting-bed') throw new ConflictException('This patient is already waiting for a bed.');
        throw new ConflictException('Triage this patient first.');
      }
      await this.sendDisposition(updated, kind);
      // The Bed Agent may have placed the patient before this admit landed: leave at once.
      if (await this.bedAlreadyAssigned(updated)) {
        const left = await this.leave({ _id: updated._id, status: 'waiting-bed' }, 'admitted');
        if (left) return this.toView(left);
      }
      return this.toView(updated);
    }

    const updated = await this.leave(
      { _id: visit._id },
      kind,
      { disposition },
      (v) => this.sendDisposition(v, kind),
    );
    if (!updated) {
      // A repeat whose er.left was lost finishes the announcement; the person's intent is already done.
      const now = await this.visits.findById(visit._id).exec();
      if (now?.status === 'left' && !now.leftAnnouncedAt) {
        await this.announceLeft(now);
        return this.toView(now);
      }
      throw new ConflictException('This patient has left the ER.');
    }
    return this.toView(updated);
  }

  /** True when the Bed Agent already placed this visit's patient (a bed.assigned on its case since it began). */
  private bedAlreadyAssigned(visit: ErVisitDocument): Promise<boolean> {
    return this.messages.existsForCaseSince(String(visit.case), 'bed.assigned', (visit as ErVisitDocument & { createdAt: Date }).createdAt);
  }

  /**
   * The one place a visit leaves: a guarded update to `left` (null when it already had), its bays freed,
   * then `before` and er.left. `leftAnnouncedAt` is set once er.left was sent; `reannounce` repeats a lost one.
   */
  private async leave(
    filter: Record<string, unknown>,
    reason: string,
    extraSet: Record<string, unknown> = {},
    before?: (visit: ErVisitDocument) => Promise<void>,
  ): Promise<ErVisitDocument | null> {
    const updated = await this.visits
      .findOneAndUpdate(
        { status: { $ne: 'left' }, ...filter },
        { $set: { status: 'left', leftAt: clinicNow(), leftReason: reason, ...extraSet }, $unset: { bay: 1, bayName: 1 } },
        { new: true },
      )
      .exec();
    if (!updated) return null;
    await this.bays.freeVisit(String(updated._id));
    if (before) await before(updated);
    await this.announceLeft(updated);
    return updated;
  }

  private async announceLeft(visit: ErVisitDocument): Promise<void> {
    await this.sendLeft(visit, visit.leftReason ?? 'left');
    visit.leftAnnouncedAt = new Date();
    await this.visits.updateOne({ _id: visit._id }, { leftAnnouncedAt: visit.leftAnnouncedAt }).exec();
  }

  /**
   * Sends the arrivals and departures the Coordinator has not heard about (a send that failed).
   * The scheduler calls it every minute; the message dedupe makes it safe against a send still in flight.
   */
  async reannounce(): Promise<{ arrived: number; left: number }> {
    let arrived = 0;
    let left = 0;
    const unheard = await this.visits.find({ status: { $in: [...OPEN_ER_STATUSES] }, announcedAt: { $exists: false } }).exec();
    for (const v of unheard) {
      try {
        await this.announce(v);
        arrived += 1;
      } catch (e) {
        this.logger.error(`Could not announce ${v.number}: ${(e as Error).message}`);
      }
    }
    const gone = await this.visits.find({ status: 'left', leftAnnouncedAt: { $exists: false } }).exec();
    for (const v of gone) {
      try {
        await this.announceLeft(v);
        left += 1;
      } catch (e) {
        this.logger.error(`Could not announce that ${v.number} left: ${(e as Error).message}`);
      }
    }
    return { arrived, left };
  }

  /**
   * The Bed Agent placed the patient: a visit of this case that waited for a bed leaves the ER.
   * No such visit is normal (a ward admission that never came through the ER). Safe to repeat.
   */
  async onBedAssigned(caseId: string): Promise<void> {
    if (!isValidObjectId(caseId)) return;
    const updated = await this.leave({ case: caseId, status: 'waiting-bed' }, 'admitted');
    if (updated) return;
    // A redelivery after a lost er.left sends it now.
    const unannounced = await this.visits.findOne({ case: caseId, status: 'left', leftReason: 'admitted', leftAnnouncedAt: { $exists: false } }).exec();
    if (unannounced) await this.announceLeft(unannounced);
  }

  private async sendDisposition(visit: ErVisitDocument, kind: ErDispositionKind): Promise<void> {
    const colour = visit.triage?.colour as TriageColour | undefined;
    await this.messages.send({
      case: String(visit.case),
      from: 'er',
      to: ['coordinator'],
      type: 'er.disposition',
      priority: colour ? BED_PRIORITY[colour] : 'medium',
      summary: `${visit.number}: decision is ${kind}`,
      payload: { visitId: String(visit._id), kind },
      // Admit, then transfer, is a real sequence; only the same decision twice is a repeat.
      dedupeKey: `er.disposition:${visit._id}:${kind}`,
    });
  }

  private async sendLeft(visit: ErVisitDocument, reason: string): Promise<void> {
    await this.messages.send({
      case: String(visit.case),
      from: 'er',
      to: ['coordinator'],
      type: 'er.left',
      priority: 'medium',
      summary: `${visit.number} left the ER (${reason})`,
      payload: { visitId: String(visit._id), reason },
      dedupeKey: `er.left:${visit._id}`,
    });
  }
}
