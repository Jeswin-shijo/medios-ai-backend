import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Subscription } from 'rxjs';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { PatientEvents } from '../patients/patient-events';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { PriceCategory } from './revenue-catalogue';
import { ACTIVE_BILL_STATES, Bill, BillDocument, BillKind, BillState } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';
import { Correction, CorrectionDocument } from './schemas/correction.schema';
import { Estimate, EstimateDocument } from './schemas/estimate.schema';
import { Payment, PaymentDocument } from './schemas/payment.schema';
import { Refund, RefundDocument } from './schemas/refund.schema';

const LIST_LIMIT = 200;

export interface OpenBillInput {
  kind: BillKind;
  patientId: string;
  caseId?: string | null;
  erVisitId?: string | null;
  admissionId?: string | null;
  appointmentId?: string | null;
  /** YYYY-MM-DD; defaults to the clinic day. Used by opd and walk-in bills. */
  day?: string;
  /** An admission bill that continues this settled bill of the same stay. */
  continuationOf?: string | null;
}

export interface ChargeInput {
  code: string;
  name: string;
  category: PriceCategory;
  qty: number;
  unitPrice: number;
  source: { type: string; ref: string };
  needsPrice?: boolean;
  /** Why a charge was added by hand. */
  reason?: string;
  by: { id?: string; name: string };
}

export interface TotalsDelta {
  charges?: number;
  discounts?: number;
  payments?: number;
  refunds?: number;
}

/** What a set of lines does to the totals: discount and write-off lines move discounts, the rest move charges. One definition for corrections and reconcile. */
export function lineTotals(lines: { category: string; amount: number }[]): { charges: number; discounts: number } {
  let charges = 0;
  let discounts = 0;
  for (const l of lines) {
    if (l.category === 'discount' || l.category === 'write-off') discounts -= l.amount;
    else charges += l.amount;
  }
  return { charges, discounts };
}

const oid = (id: string, what: string): Types.ObjectId => {
  if (!isValidObjectId(id)) throw new BadRequestException(`${what} is not a valid id`);
  return new Types.ObjectId(id);
};

/** Bills and their charge lines. Totals change only through `adjust`, one atomic $inc. */
@Injectable()
export class RevenueBillsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RevenueBillsService.name);
  private patientSub?: Subscription;

  /** Fired after every totals change. Task 8 registers here. */
  onTotalsChanged: ((billId: string) => void)[] = [];

  constructor(
    @InjectModel(Bill.name) private readonly bills: Model<BillDocument>,
    @InjectModel(ChargeLine.name) private readonly lines: Model<ChargeLineDocument>,
    @InjectModel(Payment.name) private readonly payments: Model<PaymentDocument>,
    @InjectModel(Refund.name) private readonly refunds: Model<RefundDocument>,
    @InjectModel(Correction.name) private readonly corrections: Model<CorrectionDocument>,
    @InjectModel(Estimate.name) private readonly estimates: Model<EstimateDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    /** Absent only where the service is built by hand (seeds, specs). */
    private readonly patientEvents: PatientEvents | undefined,
    /** Read-only: whether a stay whose bill is settled is still admitted (continuation bills). */
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
  ) {}

  onModuleInit() {
    this.patientSub = this.patientEvents?.detailsChanged$.subscribe((change) => {
      void this.refreshPatient(change.id);
    });
  }

  onModuleDestroy() {
    this.patientSub?.unsubscribe();
  }

  /**
   * A bill keeps a copy of the patient's name and UHID for lists, search and printing. When the patient record changes (an ER
   * placeholder filled in) every bill of the patient takes the current ones, read from the record (final I7). A Revenue write
   * to its own records; never throws. Returns how many bills changed.
   */
  async refreshPatient(patientId: string): Promise<number> {
    try {
      if (!isValidObjectId(patientId)) return 0;
      const p = await this.patients.findById(patientId).select('name uhid').lean().exec();
      if (!p) return 0;
      const r = await this.bills
        .updateMany({ patient: p._id, $or: [{ patientName: { $ne: p.name } }, { patientUhid: { $ne: p.uhid } }] }, { $set: { patientName: p.name, patientUhid: p.uhid } })
        .exec();
      return r.modifiedCount;
    } catch (e) {
      this.logger.warn(`Bills of patient ${patientId} keep the old name (${(e as Error).message})`);
      return 0;
    }
  }

  /** BL-0001 style numbers from the shared counter collection. Atomic; a lost race skips a number. */
  async nextNumber(key: string, prefix: string): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `${prefix}-${String(c.last).padStart(4, '0')}`;
  }

  /**
   * When the Revenue Agent first ran against this database, stored once (R32). Reconcile never looks before it, so a first
   * boot on a database with history does not bill past visits.
   */
  async startedAt(): Promise<Date> {
    const c = await this.counters.findOneAndUpdate({ key: 'revenue-start' }, { $setOnInsert: { last: Date.now() } }, { upsert: true, new: true }).exec();
    return new Date(c.last);
  }

  /** The link that makes a bill unique, as a query. */
  private linkQuery(input: OpenBillInput, patient: Types.ObjectId, day: string): Record<string, unknown> {
    switch (input.kind) {
      case 'opd':
        return input.appointmentId ? { kind: 'opd', appointment: oid(input.appointmentId, 'appointmentId') } : { kind: 'opd', patient, day };
      case 'er':
        if (!input.erVisitId) throw new BadRequestException('An ER bill needs an ER visit');
        return { kind: 'er', erVisit: oid(input.erVisitId, 'erVisitId') };
      case 'admission':
        if (!input.admissionId) throw new BadRequestException('An admission bill needs an admission');
        return { kind: 'admission', admission: oid(input.admissionId, 'admissionId') };
      default:
        return { kind: 'walk-in', patient, day };
    }
  }

  /** Opens a bill, or returns the active one for the same link. */
  async open(input: OpenBillInput): Promise<BillDocument> {
    const patient = await this.patients.findById(isValidObjectId(input.patientId) ? input.patientId : null).lean().exec();
    if (!patient) throw new NotFoundException('Patient not found');
    const day = input.day ?? isoDate(clinicNow());
    const link = this.linkQuery(input, patient._id as Types.ObjectId, day);
    const find = () => this.bills.findOne({ ...link, state: { $in: ACTIVE_BILL_STATES } }).exec();
    const existing = await find();
    if (existing) return existing;
    try {
      return await this.bills.create({
        number: await this.nextNumber('revenue-bill', 'BL'),
        patient: patient._id,
        patientUhid: patient.uhid,
        patientName: patient.name,
        kind: input.kind,
        state: 'open',
        case: input.caseId ? oid(input.caseId, 'caseId') : undefined,
        erVisit: input.erVisitId ? oid(input.erVisitId, 'erVisitId') : undefined,
        admission: input.admissionId ? oid(input.admissionId, 'admissionId') : undefined,
        continuationOf: input.continuationOf ? oid(input.continuationOf, 'continuationOf') : undefined,
        appointment: input.appointmentId ? oid(input.appointmentId, 'appointmentId') : undefined,
        day: input.kind === 'opd' || input.kind === 'walk-in' ? day : undefined,
        payer: 'self',
        openedAt: clinicNow(),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const won = await find();
        if (won) return won;
      }
      throw e;
    }
  }

  /**
   * Which bill a charge goes on (spec 4.1; the continuation step is Discharge design 4.5). `day` (YYYY-MM-DD, default the
   * clinic day) picks the OPD or walk-in bill. `openContinuation: false` is for a caller that charges nothing (a procedure
   * booking): it never opens a continuation bill, so it joins the case's active bill or falls through to the day's OPD or
   * walk-in bill, as before continuation bills. A charge with no case (a kiosk visit) never reaches the stay's bills.
   */
  async forCharge(
    input: { patientId: string; caseId?: string | null; day?: string },
    opts: { openContinuation?: boolean } = {},
  ): Promise<BillDocument> {
    const patient = oid(input.patientId, 'patientId');
    if (input.caseId && isValidObjectId(input.caseId)) {
      const caseId = new Types.ObjectId(input.caseId);
      const onCase = await this.bills
        .findOne({ case: caseId, kind: { $in: ['er', 'admission'] }, state: { $in: ACTIVE_BILL_STATES } })
        .sort({ openedAt: -1, _id: -1 })
        .exec();
      if (onCase) return onCase;
      // The stay's bill was settled but the patient is still admitted: the charge belongs to the stay, not to the day.
      if (opts.openContinuation !== false) {
        const continuation = await this.continuation({ case: caseId });
        if (continuation) return continuation;
      }
    }
    const day = input.day ?? isoDate(clinicNow());
    const opd = await this.bills.findOne({ patient, kind: 'opd', day, state: { $in: ACTIVE_BILL_STATES } }).sort({ openedAt: -1 }).exec();
    if (opd) return opd;
    return this.open({ kind: 'walk-in', patientId: input.patientId, day });
  }

  /**
   * Where a late charge for a settled stay goes while the patient is still admitted: the stay's active admission bill, else a
   * new continuation bill (the same patient, case and admission, `continuationOf` = the newest settled bill). Null when `where`
   * has no settled admission bill whose admission is still active. The settled bill is never touched, and two charges at once
   * open one bill (the active-only unique index on admission bills).
   */
  async continuation(where: { case: Types.ObjectId } | { admission: Types.ObjectId }): Promise<BillDocument | null> {
    const settled = await this.bills
      .find({ kind: 'admission', state: 'settled', admission: { $exists: true }, ...where })
      .sort({ settledAt: -1, _id: -1 })
      .select('patient case admission')
      .lean()
      .exec();
    if (!settled.length) return null;
    const admitted = await this.admissions.find({ _id: { $in: settled.map((b) => b.admission) }, status: 'active' }).select('_id').lean().exec();
    const active = new Set(admitted.map((a) => String(a._id)));
    const last = settled.find((b) => active.has(String(b.admission)));
    if (!last) return null;
    return this.open({
      kind: 'admission',
      patientId: String(last.patient),
      caseId: last.case ? String(last.case) : null,
      admissionId: String(last.admission),
      continuationOf: String(last._id),
    });
  }

  /**
   * Atomically changes the totals and the balance together, then tells the listeners. With `onlyActive` the write happens only
   * while the bill is open or final, so money can never land on a bill that settled a moment before (409).
   */
  async adjust(billId: string, delta: TotalsDelta, opts: { onlyActive?: boolean } = {}): Promise<BillDocument> {
    const d = { charges: 0, discounts: 0, payments: 0, refunds: 0, ...delta };
    for (const v of Object.values(d)) {
      if (!Number.isInteger(v)) throw new BadRequestException('Amounts are whole rupees');
    }
    const id = oid(billId, 'billId');
    const bill = await this.bills
      .findOneAndUpdate(
        opts.onlyActive ? { _id: id, state: { $in: ACTIVE_BILL_STATES } } : { _id: id },
        {
          $inc: {
            'totals.charges': d.charges,
            'totals.discounts': d.discounts,
            'totals.payments': d.payments,
            'totals.refunds': d.refunds,
            'totals.balance': d.charges - d.discounts - d.payments + d.refunds,
          },
        },
        { new: true },
      )
      .exec();
    if (!bill) {
      if (opts.onlyActive && (await this.bills.exists({ _id: id }))) throw new ConflictException('This bill is settled');
      throw new NotFoundException('Bill not found');
    }
    this.notifyTotalsChanged(billId);
    return bill;
  }

  /** Tells the listeners the totals changed. Never throws, never waits. */
  notifyTotalsChanged(billId: string): void {
    for (const fn of this.onTotalsChanged) {
      try {
        Promise.resolve(fn(billId)).catch((e) => this.logger.warn(`A totals listener failed: ${(e as Error).message}`));
      } catch (e) {
        this.logger.warn(`A totals listener failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Adds a charge line once per source, across all bills. A duplicate source is "already charged" (created: false),
   * never an error, and never touches the totals.
   */
  async addCharge(billId: string, input: ChargeInput): Promise<{ line: ChargeLineDocument; created: boolean }> {
    const bill = oid(billId, 'billId');
    if (!Number.isInteger(input.qty) || input.qty < 1) throw new BadRequestException('Quantity must be a whole number, 1 or more');
    if (!Number.isInteger(input.unitPrice)) throw new BadRequestException('Prices are whole rupees');
    const amount = input.qty * input.unitPrice;
    if (!Number.isSafeInteger(amount)) throw new BadRequestException('That amount is too large');
    if (amount < 0 && input.source.type !== 'correction') throw new BadRequestException('Only a correction can take money off a bill');
    const target = await this.bills.findById(bill, { state: 1 }).lean().exec();
    if (!target) throw new NotFoundException('Bill not found');
    if (target.state === 'settled') throw new ConflictException('This bill is settled');
    try {
      const line = await this.lines.create({
        bill,
        code: input.code,
        name: input.name,
        category: input.category,
        qty: input.qty,
        unitPrice: input.unitPrice,
        amount,
        source: input.source,
        chargedAt: clinicNow(),
        by: { id: input.by.id ?? '', name: input.by.name },
        needsPrice: !!input.needsPrice,
        reason: input.reason ?? '',
      });
      try {
        await this.adjust(billId, { charges: amount }, { onlyActive: true });
      } catch (e) {
        // No total, no line: a retry can then charge cleanly.
        await this.lines.deleteOne({ _id: line._id }).exec();
        throw e;
      }
      return { line, created: true };
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const line = await this.lines.findOne({ 'source.type': input.source.type, 'source.ref': input.source.ref }).exec();
        if (line) return { line, created: false };
      }
      throw e;
    }
  }

  /**
   * True while a correction is pending (or approved but not yet applied) or a refund is requested or approved but unpaid.
   * Settling waits for these (R19).
   */
  async hasPendingMoney(billId: string | Types.ObjectId): Promise<boolean> {
    const bill = typeof billId === 'string' ? oid(billId, 'billId') : billId;
    const [c, r] = await Promise.all([
      this.corrections.exists({ bill, $or: [{ state: 'pending' }, { state: 'approved', appliedAt: null }] }).exec(),
      this.refunds.exists({ bill, state: { $in: ['requested', 'approved'] } }).exec(),
    ]);
    return !!(c || r);
  }

  async get(id: string): Promise<BillDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Bill not found');
    const bill = await this.bills.findById(id).exec();
    if (!bill) throw new NotFoundException('Bill not found');
    return bill;
  }

  async view(id: string) {
    const bill = await this.get(id);
    const [lines, payments, refunds, corrections, estimates] = await Promise.all([
      this.lines.find({ bill: bill._id }).sort({ chargedAt: 1, _id: 1 }).lean().exec(),
      this.payments.find({ bill: bill._id }).sort({ at: 1, _id: 1 }).lean().exec(),
      this.refunds.find({ bill: bill._id }).sort({ _id: 1 }).lean().exec(),
      this.corrections.find({ bill: bill._id }).sort({ _id: 1 }).lean().exec(),
      this.estimates.find({ bill: bill._id }).sort({ at: -1 }).lean().exec(),
    ]);
    return { bill: bill.toObject(), lines, payments, refunds, corrections, estimates };
  }

  async list(filter: { state?: BillState; kind?: BillKind; q?: string } = {}) {
    const query: Record<string, unknown> = {};
    if (filter.state) query.state = filter.state;
    if (filter.kind) query.kind = filter.kind;
    const q = filter.q?.trim();
    if (q) {
      const rx = new RegExp(q.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ number: rx }, { patientUhid: rx }, { patientName: rx }];
    }
    return this.bills.find(query).sort({ openedAt: -1, _id: -1 }).limit(LIST_LIMIT).lean().exec();
  }

  /** What a doctor or nurse sees: the active ER or admission bill, else today's non-zero OPD or walk-in bill. */
  async patientTotal(patientId: string): Promise<{ charges: number; payments: number; balance: number; billNumber: string } | null> {
    if (!isValidObjectId(patientId)) return null;
    const patient = new Types.ObjectId(patientId);
    const active = { state: { $in: ACTIVE_BILL_STATES } };
    let bill = await this.bills.findOne({ patient, kind: { $in: ['er', 'admission'] }, ...active }).sort({ openedAt: -1, _id: -1 }).lean().exec();
    if (!bill) {
      bill = await this.bills
        .findOne({ patient, kind: { $in: ['opd', 'walk-in'] }, day: isoDate(clinicNow()), 'totals.balance': { $ne: 0 }, ...active })
        .sort({ openedAt: -1, _id: -1 })
        .lean()
        .exec();
    }
    if (!bill) return null;
    return { charges: bill.totals.charges, payments: bill.totals.payments, balance: bill.totals.balance, billNumber: bill.number };
  }
}
