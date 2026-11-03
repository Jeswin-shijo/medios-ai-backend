import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';
import { ESTIMATE_HIGH, ESTIMATE_LOW, nursingCode, procCode, wardGroupOf } from './revenue-catalogue';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueSettingsService } from './revenue-settings.service';
import { Bill, BillDocument } from './schemas/bill.schema';
import { Estimate, EstimateDocument, EstimateLine } from './schemas/estimate.schema';

const BY = { id: '', name: 'Revenue Agent' };
/** A booking that still counts toward the estimate: not cancelled and not stuck waiting for a room. */
const COUNTED = ['requested', 'booked', 'in-progress', 'done'];

/** Procedure bookings that belong to this bill: the case's, else the patient's booked ones from the bill's opening. */
export async function bookingsOf(model: Model<ProcedureBookingDocument>, bill: { case?: unknown; patient: unknown; openedAt: Date }, statuses: string[]) {
  const filter = bill.case
    ? { case: bill.case, status: { $in: statuses } }
    : { patient: bill.patient, status: { $in: statuses }, start: { $gte: bill.openedAt } };
  return model.find(filter).sort({ createdAt: 1, _id: 1 }).lean().exec();
}

export interface EstimateEdit {
  days?: number;
  extra?: { name: string; amount: number }[];
}

/**
 * The estimate for a bill: a price guide, never a limit. It is redrafted from current records, so a booking counts once
 * and a cancelled one drops out; the desk's edits survive. An ER bill estimates only its procedures (no stay).
 */
@Injectable()
export class RevenueEstimatesService {
  private readonly logger = new Logger(RevenueEstimatesService.name);

  constructor(
    private readonly registration: RevenueCoordinatorRegistration,
    private readonly settings: RevenueSettingsService,
    private readonly prices: PriceListService,
    @InjectModel(Bill.name) private readonly billModel: Model<BillDocument>,
    @InjectModel(Estimate.name) private readonly estimates: Model<EstimateDocument>,
    @InjectModel(ProcedureBooking.name) private readonly procedures: Model<ProcedureBookingDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
  ) {}

  async get(billId: string) {
    if (!isValidObjectId(billId)) return null;
    return this.estimates.findOne({ bill: new Types.ObjectId(billId) }).lean().exec();
  }

  /** The stay's lines for the ward the patient is in now. */
  private async stayLines(bill: BillDocument, days: number | null, cfg: Awaited<ReturnType<RevenueSettingsService['get']>>) {
    const wardType = bill.wardType;
    if (bill.kind !== 'admission' || !wardType) return { lines: [] as EstimateLine[], days: 0 };
    const group = wardGroupOf(wardType);
    if (!group) return { lines: [] as EstimateLine[], days: 0 };
    const stay = days ?? cfg.stay[wardType] ?? 0;
    let rate = 0;
    let wardName = wardType as string;
    const admission = bill.admission ? await this.admissions.findById(bill.admission).select('bed transfers').lean().exec() : null;
    const bedId = admission?.transfers?.length ? admission.transfers[admission.transfers.length - 1].toBed : admission?.bed;
    const bed = bedId ? await this.beds.findById(bedId).select('ward').lean().exec() : null;
    if (bed) {
      const r = await this.prices.bedRate(String(bed.ward));
      rate = r.price;
      wardName = r.wardName || wardName;
    }
    const nursing = (await this.prices.priceFor(nursingCode(group))).price;
    const lines: EstimateLine[] = [
      { name: `Bed, ${wardName} (${stay} days)`, amount: stay * rate },
      { name: `Nursing and doctor visits (${stay} days)`, amount: stay * nursing },
      { name: `Tests and medicines allowance (${stay} days)`, amount: stay * (cfg.allowance[wardType] ?? 0) },
    ];
    return { lines, days: stay };
  }

  /** One line per booking: the procedure's package price. */
  private async packageLines(bookings: { procedure: string; number: string }[]): Promise<EstimateLine[]> {
    const lines: EstimateLine[] = [];
    for (const b of bookings) {
      const p = await this.prices.priceFor(procCode(b.procedure));
      lines.push({ name: `${p.name === procCode(b.procedure) ? b.procedure : p.name} (${b.number})`, amount: p.price });
    }
    return lines;
  }

  private build(lines: EstimateLine[], extra: EstimateLine[]) {
    const all = [...lines, ...extra];
    const total = all.reduce((sum, l) => sum + l.amount, 0);
    return { lines: all, total, low: Math.round(total * ESTIMATE_LOW), high: Math.round(total * ESTIMATE_HIGH) };
  }

  /**
   * Drafts (or redrafts) the bill's estimate and tells the Coordinator when the range changed. Returns null when there is
   * nothing to estimate (no stay and no procedures). Safe to run twice.
   */
  async draft(billId: string) {
    if (!isValidObjectId(billId)) return null;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill) return null;
    const cfg = await this.settings.get();
    const existing = await this.estimates.findOne({ bill: bill._id }).exec();
    const stay = await this.stayLines(bill, existing?.daysEdited ? existing.days : null, cfg);
    const bookings = await bookingsOf(this.procedures, bill, COUNTED);
    const packages = await this.packageLines(bookings);
    const extra = (existing?.extra ?? []).map((e) => ({ name: e.name, amount: e.amount }));
    const built = this.build([...stay.lines, ...packages], extra);
    if (!existing && !stay.lines.length && !packages.length) return null;
    const days = stay.days;
    const bookingIds = bookings.map((b) => String(b._id));
    const set = { lines: built.lines, days, total: built.total, low: built.low, high: built.high, bookings: bookingIds, at: clinicNow() };
    const changed = !existing || existing.low !== built.low || existing.high !== built.high;
    let doc: EstimateDocument;
    if (existing) {
      // R23: a new range is a new state, so its message is owed until it is sent.
      doc = (await this.estimates.findByIdAndUpdate(existing._id, changed ? { $set: set, $unset: { announcedAt: 1 } } : { $set: set }, { new: true }).exec())!;
    } else {
      try {
        doc = await this.estimates.create({ bill: bill._id, ...set, extra: [], by: BY });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
        doc = (await this.estimates.findOne({ bill: bill._id }).exec())!;
      }
    }
    if (changed || !doc.announcedAt) await this.announce(bill, doc);
    return doc.toObject();
  }

  /** The reconcile pass: sends the message of an estimate with no announcedAt. Never throws; true when it sent. */
  async reannounce(estimateId: string): Promise<boolean> {
    const estimate = isValidObjectId(estimateId) ? await this.estimates.findById(estimateId).exec() : null;
    const bill = estimate ? await this.billModel.findById(estimate.bill).exec() : null;
    if (!estimate || !bill) return false;
    return this.announce(bill, estimate);
  }

  private async announce(bill: BillDocument, estimate: EstimateDocument): Promise<boolean> {
    try {
      await this.registration.send(
        'revenue.estimate-ready',
        bill,
        { billId: String(bill._id), billNumber: bill.number, low: estimate.low, high: estimate.high },
        { text: `Estimate ready, ${this.rupees(estimate.low)} to ${this.rupees(estimate.high)}`, dedupeKey: `estimate:${String(bill._id)}:${estimate.low}:${estimate.high}` },
      );
      await this.estimates.updateOne({ _id: estimate._id }, { $set: { announcedAt: new Date() } }).exec();
      return true;
    } catch (e) {
      this.logger.warn(`Estimate for ${bill.number} not announced (${(e as Error).message})`);
      return false;
    }
  }

  private rupees(n: number) {
    return `₹${n.toLocaleString('en-IN')}`;
  }

  /** The desk changes the days or the extra lines. Total, low and high follow. */
  async edit(actor: Actor, estimateId: string, input: EstimateEdit) {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) throw new ForbiddenException('Only the billing desk can edit an estimate');
    if (!isValidObjectId(estimateId)) throw new BadRequestException('estimateId is not a valid id');
    const current = await this.estimates.findById(estimateId).exec();
    if (!current) throw new NotFoundException('Estimate not found');
    if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > 60)) throw new BadRequestException('Days must be a whole number from 1 to 60');
    if (input.extra !== undefined) {
      if (!Array.isArray(input.extra) || input.extra.length > 20) throw new BadRequestException('At most 20 extra lines');
      for (const l of input.extra) {
        if (!l || typeof l.name !== 'string' || !l.name.trim() || l.name.length > 80) throw new BadRequestException('Each extra line needs a name (80 letters at most)');
        if (!Number.isInteger(l.amount) || l.amount < 0 || l.amount > 100_000_000) throw new BadRequestException('Extra amounts are whole rupees');
      }
    }
    const bill = await this.billModel.findById(current.bill).exec();
    if (!bill) throw new NotFoundException('Bill not found');
    const cfg = await this.settings.get();
    const days = input.days ?? (current.daysEdited ? current.days : null);
    const extra = (input.extra ?? current.extra).map((e) => ({ name: e.name.trim(), amount: e.amount }));
    const stay = await this.stayLines(bill, days, cfg);
    const bookings = await bookingsOf(this.procedures, bill, COUNTED);
    const packages = await this.packageLines(bookings);
    const built = this.build([...stay.lines, ...packages], extra);
    const updated = await this.estimates
      .findByIdAndUpdate(
        current._id,
        {
          $set: {
            lines: built.lines, days: stay.days || current.days, total: built.total, low: built.low, high: built.high, extra,
            daysEdited: input.days !== undefined ? true : current.daysEdited, bookings: bookings.map((b) => String(b._id)),
            by: { id: actor.id, name: actor.name }, at: clinicNow(),
          },
          $unset: { announcedAt: 1 },
        },
        { new: true },
      )
      .exec();
    if (updated) await this.announce(bill, updated);
    return updated!.toObject();
  }
}
