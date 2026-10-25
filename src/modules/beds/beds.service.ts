import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types, UpdateQuery, mongo } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { PatientsService } from '../patients/patients.service';
import { Actor } from './actor';
import { BedEvents } from './bed-events';
import { BedInfo, BedState, Feature, GenderRule, Need, RoomClass, WardInfo, WardType } from './bed-types';
import { HOLD_MINUTES, isFree } from './rules';
import { Admission, AdmissionDocument } from './schemas/admission.schema';
import { Bed, BedDocument } from './schemas/bed.schema';
import { Ward, WardDocument } from './schemas/ward.schema';

// Clocks: a hold's expiry is real time (`new Date()`), because the hold lasts five real
// minutes. Times staff see (stateSince, admittedAt, dischargedAt, transfer times) are
// on the clinic clock (`clinicNow()`), which development pins to the demo day.

export interface AdmitInput {
  patientId: string;
  suggestionId: string;
  doctor: string;
  department: string;
  roomClass: RoomClass;
  needs: Need[];
  notes: string;
  expectedStayDays: number;
}

export interface BedBoardWard {
  id: string;
  code: string;
  name: string;
  shortName: string;
  floor: number;
  type: WardType;
  gender: GenderRule;
  ratePerDay: number;
}

export interface BedBoardBed {
  id: string;
  wardId: string;
  label: string;
  number: number;
  room?: string;
  features: Feature[];
  state: BedState;
  /** When the bed entered its state (clinic clock), ISO. */
  since: string;
  sample: boolean;
  blockedReason?: string;
  /** Set on held beds: whether the viewer holds it. */
  heldByMe?: boolean;
  patient?: { id: string; name: string; uhid: string; admissionId: string; admittedAt: string };
}

export interface BedBoard {
  wards: BedBoardWard[];
  beds: BedBoardBed[];
  totals: { total: number; occupied: number; free: number; cleaning: number; held: number; blocked: number; percentFull: number };
  /** Clinic clock, like `since`, so the two can be compared. */
  updatedAt: string;
}

type WardRecord = Ward & { _id: Types.ObjectId };
type BedRecord = Bed & { _id: Types.ObjectId };
type AdmissionRecord = Admission & { _id: Types.ObjectId };

const HOLD_RAN_OUT = 'Your hold on this bed ran out. Choose a bed again.';
const NOT_OCCUPIED = 'This bed is not occupied.';
const HOLD_FIELDS = { holdBy: 1, holdExpiresAt: 1, holdSuggestion: 1 };

const isDuplicate = (err: unknown, field: string) =>
  err instanceof mongo.MongoServerError && err.code === 11000 && field in (err.keyPattern ?? {});

/** The plain shape the rules and ranking work on. */
function toBedInfo(b: BedRecord): BedInfo {
  const bed: BedInfo = {
    id: String(b._id),
    wardId: String(b.ward),
    label: b.label,
    number: b.number,
    features: [...b.features],
    state: b.state,
  };
  if (b.room) bed.room = b.room;
  if (b.holdExpiresAt) bed.holdExpiresAt = b.holdExpiresAt;
  if (b.occupantGender) bed.occupantGender = b.occupantGender;
  if (b.state === 'free') bed.freeSince = b.stateSince;
  return bed;
}

@Injectable()
export class BedsService {
  constructor(
    @InjectModel(Ward.name) private readonly wards: Model<WardDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    private readonly patients: PatientsService,
    private readonly events: BedEvents,
  ) {}

  /** Wards in board order, and their beds by ward, then number. */
  private async load(): Promise<{ wards: WardRecord[]; beds: BedRecord[] }> {
    const [wards, beds] = await Promise.all([
      this.wards.find().sort({ sortOrder: 1, code: 1 }).lean<WardRecord[]>().exec(),
      this.beds.find().lean<BedRecord[]>().exec(),
    ]);
    const order = new Map(wards.map((w, i) => [String(w._id), i]));
    const wardIndex = (b: BedRecord) => order.get(String(b.ward)) ?? wards.length;
    beds.sort((a, b) => wardIndex(a) - wardIndex(b) || a.number - b.number);
    return { wards, beds };
  }

  async board(actor: Actor): Promise<BedBoard> {
    const now = new Date();
    const { wards, beds } = await this.load();
    const admissions = await this.admissions
      .find({ _id: { $in: beds.map((b) => b.admission).filter(Boolean) } })
      .lean<AdmissionRecord[]>()
      .exec();
    const admissionById = new Map(admissions.map((a) => [String(a._id), a]));

    const views = beds.map((b): BedBoardBed => {
      const expiredHold = b.state === 'held' && isFree(toBedInfo(b), now);
      const state: BedState = expiredHold ? 'free' : b.state;
      // An expired hold has been free since it ran out: HOLD_MINUTES after it began.
      const since = expiredHold ? new Date(b.stateSince.getTime() + HOLD_MINUTES * 60_000) : b.stateSince;
      const view: BedBoardBed = {
        id: String(b._id),
        wardId: String(b.ward),
        label: b.label,
        number: b.number,
        features: [...b.features],
        state,
        since: since.toISOString(),
        sample: b.sample,
      };
      if (b.room) view.room = b.room;
      if (state === 'blocked') view.blockedReason = b.blockedReason;
      if (state === 'held') view.heldByMe = b.holdBy === actor.id;
      const admission = state === 'occupied' && b.admission ? admissionById.get(String(b.admission)) : undefined;
      if (admission) {
        view.patient = {
          id: String(admission.patient),
          name: admission.patientName,
          uhid: admission.patientUhid,
          admissionId: String(admission._id),
          admittedAt: admission.admittedAt.toISOString(),
        };
      }
      return view;
    });

    const count = (s: BedState) => views.filter((v) => v.state === s).length;
    const total = views.length;
    const occupied = count('occupied');
    return {
      wards: wards.map((w) => ({
        id: String(w._id),
        code: w.code,
        name: w.name,
        shortName: w.shortName,
        floor: w.floor,
        type: w.type,
        gender: w.gender,
        ratePerDay: w.ratePerDay,
      })),
      beds: views,
      totals: {
        total,
        occupied,
        free: count('free'),
        cleaning: count('cleaning'),
        held: count('held'),
        blocked: count('blocked'),
        percentFull: total ? Math.round((occupied / total) * 100) : 0,
      },
      updatedAt: clinicNow().toISOString(),
    };
  }

  /** Every ward and bed as plain records with string ids, for the rules and ranking. */
  async inventory(): Promise<{ wards: WardInfo[]; beds: BedInfo[] }> {
    const { wards, beds } = await this.load();
    return {
      wards: wards.map((w) => ({
        id: String(w._id),
        code: w.code,
        name: w.name,
        shortName: w.shortName,
        floor: w.floor,
        type: w.type,
        gender: w.gender,
        ratePerDay: w.ratePerDay,
        nearDepartments: [...w.nearDepartments],
      })),
      beds: beds.map(toBedInfo),
    };
  }

  activeAdmissionForPatient(patientId: string): Promise<AdmissionDocument | null> {
    return this.admissions.findOne({ patient: patientId, status: 'active' }).exec();
  }

  /**
   * Changes one bed with a single conditional update, so of two requests at once only
   * one can match. Returns the bed as it was before the change; `miss` is the conflict
   * message when the bed was not in the expected state.
   */
  private async transition(filter: FilterQuery<BedDocument>, update: UpdateQuery<BedDocument>, miss: string): Promise<BedDocument> {
    const before = await this.beds.findOneAndUpdate(filter, update, { returnDocument: 'before' }).exec();
    if (!before) throw new ConflictException(miss);
    this.events.changed();
    return before;
  }

  /** Holds a free bed (or one whose hold ran out) for the caller while they confirm. */
  async hold(bedId: string, actor: Actor, suggestionId: string): Promise<{ bedId: string; holdExpiresAt: Date }> {
    const now = new Date();
    const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
    await this.transition(
      { _id: bedId, $or: [{ state: 'free' }, { state: 'held', holdExpiresAt: { $lt: now } }] },
      { $set: { state: 'held', stateSince: clinicNow(), holdBy: actor.id, holdExpiresAt, holdSuggestion: suggestionId } },
      'That bed was just taken. Choose another.',
    );
    return { bedId, holdExpiresAt };
  }

  /** Gives back the caller's hold; does nothing if they no longer hold the bed. */
  async release(bedId: string, actor: Actor): Promise<void> {
    const released = await this.beds
      .findOneAndUpdate(
        { _id: bedId, state: 'held', holdBy: actor.id },
        { $set: { state: 'free', stateSince: clinicNow() }, $unset: HOLD_FIELDS },
      )
      .exec();
    if (released) this.events.changed();
  }

  async admit(bedId: string, actor: Actor, input: AdmitInput): Promise<AdmissionDocument> {
    const patient = await this.patients.findOne(input.patientId);
    const admittedAt = clinicNow();

    // 1. The admission first: its unique index allows one active admission per patient.
    let admission: AdmissionDocument;
    try {
      admission = await this.admissions.create({
        patient: patient._id,
        patientUhid: patient.uhid,
        patientName: patient.name,
        bed: bedId,
        doctor: input.doctor,
        department: input.department,
        roomClass: input.roomClass,
        needs: input.needs,
        notes: input.notes,
        expectedStayDays: input.expectedStayDays,
        status: 'active',
        admittedAt,
        admittedBy: actor.name,
        suggestion: input.suggestionId,
      });
    } catch (err) {
      if (isDuplicate(err, 'patient')) throw new ConflictException('This patient is already admitted.');
      throw err;
    }

    // 2. Then the bed, which needs the caller's live hold. Without it, undo the admission.
    try {
      await this.transition(
        { _id: bedId, state: 'held', holdBy: actor.id, holdExpiresAt: { $gt: new Date() } },
        {
          $set: { state: 'occupied', stateSince: admittedAt, admission: admission._id, occupantGender: patient.gender },
          $unset: HOLD_FIELDS,
        },
        HOLD_RAN_OUT,
      );
    } catch (err) {
      await this.admissions.deleteOne({ _id: admission._id }).exec();
      throw err;
    }

    // 3. Then the patient record.
    await this.patients.update(String(patient._id), { status: 'Admitted', visitType: 'IPD' });
    return admission;
  }

  /** Moves an admitted patient to a bed the caller holds; the old bed goes to cleaning. */
  async transfer(
    fromBedId: string,
    actor: Actor,
    input: { toBedId: string; suggestionId: string; reason?: string },
  ): Promise<AdmissionDocument> {
    const from = await this.beds.findById(fromBedId).exec();
    if (from?.state !== 'occupied') throw new ConflictException(NOT_OCCUPIED);
    if (!from.admission) throw new ConflictException('This bed has no admitted patient to move.');
    const at = clinicNow();

    // 1. Move the admission. Matching its current bed lets only one move or discharge win.
    const admission = await this.admissions
      .findOneAndUpdate(
        { _id: from.admission, status: 'active', bed: from._id },
        {
          $set: { bed: input.toBedId },
          $push: { transfers: { fromBed: from._id, toBed: input.toBedId, at, by: actor.name, reason: input.reason } },
        },
        { new: true },
      )
      .exec();
    if (!admission) throw new ConflictException(NOT_OCCUPIED);

    // 2. Then the new bed, which needs the caller's live hold. Without it, undo the move.
    try {
      const to = await this.beds
        .findOneAndUpdate(
          { _id: input.toBedId, state: 'held', holdBy: actor.id, holdExpiresAt: { $gt: new Date() } },
          {
            $set: { state: 'occupied', stateSince: at, admission: admission._id, occupantGender: from.occupantGender },
            $unset: HOLD_FIELDS,
          },
        )
        .exec();
      if (!to) throw new ConflictException(HOLD_RAN_OUT);
    } catch (err) {
      await this.admissions
        .updateOne({ _id: admission._id, bed: input.toBedId }, { $set: { bed: from._id }, $pop: { transfers: 1 } })
        .exec();
      throw err;
    }

    // 3. The old bed waits for cleaning (unless a discharge just did that).
    await this.beds
      .updateOne(
        { _id: from._id, state: 'occupied', admission: admission._id },
        { $set: { state: 'cleaning', stateSince: at, admission: null }, $unset: { occupantGender: 1 } },
      )
      .exec();
    this.events.changed();
    return admission;
  }

  /** The bed goes to cleaning and its admission ends. */
  async discharge(bedId: string, actor: Actor): Promise<void> {
    const at = clinicNow();
    const before = await this.transition(
      { _id: bedId, state: 'occupied' },
      { $set: { state: 'cleaning', stateSince: at, admission: null, sample: false }, $unset: { occupantGender: 1 } },
      NOT_OCCUPIED,
    );
    // A sample occupant has no admission and no patient record to update.
    if (!before.admission) return;
    // Matching the bed: if a transfer moved the patient meanwhile, their admission stays.
    const admission = await this.admissions
      .findOneAndUpdate(
        { _id: before.admission, status: 'active', bed: before._id },
        { $set: { status: 'discharged', dischargedAt: at, dischargedBy: actor.name } },
        { new: true },
      )
      .exec();
    if (admission) await this.patients.update(String(admission.patient), { status: 'Discharged' });
  }

  async markCleaned(bedId: string, _actor: Actor): Promise<void> {
    await this.transition(
      { _id: bedId, state: 'cleaning' },
      { $set: { state: 'free', stateSince: clinicNow() } },
      'This bed is not waiting for cleaning.',
    );
  }

  async block(bedId: string, _actor: Actor, reason: string): Promise<void> {
    await this.transition(
      { _id: bedId, state: 'free' },
      { $set: { state: 'blocked', stateSince: clinicNow(), blockedReason: reason } },
      'Only a free bed can be blocked.',
    );
  }

  async unblock(bedId: string, _actor: Actor): Promise<void> {
    await this.transition(
      { _id: bedId, state: 'blocked' },
      { $set: { state: 'free', stateSince: clinicNow() }, $unset: { blockedReason: 1 } },
      'This bed is not blocked.',
    );
  }
}
