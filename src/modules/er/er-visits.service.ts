import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId, mongo } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { MessagesService } from '../coordinator/messages.service';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { PatientsService } from '../patients/patients.service';
import { PatientCardsService } from '../queue/patient-cards.service';
import { COLOUR_RANK, COMPLAINTS, ComplaintKey, PathwayKey, StepKey, TriageColour } from './er-rules';
import { ErExpected, ErExpectedDocument } from './schemas/er-expected.schema';
import { ER_MODES, ErDispositionKind, ErMode, ErStatus, ErVisit, ErVisitDocument, OPEN_ER_STATUSES } from './schemas/er-visit.schema';

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
  painScore: number | null;
  bayId: string | null;
  /** Filled in once bays exist. */
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

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export function toVisitView(v: any): ErVisitView {
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
    painScore: v.painScore ?? null,
    bayId: v.bay ? String(v.bay) : null,
    bayName: null,
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
  ) {}

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
      if (open) return toVisitView(await this.announce(open, input.expectedId));
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
        if (open) return toVisitView(await this.announce(open, input.expectedId));
      }
      throw err;
    }
    return toVisitView(await this.announce(visit, input.expectedId));
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

  /** Both times are on the clinic clock: the scheduler passes `clinicNow()`. */
  async expireExpected(now: Date): Promise<number> {
    const res = await this.expected.updateMany({ state: 'waiting', expectedAt: { $lt: new Date(now.getTime() - 2 * HOUR_MS) } }, { state: 'expired' }).exec();
    return res.modifiedCount;
  }

  async get(id: string): Promise<ErVisitView> {
    const visit = isValidObjectId(id) ? await this.visits.findById(id).lean().exec() : null;
    if (!visit) throw new NotFoundException('ER visit not found');
    return toVisitView(visit);
  }

  async board(): Promise<{ visits: ErVisitView[]; expected: ErExpectedView[] }> {
    const [visits, expected] = await Promise.all([
      this.visits.find({ status: { $in: [...OPEN_ER_STATUSES] } }).lean().exec(),
      this.expected.find({ state: 'waiting' }).sort({ expectedAt: 1 }).lean().exec(),
    ]);
    return { visits: visits.sort(boardOrder).map(toVisitView), expected: expected.map(toExpectedView) };
  }
}
