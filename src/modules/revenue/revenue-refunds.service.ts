import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import type { Actor } from '../beds/actor';
import { ApprovalsService } from '../coordinator/approvals.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { UserRole } from '../users/schemas/user.schema';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueSettingsService } from './revenue-settings.service';
import { Refund, RefundDocument } from './schemas/refund.schema';

const MODES = ['cash', 'upi', 'card'];
const link = (id: unknown) => `revenue-refund:${String(id)}`;

/**
 * Money owed back to the patient: a final bill with a negative balance. An admin approves (their own request approves at
 * once), then the desk pays it. Paying is one guarded write and one atomic total change; nothing is ever deleted.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly registration: RevenueCoordinatorRegistration,
    private readonly settings: RevenueSettingsService,
    private readonly bills: RevenueBillsService,
    private readonly approvals: ApprovalsService,
    @InjectModel(Refund.name) private readonly refunds: Model<RefundDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
  ) {
    registration.onRefundDecision.push((id, decision, actor) => this.decided(id, decision, actor));
  }

  private desk(actor: Actor) {
    if (!actor || (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF)) throw new ForbiddenException('Only the billing desk or an admin can handle a refund');
  }

  /** Asks to refund what the final bill owes. Waits for an admin; an admin's own request is approved at once. */
  async request(actor: Actor, billId: string): Promise<RefundDocument> {
    this.desk(actor);
    const bill = await this.bills.get(billId);
    if (bill.state === 'settled') throw new ConflictException('This bill is settled');
    if (bill.state !== 'final') throw new ConflictException('Prepare the final bill first');
    const owed = -(bill.totals?.balance ?? 0);
    if (owed < 1) throw new ConflictException('This bill owes the patient nothing');
    if (await this.refunds.exists({ bill: bill._id, waiting: true }).exec()) throw new ConflictException('A refund is already waiting on this bill');
    let refund: RefundDocument;
    try {
      refund = await this.refunds.create({
        number: await this.bills.nextNumber('revenue-refund', 'RF'),
        bill: bill._id,
        amount: owed,
        state: 'requested',
        waiting: true,
        requestedBy: { id: actor.id, name: actor.name },
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new ConflictException('A refund is already waiting on this bill');
      throw e;
    }
    if (actor.role === UserRole.ADMIN) return this.approve(String(refund._id), actor);
    try {
      const approval = await this.approvals.request({
        type: 'revenue.refund',
        case: bill.case ? String(bill.case) : null,
        summary: `${bill.number}: Refund ${formatRupees(owed)}`,
        source: { kind: 'revenue-refund', id: String(refund._id) },
      });
      refund.approvalId = approval._id as Types.ObjectId;
      await this.refunds.updateOne({ _id: refund._id }, { $set: { approvalId: approval._id } }).exec();
    } catch (e) {
      await this.refunds.deleteOne({ _id: refund._id }).exec();
      throw e;
    }
    return refund;
  }

  private async decided(approvalId: string, decision: 'approved' | 'rejected', actor: Actor): Promise<void> {
    if (!isValidObjectId(approvalId)) return;
    const r = await this.refunds.findOne({ approvalId: new Types.ObjectId(approvalId) }).exec();
    if (!r) return;
    if (decision === 'rejected') {
      await this.refunds.updateOne({ _id: r._id, state: 'requested' }, { $set: { state: 'rejected', waiting: false, decidedBy: { id: actor.id, name: actor.name } } }).exec();
      return;
    }
    await this.approve(String(r._id), actor);
  }

  /**
   * Approves and announces: `revenue.refund-due` (the clock, dueAt = real now + the refund target) and the `revenue-refund:<id>`
   * task. The claim is one guarded write; a retry after a throw finds it approved but not announced and finishes the announcing.
   */
  private async approve(refundId: string, actor: Actor): Promise<RefundDocument> {
    let r = await this.refunds.findOneAndUpdate({ _id: refundId, state: 'requested' }, { $set: { state: 'approved', decidedBy: { id: actor.id, name: actor.name } } }, { new: true }).exec();
    if (!r) {
      const found = await this.refunds.findById(refundId).exec();
      if (!found) throw new NotFoundException('Refund not found');
      if (found.state !== 'approved' || found.announcedAt) return found;
      r = found;
    }
    const bill = await this.bills.get(String(r.bill));
    const cfg = await this.settings.get();
    const dueAt = new Date(Date.now() + cfg.clocks.refund * 60_000);
    await this.registration.send(
      'revenue.refund-due',
      bill,
      { refundId: String(r._id), refundNumber: r.number, billNumber: bill.number, amount: r.amount, dueAt },
      { text: `Refund ${r.number} to pay`, amount: r.amount, dedupeKey: `refund-due:${String(r._id)}` },
    );
    try {
      await this.alerts.create({
        title: `Pay refund ${r.number}: ${formatRupees(r.amount)}`,
        subtitle: `Bill ${bill.number}`,
        patientName: bill.patientName,
        uhid: bill.patientUhid,
        type: 'System',
        category: 'System',
        priority: 'Medium',
        status: 'Pending',
        link: link(r._id),
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    return (await this.refunds.findOneAndUpdate({ _id: r._id }, { $set: { announcedAt: new Date(), dueAt } }, { new: true }).exec()) ?? r;
  }

  /** Pays an approved refund once: the total moves only if this call won the claim, and goes back if the move fails. */
  async pay(actor: Actor, refundId: string, input: { mode: string; reference?: string }): Promise<RefundDocument> {
    this.desk(actor);
    if (!MODES.includes(input?.mode)) throw new BadRequestException('The payment mode must be cash, upi or card');
    const found = isValidObjectId(refundId) ? await this.refunds.findById(refundId).exec() : null;
    if (!found) throw new NotFoundException('Refund not found');
    if (found.state === 'paid') throw new ConflictException('This refund is already paid');
    if (found.state !== 'approved') throw new ConflictException('The refund has not been approved');
    const bill = await this.bills.get(String(found.bill));
    if (-(bill.totals?.balance ?? 0) < found.amount) throw new ConflictException('The bill no longer owes this refund');
    const paid = await this.refunds
      .findOneAndUpdate(
        { _id: found._id, state: 'approved' },
        { $set: { state: 'paid', waiting: false, paid: { at: clinicNow(), by: { id: actor.id, name: actor.name }, mode: input.mode, reference: (input.reference ?? '').trim().slice(0, 80) } } },
        { new: true },
      )
      .exec();
    if (!paid) throw new ConflictException('This refund is already paid');
    try {
      await this.bills.adjust(String(bill._id), { refunds: paid.amount }, { onlyActive: true });
    } catch (e) {
      await this.refunds.updateOne({ _id: paid._id }, { $set: { state: 'approved', waiting: true }, $unset: { paid: 1 } }).exec();
      throw e;
    }
    try {
      await this.registration.send(
        'revenue.refund-paid',
        bill,
        { refundId: String(paid._id), refundNumber: paid.number, billNumber: bill.number },
        { text: `Refund ${paid.number} paid by ${input.mode}`, amount: paid.amount, dedupeKey: `refund-paid:${String(paid._id)}` },
      );
      await this.alerts.updateOne({ link: link(paid._id), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    } catch (e) {
      // The money is recorded; the reconcile pass (Task 11) tells the Coordinator again.
      this.logger.warn(`Refund ${paid.number} paid, but its message or task failed (${(e as Error).message})`);
    }
    return paid;
  }

  /** What the refund voucher prints. */
  async receipt(refundId: string) {
    const r = isValidObjectId(refundId) ? await this.refunds.findById(refundId).lean().exec() : null;
    if (!r) throw new NotFoundException('Refund not found');
    const [bill, cfg] = await Promise.all([this.bills.get(String(r.bill)), this.settings.get()]);
    return {
      header: cfg.receiptHeader,
      refundNumber: r.number,
      billNumber: bill.number,
      patientName: bill.patientName,
      patientUhid: bill.patientUhid,
      amount: r.amount,
      state: r.state,
      mode: r.paid?.mode ?? null,
      reference: r.paid?.reference ?? '',
      paidBy: r.paid?.by.name ?? null,
      at: r.paid?.at ?? null,
    };
  }
}
