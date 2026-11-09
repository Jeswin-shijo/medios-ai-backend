import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { DischargeOrder, DischargeOrderDocument, OPEN_ORDER_STATES } from '../discharge/schemas/discharge-order.schema';
import { ErVisit, ErVisitDocument } from '../er/schemas/er-visit.schema';
import { LabLine, LabLineDocument } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
import { ConsultRequest, ConsultRequestDocument } from '../scheduling/schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueBillsService, lineTotals } from './revenue-bills.service';
import { RevenueCaptureService } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueDepositsService } from './revenue-deposits.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueOpdService } from './revenue-opd.service';
import { PaymentsService } from './revenue-payments.service';
import { RefundsService } from './revenue-refunds.service';
import { ACTIVE_BILL_STATES, Bill, BillDocument } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';
import { Correction, CorrectionDocument } from './schemas/correction.schema';
import { Estimate, EstimateDocument } from './schemas/estimate.schema';
import { Payment, PaymentDocument } from './schemas/payment.schema';
import { Refund, RefundDocument } from './schemas/refund.schema';

/** Records younger than this are left alone: the request that made them may still be finishing its own writes and messages. */
export const RECONCILE_GRACE_MS = 30_000;
/** Messages, tasks and charges are healed only for records changed within this long. */
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Lab lines past collection: a charge was made for each when the sample was collected. */
const COLLECTED = ['collected', 'received', 'awaiting-validation', 'released'];
const BATCH = 300;
/** At most this many missed charges are made per pass; rows examined are not capped. */
const MISS_CAP = 200;
const stamp = (doc: unknown, key: 'createdAt' | 'updatedAt'): Date | undefined => (doc as Partial<Record<typeof key, Date>>)[key];

export interface RevenueReconcileResult {
  announced: number;
  tasks: number;
  charges: number;
  totals: number;
  reversals: number;
  clocks: number;
  bedDays: number;
  opdFees: number;
  /** Kiosk bills settled (R30). */
  settled: number;
}

@Injectable()
export class RevenueReconcileService implements OnModuleInit {
  private readonly logger = new Logger(RevenueReconcileService.name);

  constructor(
    private readonly registration: RevenueCoordinatorRegistration,
    private readonly bills: RevenueBillsService,
    private readonly final: FinalBillService,
    private readonly payments: PaymentsService,
    private readonly estimates: RevenueEstimatesService,
    private readonly deposits: RevenueDepositsService,
    private readonly refunds: RefundsService,
    private readonly capture: RevenueCaptureService,
    private readonly bedDays: RevenueBedDaysService,
    private readonly opd: RevenueOpdService,
    @InjectModel(Bill.name) private readonly billModel: Model<BillDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Refund.name) private readonly refundModel: Model<RefundDocument>,
    @InjectModel(Correction.name) private readonly corrections: Model<CorrectionDocument>,
    @InjectModel(Estimate.name) private readonly estimateModel: Model<EstimateDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    @InjectModel(Clock.name) private readonly clockModel: Model<ClockDocument>,
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    @InjectModel(LabRequest.name) private readonly labRequests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly labLines: Model<LabLineDocument>,
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly pharmacyOrders: Model<PharmacyOrderDocument>,
    @InjectModel(ProcedureBooking.name) private readonly procedures: Model<ProcedureBookingDocument>,
    @InjectModel(ConsultRequest.name) private readonly consults: Model<ConsultRequestDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    /** Read-only: a stay whose discharge window has opened is owed its final-bill request. */
    @InjectModel(DischargeOrder.name) private readonly dischargeOrders: Model<DischargeOrderDocument>,
  ) {}

  /** R32: remember when the Revenue Agent first ran, so the first pass never looks before it. */
  async onModuleInit(): Promise<void> {
    try {
      await this.bills.startedAt();
    } catch (e) {
      this.logger.warn(`Revenue start time not stored (${(e as Error).message})`);
    }
  }

  /**
   * Repairs what a failed send or a crash left undone, then runs the agent's periodic work. Every step is idempotent, a step
   * that fails is logged and does not stop the next, and records younger than 30 seconds are left alone. Nothing older than
   * 7 days, or than the Revenue Agent's first start, is touched (R32). The scheduler (a later task) calls reconcile() every minute.
   */
  async reconcile(): Promise<RevenueReconcileResult> {
    const old = new Date(Date.now() - RECONCILE_GRACE_MS);
    const start = await this.bills.startedAt();
    const since = new Date(Math.max(Date.now() - RECONCILE_WINDOW_MS, start.getTime()));
    const out: RevenueReconcileResult = { announced: 0, tasks: 0, charges: 0, totals: 0, reversals: 0, clocks: 0, bedDays: 0, opdFees: 0, settled: 0 };
    await this.step('charges', async () => (out.charges += await this.missedCharges(old, since)));
    await this.step('bed days', async () => (out.bedDays += await this.bedDays.tick()));
    await this.step('OPD fees', async () => (out.opdFees += await this.opd.catchUp(undefined, since)));
    await this.step('totals', async () => (out.totals += await this.healTotals(old, since)));
    await this.step('kiosk bills', async () => (out.settled += await this.settleKioskBills(old, since)));
    await this.step('final bills', async () => (out.tasks += await this.requestFinals(old, since)));
    await this.step('bill messages', async () => (out.announced += await this.reannounceBills(old, since)));
    await this.step('payment messages', async () => (out.announced += await this.reannouncePayments(old, since)));
    await this.step('estimate messages', async () => (out.announced += await this.reannounceEstimates(old, since)));
    await this.step('refund messages', async () => (out.announced += await this.reannounceRefunds(old, since)));
    await this.step('refund clocks', async () => (out.clocks += await this.stopDeadRefundClocks(old)));
    await this.step('tasks', async () => (out.tasks += await this.restoreTasks(old, since)));
    await this.step('deposit and top-up messages', async () => (out.announced += await this.reannounceAsks(old, since)));
    await this.step('suggested reversals', async () => (out.reversals += await this.resuggestReversals(old, since)));
    return out;
  }

  private async step(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e) {
      this.logger.error(`Revenue reconcile: ${what} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Walks every row of a filter in _id order, a page at a time (R30): handled rows never crowd out the rest, because nothing
   * here is "the N oldest". A page callback returns false to stop early.
   */
  private async walk(model: Model<any>, filter: Record<string, unknown>, each: (rows: any[]) => Promise<void | false>): Promise<void> {
    let last: unknown = null;
    for (;;) {
      const rows = await model.find(last ? { ...filter, _id: { $gt: last } } : filter).sort({ _id: 1 }).limit(BATCH).lean().exec();
      if (!rows.length) return;
      if ((await each(rows)) === false) return;
      if (rows.length < BATCH) return;
      last = rows[rows.length - 1]._id;
    }
  }

  /** Of these source refs, the ones with no charge line yet (one query for the whole page). */
  private async uncharged(type: string, refs: string[]): Promise<Set<string>> {
    if (!refs.length) return new Set();
    const have = new Set((await this.chargeLines.distinct('source.ref', { 'source.type': type, 'source.ref': { $in: refs } }).exec()) as string[]);
    return new Set(refs.filter((r) => !have.has(r)));
  }

  // ---------- messages ----------

  /** Bills whose message for the current state never went out: final, settled, or open with an open `:final` task. */
  private async reannounceBills(old: Date, since: Date): Promise<number> {
    const window = { announcedAt: { $exists: false }, updatedAt: { $lte: old, $gte: since } };
    let n = 0;
    await this.walk(this.billModel, { ...window, state: { $in: ['final', 'settled'] } }, async (rows) => {
      for (const r of rows) if (await this.final.announce(String(r._id))) n++;
    });
    await this.walk(this.alerts, { link: /^revenue-bill:[0-9a-f]{24}:final$/, status: { $ne: 'Completed' } }, async (tasks) => {
      const ids = tasks.map((t) => String(t.link).split(':')[1]).filter((id) => isValidObjectId(id));
      const asking = ids.length ? await this.billModel.find({ ...window, _id: { $in: ids }, state: 'open' }).select('_id').lean().exec() : [];
      for (const b of asking) if (await this.final.announce(String(b._id))) n++;
    });
    return n;
  }

  private async reannouncePayments(old: Date, since: Date): Promise<number> {
    let n = 0;
    await this.walk(this.paymentModel, { announcedAt: { $exists: false }, cancelled: { $exists: false }, updatedAt: { $lte: old, $gte: since } }, async (rows) => {
      for (const r of rows) if (await this.payments.announce(String(r._id))) n++;
    });
    return n;
  }

  private async reannounceEstimates(old: Date, since: Date): Promise<number> {
    let n = 0;
    await this.walk(this.estimateModel, { announcedAt: { $exists: false }, updatedAt: { $lte: old, $gte: since } }, async (rows) => {
      for (const r of rows) if (await this.estimates.reannounce(String(r._id))) n++;
    });
    return n;
  }

  /** Refunds whose message for the current state never went out (refund-due, refund-paid, refund-void). */
  private async reannounceRefunds(old: Date, since: Date): Promise<number> {
    let n = 0;
    await this.walk(this.refundModel, { announcedAt: { $exists: false }, state: { $in: ['approved', 'paid', 'void'] }, updatedAt: { $lte: old, $gte: since } }, async (rows) => {
      for (const r of rows) if (await this.refunds.reannounce(String(r._id))) n++;
    });
    return n;
  }

  /**
   * A running revenue-refund clock whose refund was rejected, voided or withdrawn (deleted) has nobody to stop it, and its
   * escalation cannot be acknowledged. Sends `revenue.refund-void` for it (deduped) and completes the task.
   */
  private async stopDeadRefundClocks(old: Date): Promise<number> {
    let n = 0;
    await this.walk(this.clockModel, { def: 'revenue-refund', state: 'running', startedAt: { $lte: old } }, async (running) => {
      for (const c of running) {
        const ref = c.ref ?? '';
        try {
          const refund = isValidObjectId(ref) ? await this.refundModel.findById(ref).lean().exec() : null;
          if (refund && refund.state !== 'rejected' && refund.state !== 'void') continue;
          const bill = refund ? await this.billModel.findById(refund.bill).select('number case').lean().exec() : null;
          const billNumber = bill?.number ?? '';
          await this.registration.send(
            'revenue.refund-void',
            { number: billNumber, case: bill?.case ?? c.case ?? undefined },
            { refundId: ref, refundNumber: refund?.number ?? c.detail ?? '', billNumber },
            { text: `Refund ${refund?.number ?? c.detail ?? ''} is no longer owed`, dedupeKey: `refund-void:${ref}` },
          );
          await this.alerts.updateOne({ link: `revenue-refund:${ref}`, status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
          n++;
        } catch (e) {
          this.logger.warn(`Refund clock ${String(c._id)} not stopped (${(e as Error).message})`);
        }
      }
    });
    return n;
  }

  /** Deposit, top-up and top-up-met messages that a failed send left unsent. */
  private async reannounceAsks(old: Date, since: Date): Promise<number> {
    let n = 0;
    await this.walk(
      this.billModel,
      {
        updatedAt: { $lte: old, $gte: since },
        $or: [
          { 'depositAsk.amount': { $exists: true }, 'depositAsk.announcedAt': { $exists: false } },
          { 'topupAsk.amount': { $exists: true }, 'topupAsk.announcedAt': { $exists: false } },
          { 'topupAsk.metAt': { $exists: true }, 'topupAsk.metAnnouncedAt': { $exists: false } },
        ],
      },
      async (rows) => {
        for (const r of rows) n += await this.deposits.announceAsks(String(r._id));
      },
    );
    return n;
  }

  // ---------- tasks ----------

  /**
   * The final bill is asked for (R29) when an open ER bill's visit has left for any reason but admission, or an open admission
   * bill's admission is discharged or has a discharge order in progress whose window has opened (a lost window request, or a
   * continuation bill opened after it), and no `:final` task exists. request() itself refuses a bill that already has one.
   */
  private async requestFinals(old: Date, since: Date): Promise<number> {
    let n = 0;
    const window = { state: 'open', updatedAt: { $lte: old, $gte: since } };
    await this.walk(this.billModel, { ...window, kind: 'er', erVisit: { $exists: true } }, async (bills) => {
      const left = await this.visits.find({ _id: { $in: bills.map((b) => b.erVisit) }, status: 'left', leftReason: { $ne: 'admitted' } }).select('_id').lean().exec();
      const gone = new Set(this.ids(left));
      for (const b of bills) if (gone.has(String(b.erVisit)) && (await this.final.request('agent', String(b._id)))) n++;
    });
    await this.walk(this.billModel, { ...window, kind: 'admission', admission: { $exists: true } }, async (bills) => {
      const stays = bills.map((b) => b.admission);
      const done = await this.admissions.find({ _id: { $in: stays }, status: 'discharged' }).select('_id').lean().exec();
      const leaving = await this.dischargeOrders
        .find({ admission: { $in: stays }, state: { $in: OPEN_ORDER_STATES }, windowOpenedAt: { $ne: null } })
        .select('admission')
        .lean()
        .exec();
      const due = new Set([...this.ids(done), ...leaving.map((o) => String(o.admission))]);
      for (const b of bills) if (due.has(String(b.admission)) && (await this.final.request('agent', String(b._id)))) n++;
    });
    return n;
  }

  /** Deposit, top-up, final-bill and refund tasks that are missing. A task that exists, completed or not, is never touched. */
  private async restoreTasks(old: Date, since: Date): Promise<number> {
    let n = 0;
    await this.walk(this.billModel, { state: { $in: ACTIVE_BILL_STATES }, kind: { $ne: 'er' }, updatedAt: { $lte: old, $gte: since } }, async (rows) => {
      for (const b of rows) {
        try {
          if (await this.deposits.ensureDepositTask(String(b._id))) n++;
          if (b.kind === 'admission' && (await this.deposits.ensureTopUpTask(String(b._id)))) n++;
        } catch (e) {
          this.logger.warn(`Tasks of bill ${String(b._id)} not restored (${(e as Error).message})`);
        }
      }
    });
    await this.walk(this.billModel, { state: 'open', kind: { $in: ['er', 'admission'] }, announcedAt: { $exists: true }, updatedAt: { $lte: old, $gte: since } }, async (rows) => {
      for (const b of rows) if (await this.final.ensureFinalTask(String(b._id))) n++;
    });
    await this.walk(this.refundModel, { state: 'approved', announcedAt: { $exists: true }, updatedAt: { $lte: old, $gte: since } }, async (rows) => {
      for (const r of rows) if (await this.refunds.ensureTask(String(r._id))) n++;
    });
    return n;
  }

  private ids(docs: { _id: unknown }[]): string[] {
    return docs.map((d) => String(d._id));
  }

  // ---------- kiosk bills ----------

  /**
   * R30: an open OPD or walk-in bill holding a reception kiosk visit (an `op-visit` line) with nothing due goes through the one
   * auto-settle rule. Today's settles once its visits are over, which catches a token event that was missed; an earlier clinic
   * day's settles whatever the visits' state, the backstop once the day is over (a demo that pins one clinic day relies on the
   * token rule alone). Only lines made inside the window; a bill touched in the last 30 seconds is left alone.
   */
  private async settleKioskBills(old: Date, since: Date): Promise<number> {
    const today = isoDate(clinicNow());
    const ids = (await this.chargeLines.distinct('bill', { 'source.type': 'op-visit', updatedAt: { $gte: since } }).exec()) as unknown[];
    let n = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const due = await this.billModel
        .find({ _id: { $in: ids.slice(i, i + BATCH) }, kind: { $in: ['opd', 'walk-in'] }, state: { $in: ACTIVE_BILL_STATES }, 'totals.balance': 0, updatedAt: { $lte: old } })
        .select('_id day')
        .lean()
        .exec();
      for (const b of due) if (await this.final.autoSettleOpd(String(b._id), { dayOver: !!b.day && b.day < today })) n++;
    }
    return n;
  }

  // ---------- charges ----------

  private async has(type: string, ref: string): Promise<boolean> {
    return !!(await this.chargeLines.exists({ 'source.type': type, 'source.ref': ref }).exec());
  }

  /**
   * Charges for things that happened while the agent was down or a message was lost, found from the last 7 days of ER, Lab,
   * Pharmacy and Scheduling records. Every page of rows is checked against the charge lines in one query (R30), and only the
   * misses are replayed through the same handler the message would have used, which checks the charge source first, so
   * nothing is charged twice. Returns how many new charges appeared (at most MISS_CAP per pass).
   */
  private async missedCharges(old: Date, since: Date): Promise<number> {
    const window = { updatedAt: { $lte: old, $gte: since } };
    let n = 0;
    const full = () => n >= MISS_CAP;
    const guard = async (what: string, id: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        this.logger.warn(`Missed ${what} charge ${id} not made (${(e as Error).message})`);
      }
    };
    const replay = async (type: string, refType: string, ref: string, message: { case: string | null; payload: Record<string, unknown> }) => {
      await this.capture.replay(type, message);
      if (await this.has(refType, ref)) n++;
    };

    // ER visits: arrival, and the doctor's visit once seen. A visit whose bill is already settled is left alone.
    await this.walk(this.visits, window, async (visits) => {
      const noArrival = await this.uncharged('er.arrived', this.ids(visits));
      const noDoctor = await this.uncharged('er.doctor-seen', this.ids(visits.filter((v) => v.doctorSeenAt)));
      for (const v of visits) {
        const id = String(v._id);
        if (full()) return false;
        if (!noArrival.has(id) && !noDoctor.has(id)) continue;
        await guard('ER', id, async () => {
          if (await this.billModel.exists({ kind: 'er', erVisit: v._id, state: 'settled' }).exec()) return;
          const message = { case: v.case ? String(v.case) : null, payload: { visitId: id } };
          if (noArrival.has(id)) await replay('er.arrived', 'er.arrived', id, message);
          if (noDoctor.has(id)) await replay('er.doctor-seen', 'er.doctor-seen', id, message);
        });
      }
    });

    // Lab: tests collected or later, grouped by request.
    await this.walk(this.labLines, { ...window, status: { $in: COLLECTED } }, async (lines) => {
      const missing = await this.uncharged('lab', lines.map((l) => `${l.request}:${l.test}`));
      const byRequest = new Map<string, string[]>();
      for (const l of lines) if (missing.has(`${l.request}:${l.test}`)) byRequest.set(String(l.request), [...(byRequest.get(String(l.request)) ?? []), l.test]);
      for (const [requestId, tests] of byRequest) {
        if (full()) return false;
        await guard('lab', requestId, async () => {
          const request = await this.labRequests.findById(requestId).select('case').lean().exec();
          if (!request) return;
          await this.capture.replay('lab.collected', { case: String(request.case), payload: { requestId, tests } });
          for (const t of tests) if (await this.has('lab', `${requestId}:${t}`)) n++;
        });
      }
    });

    // Pharmacy: lines issued, even if the doctor has stopped them since (a stopped line that was never issued has no quantity).
    await this.walk(this.pharmacyLines, { ...window, status: { $in: ['issued', 'stopped'] }, 'issued.quantity': { $gte: 1 } }, async (lines) => {
      const missing = await this.uncharged('pharmacy.issued', this.ids(lines));
      for (const l of lines) {
        const id = String(l._id);
        if (!missing.has(id)) continue;
        if (full()) return false;
        await guard('pharmacy', id, async () => {
          const order = await this.pharmacyOrders.findById(l.order).select('case').lean().exec();
          await replay('pharmacy.issued', 'pharmacy.issued', id, { case: order?.case ? String(order.case) : null, payload: { lineId: id, quantity: l.issued?.quantity } });
        });
      }
    });

    // Scheduling: procedures done, consults seen.
    await this.walk(this.procedures, { ...window, status: 'done' }, async (rows) => {
      const missing = await this.uncharged('procedure', this.ids(rows));
      for (const b of rows) {
        if (!missing.has(String(b._id))) continue;
        if (full()) return false;
        await guard('procedure', String(b._id), () => replay('scheduling.procedure-done', 'procedure', String(b._id), { case: b.case ? String(b.case) : null, payload: { bookingId: String(b._id) } }));
      }
    });
    await this.walk(this.consults, { ...window, status: 'seen' }, async (rows) => {
      const missing = await this.uncharged('consult', this.ids(rows));
      for (const c of rows) {
        if (!missing.has(String(c._id))) continue;
        if (full()) return false;
        await guard('consult', String(c._id), () => replay('scheduling.consult-seen', 'consult', String(c._id), { case: c.case ? String(c.case) : null, payload: { consultId: String(c._id) } }));
      }
    });
    return n;
  }

  // ---------- totals ----------

  /**
   * Rewrites the totals of an active bill when they disagree with its records (a crash between a line insert and its total
   * leaves them behind): charges = the non-discount lines, discounts = the discount and write-off lines, payments = the
   * non-cancelled payments, refunds = the paid refunds, balance = charges - discounts - payments + refunds. A correction's
   * lines count only once the correction is applied (a ref of `<id>:discount` belongs to correction `<id>`). Every bill with a
   * record changed inside the window is checked (R30); one touched in the last 30 seconds, or with a correction being applied,
   * is skipped. The write is guarded by the totals it read.
   */
  private async healTotals(old: Date, since: Date): Promise<number> {
    const touched = new Set<string>();
    for (const model of [this.chargeLines, this.paymentModel, this.refundModel, this.corrections] as Model<any>[]) {
      for (const id of (await model.distinct('bill', { updatedAt: { $gte: since } }).exec()) as unknown[]) touched.add(String(id));
    }
    for (const id of (await this.billModel.distinct('_id', { updatedAt: { $gte: since } }).exec()) as unknown[]) touched.add(String(id));
    const all = [...touched];
    let healed = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const candidates = await this.billModel.find({ _id: { $in: all.slice(i, i + BATCH) }, state: { $in: ACTIVE_BILL_STATES } }).select('_id totals updatedAt').lean().exec();
      for (const bill of candidates) if (await this.healBill(bill, old)) healed++;
    }
    return healed;
  }

  private async healBill(bill: { _id: Types.ObjectId; totals?: { charges: number; discounts: number; payments: number; refunds: number; balance: number } }, old: Date): Promise<boolean> {
    try {
      if (new Date(stamp(bill, 'updatedAt') ?? 0) > old) return false;
      if (await this.corrections.exists({ bill: bill._id, state: 'approved', appliedAt: null }).exec()) return false;
      const [lines, payments, refunds] = await Promise.all([
        this.chargeLines.find({ bill: bill._id }).select('amount category source createdAt').lean().exec(),
        this.paymentModel.find({ bill: bill._id }).select('amount cancelled updatedAt').lean().exec(),
        this.refundModel.find({ bill: bill._id, state: 'paid' }).select('amount paid updatedAt').lean().exec(),
      ]);
      const recent = [...lines.map((l) => stamp(l, 'createdAt')), ...payments.map((p) => stamp(p, 'updatedAt')), ...refunds.map((r) => stamp(r, 'updatedAt'))].some((t) => t && new Date(t) > old);
      if (recent) return false;
      const correctionIds = [...new Set(lines.filter((l) => l.source.type === 'correction').map((l) => l.source.ref.split(':')[0]))].filter((id) => isValidObjectId(id));
      const applied = new Set(
        correctionIds.length ? this.ids(await this.corrections.find({ _id: { $in: correctionIds.map((id) => new Types.ObjectId(id)) }, appliedAt: { $ne: null } }).select('_id').lean().exec()) : [],
      );
      const counted = lines.filter((l) => l.source.type !== 'correction' || applied.has(l.source.ref.split(':')[0]));
      const { charges, discounts } = lineTotals(counted);
      const paid = payments.filter((p) => !p.cancelled).reduce((sum, p) => sum + p.amount, 0);
      const refunded = refunds.reduce((sum, r) => sum + (r.paid?.amount ?? r.amount), 0);
      const next = { charges, discounts, payments: paid, refunds: refunded, balance: charges - discounts - paid + refunded };
      const t = bill.totals ?? { charges: 0, discounts: 0, payments: 0, refunds: 0, balance: 0 };
      if (t.charges === next.charges && t.discounts === next.discounts && t.payments === next.payments && t.refunds === next.refunds && t.balance === next.balance) return false;
      const r = await this.billModel
        .updateOne(
          { _id: bill._id, state: { $in: ACTIVE_BILL_STATES }, 'totals.charges': t.charges, 'totals.discounts': t.discounts, 'totals.payments': t.payments, 'totals.refunds': t.refunds, 'totals.balance': t.balance },
          { $set: { totals: next } },
        )
        .exec();
      if (!r.modifiedCount) return false;
      this.logger.warn(`Bill ${String(bill._id)}: totals rewritten from its records (balance ${t.balance} to ${next.balance})`);
      this.bills.notifyTotalsChanged(String(bill._id));
      return true;
    } catch (e) {
      this.logger.warn(`Totals of bill ${String(bill._id)} not checked (${(e as Error).message})`);
      return false;
    }
  }

  // ---------- suggested reversals ----------

  /**
   * A lab test cancelled while a desk correction was pending on its charge line lost the agent's suggested reversal. When the
   * line is charged, not reversed, free of a pending correction and has no suggestion yet, suggest it again. The suggestion
   * itself is once per line, so a replay is safe.
   */
  private async resuggestReversals(old: Date, since: Date): Promise<number> {
    let n = 0;
    await this.walk(this.labLines, { status: 'cancelled', updatedAt: { $lte: old, $gte: since } }, async (cancelled) => {
      const tests = new Map(cancelled.map((l) => [`${l.request}:${l.test}`, l.test as string]));
      const charged = await this.chargeLines.find({ 'source.type': 'lab', 'source.ref': { $in: [...tests.keys()] }, reversed: false }).select('_id bill source').lean().exec();
      if (!charged.length) return;
      const ids = charged.map((c) => c._id);
      const busy = new Set((await this.corrections.distinct('line', { line: { $in: ids }, state: 'pending' }).exec()).map(String));
      const suggestedBefore = { kind: 'reversal', suggested: true, state: { $ne: 'void' } };
      const done = new Set((await this.corrections.distinct('line', { line: { $in: ids }, ...suggestedBefore }).exec()).map(String));
      for (const c of charged) {
        const id = String(c._id);
        if (busy.has(id) || done.has(id)) continue;
        try {
          await this.capture.suggestReversal({ billId: String(c.bill), lineId: id, reason: `Lab test ${tests.get(c.source.ref)} was cancelled after it was charged` });
          if (await this.corrections.exists({ line: c._id, ...suggestedBefore }).exec()) n++;
        } catch (e) {
          this.logger.warn(`Suggested reversal for charge line ${id} not made (${(e as Error).message})`);
        }
      }
    });
    return n;
  }
}
