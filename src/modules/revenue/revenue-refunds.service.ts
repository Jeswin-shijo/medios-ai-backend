import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import type { Actor } from '../beds/actor';
import { ApprovalsService } from '../coordinator/approvals.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { UserRole } from '../users/schemas/user.schema';
import { FinalBillService } from './revenue-final.service';
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
    private readonly final: FinalBillService,
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
    // A settle that ran between the check above and the insert wins: the refund is withdrawn.
    if ((await this.bills.get(billId)).state === 'settled') {
      await this.refunds.deleteOne({ _id: refund._id }).exec();
      throw new ConflictException('This bill is settled');
    }
    if (actor.role === UserRole.ADMIN) {
      try {
        return await this.approve(String(refund._id), actor);
      } catch (e) {
        // Rolled back to requested with no approval to reopen: withdraw it so it cannot hold the bill.
        await this.refunds.deleteOne({ _id: refund._id, state: 'requested' }).exec();
        throw e;
      }
    }
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
      await this.alerts.updateOne({ link: link(r._id), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
      return;
    }
    await this.approve(String(r._id), actor);
  }

  /**
   * Approves and announces: `revenue.refund-due` (the clock, dueAt = real now + the refund target) and the `revenue-refund:<id>`
   * task. The claim is one guarded write. If announcing throws, the claim is put back (R24) so the reopened approval can be
   * approved again or rejected.
   */
  private async approve(refundId: string, actor: Actor): Promise<RefundDocument> {
    let r = await this.refunds.findOneAndUpdate({ _id: refundId, state: 'requested' }, { $set: { state: 'approved', decidedBy: { id: actor.id, name: actor.name } } }, { new: true }).exec();
    if (!r) {
      const found = await this.refunds.findById(refundId).exec();
      if (!found) throw new NotFoundException('Refund not found');
      if (found.state !== 'approved' || found.announcedAt) return found;
      r = found;
    }
    try {
      return await this.announce(r);
    } catch (e) {
      await this.refunds.updateOne({ _id: r._id, state: 'approved', announcedAt: null }, { $set: { state: 'requested' }, $unset: { decidedBy: 1 } }).exec().catch(() => undefined);
      throw e;
    }
  }

  private taskFields(r: RefundDocument, bill: { number: string; patientName: string; patientUhid: string }) {
    return {
      title: `Pay refund ${r.number}: ${formatRupees(r.amount)}`,
      subtitle: `Bill ${bill.number}`,
      patientName: bill.patientName,
      uhid: bill.patientUhid,
      type: 'System',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    };
  }

  /** The reconcile pass: writes the task of an approved, announced refund when it is missing. Never reopens one. Never throws; true when it wrote one. */
  async ensureTask(refundId: string): Promise<boolean> {
    try {
      const r = isValidObjectId(refundId) ? await this.refunds.findById(refundId).exec() : null;
      if (!r || r.state !== 'approved' || !r.announcedAt) return false;
      const bill = await this.bills.get(String(r.bill));
      const res = await this.alerts.updateOne({ link: link(r._id) }, { $setOnInsert: { ...this.taskFields(r, bill), link: link(r._id) } }, { upsert: true }).exec();
      return !!res.upsertedCount;
    } catch (e) {
      this.logger.warn(`Refund ${refundId}: task not restored (${(e as Error).message})`);
      return false;
    }
  }

  private async announce(r: RefundDocument): Promise<RefundDocument> {
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
      await this.alerts.create({ ...this.taskFields(r, bill), link: link(r._id) });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    return (await this.refunds.findOneAndUpdate({ _id: r._id }, { $set: { announcedAt: new Date(), dueAt } }, { new: true }).exec()) ?? r;
  }

  /**
   * Sends the message for a refund that has ended: `revenue.refund-paid` (paid) or `revenue.refund-void` (void), completes its
   * task, and sets announcedAt only when the send went. Never throws; true when it sent.
   */
  private async announceEnd(refundId: string): Promise<boolean> {
    try {
      const r = await this.refunds.findById(refundId).exec();
      if (!r || (r.state !== 'paid' && r.state !== 'void')) return false;
      const bill = await this.bills.get(String(r.bill));
      if (r.state === 'paid') {
        const amount = r.paid?.amount ?? r.amount;
        await this.registration.send(
          'revenue.refund-paid',
          bill,
          { refundId: String(r._id), refundNumber: r.number, billNumber: bill.number },
          { text: `Refund ${r.number} paid by ${r.paid?.mode ?? 'cash'}`, amount, dedupeKey: `refund-paid:${String(r._id)}` },
        );
      } else {
        await this.registration.send(
          'revenue.refund-void',
          bill,
          { refundId: String(r._id), refundNumber: r.number, billNumber: bill.number },
          { text: `Refund ${r.number} is no longer owed`, dedupeKey: `refund-void:${String(r._id)}` },
        );
      }
      await this.alerts.updateOne({ link: link(r._id), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
      await this.refunds.updateOne({ _id: r._id, state: r.state }, { $set: { announcedAt: new Date() } }).exec();
      return true;
    } catch (e) {
      this.logger.warn(`Refund ${refundId}: Coordinator message not sent; the reconcile pass will send it (${(e as Error).message})`);
      return false;
    }
  }

  /**
   * The reconcile pass: sends what a refund's current state owes the Coordinator, when it has no announcedAt. An approved refund
   * gets `revenue.refund-due` and its task; a paid or void one gets its end message. Never throws; true when it sent.
   */
  async reannounce(refundId: string): Promise<boolean> {
    try {
      const r = isValidObjectId(refundId) ? await this.refunds.findById(refundId).exec() : null;
      if (!r || r.announcedAt) return false;
      if (r.state === 'approved') {
        await this.announce(r);
        return true;
      }
      return await this.announceEnd(refundId);
    } catch (e) {
      this.logger.warn(`Refund ${refundId}: not re-announced (${(e as Error).message})`);
      return false;
    }
  }

  /** R27: a refund that leaves the balance at 0 settles the bill through the guarded settle. A failure is logged, not thrown. */
  private async settleIfZero(billId: string): Promise<void> {
    try {
      const bill = await this.bills.get(billId);
      if ((bill.totals?.balance ?? 0) === 0 && bill.state !== 'settled') await this.final.settle('agent', billId);
    } catch (e) {
      this.logger.warn(`Bill ${billId} did not settle after its refund (${(e as Error).message})`);
    }
  }

  /** The bill owes the patient nothing any more: the refund is void, its task completes and its clock stops (R25). */
  private async voidRefund(found: RefundDocument, bill: { _id: unknown; number: string; case?: unknown }): Promise<RefundDocument> {
    const v = await this.refunds.findOneAndUpdate({ _id: found._id, state: 'approved' }, { $set: { state: 'void', waiting: false, voidReason: 'Nothing left to refund' }, $unset: { announcedAt: 1 } }, { new: true }).exec();
    if (!v) throw new ConflictException('This refund is no longer waiting');
    // R23: the void message is owed until it is sent; the reconcile pass re-sends it (that is what stops the clock).
    await this.announceEnd(String(v._id));
    await this.settleIfZero(String(v.bill));
    return v;
  }

  /**
   * Pays an approved refund once: the total moves only if this call won the claim, and goes back if the move fails. It pays
   * what the bill owes the patient now, at most the approved amount; when nothing is owed the refund is voided (R25).
   */
  async pay(actor: Actor, refundId: string, input: { mode: string; reference?: string }): Promise<RefundDocument> {
    this.desk(actor);
    if (!MODES.includes(input?.mode)) throw new BadRequestException('The payment mode must be cash, upi or card');
    const found = isValidObjectId(refundId) ? await this.refunds.findById(refundId).exec() : null;
    if (!found) throw new NotFoundException('Refund not found');
    if (found.state === 'paid') throw new ConflictException('This refund is already paid');
    if (found.state === 'void') throw new ConflictException('This refund is void: nothing is left to refund');
    if (found.state !== 'approved') throw new ConflictException('The refund has not been approved');
    const bill = await this.bills.get(String(found.bill));
    const owed = -(bill.totals?.balance ?? 0);
    if (bill.state === 'settled' || owed < 1) return this.voidRefund(found, bill);
    const amount = Math.min(found.amount, owed);
    const paid = await this.refunds
      .findOneAndUpdate(
        { _id: found._id, state: 'approved' },
        { $set: { state: 'paid', waiting: false, paid: { at: clinicNow(), by: { id: actor.id, name: actor.name }, amount, mode: input.mode, reference: (input.reference ?? '').trim().slice(0, 80) } }, $unset: { announcedAt: 1 } },
        { new: true },
      )
      .exec();
    if (!paid) throw new ConflictException('This refund is already paid');
    try {
      await this.bills.adjust(String(bill._id), { refunds: amount }, { onlyActive: true });
    } catch (e) {
      await this.refunds.updateOne({ _id: paid._id }, { $set: { state: 'approved', waiting: true, ...(found.announcedAt ? { announcedAt: found.announcedAt } : {}) }, $unset: { paid: 1 } }).exec();
      throw e;
    }
    // The money is recorded; if the message fails, the reconcile pass tells the Coordinator again.
    await this.announceEnd(String(paid._id));
    await this.settleIfZero(String(bill._id));
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
      amount: r.paid?.amount ?? r.amount,
      state: r.state,
      mode: r.paid?.mode ?? null,
      reference: r.paid?.reference ?? '',
      paidBy: r.paid?.by.name ?? null,
      at: r.paid?.at ?? null,
    };
  }
}
