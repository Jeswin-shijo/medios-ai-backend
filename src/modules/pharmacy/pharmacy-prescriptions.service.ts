import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { PatientsService } from '../patients/patients.service';
import { Prescription, PrescriptionDocument, PrescriptionItem } from '../prescriptions/schemas/prescription.schema';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from '../beds/actor';
import { Frequency, matchMedicine, parseDose, parseDurationDays, pickProduct, quantityFor, routeFor, routeFromText } from './pharmacy-catalogue';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { LineSpec, PharmacyOrdersService } from './pharmacy-orders.service';
import { startKey } from './pharmacy-rounds';
import { Flag } from './pharmacy-rules';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

/** How long one sync holds its claim on an order (real time). */
const CLAIM_MS = 60_000;
const OPEN = ['to-check', 'query', 'approved'];

export type SyncResult = 'synced' | 'busy' | 'current';

export type ItemStatus = { lineId: string; status: string; red: number; amber: number; waitingForStock: boolean } | { status: 'not-sent' };

/**
 * One prescription item as a medicine line. Pure. A medicine the list does not know becomes an unlisted line
 * (its typed name, no quantity). A dose the list cannot read (another unit, or not a number and unit) keeps
 * its text and gets the "Dose not readable" flag.
 */
export function prescriptionLine(item: PrescriptionItem & { _id?: unknown }, rev: number): LineSpec {
  const prescriptionItem = String(item._id ?? '');
  const med = matchMedicine(item.medicine);
  const days = item.frequency === 'STAT' ? null : parseDurationDays(item.duration);
  if (!med) {
    return {
      medicine: null,
      product: null,
      freeName: item.medicine,
      dose: null,
      doseText: item.dose,
      unit: '',
      route: routeFromText(item.route) ?? String(item.route ?? '').trim().toLowerCase().slice(0, 30),
      frequency: item.frequency,
      durationDays: days,
      quantity: null,
      prescriptionItem,
      prescriptionRev: rev,
    };
  }
  const parsed = parseDose(item.dose);
  const dose = parsed && parsed.unit === med.unit ? parsed.value : null;
  const product = pickProduct(med, dose, item.route);
  return {
    medicine: med.key,
    product: product.key,
    dose,
    ...(dose === null ? { doseText: item.dose } : {}),
    unit: med.unit,
    route: routeFor(product, item.route),
    frequency: item.frequency,
    durationDays: days,
    quantity: dose === null ? null : quantityFor(product, dose, item.frequency as Frequency, days),
    prescriptionItem,
    prescriptionRev: rev,
  };
}

const same = (a: LineSpec, l: PharmacyLineDocument | PharmacyLine) =>
  (a.medicine ? a.medicine === l.medicine : !l.medicine && (a.freeName ?? '').toLowerCase() === (l.freeName ?? '').toLowerCase()) &&
  (a.dose !== null ? a.dose === l.dose : l.dose === null && (a.doseText ?? '').toLowerCase() === (l.doseText ?? '').toLowerCase()) &&
  a.frequency === l.frequency &&
  a.durationDays === l.durationDays;

/** Saved prescriptions become OPD-counter orders, one per prescription, kept in step with every edit. */
@Injectable()
export class PharmacyPrescriptionsService {
  private readonly logger = new Logger(PharmacyPrescriptionsService.name);

  constructor(
    @InjectModel(Prescription.name) private readonly rxs: Model<PrescriptionDocument>,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    private readonly orders: PharmacyOrdersService,
    private readonly checks: PharmacyChecksService,
    private readonly patients: PatientsService,
  ) {}

  /**
   * Brings the prescription's order up to the prescription's current revision. Idempotent per revision: a second
   * caller while one runs gets `busy`, an order already at the revision gets `current`.
   */
  async sync(prescriptionId: string): Promise<SyncResult> {
    const first = await this.load(prescriptionId);
    if (!first || first.pharmacyRev <= 0) return 'current';
    let order: PharmacyOrderDocument | null = await this.orderDocs.findOne({ prescription: first._id }).exec();
    if (order && order.prescriptionRev >= first.pharmacyRev) return this.settled(first, 'current');
    if (!order) {
      // Nothing to dispense and nothing sent before: no order is made.
      if (!first.items.some((i) => i.status === 'Active')) return this.settled(first, 'current');
      let patient;
      try {
        patient = await this.patients.findOne(first.uhid);
      } catch (e) {
        if (e instanceof NotFoundException) {
          this.logger.warn(`Prescription ${String(first._id)} has no patient record for its UHID; not sent to Pharmacy`);
          return this.settled(first, 'current');
        }
        throw e;
      }
      try {
        order = await this.orders.createOrder({
          patient: { _id: patient._id, uhid: patient.uhid, name: patient.name },
          priority: 'routine',
          orderedBy: this.by(first),
          source: 'prescription',
          setting: 'OPD',
          prescription: first._id,
          prescriptionRev: 0,
        });
      } catch (e) {
        // The unique prescription index: another sync made the order first.
        if ((e as { code?: number }).code === 11000) return 'busy';
        throw e;
      }
    }
    const orderId = order._id;
    const now = Date.now();
    const until = new Date(now + CLAIM_MS);
    const claimed = await this.orderDocs
      .updateOne({ _id: orderId, $or: [{ syncingUntil: { $exists: false } }, { syncingUntil: null }, { syncingUntil: { $lt: new Date(now) } }] }, { $set: { syncingUntil: until } })
      .exec();
    if (!claimed.modifiedCount) return 'busy';
    try {
      // Read again under the claim: an edit may have landed since the first read.
      const rx = await this.load(prescriptionId);
      const fresh = await this.orderDocs.findById(orderId).exec();
      if (!rx || !fresh || fresh.prescriptionRev >= rx.pharmacyRev) return rx ? await this.settled(rx, 'current') : 'current';
      await this.apply(rx, fresh);
      // Guarded on this sync's own claim: one that overran its claim never lowers the revision or frees a newer claim.
      const done = await this.orderDocs.updateOne({ _id: orderId, syncingUntil: until }, { $set: { prescriptionRev: rx.pharmacyRev }, $unset: { syncingUntil: '' } }).exec();
      if (!done.modifiedCount) return 'busy';
      return await this.settled(rx, 'synced');
    } finally {
      await this.orderDocs.updateOne({ _id: orderId, syncingUntil: until }, { $unset: { syncingUntil: '' } }).exec();
    }
  }

  /** Clears the pending mark of the revision just handled (not a newer one saved meanwhile). */
  private async settled(rx: PrescriptionDocument, result: SyncResult): Promise<SyncResult> {
    await this.rxs.updateOne({ _id: rx._id, pharmacyRev: rx.pharmacyRev }, { $unset: { pharmacyPending: '' } }).exec();
    return result;
  }

  private async apply(rx: PrescriptionDocument, order: PharmacyOrderDocument): Promise<void> {
    const rev = rx.pharmacyRev;
    const by = this.by(rx);
    const actor: Actor = { id: by.id, name: by.name, role: UserRole.DOCTOR };
    // Earlier revisions' unissued lines go (this closes an open query and publishes pharmacy.cancelled).
    const old = await this.lines.find({ order: order._id, status: { $in: OPEN }, $or: [{ prescriptionRev: { $lt: rev } }, { prescriptionRev: { $exists: false } }] }).sort({ _id: 1 }).exec();
    for (const l of old) await this.cancelOld(actor, String(l._id));

    // An Active item with no line of this revision yet: carry over an identical issued line, else add a line.
    const specs = rx.items.filter((i) => i.status === 'Active').map((i) => prescriptionLine(i, rev));
    const mine = await this.lines.find({ order: order._id, prescriptionRev: rev }).exec();
    const have = new Set(mine.map((l) => l.prescriptionItem));
    const issued = await this.lines.find({ order: order._id, status: 'issued', prescriptionRev: { $lt: rev } }).sort({ _id: 1 }).exec();
    const taken = new Set<string>();
    const add: LineSpec[] = [];
    for (const spec of specs) {
      if (have.has(spec.prescriptionItem)) continue;
      const match = issued.find((l) => !taken.has(String(l._id)) && same(spec, l));
      if (match) {
        taken.add(String(match._id));
        await this.lines.updateOne({ _id: match._id, status: 'issued' }, { $set: { prescriptionItem: spec.prescriptionItem, prescriptionRev: rev } }).exec();
        continue;
      }
      add.push(spec);
    }
    if (add.length) await this.orders.addLines(order, add);

    // Every line of this revision still waiting: held at once on an unconfirmed red allergy, then re-checked with the others.
    const waiting = await this.lines.find({ order: order._id, prescriptionRev: rev, status: 'to-check' }).sort({ _id: 1 }).exec();
    await this.checks.holdAtOnce(waiting);
    await this.orders.recheckPatient(String(order.patient), 'prescription', { skip: waiting.map((l) => String(l._id)) });
    await this.orders.announceOrdered(order);
    const toCheck = await this.lines.find({ _id: { $in: waiting.map((l) => l._id) }, status: 'to-check' }).sort({ _id: 1 }).exec();
    if (toCheck.length) await this.orders.publish(String(order._id), toCheck.map((l) => ({ type: 'pharmacy.to-check' as const, lineId: String(l._id), dedupeKey: startKey('pharmacy.to-check', l) })));
  }

  /** Cancels one earlier line. A version race is retried once; a line that is issued or closed now has moved on and is left. */
  private async cancelOld(actor: Actor, lineId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.checks.cancel(actor, lineId, 'Prescription edited');
        return;
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        const now = await this.lines.findById(lineId).select('status').lean<{ status: string }>().exec();
        if (!now || !OPEN.includes(now.status)) return;
        if (attempt >= 1) throw e;
      }
    }
  }

  /** The status of each item of a prescription, by item id. */
  async status(prescriptionId: string): Promise<Record<string, ItemStatus>> {
    const rx = await this.load(prescriptionId);
    if (!rx) throw new NotFoundException(`Prescription ${prescriptionId} not found`);
    const order = await this.orderDocs.findOne({ prescription: rx._id }).lean<PharmacyOrderDocument>().exec();
    const lines = order ? await this.lines.find({ order: order._id }).sort({ _id: 1 }).lean<PharmacyLineDocument[]>().exec() : [];
    const out: Record<string, ItemStatus> = {};
    for (const item of rx.items) {
      const id = String((item as { _id?: unknown })._id);
      // The newest line of the item: the highest revision, then the latest.
      const mine = lines.filter((l) => l.prescriptionItem === id);
      const line = mine.reduce<PharmacyLineDocument | undefined>((best, l) => (!best || (l.prescriptionRev ?? 0) >= (best.prescriptionRev ?? 0) ? l : best), undefined);
      if (!line) {
        out[id] = { status: 'not-sent' };
        continue;
      }
      const flags = ((line.flags ?? []) as Flag[]).filter((f) => f.version === line.version);
      out[id] = {
        lineId: String(line._id),
        status: line.status,
        red: flags.filter((f) => f.severity === 'red').length,
        amber: flags.filter((f) => f.severity === 'amber').length,
        waitingForStock: !!line.waitingForStock,
      };
    }
    return out;
  }

  private by(rx: PrescriptionDocument): { id: string; name: string } {
    return rx.pharmacyBy?.id ? { id: rx.pharmacyBy.id, name: rx.pharmacyBy.name } : { id: 'unknown', name: rx.doctor || 'Doctor' };
  }

  private load(id: string): Promise<PrescriptionDocument | null> {
    return isValidObjectId(id) ? this.rxs.findById(id).exec() : Promise.resolve(null);
  }
}
