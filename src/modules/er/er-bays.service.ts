import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import type { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import type { TriageColour } from './er-rules';
import { ER_BAY_KINDS, ErBay, ErBayDocument, ErBayKind } from './schemas/er-bay.schema';
import { ErVisit, ErVisitDocument } from './schemas/er-visit.schema';

const NAME_MAX = 40;

export interface ErBayView {
  id: string;
  name: string;
  kind: ErBayKind;
  order: number;
  outOfUse: boolean;
  /** The visit using the bay, with its number, or null when free. */
  visitId: string | null;
  visitNumber: string | null;
}

export interface ErBayInput {
  id?: string;
  name: string;
  kind: ErBayKind;
  outOfUse: boolean;
}

export interface ErBayAssignment {
  visitId: string;
  bayId: string | null;
  bayName: string | null;
}

/** The hospital's default ER layout: Bay 1 and 2 are resus, then eight more bays, then eight stretchers. */
export const DEFAULT_BAYS: { name: string; kind: ErBayKind }[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ name: `Bay ${i + 1}`, kind: (i < 2 ? 'resus' : 'bay') as ErBayKind })),
  ...Array.from({ length: 8 }, (_, i) => ({ name: `Stretcher ${i + 1}`, kind: 'stretcher' as ErBayKind })),
];

const toView = (b: any, visitNumber: string | null): ErBayView => ({
  id: String(b._id),
  name: b.name,
  kind: b.kind,
  order: b.order,
  outOfUse: !!b.outOfUse,
  visitId: b.visit ? String(b.visit) : null,
  visitNumber,
});

const free = { $or: [{ visit: { $exists: false } }, { visit: null }] };

/** ER bays and stretchers: which are in use, who is in each, and the admin's list. Bay moves are not case messages. */
@Injectable()
export class ErBaysService {
  constructor(
    @InjectModel(ErBay.name) private readonly bays: Model<ErBayDocument>,
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
  ) {}

  /** Makes the default list, only when there are no bays at all. */
  async ensureDefaults(): Promise<void> {
    if ((await this.bays.estimatedDocumentCount().exec()) > 0) return;
    await this.bays.insertMany(DEFAULT_BAYS.map((b, order) => ({ ...b, order, outOfUse: false })));
  }

  /** How many bays are not out of use. */
  countInUse(): Promise<number> {
    return this.bays.countDocuments({ outOfUse: false }).exec();
  }

  async list(): Promise<ErBayView[]> {
    const bays = await this.bays.find().sort({ order: 1 }).lean().exec();
    const ids = bays.filter((b) => b.visit).map((b) => b.visit);
    const numbers = new Map(
      (await this.visits.find({ _id: { $in: ids } }).select('number').lean().exec()).map((v) => [String(v._id), v.number]),
    );
    return bays.map((b) => toView(b, b.visit ? (numbers.get(String(b.visit)) ?? null) : null));
  }

  /** The bay to offer: a free, in-use one. Red goes to resus first; no other colour is offered resus. */
  async suggest(colour: TriageColour): Promise<ErBayView | null> {
    const open = await this.bays.find({ outOfUse: false, ...free }).sort({ order: 1 }).lean().exec();
    const order: ErBayKind[] = colour === 'red' ? ['resus', 'bay', 'stretcher'] : ['bay', 'stretcher'];
    for (const kind of order) {
      const found = open.find((b) => b.kind === kind);
      if (found) return toView(found, null);
    }
    return null;
  }

  /** Puts a visit in a bay (freeing its old one), or takes it out of its bay when `bayId` is null. */
  async assign(_actor: Actor, visitId: string, bayId: string | null): Promise<ErBayAssignment> {
    const visit = isValidObjectId(visitId) ? await this.visits.findById(visitId).select('status').lean().exec() : null;
    if (!visit) throw new NotFoundException('ER visit not found');
    if (visit.status === 'left') throw new ConflictException('This patient has left the ER.');
    const id = new Types.ObjectId(visitId);

    if (bayId === null) {
      const updated = await this.visits.updateOne({ _id: id, status: { $ne: 'left' } }, { $unset: { bay: 1, bayName: 1 } }).exec();
      if (!updated.matchedCount) throw new ConflictException('This patient has left the ER.');
      await this.freeVisit(visitId);
      return { visitId, bayId: null, bayName: null };
    }

    if (!isValidObjectId(bayId)) throw new NotFoundException('Bay not found');
    // The one atomic step: a bay that is in use and free (or already this visit's) takes the visit.
    const claimed = await this.bays
      .findOneAndUpdate({ _id: bayId, outOfUse: false, $or: [{ visit: { $exists: false } }, { visit: null }, { visit: id }] }, { $set: { visit: id } }, { new: true })
      .lean()
      .exec();
    if (!claimed) {
      const bay = await this.bays.findById(bayId).select('outOfUse').lean().exec();
      if (!bay) throw new NotFoundException('Bay not found');
      if (bay.outOfUse) throw new ConflictException('That bay is out of use.');
      throw new ConflictException('That bay is taken.');
    }
    const placed = await this.visits.updateOne({ _id: id, status: { $ne: 'left' } }, { $set: { bay: claimed._id, bayName: claimed.name } }).exec();
    if (!placed.matchedCount) {
      // The patient left between the two steps: give the bay back.
      await this.bays.updateOne({ _id: claimed._id, visit: id }, { $unset: { visit: 1 } }).exec();
      throw new ConflictException('This patient has left the ER.');
    }
    await this.bays.updateMany({ visit: id, _id: { $ne: claimed._id } }, { $unset: { visit: 1 } }).exec();
    return { visitId, bayId: String(claimed._id), bayName: claimed.name };
  }

  /** Frees every bay a visit holds. The visit's own fields are the caller's to change. */
  async freeVisit(visitId: string): Promise<void> {
    await this.bays.updateMany({ visit: new Types.ObjectId(visitId) }, { $unset: { visit: 1 } }).exec();
  }

  /** Frees bays still held by a visit that has left (a leave that stopped before its bay was freed). Returns how many. */
  async freeLeftVisits(): Promise<number> {
    const held = await this.bays.find({ visit: { $exists: true, $ne: null } }).select('visit').lean().exec();
    if (!held.length) return 0;
    const gone = await this.visits.find({ _id: { $in: held.map((b) => b.visit) }, status: 'left' }).select('_id').lean().exec();
    if (!gone.length) return 0;
    const res = await this.bays.updateMany({ visit: { $in: gone.map((v) => v._id) } }, { $unset: { visit: 1 } }).exec();
    return res.modifiedCount;
  }

  /** Replaces the list. Bays are matched by id; the list order becomes the bay order. Admin only. */
  async save(actor: Actor, input: ErBayInput[]): Promise<ErBayView[]> {
    if (actor.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change the ER bays.');
    if (!Array.isArray(input)) throw new BadRequestException('Send the list of bays');
    const seen = new Set<string>();
    const ids = new Set<string>();
    const wanted = input.map((b) => {
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (!name) throw new BadRequestException('Every bay needs a name');
      if (name.length > NAME_MAX) throw new BadRequestException(`A bay name can have at most ${NAME_MAX} characters`);
      if (!ER_BAY_KINDS.includes(b.kind)) throw new BadRequestException('A bay is a bay, resus or stretcher');
      if (b.id !== undefined && b.id !== null && !isValidObjectId(b.id)) throw new BadRequestException('A bay id is not valid');
      if (b.id) {
        if (ids.has(String(b.id))) throw new BadRequestException('The same bay is in the list twice');
        ids.add(String(b.id));
      }
      const key = name.toLowerCase();
      if (seen.has(key)) throw new BadRequestException(`There are two bays called "${name}"`);
      seen.add(key);
      return { id: b.id ? String(b.id) : null, name, kind: b.kind, outOfUse: !!b.outOfUse };
    });

    const existing = await this.bays.find().lean().exec();
    const byId = new Map(existing.map((b) => [String(b._id), b]));
    const kept = new Set(wanted.filter((w) => w.id).map((w) => w.id as string));
    for (const w of wanted) if (w.id && !byId.has(w.id)) throw new NotFoundException('A bay in the list no longer exists');

    // Occupied bays stay as they are: not removed, renamed away or taken out of use. Refuse up front
    // so nothing is half saved; each change below is also conditional on the bay still being free,
    // so a patient placed meanwhile is never displaced.
    for (const b of existing) {
      if (!b.visit) continue;
      const w = wanted.find((x) => x.id === String(b._id));
      if (!w) throw new ConflictException(`${b.name} has a patient in it, so it cannot be removed.`);
      if (w.name !== b.name) throw new ConflictException(`${b.name} has a patient in it, so it cannot be renamed.`);
      if (w.outOfUse && !b.outOfUse) throw new ConflictException(`${b.name} has a patient in it, so it cannot be taken out of use.`);
    }
    for (const b of existing) {
      const w = wanted.find((x) => x.id === String(b._id));
      if (!w) {
        const gone = await this.bays.deleteOne({ _id: b._id, ...free }).exec();
        if (!gone.deletedCount) throw new ConflictException(`${b.name} has a patient in it, so it cannot be removed.`);
      } else if (w.name !== b.name || (w.outOfUse && !b.outOfUse)) {
        const done = await this.bays.updateOne({ _id: b._id, ...free }, { $set: { name: w.name, outOfUse: w.outOfUse } }).exec();
        if (!done.matchedCount) {
          throw new ConflictException(`${b.name} has a patient in it, so it cannot be ${w.name !== b.name ? 'renamed' : 'taken out of use'}.`);
        }
      }
    }
    for (const [order, w] of wanted.entries()) {
      if (w.id && kept.has(w.id)) {
        await this.bays.updateOne({ _id: w.id }, { $set: { kind: w.kind, order, outOfUse: w.outOfUse, name: w.name } }).exec();
      } else {
        await this.bays.create({ name: w.name, kind: w.kind, order, outOfUse: w.outOfUse });
      }
    }
    return this.list();
  }
}
