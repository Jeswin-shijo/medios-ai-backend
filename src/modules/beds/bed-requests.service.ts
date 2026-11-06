import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { PatientsService } from '../patients/patients.service';
import { isStepDown } from './agent-policy';
import { Actor } from './actor';
import { BedAlerts } from './bed-alerts';
import { BedEvents } from './bed-events';
import { AdmissionRequestInput, BedInfo, Need, PatientGender, RoomClass, WardType } from './bed-types';
import { BedsService } from './beds.service';
import { applyRules } from './rules';
import {
  BedDecision,
  BedRequest,
  BedRequestDocument,
  NeedEvidence,
  OPEN_STATES,
  RequestPriority,
  RequestState,
  ResolvedNeed,
} from './schemas/bed-request.schema';

export interface CreateBedRequestInput {
  type: 'admission' | 'transfer';
  patientId: string;
  fromBedId?: string;
  roomClass: RoomClass;
  needs: Need[];
  notes: string;
  department: string;
  doctor: string;
  expectedStayDays: number;
  priority: RequestPriority;
}

export interface BedRequestView {
  id: string;
  type: 'admission' | 'transfer';
  stepDown: boolean;
  patientId: string;
  patientName: string;
  patientUhid: string;
  patientAge: number;
  patientGender: PatientGender;
  fromBedId?: string;
  fromBedLabel?: string;
  fromWardType?: WardType;
  admissionId?: string;
  roomClass: RoomClass;
  needs: Need[];
  addedNeeds: NeedEvidence[];
  pendingNeeds: NeedEvidence[];
  dismissedNeeds: Need[];
  resolvedNeeds: Array<Omit<ResolvedNeed, 'at'> & { at: string }>;
  /** Only in `get`: lists leave the clinical notes out. */
  notes?: string;
  department: string;
  doctor: string;
  expectedStayDays: number;
  priority: RequestPriority;
  state: RequestState;
  stateReason: string;
  stateSince: string;
  open: boolean;
  attempts: number;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  assignedBedId?: string;
  assignedBedLabel?: string;
  assignedAt?: string;
  decision?: BedDecision;
  closedByName?: string;
}

/** A bed whose patient has a discharge order and that would suit a waiting request once free. */
export interface LeavingSoonBed {
  bedId: string;
  bedLabel: string;
  wardName: string;
  /** The planned leaving time (clinic clock), ISO. */
  plannedAt: string;
}

export interface BedRequestQuery {
  state?: string;
  type?: 'admission' | 'transfer' | 'step-down';
  limit?: number;
  before?: string;
}

const PRIORITY_RANK: Record<RequestPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const LOCK_MS = 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const iso = (d?: Date) => (d ? d.toISOString() : undefined);

/** The request as the rules see it. A transfer leaves the patient's current bed out. */
export function ruleInput(req: BedRequestDocument): AdmissionRequestInput {
  return {
    age: req.patientAge,
    gender: req.patientGender,
    roomClass: req.roomClass,
    needs: [...req.needs],
    department: req.department,
    expectedStayDays: req.expectedStayDays,
    notes: req.notes,
    currentBedId: req.type === 'transfer' && req.fromBed ? String(req.fromBed) : undefined,
  };
}

/** An occupied bed as the rules see a free one: no occupant. */
function asFree(bed: BedInfo): BedInfo {
  const { occupantGender: _occupant, ...rest } = bed;
  return { ...rest, state: 'free' };
}

/** No agent pass holds the request: its lock is absent or has run out (real clock). */
const unlocked = (now: Date): FilterQuery<BedRequestDocument> => ({
  $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lt: now } }],
});

function toView(r: BedRequestDocument, withNotes: boolean): BedRequestView {
  return {
    id: String(r._id),
    type: r.type,
    stepDown: r.stepDown,
    patientId: String(r.patient),
    patientName: r.patientName,
    patientUhid: r.patientUhid,
    patientAge: r.patientAge,
    patientGender: r.patientGender,
    fromBedId: r.fromBed ? String(r.fromBed) : undefined,
    fromBedLabel: r.fromBedLabel,
    fromWardType: r.fromWardType,
    admissionId: r.admission ? String(r.admission) : undefined,
    roomClass: r.roomClass,
    needs: [...r.needs],
    addedNeeds: r.addedNeeds.map((n) => ({ need: n.need, evidence: n.evidence })),
    pendingNeeds: r.pendingNeeds.map((n) => ({ need: n.need, evidence: n.evidence })),
    dismissedNeeds: [...r.dismissedNeeds],
    resolvedNeeds: r.resolvedNeeds.map((n) => ({
      need: n.need,
      evidence: n.evidence,
      confirmed: n.confirmed,
      byName: n.byName,
      at: n.at.toISOString(),
    })),
    ...(withNotes ? { notes: r.notes } : {}),
    department: r.department,
    doctor: r.doctor,
    expectedStayDays: r.expectedStayDays,
    priority: r.priority,
    state: r.state,
    stateReason: r.stateReason,
    stateSince: r.stateSince.toISOString(),
    open: r.open,
    attempts: r.attempts,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName,
    requestedAt: r.requestedAt.toISOString(),
    assignedBedId: r.assignedBed ? String(r.assignedBed) : undefined,
    assignedBedLabel: r.assignedBedLabel,
    assignedAt: iso(r.assignedAt),
    decision: r.decision,
    closedByName: r.closedByName,
  };
}

const NOT_FOUND = 'Bed request not found.';

@Injectable()
export class BedRequestsService {
  constructor(
    @InjectModel(BedRequest.name) private readonly requests: Model<BedRequestDocument>,
    private readonly patients: PatientsService,
    private readonly beds: BedsService,
    private readonly alerts: BedAlerts,
    private readonly events: BedEvents,
  ) {}

  async create(actor: Actor, dto: CreateBedRequestInput): Promise<BedRequestDocument> {
    const patient = await this.patients.findOne(dto.patientId);
    const patientId = String(patient._id);
    const transfer: Record<string, unknown> = {};

    if (dto.type === 'admission') {
      if (await this.beds.activeAdmissionForPatient(patientId)) throw new ConflictException('This patient is already admitted.');
    } else {
      const admission = await this.admissionInBed(dto.fromBedId, patientId);
      transfer.fromBed = admission.bed;
      transfer.fromBedLabel = admission.bedLabel;
      transfer.fromWardType = admission.wardType;
      transfer.admission = admission.id;
    }

    const now = clinicNow();
    const stepDown = dto.type === 'transfer' && !!transfer.fromWardType && isStepDown(transfer.fromWardType as WardType, dto.roomClass);
    try {
      const created = await this.requests.create({
        type: dto.type,
        patient: patient._id,
        patientName: patient.name,
        patientUhid: patient.uhid,
        patientAge: patient.age,
        patientGender: patient.gender as PatientGender,
        ...transfer,
        stepDown,
        roomClass: dto.roomClass,
        needs: dto.needs,
        notes: dto.notes,
        department: dto.department,
        doctor: dto.doctor,
        expectedStayDays: dto.expectedStayDays,
        priority: dto.priority,
        priorityRank: PRIORITY_RANK[dto.priority],
        state: 'searching',
        stateReason: 'Bed Agent is looking for a bed.',
        stateSince: now,
        open: true,
        attempts: 0,
        requestedBy: actor.id,
        requestedByName: actor.name,
        requestedAt: now,
      });
      this.emit(created);
      return created;
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('This patient already has an open bed request.');
      throw e;
    }
  }

  /** The admitted patient in a bed, which must be the request's patient. */
  private async admissionInBed(bedId: string | undefined, patientId: string) {
    const none = new ConflictException('This bed has no admitted patient.');
    if (!bedId) throw none;
    const admission = await this.beds.admissionInBed(bedId).catch(() => {
      throw none;
    });
    if (admission.patient.id !== patientId) throw none;
    const { wards, beds } = await this.beds.inventory();
    const bed = beds.find((b) => b.id === bedId);
    const ward = wards.find((w) => w.id === bed?.wardId);
    if (!bed || !ward) throw none;
    return { id: admission.admissionId, bed: bedId, bedLabel: bed.label, wardType: ward.type };
  }

  /**
   * Moves a request to a state. `stateSince` changes only with the state: a new reason for
   * the same state (still waiting, say) keeps it. With `onlyIfOpen`, a request that closed
   * meanwhile is left alone: nothing is written, raised or emitted, and null comes back.
   */
  async toState(
    id: string,
    state: RequestState,
    reason: string,
    patch: Partial<BedRequest> = {},
    opts: { onlyIfOpen?: boolean } = {},
  ): Promise<BedRequestDocument | null> {
    const open = OPEN_STATES.includes(state);
    const filter: FilterQuery<BedRequestDocument> = opts.onlyIfOpen ? { _id: id, open: true } : { _id: id };
    // An update pipeline, so stateSince can depend on the state before, in the same atomic
    // write. Pipelines are not cast, so every value goes in as a literal.
    const fields = Object.entries({ ...patch, state, stateReason: reason, open }).filter(([, v]) => v !== undefined);
    const set = Object.fromEntries(fields.map(([key, value]) => [key, { $literal: value }]));
    const stateSince = { $cond: [{ $eq: ['$state', { $literal: state }] }, '$stateSince', clinicNow()] };
    const updated = await this.requests.findOneAndUpdate(filter, [{ $set: { ...set, stateSince } }], { new: true }).exec();
    if (!updated) {
      if (opts.onlyIfOpen && (await this.requests.exists({ _id: id }))) return null;
      throw new NotFoundException(NOT_FOUND);
    }
    await this.syncAlert(updated);
    this.emit(updated);
    return updated;
  }

  /** A failure here propagates; the next toState re-raises, and the upsert makes that safe. */
  private async syncAlert(req: BedRequestDocument) {
    if (req.state === 'waiting' || req.state === 'attention') {
      const alert = await this.alerts.raise(req);
      if (!req.alert) {
        req.alert = alert as any;
        await this.requests.updateOne({ _id: req._id }, { alert }).exec();
      }
    } else if (req.state === 'assigned' || req.state === 'cancelled') {
      await this.alerts.resolve(String(req._id));
    }
  }

  /** Takes a request for one agent pass. Null when it is closed or another pass holds it. */
  claim(id: string): Promise<BedRequestDocument | null> {
    const now = new Date();
    return this.requests
      .findOneAndUpdate(
        { _id: id, open: true, ...unlocked(now) },
        { lockedUntil: new Date(now.getTime() + LOCK_MS) },
        { new: true },
      )
      .exec();
  }

  async release(id: string): Promise<void> {
    await this.requests.updateOne({ _id: id }, { $unset: { lockedUntil: '' } }).exec();
  }

  /** Cancels an open request that the agent is not working on, in one atomic update. `reason` replaces "Cancelled by …". */
  async cancel(actor: Actor, id: string, reason?: string): Promise<BedRequestDocument> {
    const now = new Date();
    const cancelled = await this.requests
      .findOneAndUpdate(
        { _id: id, open: true, ...unlocked(now) },
        {
          state: 'cancelled',
          stateReason: reason ?? `Cancelled by ${actor.name}.`,
          stateSince: clinicNow(),
          open: false,
          closedByName: actor.name,
          $unset: { lockedUntil: '' },
        },
        { new: true },
      )
      .exec();
    if (!cancelled) {
      const found = await this.requests.findById(id).exec();
      if (!found) throw new NotFoundException(NOT_FOUND);
      if (found.open) throw new ConflictException('The Bed Agent is placing this patient right now. Try again in a moment.');
      throw new ConflictException('This request is already closed.');
    }
    await this.syncAlert(cancelled);
    this.emit(cancelled);
    return cancelled;
  }

  async list(q: BedRequestQuery): Promise<BedRequestView[]> {
    const filter: FilterQuery<BedRequestDocument> = {};
    if (q.state) filter.state = q.state;
    if (q.type === 'step-down') filter.stepDown = true;
    else if (q.type) filter.type = q.type;
    if (q.before) filter.requestedAt = { $lt: new Date(q.before) };
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const rows = await this.requests.find(filter).sort({ requestedAt: -1, _id: -1 }).limit(limit).exec();
    return rows.map((r) => toView(r, false));
  }

  async get(id: string): Promise<BedRequestView> {
    const found = await this.requests.findById(id).exec();
    if (!found) throw new NotFoundException(NOT_FOUND);
    return toView(found, true);
  }

  /** Before staff place a patient by hand for a request: it must be open and be for this patient and bed. */
  async checkHandAssign(
    id: string,
    expect: { patientId: string; type: 'admission' | 'transfer'; fromBedId?: string },
  ): Promise<void> {
    const req = await this.requests.findById(id).exec();
    if (!req) throw new NotFoundException(NOT_FOUND);
    if (!req.open) throw new ConflictException('This request is already closed.');
    const sameBed = expect.type !== 'transfer' || String(req.fromBed ?? '') === expect.fromBedId;
    if (String(req.patient) !== expect.patientId || req.type !== expect.type || !sameBed) {
      throw new BadRequestException('This bed request is for another patient or bed.');
    }
  }

  /**
   * For a waiting request: the beds whose patient has an open discharge order and that the fixed
   * rules would offer once free, soonest first. The rules run on the whole inventory with those
   * beds treated as free, so wards and twin rooms are checked as usual. Nothing is held. Empty
   * unless the request is waiting.
   */
  async leavingSoon(id: string): Promise<LeavingSoonBed[]> {
    const req = await this.requests.findById(id).exec();
    if (!req) throw new NotFoundException(NOT_FOUND);
    if (req.state !== 'waiting') return [];
    const leaving = await this.beds.leavingBeds();
    if (!leaving.size) return [];
    const { wards, beds } = await this.beds.inventory();
    const freed = beds.map((b) => (b.state === 'occupied' && leaving.has(b.id) ? asFree(b) : b));
    const { candidates } = applyRules(ruleInput(req), wards, freed, new Date());
    const wardName = new Map(wards.map((w) => [w.id, w.name]));
    return candidates
      .filter((b) => leaving.has(b.id))
      .map((b) => ({ bedId: b.id, bedLabel: b.label, wardName: wardName.get(b.wardId) ?? '', at: leaving.get(b.id)! }))
      .sort((x, y) => x.at.getTime() - y.at.getTime())
      .map(({ at, ...bed }) => ({ ...bed, plannedAt: at.toISOString() }));
  }

  /** Requests the agent is still placing or waiting for. */
  countOpen(): Promise<number> {
    return this.requests.countDocuments({ open: true }).exec();
  }

  /** Requests that wait for a bed or need staff to decide. */
  countNeedingAttention(): Promise<number> {
    return this.requests.countDocuments({ state: { $in: ['waiting', 'attention'] } }).exec();
  }

  waiting(): Promise<BedRequestDocument[]> {
    return this.requests.find({ state: 'waiting' }).sort({ priorityRank: 1, requestedAt: 1, _id: 1 }).exec();
  }

  /** Searching requests no agent pass holds (one stopped mid-pass, say), priority then oldest. */
  unclaimedSearching(): Promise<BedRequestDocument[]> {
    return this.requests
      .find({ state: 'searching', open: true, ...unlocked(new Date()) })
      .sort({ priorityRank: 1, requestedAt: 1, _id: 1 })
      .exec();
  }

  /** Requests that need attention and no agent pass holds, oldest first. */
  unclaimedAttention(): Promise<BedRequestDocument[]> {
    return this.requests
      .find({ state: 'attention', open: true, ...unlocked(new Date()) })
      .sort({ requestedAt: 1, _id: 1 })
      .exec();
  }

  private emit(r: BedRequestDocument) {
    this.events.requestChanged({
      id: String(r._id),
      state: r.state,
      type: r.type,
      patientName: r.patientName,
      bedLabel: r.assignedBedLabel,
      reason: r.stateReason,
    });
  }
}
