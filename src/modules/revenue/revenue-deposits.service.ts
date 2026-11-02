import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
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
    // Only a bill that exists (or an outpatient one) takes it; the routing is the same as for any charge.
    const bill = await this.bills.forCharge({ patientId: String(booking.patient), caseId });
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

  /** The advance that should be collected, or null: ER bills, STAT bookings, no ward or package, or the reminder rule off. */
  async dueFor(bill: BillDocument): Promise<{ amount: number; reason: string } | null> {
    if (bill.kind === 'er') return null;
    if (!(await this.rules.isOn(RULE))) return null;
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
    const due = await this.dueFor(bill);
    if (!due) return null;
    const link = depositLink(bill._id);
    const remaining = due.amount - (bill.totals?.payments ?? 0);
    if (remaining <= 0) {
      await this.complete(link);
      return null;
    }
    const existing = await this.alerts.findOne({ link }).lean().exec();
    if (opts.onlyIfOpen && (!existing || existing.status === 'Completed')) return null;
    const subtitle = (await this.fromEr(bill)) ? `${due.reason ? `${due.reason} · ` : ''}${AFTER_PLAN}` : due.reason;
    const fields = {
      title: `Collect advance ${formatRupees(remaining)}: ${bill.number}`,
      subtitle,
      patientName: bill.patientName,
      uhid: bill.patientUhid,
      type: 'System',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    };
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
      await this.registration.send(
        'revenue.deposit-due',
        bill,
        { billId: String(bill._id), billNumber: bill.number, amount: remaining },
        { text: 'Advance due', amount: remaining, dedupeKey: `deposit:${String(bill._id)}:${remaining}` },
      );
    }
    return remaining;
  }

  private async complete(link: string): Promise<boolean> {
    const r = await this.alerts.updateOne({ link, status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    return r.modifiedCount > 0;
  }

  /** Payments at or above the due amount complete the deposit task. */
  async closeIfMet(billId: string): Promise<boolean> {
    if (!isValidObjectId(billId)) return false;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill) return false;
    const due = await this.dueFor(bill);
    if (!due || (bill.totals?.payments ?? 0) < due.amount) return false;
    return this.complete(depositLink(bill._id));
  }

  /**
   * An admission asks for a top-up when charges reach the threshold share of payments (payments above 0). The task says how
   * much (the ward's deposit, or what keeps payments ahead of charges, whichever is larger) and the clock starts. When
   * payments catch up the task completes and `revenue.topup-met` stops the clock.
   */
  async checkTopUp(billId: string): Promise<'raised' | 'met' | null> {
    if (!isValidObjectId(billId)) return null;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || bill.kind !== 'admission' || !ACTIVE_BILL_STATES.includes(bill.state)) return null;
    if (!(await this.rules.isOn(RULE))) return null;
    const cfg = await this.settings.get();
    const t = bill.totals;
    const payments = t?.payments ?? 0;
    const owed = (t?.charges ?? 0) - (t?.discounts ?? 0);
    const needed = payments > 0 && owed >= (cfg.topupThreshold / 100) * payments;
    const link = topupLink(bill._id);
    if (!needed) {
      if (!(await this.complete(link))) return null;
      await this.registration.send(
        'revenue.topup-met',
        bill,
        { billId: String(bill._id), billNumber: bill.number },
        { text: 'Top-up met' },
      );
      return 'met';
    }
    const group = bill.wardType ? wardGroupOf(bill.wardType) : null;
    const amount = Math.max(group ? cfg.deposits[group] : 0, owed - payments);
    if (!(amount > 0)) return null;
    const fields = {
      title: `Ask for a top-up ${formatRupees(amount)}: ${bill.number}`,
      subtitle: await this.wardNameOf(bill),
      patientName: bill.patientName,
      uhid: bill.patientUhid,
      type: 'System',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    };
    const existing = await this.alerts.findOne({ link }).lean().exec();
    let raised = false;
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
    // Clocks run on real time; the bill's own times are on the clinic clock.
    const dueAt = new Date(Date.now() + cfg.clocks.topup * 60_000);
    await this.registration.send(
      'revenue.topup-due',
      bill,
      { billId: String(bill._id), billNumber: bill.number, amount, dueAt },
      { text: 'Top-up due', amount },
    );
    return 'raised';
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
