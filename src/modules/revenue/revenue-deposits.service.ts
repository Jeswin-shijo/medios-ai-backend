import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { Ward, WardDocument } from '../beds/schemas/ward.schema';
import { MessagesService } from '../coordinator/messages.service';
import { Case, CaseDocument } from '../coordinator/schemas/case.schema';
import { RulesService } from '../coordinator/rules.service';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { PriceListService } from './price-list.service';
import { procCode, wardGroupOf } from './revenue-catalogue';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { bookingsOf, RevenueEstimatesService } from './revenue-estimates.service';
import { RevenueSettingsService } from './revenue-settings.service';
import { ACTIVE_BILL_STATES, Bill, BillDocument } from './schemas/bill.schema';

const RULE = 'revenue-deposit-reminders';
/** A booking the patient still has ahead of them. STAT is never included. */
const PLANNED = ['requested', 'booked', 'cant-book'];
const AFTER_PLAN = 'after the doctor has explained the plan';
const depositLink = (billId: unknown) => `revenue-bill:${String(billId)}:deposit`;
const topupLink = (billId: unknown) => `revenue-bill:${String(billId)}:topup`;

type Msg = { case: string | null; payload: Record<string, unknown> };
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Advance deposits and top-ups. Both are tasks for the billing desk and nothing else: no code here blocks, delays or
 * reorders care. An ER bill, and a STAT procedure, never ask for money. Handlers never throw.
 */
@Injectable()
export class RevenueDepositsService {
  private readonly logger = new Logger(RevenueDepositsService.name);

  constructor(
    private readonly messages: MessagesService,
    private readonly registration: RevenueCoordinatorRegistration,
    private readonly rules: RulesService,
    private readonly settings: RevenueSettingsService,
    private readonly prices: PriceListService,
    private readonly bills: RevenueBillsService,
    private readonly estimates: RevenueEstimatesService,
    @InjectModel(Bill.name) private readonly billModel: Model<BillDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    @InjectModel(ProcedureBooking.name) private readonly procedures: Model<ProcedureBookingDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
    @InjectModel(Ward.name) private readonly wards: Model<WardDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
  ) {
    registration.capture.set('scheduling.procedure-booked', (id) => this.run(id));
    bills.onTotalsChanged.push((billId) => this.onTotals(billId));
  }

  /** scheduling.procedure-booked: the booking joins the estimate (counted once), then the deposit is raised or raised again. */
  private async run(messageId: string): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message) {
        this.logger.warn(`scheduling.procedure-booked: message ${messageId} not found`);
        return;
      }
      await this.onBooked({ case: message.case ?? null, payload: message.payload ?? {} });
    } catch (e) {
      this.logger.warn(`scheduling.procedure-booked: no estimate or deposit (${(e as Error).message})`);
    }
  }

  private async onBooked(m: Msg): Promise<void> {
    const bookingId = str(m.payload.bookingId);
    const booking = bookingId && isValidObjectId(bookingId) ? await this.procedures.findById(bookingId).lean().exec() : null;
    if (!booking) {
      this.logger.warn('scheduling.procedure-booked: booking not found');
      return;
    }
    const caseId = m.case ?? String(booking.case);
    // A STAT booking never opens a bill: it joins one that exists, or nothing happens.
    if (booking.priority === 'stat' && !(await this.hasActiveBill(String(booking.patient), caseId))) return;
    // The routing is the same as for any charge, except that a booking charges nothing, so it never opens a continuation bill:
    // an empty one would hold the patient's discharge with nothing to prepare.
    const bill = await this.bills.forCharge({ patientId: String(booking.patient), caseId }, { openContinuation: false });
    const billId = String(bill._id);
    try {
      await this.estimates.draft(billId);
    } catch (e) {
      this.logger.warn(`Estimate for ${bill.number} failed (${(e as Error).message})`);
    }
    try {
      await this.raise(billId);
    } catch (e) {
      this.logger.warn(`Deposit for ${bill.number} failed (${(e as Error).message})`);
    }
  }

  /**
   * Whether the bill a booking would join already exists: the case's active ER or admission bill (a continuation bill included),
   * or the day's OPD or walk-in bill. It mirrors `forCharge(…, { openContinuation: false })` and never opens one.
   */
  private async hasActiveBill(patientId: string, caseId: string): Promise<boolean> {
    const active = { $in: ACTIVE_BILL_STATES };
    if (isValidObjectId(caseId) && (await this.billModel.exists({ case: new Types.ObjectId(caseId), kind: { $in: ['er', 'admission'] }, state: active }))) return true;
    return !!(await this.billModel.exists({ patient: new Types.ObjectId(patientId), kind: { $in: ['opd', 'walk-in'] }, day: isoDate(clinicNow()), state: active }));
  }

  /** The advance that should be asked for, or null: ER bills, STAT bookings, no ward or package, or the reminder rule off. */
  async dueFor(bill: BillDocument): Promise<{ amount: number; reason: string } | null> {
    if (!(await this.rules.isOn(RULE))) return null;
    return this.depositDue(bill);
  }

  /**
   * The advance the bill carries, whatever the reminder rule says: R45 lets the rule stop only new asks, so an ask already
   * made still completes once it is paid. Null for ER bills, STAT bookings, or no ward or package.
   */
  private async depositDue(bill: BillDocument): Promise<{ amount: number; reason: string } | null> {
    if (bill.kind === 'er') return null;
    const cfg = await this.settings.get();
    let amount = 0;
    const parts: string[] = [];
    if (bill.kind === 'admission') {
      const group = bill.wardType ? wardGroupOf(bill.wardType) : null;
      if (group) {
        amount += cfg.deposits[group];
        parts.push(await this.wardNameOf(bill));
      }
    }
    const planned = (await bookingsOf(this.procedures, bill, PLANNED)).filter((b) => b.priority !== 'stat');
    const names: string[] = [];
    for (const b of planned) {
      const p = await this.prices.priceFor(procCode(b.procedure));
      amount += p.price;
      names.push(p.name === procCode(b.procedure) ? b.procedure : p.name);
    }
    if (!parts.length && names.length) parts.push(names.join(', '));
    if (!(amount > 0)) return null;
    return { amount, reason: parts.join(' · ') };
  }

  private async wardNameOf(bill: BillDocument): Promise<string> {
    try {
      const admission = bill.admission ? await this.admissions.findById(bill.admission).select('bed transfers').lean().exec() : null;
      const bedId = admission?.transfers?.length ? admission.transfers[admission.transfers.length - 1].toBed : admission?.bed;
      const bed = bedId ? await this.beds.findById(bedId).select('ward').lean().exec() : null;
      const ward = bed ? await this.wards.findById(bed.ward).select('name').lean().exec() : null;
      if (ward?.name) return ward.name;
    } catch (e) {
      this.logger.warn(`Ward name lookup failed (${(e as Error).message})`);
    }
    return bill.wardType ?? '';
  }

  /** True when the admission came from the ER (the bill was an ER bill, or the case is an ER case). */
  private async fromEr(bill: BillDocument): Promise<boolean> {
    if (bill.erVisit) return true;
    if (!bill.case) return false;
    const c = await this.cases.findById(bill.case).select('kind').lean().exec();
    return c?.kind === 'er';
  }

  /**
   * Writes the `revenue-bill:<id>:deposit` task and sends `revenue.deposit-due`. One task per bill: it is updated when
   * the amount or ward changes, reopened when the due amount rises above payments, and left alone when already met.
   * `onlyIfOpen` (a ward transfer) rewrites an open task and never creates one. Returns the amount asked, else null.
   */
  async raise(billId: string, opts: { onlyIfOpen?: boolean } = {}): Promise<number | null> {
    if (!isValidObjectId(billId)) return null;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || !ACTIVE_BILL_STATES.includes(bill.state)) return null;
    const due = await this.depositDue(bill);
    if (!due) return null;
    const link = depositLink(bill._id);
    const remaining = due.amount - (bill.totals?.payments ?? 0);
    if (remaining <= 0) {
      await this.complete(link);
      return null;
    }
    // R45: the reminder rule off stops new asks (a task, a reopen, a rewrite or a message); a met one still completes above.
    if (!(await this.rules.isOn(RULE))) return null;
    const existing = await this.alerts.findOne({ link }).lean().exec();
    if (opts.onlyIfOpen && (!existing || existing.status === 'Completed')) return null;
    const fields = await this.depositFields(bill, due.reason, remaining);
    // R31: the ask is written before the task, so a crash between them leaves a marker the reconcile pass completes.
    if (!existing || existing.status === 'Completed' || existing.title !== fields.title) {
      await this.billModel.updateOne({ _id: bill._id }, { $set: { depositAsk: { amount: remaining } } }).exec();
    }
    let announce = false;
    if (!existing) {
      try {
        await this.alerts.create({ ...fields, link });
        announce = true;
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    } else if (existing.status === 'Completed') {
      // Reopen once, even if two events arrive together.
      const won = await this.alerts.findOneAndUpdate({ link, status: 'Completed' }, { $set: fields }, { new: true }).lean().exec();
      announce = !!won;
    } else if (existing.title !== fields.title || existing.subtitle !== fields.subtitle) {
      await this.alerts.updateOne({ link }, { $set: { title: fields.title, subtitle: fields.subtitle } }).exec();
      announce = existing.title !== fields.title;
    }
    if (announce) {
      await this.sendDepositDue(bill, remaining);
    }
    return remaining;
  }

  private async depositFields(bill: BillDocument, reason: string, remaining: number) {
    const subtitle = (await this.fromEr(bill)) ? `${reason ? `${reason} · ` : ''}${AFTER_PLAN}` : reason;
    return {
      title: `Collect advance ${formatRupees(remaining)}: ${bill.number}`,
      subtitle,
      patientName: bill.patientName,
      uhid: bill.patientUhid,
      type: 'System',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    };
  }

  /** Sends `revenue.deposit-due` and marks the ask announced. Throws when the send fails (the ask stays unannounced). */
  private async sendDepositDue(bill: BillDocument, amount: number): Promise<void> {
    await this.registration.send(
      'revenue.deposit-due',
      bill,
      { billId: String(bill._id), billNumber: bill.number, amount },
      { text: 'Advance due', amount, dedupeKey: `deposit:${String(bill._id)}:${amount}` },
    );
    await this.billModel.updateOne({ _id: bill._id, 'depositAsk.amount': amount }, { $set: { 'depositAsk.announcedAt': new Date() } }).exec();
  }

  /**
   * The reconcile pass: writes the deposit task when it is missing and an advance is due. Never reopens a task that exists,
   * completed or not. A task it writes starts an ask that `announceAsks` sends. Returns true when it wrote one.
   */
  async ensureDepositTask(billId: string): Promise<boolean> {
    if (!isValidObjectId(billId)) return false;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || !ACTIVE_BILL_STATES.includes(bill.state)) return false;
    const due = await this.dueFor(bill);
    if (!due) return false;
    const remaining = due.amount - (bill.totals?.payments ?? 0);
    if (remaining <= 0) return false;
    const link = depositLink(bill._id);
    if (await this.alerts.exists({ link })) return false;
    // R31: marker first.
    await this.billModel.updateOne({ _id: bill._id }, { $set: { depositAsk: { amount: remaining } } }).exec();
    const r = await this.alerts.updateOne({ link }, { $setOnInsert: { ...(await this.depositFields(bill, due.reason, remaining)), link } }, { upsert: true }).exec();
    return !!r.upsertedCount;
  }

  /** The reconcile pass: writes the top-up task when it is needed and missing. Never reopens one that exists. True when it wrote one. */
  async ensureTopUpTask(billId: string): Promise<boolean> {
    if (!isValidObjectId(billId)) return false;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || bill.kind !== 'admission' || !ACTIVE_BILL_STATES.includes(bill.state)) return false;
    if (!(await this.rules.isOn(RULE))) return false;
    const plan = await this.topUpPlan(bill);
    if (!plan.needed || !(plan.amount > 0)) return false;
    const link = topupLink(bill._id);
    if (await this.alerts.exists({ link })) return false;
    const cfg = await this.settings.get();
    // R31: marker first.
    await this.billModel.updateOne({ _id: bill._id }, { $set: { topupAsk: { amount: plan.amount, dueAt: new Date(Date.now() + cfg.clocks.topup * 60_000) } } }).exec();
    const r = await this.alerts.updateOne({ link }, { $setOnInsert: { ...(await this.topUpFields(bill, plan.amount)), link } }, { upsert: true }).exec();
    return !!r.upsertedCount;
  }

  /**
   * The reconcile pass: sends the deposit-due, topup-due and topup-met messages that a failed send left unsent. An ask whose
   * task is already completed is just marked (nothing is owed any more). Never throws; returns how many were sent.
   */
  async announceAsks(billId: string): Promise<number> {
    let n = 0;
    try {
      const bill = isValidObjectId(billId) ? await this.billModel.findById(billId).exec() : null;
      if (!bill) return 0;
      const open = async (link: string) => {
        const t = await this.alerts.findOne({ link }).select('status').lean().exec();
        return t ? (t.status === 'Completed' ? 'done' : 'open') : 'none';
      };
      const dep = bill.depositAsk;
      if (dep && !dep.announcedAt && typeof dep.amount === 'number') {
        const state = await open(depositLink(bill._id));
        if (state === 'open') {
          await this.sendDepositDue(bill, dep.amount);
          n++;
        } else if (state === 'done') {
          await this.billModel.updateOne({ _id: bill._id, 'depositAsk.amount': dep.amount }, { $set: { 'depositAsk.announcedAt': new Date() } }).exec();
        }
      }
      const top = bill.topupAsk;
      if (top?.metAt && !top.metAnnouncedAt) {
        await this.sendTopUpMet(bill);
        n++;
      } else if (top && !top.announcedAt && !top.metAt && typeof top.amount === 'number') {
        const state = await open(topupLink(bill._id));
        if (state === 'open') {
          await this.sendTopUpDue(bill, top.amount, new Date(top.dueAt ?? Date.now()));
          n++;
        } else if (state === 'done') {
          await this.billModel.updateOne({ _id: bill._id }, { $set: { 'topupAsk.announcedAt': new Date() } }).exec();
        }
      }
    } catch (e) {
      this.logger.warn(`Asks of bill ${billId} not re-sent (${(e as Error).message})`);
    }
    return n;
  }

  private async sendTopUpDue(bill: BillDocument, amount: number, dueAt: Date): Promise<void> {
    await this.registration.send('revenue.topup-due', bill, { billId: String(bill._id), billNumber: bill.number, amount, dueAt }, { text: 'Top-up due', amount });
    // Guarded on the amount and time that went out, so a newer top-up written meanwhile stays unannounced.
    await this.billModel.updateOne({ _id: bill._id, 'topupAsk.amount': amount, 'topupAsk.dueAt': dueAt }, { $set: { 'topupAsk.announcedAt': new Date() } }).exec();
  }

  private async sendTopUpMet(bill: BillDocument): Promise<void> {
    await this.registration.send('revenue.topup-met', bill, { billId: String(bill._id), billNumber: bill.number }, { text: 'Top-up met' });
    // The due message is moot once the top-up is met: mark it too, so it does not keep matching the reconcile pass.
    await this.billModel.updateOne({ _id: bill._id, 'topupAsk.metAt': { $exists: true } }, { $set: { 'topupAsk.metAnnouncedAt': new Date(), 'topupAsk.announcedAt': new Date() } }).exec();
  }

  private async complete(link: string): Promise<boolean> {
    const r = await this.alerts.updateOne({ link, status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    return r.modifiedCount > 0;
  }

  /** Payments at or above the due amount complete the deposit task, with the reminder rule on or off (R45). */
  async closeIfMet(billId: string): Promise<boolean> {
    if (!isValidObjectId(billId)) return false;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill) return false;
    const due = await this.depositDue(bill);
    if (!due || (bill.totals?.payments ?? 0) < due.amount) return false;
    return this.complete(depositLink(bill._id));
  }

  /**
   * An admission asks for a top-up when charges reach the threshold share of payments (payments above 0). The task says how
   * much (the ward's deposit, or what keeps payments ahead of charges, whichever is larger) and the clock starts. When
   * payments catch up the task completes and `revenue.topup-met` stops the clock. With the reminder rule off only the "met"
   * half runs (R45): an open top-up still completes and its clock still stops, but no new top-up is asked.
   */
  async checkTopUp(billId: string): Promise<'raised' | 'met' | null> {
    if (!isValidObjectId(billId)) return null;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || bill.kind !== 'admission' || !ACTIVE_BILL_STATES.includes(bill.state)) return null;
    const link = topupLink(bill._id);
    const plan = await this.topUpPlan(bill);
    if (!plan.needed) {
      if (!(await this.complete(link))) return null;
      // The met mark is written before the send, so a failed send is left for the reconcile pass.
      await this.billModel.updateOne({ _id: bill._id }, { $set: { 'topupAsk.metAt': new Date() }, $unset: { 'topupAsk.metAnnouncedAt': 1 } }).exec();
      await this.sendTopUpMet(bill);
      return 'met';
    }
    if (!(await this.rules.isOn(RULE))) return null;
    const { amount } = plan;
    if (!(amount > 0)) return null;
    const fields = await this.topUpFields(bill, amount);
    const existing = await this.alerts.findOne({ link }).lean().exec();
    let raised = false;
    const cfg = await this.settings.get();
    // Clocks run on real time; the bill's own times are on the clinic clock.
    const dueAt = new Date(Date.now() + cfg.clocks.topup * 60_000);
    // R31: the ask is written before the task.
    if (!existing || existing.status === 'Completed') await this.billModel.updateOne({ _id: bill._id }, { $set: { topupAsk: { amount, dueAt } } }).exec();
    if (!existing) {
      try {
        await this.alerts.create({ ...fields, link });
        raised = true;
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    } else if (existing.status === 'Completed') {
      raised = !!(await this.alerts.findOneAndUpdate({ link, status: 'Completed' }, { $set: fields }, { new: true }).lean().exec());
    }
    if (!raised) return null;
    await this.sendTopUpDue(bill, amount, dueAt);
    return 'raised';
  }

  /** Whether an admission bill needs a top-up now, and how much (the ward's deposit, or what keeps payments ahead of charges, whichever is larger). */
  private async topUpPlan(bill: BillDocument): Promise<{ needed: boolean; amount: number }> {
    const cfg = await this.settings.get();
    const t = bill.totals;
    const payments = t?.payments ?? 0;
    const owed = (t?.charges ?? 0) - (t?.discounts ?? 0);
    if (!(payments > 0 && owed >= (cfg.topupThreshold / 100) * payments)) return { needed: false, amount: 0 };
    const group = bill.wardType ? wardGroupOf(bill.wardType) : null;
    return { needed: true, amount: (group ? cfg.deposits[group] : 0) + Math.max(0, owed - payments) };
  }

  private async topUpFields(bill: BillDocument, amount: number) {
    return {
      title: `Ask for a top-up ${formatRupees(amount)}: ${bill.number}`,
      subtitle: await this.wardNameOf(bill),
      patientName: bill.patientName,
      uhid: bill.patientUhid,
      type: 'System',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    };
  }

  /** The bills service tells us after every charge and payment. Never throws. */
  private async onTotals(billId: string): Promise<void> {
    try {
      await this.closeIfMet(billId);
    } catch (e) {
      this.logger.warn(`Deposit check for bill ${billId} failed (${(e as Error).message})`);
    }
    try {
      await this.checkTopUp(billId);
    } catch (e) {
      this.logger.warn(`Top-up check for bill ${billId} failed (${(e as Error).message})`);
    }
  }
}
