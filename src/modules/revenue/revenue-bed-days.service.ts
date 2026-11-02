import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { MessagesService } from '../coordinator/messages.service';
import { Case, CaseDocument } from '../coordinator/schemas/case.schema';
import { PriceListService } from './price-list.service';
import { nursingCode, wardGroupOf } from './revenue-catalogue';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { ACTIVE_BILL_STATES, Bill, BillDocument } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';

const BY = { name: 'Revenue Agent' };
const DAY_MS = 24 * 60 * 60 * 1000;
/** A stay longer than this many periods is a data error; stop rather than loop. */
const MAX_PERIODS = 3660;

type Msg = { case: string | null; payload: Record<string, unknown> };
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Bed days and daily nursing charges for admitted patients. Each 24-hour period from the admission time is charged once,
 * at the rate of the ward the patient was in when the period started. Handlers never throw.
 * Task 8 appends the estimate and deposit to `onAssigned`; Task 9 appends the final-bill request to `onDischarged`.
 */
@Injectable()
export class RevenueBedDaysService {
  private readonly logger = new Logger(RevenueBedDaysService.name);

  /** The clinic clock; a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly messages: MessagesService,
    private readonly prices: PriceListService,
    private readonly bills: RevenueBillsService,
    registration: RevenueCoordinatorRegistration,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(Bill.name) private readonly billModel: Model<BillDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
  ) {
    registration.capture.set('bed.assigned', (id) => this.run('bed.assigned', id, (m) => this.onAssigned(m)));
    registration.capture.set('bed.transferred', (id) => this.run('bed.transferred', id, (m) => this.onTransferred(m)));
    registration.capture.set('bed.discharged', (id) => this.run('bed.discharged', id, (m) => this.onDischarged(m)));
  }

  /** Loads the message and runs the handler. Nothing escapes. */
  private async run(type: string, messageId: string, fn: (m: Msg) => Promise<void>): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message) {
        this.logger.warn(`${type}: message ${messageId} not found`);
        return;
      }
      await fn({ case: message.case ?? null, payload: message.payload ?? {} });
    } catch (e) {
      this.logger.warn(`${type}: no bed-day charge made (${(e as Error).message})`);
    }
  }

  /** The admission named by the message, else the one the case points to. */
  private async admissionOf(m: Msg) {
    const named = str(m.payload.admissionId);
    let id = named && isValidObjectId(named) ? named : null;
    if (!id && m.case && isValidObjectId(m.case)) {
      const c = await this.cases.findById(m.case).select('refs').lean().exec();
      const ref = c?.refs?.admissionId;
      id = ref && isValidObjectId(ref) ? ref : null;
    }
    return id ? this.admissions.findById(id).lean().exec() : null;
  }

  /** bed.assigned: the admission bill (an ER bill of the same case becomes it), then the days so far. */
  private async onAssigned(m: Msg): Promise<void> {
    const admission = await this.admissionOf(m);
    if (!admission) {
      this.logger.warn('bed.assigned: admission not found; no bed-day charge');
      return;
    }
    if (admission.sample) return;
    // Step 1: the admission bill.
    await this.ensureBill(admission, m.case);
    // Step 2: bed days and nursing so far. Task 8 adds the estimate and deposit after this step.
    await this.chargeDue(String(admission._id));
  }

  /** bed.transferred: the ward history lives on the Admission, so there is only the days to catch up. */
  private async onTransferred(m: Msg): Promise<void> {
    const admission = await this.admissionOf(m);
    if (!admission || admission.sample) return;
    await this.chargeDue(String(admission._id));
  }

  /** bed.discharged: the case may be null and the message may carry no admission id. */
  private async onDischarged(m: Msg): Promise<void> {
    let admission = await this.admissionOf(m);
    if (!admission) {
      // R14: the Admission keeps its last bed; the bed's own admission link is already cleared.
      const bedId = str(m.payload.bedId);
      if (bedId && isValidObjectId(bedId)) {
        admission = await this.admissions.findOne({ bed: new Types.ObjectId(bedId), status: 'discharged' }).sort({ dischargedAt: -1, _id: -1 }).lean().exec();
      }
    }
    if (!admission) {
      this.logger.warn('bed.discharged: admission not found; no bed-day charge');
      return;
    }
    if (admission.sample) return;
    // Step 1: make sure the stay has a bill (a missed bed.assigned would leave none).
    await this.ensureBill(admission, m.case);
    // Step 2: the last bed day. Task 9 adds the final-bill request after this step.
    await this.chargeDue(String(admission._id));
  }

  /**
   * The admission's bill. Any existing bill for it (even a settled one) is returned, so a replay never opens a second.
   * Else the case's active ER bill becomes it (its ER charges stay); else a new admission bill opens.
   */
  private async ensureBill(admission: { _id: unknown; patient: unknown; bed: unknown; transfers?: { fromBed: unknown }[] }, caseId: string | null): Promise<BillDocument> {
    const admissionId = new Types.ObjectId(String(admission._id));
    const existing = await this.billModel.findOne({ kind: 'admission', admission: admissionId }).sort({ openedAt: -1, _id: -1 }).exec();
    if (existing) return existing;
    const wardType = await this.firstWardType(admission);
    if (caseId && isValidObjectId(caseId)) {
      const er = await this.billModel
        .findOne({ case: new Types.ObjectId(caseId), kind: 'er', state: { $in: ACTIVE_BILL_STATES } })
        .sort({ openedAt: -1, _id: -1 })
        .exec();
      if (er) {
        const converted = await this.billModel
          .findOneAndUpdate({ _id: er._id, kind: 'er' }, { $set: { kind: 'admission', admission: admissionId, ...(wardType ? { wardType } : {}) } }, { new: true })
          .exec();
        if (converted) return converted;
        const again = await this.billModel.findOne({ kind: 'admission', admission: admissionId }).exec();
        if (again) return again;
      }
    }
    const bill = await this.bills.open({ kind: 'admission', patientId: String(admission.patient), caseId, admissionId: String(admission._id) });
    if (wardType && !bill.wardType) {
      await this.billModel.updateOne({ _id: bill._id }, { $set: { wardType } }).exec();
      bill.wardType = wardType;
    }
    return bill;
  }

  private async firstWardType(admission: { bed: unknown; transfers?: { fromBed: unknown }[] }) {
    const first = admission.transfers?.[0]?.fromBed ?? admission.bed;
    const bed = await this.beds.findById(first as Types.ObjectId).select('ward').lean().exec();
    if (!bed) return null;
    return (await this.prices.bedRate(String(bed.ward))).wardType;
  }

  /**
   * Charges every started 24-hour period not yet charged: `bed-day` and `nursing-day`, ref `<admissionId>:<k>`.
   * Period k starts at admittedAt + k days. While admitted it counts once that moment has come; after discharge only if it
   * starts before the discharge time (so a discharge at exactly 24 h is one day). Returns the number of new lines.
   */
  async chargeDue(admissionId: string, now: Date = this.clock()): Promise<number> {
    if (!isValidObjectId(admissionId)) return 0;
    const admission = await this.admissions.findById(admissionId).lean().exec();
    if (!admission || admission.sample) return 0;
    const bill = await this.billModel
      .findOne({ kind: 'admission', admission: admission._id, state: { $in: ACTIVE_BILL_STATES } })
      .sort({ openedAt: -1, _id: -1 })
      .exec();
    if (!bill) return 0;

    const discharged = admission.status === 'discharged' && admission.dischargedAt;
    const end = discharged ? new Date(Math.min(now.getTime(), new Date(admission.dischargedAt!).getTime())) : now;
    const admittedMs = new Date(admission.admittedAt).getTime();
    const starts: number[] = [];
    for (let k = 0; k < MAX_PERIODS; k++) {
      const start = admittedMs + k * DAY_MS;
      if (discharged ? start >= end.getTime() : start > end.getTime()) break;
      starts.push(start);
    }
    if (!starts.length) return 0;

    // The ward history: the first bed, then each transfer's new bed from the time it moved.
    const transfers = [...(admission.transfers ?? [])].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const firstBed = transfers[0]?.fromBed ?? admission.bed;
    const bedIds = [firstBed, ...transfers.map((t) => t.toBed)];
    const bedDocs = await this.beds.find({ _id: { $in: bedIds } }).select('ward').lean().exec();
    const wardOfBed = new Map(bedDocs.map((b) => [String(b._id), String(b.ward)]));
    const rates = new Map<string, Awaited<ReturnType<PriceListService['bedRate']>>>();
    const nursing = new Map<string, Awaited<ReturnType<PriceListService['priceFor']>>>();

    let created = 0;
    for (let k = 0; k < starts.length; k++) {
      const ref = `${admissionId}:${k}`;
      try {
        const bedAtStart = transfers.filter((t) => new Date(t.at).getTime() <= starts[k]).pop()?.toBed ?? firstBed;
        const wardId = wardOfBed.get(String(bedAtStart));
        if (!wardId) {
          this.logger.warn(`Admission ${admissionId} day ${k + 1}: bed ${String(bedAtStart)} not found; will retry`);
          continue;
        }
        let rate = rates.get(wardId);
        if (!rate) {
          rate = await this.prices.bedRate(wardId);
          rates.set(wardId, rate);
        }
        const day = k + 1;
        if (!(await this.chargeLines.exists({ 'source.type': 'bed-day', 'source.ref': ref }).exec())) {
          const r = await this.bills.addCharge(String(bill._id), {
            code: `bed:${rate.wardType}`,
            name: `Bed, ${rate.wardName || rate.wardType} (day ${day})`,
            category: 'bed',
            qty: 1,
            unitPrice: rate.price,
            source: { type: 'bed-day', ref },
            needsPrice: rate.price === 0,
            by: BY,
          });
          if (r.created) created++;
        }
        const group = wardGroupOf(rate.wardType);
        if (group && !(await this.chargeLines.exists({ 'source.type': 'nursing-day', 'source.ref': ref }).exec())) {
          const code = nursingCode(group);
          let p = nursing.get(code);
          if (!p) {
            try {
              p = await this.prices.priceFor(code);
            } catch (e) {
              this.logger.warn(`Price lookup for ${code} failed (${(e as Error).message}); charging 0`);
              p = { price: 0, name: code, needsPrice: true };
            }
            nursing.set(code, p);
          }
          const r = await this.bills.addCharge(String(bill._id), {
            code,
            name: `${p.name === code ? 'Nursing and doctor visit' : p.name} (day ${day})`,
            category: 'nursing',
            qty: 1,
            unitPrice: p.price,
            source: { type: 'nursing-day', ref },
            needsPrice: p.needsPrice,
            by: BY,
          });
          if (r.created) created++;
        }
      } catch (e) {
        this.logger.warn(`Admission ${admissionId} day ${k + 1}: not charged (${(e as Error).message})`);
      }
    }
    return created;
  }

  /** Every active admission that has a revenue bill gets its days caught up. One bad admission never stops the rest. */
  async tick(now: Date = this.clock()): Promise<number> {
    let total = 0;
    try {
      const ids = await this.billModel.distinct('admission', { kind: 'admission', state: { $in: ACTIVE_BILL_STATES }, admission: { $exists: true } }).exec();
      const active = await this.admissions.find({ _id: { $in: ids }, status: 'active', sample: { $ne: true } }).select('_id').lean().exec();
      for (const a of active) {
        try {
          total += await this.chargeDue(String(a._id), now);
        } catch (e) {
          this.logger.warn(`Bed days for admission ${String(a._id)} failed (${(e as Error).message})`);
        }
      }
    } catch (e) {
      this.logger.warn(`Bed-day tick failed (${(e as Error).message})`);
    }
    return total;
  }
}
