import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types, UpdateQuery, mongo } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { PatientsService } from '../patients/patients.service';
import { Actor } from './actor';
import { BedEvents } from './bed-events';
import { BedInfo, BedState, Feature, GenderRule, Need, PatientGender, RoomClass, WardInfo, WardType } from './bed-types';
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
  /** A sample inpatient has no patient record: `id` is ''. */
  patient?: { id: string; name: string; uhid: string; admissionId: string; admittedAt: string; sample: boolean };
}

/** The admitted patient in a bed and what their admission asked for: a transfer starts from it. */
export interface BedAdmission {
  admissionId: string;
  patient: { id: string; name: string; uhid: string; age: number; gender: PatientGender };
  roomClass: RoomClass;
  needs: Need[];
  department: string;
  doctor: string;
  notes: string;
  expectedStayDays: number;
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
const OTHER_GENDER_ROOM = 'This room now has a patient of another gender. Choose another bed.';
const UNKNOWN_GENDER_ROOM = "The patient's gender is not recorded, so a shared room can't be checked. Choose another bed.";
const BED_CHANGED = 'This bed changed since you opened it. Check the board and try again.';
const HOLD_FIELDS = { holdBy: 1, holdExpiresAt: 1, holdSuggestion: 1, holdGender: 1 };

/** Free, or held with a hold that ran out (real clock): a bed the board shows as free. */
const freeOrExpiredHold = (now: Date): FilterQuery<BedDocument> => ({
  $or: [{ state: 'free' }, { state: 'held', holdExpiresAt: { $lt: now } }],
});

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
  if (b.holdGender) bed.holdGender = b.holdGender;
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
          id: admission.sample ? '' : String(admission.patient),
          name: admission.patientName,
          uhid: admission.patientUhid,
          admissionId: String(admission._id),
          admittedAt: admission.admittedAt.toISOString(),
          sample: !!admission.sample,
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

  /** The active admission in an occupied bed, with its patient. Not for the board: it has the notes. */
  async admissionInBed(bedId: string): Promise<BedAdmission> {
    const bed = await this.beds.findById(bedId).lean<BedRecord>().exec();
    const admission =
      bed?.state === 'occupied' && bed.admission
        ? await this.admissions.findOne({ _id: bed.admission, status: 'active', bed: bed._id }).lean<AdmissionRecord>().exec()
        : null;
    if (!admission) throw new NotFoundException('This bed has no admitted patient.');
    if (admission.sample) throw new ConflictException('A sample inpatient cannot be transferred.');
    const patient = await this.patients.findOne(String(admission.patient));
    return {
      admissionId: String(admission._id),
      patient: { id: String(patient._id), name: patient.name, uhid: patient.uhid, age: patient.age, gender: patient.gender as PatientGender },
      roomClass: admission.roomClass,
      needs: [...admission.needs],
      department: admission.department,
      doctor: admission.doctor,
      notes: admission.notes,
      expectedStayDays: admission.expectedStayDays,
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

  /**
   * Holds a free bed (or one whose hold ran out) for the caller while they confirm, for a
   * patient of this gender. A twin room keeps to one gender: its roommate counts while in
   * the bed or holding it.
   */
  async hold(
    bedId: string,
    actor: Actor,
    suggestionId: string,
    gender: PatientGender,
  ): Promise<{ bedId: string; holdExpiresAt: Date }> {
    const now = new Date();
    if (await this.roommateClash(bedId, gender, now)) throw new ConflictException(OTHER_GENDER_ROOM);
    const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);
    const before = await this.transition(
      { _id: bedId, ...freeOrExpiredHold(now) },
      { $set: { state: 'held', stateSince: clinicNow(), holdBy: actor.id, holdExpiresAt, holdSuggestion: suggestionId, holdGender: gender } },
      'That bed was just taken. Choose another.',
    );
    // Checked again now the hold is in place: of two holds for different genders placed in
    // the same room at once, at most one stays.
    if (await this.roommateClash(bedId, gender, now)) {
      await this.beds
        .updateOne(
          { _id: bedId, state: 'held', holdBy: actor.id, holdExpiresAt },
          { $set: { state: 'free', stateSince: before.state === 'free' ? before.stateSince : clinicNow() }, $unset: HOLD_FIELDS },
        )
        .exec();
      this.events.changed();
      throw new ConflictException(OTHER_GENDER_ROOM);
    }
    return { bedId, holdExpiresAt };
  }

  /** The bed when it is in a twin room, where roommates keep to one gender; otherwise null. */
  private async twinBed(bedId: string): Promise<BedRecord | null> {
    const bed = await this.beds.findById(bedId).lean<BedRecord>().exec();
    if (!bed?.room) return null;
    const ward = await this.wards.findById(bed.ward).lean<WardRecord>().exec();
    return ward?.type === 'twin' ? bed : null;
  }

  /** Whether the bed's twin roommate is, or is held for, a patient of another gender. */
  private async roommateClash(bedId: string, gender: PatientGender, now: Date): Promise<boolean> {
    const bed = await this.twinBed(bedId);
    if (!bed) return false;
    const roommate = await this.beds
      .exists({
        _id: { $ne: bed._id },
        ward: bed.ward,
        room: bed.room,
        $or: [
          { state: 'occupied', occupantGender: { $exists: true, $ne: gender } },
          { state: 'held', holdExpiresAt: { $gt: now }, holdGender: { $exists: true, $ne: gender } },
        ],
      })
      .exec();
    return !!roommate;
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

  /** The admission record for an admit. Its unique index allows one active admission per patient. */
  private async createAdmission(
    bedId: string,
    actor: Actor,
    patient: { _id: Types.ObjectId; uhid: string; name: string },
    input: Omit<AdmitInput, 'suggestionId'> & { suggestionId?: string },
    admittedAt: Date,
  ): Promise<AdmissionDocument> {
    try {
      return await this.admissions.create({
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
  }

  async admit(bedId: string, actor: Actor, input: AdmitInput): Promise<AdmissionDocument> {
    const patient = await this.patients.findOne(input.patientId);
    const admittedAt = clinicNow();

    // 1. The admission first.
    const admission = await this.createAdmission(bedId, actor, patient, input, admittedAt);

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

  /**
   * Admits straight into a free bed (or one whose hold ran out), with no hold: for the bed
   * agent. Of two admits to one bed at once, one wins. A twin room keeps to one gender,
   * checked before and again after the bed is taken, like `hold`.
   */
  async admitToFreeBed(
    bedId: string,
    actor: Actor,
    input: Omit<AdmitInput, 'suggestionId'> & { suggestionId?: string },
  ): Promise<AdmissionDocument> {
    const patient = await this.patients.findOne(input.patientId);
    const gender = patient.gender as PatientGender;
    if (await this.roommateClash(bedId, gender, new Date())) throw new ConflictException(OTHER_GENDER_ROOM);
    const admittedAt = clinicNow();

    // 1. The admission first.
    const admission = await this.createAdmission(bedId, actor, patient, input, admittedAt);

    // 2. Then the bed. Without it, undo the admission.
    let before: BedDocument;
    try {
      before = await this.transition(
        { _id: bedId, ...freeOrExpiredHold(new Date()) },
        {
          $set: { state: 'occupied', stateSince: admittedAt, admission: admission._id, occupantGender: gender },
          $unset: HOLD_FIELDS,
        },
        'That bed was just taken.',
      );
    } catch (err) {
      await this.admissions.deleteOne({ _id: admission._id }).exec();
      throw err;
    }

    // Checked again now the bed is taken: of two patients of different genders placed in
    // one twin room at once, at most one stays.
    if (await this.roommateClash(bedId, gender, new Date())) {
      await this.freeBed(bedId, admission._id, before);
      await this.admissions.deleteOne({ _id: admission._id }).exec();
      throw new ConflictException(OTHER_GENDER_ROOM);
    }

    // 3. Then the patient record.
    await this.patients.update(String(patient._id), { status: 'Admitted', visitType: 'IPD' });
    return admission;
  }

  /** Puts back a bed an agent just took (`before` is the bed as it was), if it still holds that admission. */
  private async freeBed(bedId: string, admissionId: Types.ObjectId, before: BedDocument): Promise<void> {
    await this.beds
      .updateOne(
        { _id: bedId, state: 'occupied', admission: admissionId },
        {
          $set: { state: 'free', stateSince: before.state === 'free' ? before.stateSince : clinicNow(), admission: null },
          $unset: { occupantGender: 1 },
        },
      )
      .exec();
    this.events.changed();
  }

  /**
   * Moves an admitted patient into the bed `claim` takes, then sends the old bed to cleaning.
   * `claim` returns the new bed as it was before, or throws; the move is undone then.
   */
  private async moveAdmission(
    fromBedId: string,
    toBedId: string,
    actor: Actor,
    reason: string | undefined,
    claim: (from: BedDocument, admission: AdmissionDocument, at: Date) => Promise<void>,
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
          $set: { bed: toBedId },
          $push: { transfers: { fromBed: from._id, toBed: toBedId, at, by: actor.name, reason } },
        },
        { new: true },
      )
      .exec();
    if (!admission) throw new ConflictException(NOT_OCCUPIED);

    // 2. Then the new bed. Without it, undo the move.
    try {
      await claim(from, admission, at);
    } catch (err) {
      await this.admissions
        .updateOne({ _id: admission._id, bed: toBedId }, { $set: { bed: from._id }, $pop: { transfers: 1 } })
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

  /** Moves an admitted patient to a bed the caller holds; the old bed goes to cleaning. */
  transfer(
    fromBedId: string,
    actor: Actor,
    input: { toBedId: string; suggestionId: string; reason?: string },
  ): Promise<AdmissionDocument> {
    return this.moveAdmission(fromBedId, input.toBedId, actor, input.reason, async (from, admission, at) => {
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
    });
  }

  /**
   * Like `transfer`, but into a free bed with no hold: for the bed agent. Twin rooms keep to
   * one gender: the old bed's record of it, else `gender` (the request's). A twin bed is
   * refused when neither is known.
   */
  transferToFreeBed(
    fromBedId: string,
    toBedId: string,
    actor: Actor,
    reason?: string,
    gender?: PatientGender,
  ): Promise<AdmissionDocument> {
    return this.moveAdmission(fromBedId, toBedId, actor, reason, async (from, admission, at) => {
      const known = from.occupantGender ?? gender;
      if (!known && (await this.twinBed(toBedId))) throw new ConflictException(UNKNOWN_GENDER_ROOM);
      if (known && (await this.roommateClash(toBedId, known, new Date()))) throw new ConflictException(OTHER_GENDER_ROOM);
      const before = await this.transition(
        { _id: toBedId, ...freeOrExpiredHold(new Date()) },
        {
          $set: { state: 'occupied', stateSince: at, admission: admission._id, occupantGender: known },
          $unset: HOLD_FIELDS,
        },
        'That bed was just taken.',
      );
      if (known && (await this.roommateClash(toBedId, known, new Date()))) {
        await this.freeBed(toBedId, admission._id, before);
        throw new ConflictException(OTHER_GENDER_ROOM);
      }
    });
  }

  /**
   * Ends the admission staff saw in the bed (`admissionId`; null for a sample occupant) and
   * sends the bed to cleaning. The admission is part of the update's condition, so a panel
   * opened before a transfer or another discharge cannot end someone else's stay.
   */
  async discharge(bedId: string, actor: Actor, admissionId: string | null): Promise<void> {
    const at = clinicNow();
    let before: BedDocument;
    try {
      before = await this.transition(
        { _id: bedId, state: 'occupied', admission: admissionId ?? null },
        { $set: { state: 'cleaning', stateSince: at, admission: null, sample: false }, $unset: { occupantGender: 1 } },
        BED_CHANGED,
      );
    } catch (err) {
      // Still occupied: by someone other than the patient named. Otherwise it was never occupied.
      if (await this.beds.exists({ _id: bedId, state: 'occupied' }).exec()) throw err;
      throw new ConflictException(NOT_OCCUPIED);
    }
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
    if (admission && !admission.sample) await this.patients.update(String(admission.patient), { status: 'Discharged' });
  }

  async markCleaned(bedId: string, _actor: Actor): Promise<void> {
    await this.transition(
      { _id: bedId, state: 'cleaning' },
      { $set: { state: 'free', stateSince: clinicNow() } },
      'This bed is not waiting for cleaning.',
    );
  }

  /** Blocks a free bed, including one whose hold ran out (the board shows it as free). */
  async block(bedId: string, _actor: Actor, reason: string): Promise<void> {
    await this.transition(
      { _id: bedId, ...freeOrExpiredHold(new Date()) },
      { $set: { state: 'blocked', stateSince: clinicNow(), blockedReason: reason }, $unset: HOLD_FIELDS },
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
