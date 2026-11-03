import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { ErVisit, ErVisitDocument } from '../er/schemas/er-visit.schema';
import { LabLine, LabLineDocument } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
import { ConsultRequest, ConsultRequestDocument } from '../scheduling/schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueBillsService } from './revenue-bills.service';
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
}

@Injectable()
export class RevenueReconcileService {
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
  ) {}

  /**
   * Repairs what a failed send or a crash left undone, then runs the agent's periodic work. Every step is idempotent, a step
   * that fails is logged and does not stop the next, and records younger than 30 seconds are left alone. The scheduler
   * (a later task) calls reconcile() every minute.
   */
  async reconcile(): Promise<RevenueReconcileResult> {
    const old = new Date(Date.now() - RECONCILE_GRACE_MS);
    const since = new Date(Date.now() - RECONCILE_WINDOW_MS);
    const out: RevenueReconcileResult = { announced: 0, tasks: 0, charges: 0, totals: 0, reversals: 0, clocks: 0, bedDays: 0, opdFees: 0 };
    await this.step('charges', async () => (out.charges += await this.missedCharges(old, since)));
    await this.step('bed days', async () => (out.bedDays += await this.bedDays.tick()));
    await this.step('OPD fees', async () => (out.opdFees += await this.opd.catchUp()));
    await this.step('totals', async () => (out.totals += await this.healTotals(old)));
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

  private ids(docs: { _id: unknown }[]): string[] {
    return docs.map((d) => String(d._id));
  }

  // ---------- messages ----------

  /** Bills whose message for the current state never went out: final, settled, or open with an open `:final` task. */
  private async reannounceBills(old: Date, since: Date): Promise<number> {
    const window = { announcedAt: { $exists: false }, updatedAt: { $lte: old, $gte: since } };
    const owed = await this.billModel.find({ ...window, state: { $in: ['final', 'settled'] } }).select('_id').sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    const tasks = await this.alerts.find({ link: /^revenue-bill:[0-9a-f]{24}:final$/, status: { $ne: 'Completed' } }).select('link').limit(BATCH).lean().exec();
    const taskBills = tasks.map((t) => (t.link ?? '').split(':')[1]).filter((id) => isValidObjectId(id));
    const asking = taskBills.length ? await this.billModel.find({ ...window, _id: { $in: taskBills }, state: 'open' }).select('_id').lean().exec() : [];
    let n = 0;
    for (const id of [...this.ids(owed), ...this.ids(asking)]) if (await this.final.announce(id)) n++;
    return n;
  }

  private async reannouncePayments(old: Date, since: Date): Promise<number> {
    const owed = await this.paymentModel.find({ announcedAt: { $exists: false }, cancelled: { $exists: false }, updatedAt: { $lte: old, $gte: since } }).select('_id').sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    let n = 0;
    for (const id of this.ids(owed)) if (await this.payments.announce(id)) n++;
    return n;
  }

  private async reannounceEstimates(old: Date, since: Date): Promise<number> {
    const owed = await this.estimateModel.find({ announcedAt: { $exists: false }, updatedAt: { $lte: old, $gte: since } }).select('_id').sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    let n = 0;
    for (const id of this.ids(owed)) if (await this.estimates.reannounce(id)) n++;
    return n;
  }

  /** Refunds whose message for the current state never went out (refund-due, refund-paid, refund-void). */
  private async reannounceRefunds(old: Date, since: Date): Promise<number> {
    const owed = await this.refundModel.find({ announcedAt: { $exists: false }, state: { $in: ['approved', 'paid', 'void'] }, updatedAt: { $lte: old, $gte: since } }).select('_id').sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    let n = 0;
    for (const id of this.ids(owed)) if (await this.refunds.reannounce(id)) n++;
    return n;
  }

  /**
   * A running revenue-refund clock whose refund was rejected, voided or withdrawn (deleted) has nobody to stop it, and its
   * escalation cannot be acknowledged. Sends `revenue.refund-void` for it (deduped) and completes the task.
   */
  private async stopDeadRefundClocks(old: Date): Promise<number> {
    const running = await this.clockModel.find({ def: 'revenue-refund', state: 'running', startedAt: { $lte: old } }).limit(BATCH).lean().exec();
    let n = 0;
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
    return n;
  }

  /** Deposit, top-up and top-up-met messages that a failed send left unsent. */
  private async reannounceAsks(old: Date, since: Date): Promise<number> {
    const owed = await this.billModel
      .find({
        updatedAt: { $lte: old, $gte: since },
        $or: [
          { 'depositAsk.amount': { $exists: true }, 'depositAsk.announcedAt': { $exists: false } },
          { 'topupAsk.amount': { $exists: true }, 'topupAsk.announcedAt': { $exists: false } },
          { 'topupAsk.metAt': { $exists: true }, 'topupAsk.metAnnouncedAt': { $exists: false } },
        ],
      })
      .select('_id')
      .limit(BATCH)
      .lean()
      .exec();
    let n = 0;
    for (const id of this.ids(owed)) n += await this.deposits.announceAsks(id);
    return n;
  }

  // ---------- tasks ----------

  /** Deposit, top-up, final-bill and refund tasks that are missing. A task that exists, completed or not, is never touched. */
  private async restoreTasks(old: Date, since: Date): Promise<number> {
    let n = 0;
    const active = await this.billModel
      .find({ state: { $in: ACTIVE_BILL_STATES }, kind: { $ne: 'er' }, updatedAt: { $lte: old, $gte: since } })
      .select('_id kind')
      .sort({ updatedAt: -1 })
      .limit(BATCH)
      .lean()
      .exec();
    for (const b of active) {
      try {
        if (await this.deposits.ensureDepositTask(String(b._id))) n++;
        if (b.kind === 'admission' && (await this.deposits.ensureTopUpTask(String(b._id)))) n++;
      } catch (e) {
        this.logger.warn(`Tasks of bill ${String(b._id)} not restored (${(e as Error).message})`);
      }
    }
    const asked = await this.billModel
      .find({ state: 'open', kind: { $in: ['er', 'admission'] }, announcedAt: { $exists: true }, updatedAt: { $lte: old, $gte: since } })
      .select('_id')
      .limit(BATCH)
      .lean()
      .exec();
    for (const id of this.ids(asked)) if (await this.final.ensureFinalTask(id)) n++;
    const owed = await this.refundModel.find({ state: 'approved', announcedAt: { $exists: true }, updatedAt: { $lte: old, $gte: since } }).select('_id').limit(BATCH).lean().exec();
    for (const id of this.ids(owed)) if (await this.refunds.ensureTask(id)) n++;
    return n;
  }

  // ---------- charges ----------

  private async has(type: string, ref: string): Promise<boolean> {
    return !!(await this.chargeLines.exists({ 'source.type': type, 'source.ref': ref }).exec());
  }

  /**
   * Charges for things that happened while the agent was down or a message was lost, found from the last 7 days of ER, Lab,
   * Pharmacy and Scheduling records. Each goes through the same handler the message would have, which checks the charge
   * source first, so nothing is charged twice. Returns how many new charges appeared.
   */
  private async missedCharges(old: Date, since: Date): Promise<number> {
    const window = { updatedAt: { $lte: old, $gte: since } };
    let n = 0;
    const attempt = async (type: string, ref: string, refType: string, message: { case: string | null; payload: Record<string, unknown> }) => {
      if (await this.has(refType, ref)) return;
      await this.capture.replay(type, message);
      if (await this.has(refType, ref)) n++;
    };
    const each = async <T extends { _id: unknown }>(what: string, rows: T[], fn: (row: T) => Promise<void>) => {
      for (const row of rows) {
        try {
          await fn(row);
        } catch (e) {
          this.logger.warn(`Missed ${what} charge ${String(row._id)} not made (${(e as Error).message})`);
        }
      }
    };

    // ER visits: arrival, and the doctor's visit once seen. A visit whose bill is already settled is left alone.
    const visits = await this.visits.find(window).sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    await each('ER', visits, async (v) => {
      const id = String(v._id);
      if (await this.billModel.exists({ kind: 'er', erVisit: v._id, state: 'settled' }).exec()) return;
      const caseId = v.case ? String(v.case) : null;
      await attempt('er.arrived', id, 'er.arrived', { case: caseId, payload: { visitId: id } });
      if (v.doctorSeenAt) await attempt('er.doctor-seen', id, 'er.doctor-seen', { case: caseId, payload: { visitId: id } });
    });

    // Lab: tests collected or later, grouped by request.
    const labLines = await this.labLines.find({ ...window, status: { $in: COLLECTED } }).sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    const byRequest = new Map<string, string[]>();
    for (const l of labLines) {
      const key = String(l.request);
      byRequest.set(key, [...(byRequest.get(key) ?? []), l.test]);
    }
    await each('lab', [...byRequest.entries()].map(([request, tests]) => ({ _id: request, tests })), async ({ _id, tests }) => {
      const request = await this.labRequests.findById(_id).select('case').lean().exec();
      if (!request) return;
      const missing: string[] = [];
      for (const t of tests) if (!(await this.has('lab', `${_id}:${t}`))) missing.push(t);
      if (!missing.length) return;
      await this.capture.replay('lab.collected', { case: String(request.case), payload: { requestId: String(_id), tests: missing } });
      for (const t of missing) if (await this.has('lab', `${_id}:${t}`)) n++;
    });

    // Pharmacy: lines issued.
    const pharmacy = await this.pharmacyLines.find({ ...window, status: 'issued' }).sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    await each('pharmacy', pharmacy, async (l) => {
      const id = String(l._id);
      if (await this.has('pharmacy.issued', id)) return;
      const order = await this.pharmacyOrders.findById(l.order).select('case').lean().exec();
      await attempt('pharmacy.issued', id, 'pharmacy.issued', { case: order?.case ? String(order.case) : null, payload: { lineId: id, quantity: l.issued?.quantity } });
    });

    // Scheduling: procedures done, consults seen.
    const done = await this.procedures.find({ ...window, status: 'done' }).sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    await each('procedure', done, (b) => attempt('scheduling.procedure-done', String(b._id), 'procedure', { case: b.case ? String(b.case) : null, payload: { bookingId: String(b._id) } }));
    const seen = await this.consults.find({ ...window, status: 'seen' }).sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    await each('consult', seen, (c) => attempt('scheduling.consult-seen', String(c._id), 'consult', { case: c.case ? String(c.case) : null, payload: { consultId: String(c._id) } }));
    return n;
  }

  // ---------- totals ----------

  /**
   * Rewrites the totals of an active bill when they disagree with its records (a crash between a line insert and its total
   * leaves them behind): charges = the non-discount lines, discounts = the discount and write-off lines, payments = the
   * non-cancelled payments, refunds = the paid refunds, balance = charges - discounts - payments + refunds. A correction's
   * lines count only once the correction is applied (a ref of `<id>:discount` belongs to correction `<id>`). A bill touched in
   * the last 30 seconds, or with a correction being applied, is skipped. The write is guarded by the totals it read.
   */
  private async healTotals(old: Date): Promise<number> {
    const candidates = await this.billModel.find({ state: { $in: ACTIVE_BILL_STATES } }).select('_id totals updatedAt').sort({ updatedAt: -1 }).limit(1000).lean().exec();
    let healed = 0;
    for (const bill of candidates) {
      try {
        if (new Date(stamp(bill, 'updatedAt') ?? 0) > old) continue;
        if (await this.corrections.exists({ bill: bill._id, state: 'approved', appliedAt: null }).exec()) continue;
        const [lines, payments, refunds] = await Promise.all([
          this.chargeLines.find({ bill: bill._id }).select('amount category source createdAt').lean().exec(),
          this.paymentModel.find({ bill: bill._id }).select('amount cancelled updatedAt').lean().exec(),
          this.refundModel.find({ bill: bill._id, state: 'paid' }).select('amount paid updatedAt').lean().exec(),
        ]);
        const recent = [...lines.map((l) => stamp(l, 'createdAt')), ...payments.map((p) => stamp(p, 'updatedAt')), ...refunds.map((r) => stamp(r, 'updatedAt'))].some((t) => t && new Date(t) > old);
        if (recent) continue;
        const correctionIds = [...new Set(lines.filter((l) => l.source.type === 'correction').map((l) => l.source.ref.split(':')[0]))].filter((id) => isValidObjectId(id));
        const applied = new Set(
          correctionIds.length ? this.ids(await this.corrections.find({ _id: { $in: correctionIds.map((id) => new Types.ObjectId(id)) }, appliedAt: { $ne: null } }).select('_id').lean().exec()) : [],
        );
        let charges = 0;
        let discounts = 0;
        for (const l of lines) {
          if (l.source.type === 'correction' && !applied.has(l.source.ref.split(':')[0])) continue;
          if (l.category === 'discount' || l.category === 'write-off') discounts -= l.amount;
          else charges += l.amount;
        }
        const paid = payments.filter((p) => !p.cancelled).reduce((sum, p) => sum + p.amount, 0);
        const refunded = refunds.reduce((sum, r) => sum + (r.paid?.amount ?? r.amount), 0);
        const next = { charges, discounts, payments: paid, refunds: refunded, balance: charges - discounts - paid + refunded };
        const t = bill.totals ?? { charges: 0, discounts: 0, payments: 0, refunds: 0, balance: 0 };
        if (t.charges === next.charges && t.discounts === next.discounts && t.payments === next.payments && t.refunds === next.refunds && t.balance === next.balance) continue;
        const r = await this.billModel
          .updateOne(
            { _id: bill._id, state: { $in: ACTIVE_BILL_STATES }, 'totals.charges': t.charges, 'totals.discounts': t.discounts, 'totals.payments': t.payments, 'totals.refunds': t.refunds, 'totals.balance': t.balance },
            { $set: { totals: next } },
          )
          .exec();
        if (!r.modifiedCount) continue;
        healed++;
        this.logger.warn(`Bill ${String(bill._id)}: totals rewritten from its records (balance ${t.balance} to ${next.balance})`);
        for (const fn of this.bills.onTotalsChanged) {
          try {
            Promise.resolve(fn(String(bill._id))).catch((e) => this.logger.warn(`A totals listener failed: ${(e as Error).message}`));
          } catch (e) {
            this.logger.warn(`A totals listener failed: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        this.logger.warn(`Totals of bill ${String(bill._id)} not checked (${(e as Error).message})`);
      }
    }
    return healed;
  }

  // ---------- suggested reversals ----------

  /**
   * A lab test cancelled while a desk correction was pending on its charge line lost the agent's suggested reversal. When the
   * line is charged, not reversed, free of a pending correction and has no suggestion yet, suggest it again. The suggestion
   * itself is once per line, so a replay is safe.
   */
  private async resuggestReversals(old: Date, since: Date): Promise<number> {
    const cancelled = await this.labLines.find({ status: 'cancelled', updatedAt: { $lte: old, $gte: since } }).sort({ updatedAt: 1 }).limit(BATCH).lean().exec();
    let n = 0;
    for (const l of cancelled) {
      try {
        const charged = await this.chargeLines.findOne({ 'source.type': 'lab', 'source.ref': `${l.request}:${l.test}` }).lean().exec();
        if (!charged || charged.reversed) continue;
        if (await this.corrections.exists({ line: charged._id, state: 'pending' }).exec()) continue;
        const suggested = { line: charged._id, kind: 'reversal', suggested: true, state: { $ne: 'void' } };
        if (await this.corrections.exists(suggested).exec()) continue;
        await this.capture.suggestReversal({ billId: String(charged.bill), lineId: String(charged._id), reason: `Lab test ${l.test} was cancelled after it was charged` });
        if (await this.corrections.exists(suggested).exec()) n++;
      } catch (e) {
        this.logger.warn(`Suggested reversal for lab line ${String(l._id)} not made (${(e as Error).message})`);
      }
    }
    return n;
  }
}
