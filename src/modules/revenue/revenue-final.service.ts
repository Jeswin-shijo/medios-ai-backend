import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, displayTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { MessagesService } from '../coordinator/messages.service';
import { DischargeOrder, DischargeOrderDocument, OPEN_ORDER_STATES } from '../discharge/schemas/discharge-order.schema';
import { LabLine, LabLineDocument } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
import { QueueToken, QueueTokenDocument } from '../queue/schemas/queue-token.schema';
import { OpVisit, OpVisitDocument } from '../reception/schemas/op-visit.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueSettingsService } from './revenue-settings.service';
import { ACTIVE_BILL_STATES, Bill, BillDocument } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';

export interface FinalWarning {
  kind: 'pharmacy' | 'lab' | 'admission' | 'needs-price';
  text: string;
}

/** Lab lines past collection: a charge was made for each when the sample was collected. */
const COLLECTED = ['collected', 'received', 'awaiting-validation', 'released'];
const finalLink = (billId: unknown) => `revenue-bill:${String(billId)}:final`;
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const list = (names: string[]) => (names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', '));
/** "02:30 PM": a clinic-clock moment in the app's 12-hour format (B3-M6). */
const hhmm = (d: Date) => displayTime(d);
const date = (v: unknown): Date | null => {
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

/**
 * The final bill and settlement. Preparing the bill, and settling it, are desk actions; nothing here holds care.
 * A final-bill request exists only for ER and admission bills. Handlers never throw.
 */
@Injectable()
export class FinalBillService {
  private readonly logger = new Logger(FinalBillService.name);

  constructor(
    private readonly messages: MessagesService,
    private readonly registration: RevenueCoordinatorRegistration,
    private readonly settings: RevenueSettingsService,
    private readonly bills: RevenueBillsService,
    @InjectModel(Bill.name) private readonly billModel: Model<BillDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    @InjectModel(PharmacyOrder.name) private readonly pharmacyOrders: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
    @InjectModel(LabRequest.name) private readonly labRequests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly labLines: Model<LabLineDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    /** Read-only: the open discharge order of a stay (its planned leaving time). */
    @InjectModel(DischargeOrder.name) private readonly dischargeOrders: Model<DischargeOrderDocument>,
    /** The reception kiosk's visits and the queue's tokens, read-only (R30). Absent only where the service is built by hand (seeds, specs): a kiosk visit then never counts as over. */
    @InjectModel(OpVisit.name) private readonly opVisits?: Model<OpVisitDocument>,
    @InjectModel(QueueToken.name) private readonly tokens?: Model<QueueTokenDocument>,
  ) {
    // A.2: the ER trigger is er.left with any reason but `admitted` (the stay's own bill asks at bed.discharged).
    registration.capture.set('er.left', (id) => this.onErLeft(id));
    // Discharge A2: a stay's bill is asked for when its discharge window opens, before the patient leaves.
    registration.capture.set('discharge.window-opened', (id) => this.onWindowOpened(id));
  }

  /** discharge.window-opened: the final bill for the stay's active admission bill, once. Never throws. */
  private async onWindowOpened(messageId: string): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message) {
        this.logger.warn(`discharge.window-opened: message ${messageId} not found`);
        return;
      }
      const payload = message.payload ?? {};
      const admissionId = str(payload.admissionId);
      const bill =
        admissionId && isValidObjectId(admissionId)
          ? await this.billModel.findOne({ kind: 'admission', admission: new Types.ObjectId(admissionId), state: { $in: ACTIVE_BILL_STATES } }).select('_id').lean().exec()
          : null;
      if (!bill) {
        this.logger.warn(`discharge.window-opened: no active bill for admission ${admissionId ?? '(none)'}; no final bill requested`);
        return;
      }
      await this.request('agent', String(bill._id), { leavingAt: date(payload.plannedLeaveAt) ?? undefined });
    } catch (e) {
      this.logger.warn(`discharge.window-opened: final bill not requested (${(e as Error).message})`);
    }
  }

  /** The planned leaving time (clinic clock) of the stay's order in progress, or null. */
  private async leavingAt(admission: unknown): Promise<Date | null> {
    if (!admission) return null;
    const order = await this.dischargeOrders
      .findOne({ admission, state: { $in: OPEN_ORDER_STATES } })
      .sort({ orderedAt: -1, _id: -1 })
      .select('plannedLeaveAt')
      .lean()
      .exec();
    return date(order?.plannedLeaveAt);
  }

  /** For an admission bill whose patient is still admitted: the planned leaving time of the stay's order in progress, or null. */
  private async leavingFor(bill: { kind: string; admission?: unknown }): Promise<Date | null> {
    if (bill.kind !== 'admission' || !bill.admission) return null;
    if (!(await this.admissions.exists({ _id: bill.admission, status: 'active' }))) return null;
    return this.leavingAt(bill.admission);
  }

  private async onErLeft(messageId: string): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message) {
        this.logger.warn(`er.left: message ${messageId} not found`);
        return;
      }
      const payload = message.payload ?? {};
      const reason = str(payload.reason);
      if (!reason || reason === 'admitted') return;
      const visitId = str(payload.visitId);
      const bill = visitId && isValidObjectId(visitId) ? await this.billModel.findOne({ kind: 'er', erVisit: new Types.ObjectId(visitId) }).sort({ openedAt: -1, _id: -1 }).lean().exec() : null;
      if (!bill) {
        this.logger.warn(`er.left: no ER bill for visit ${visitId ?? '(none)'}; no final bill requested`);
        return;
      }
      await this.request('agent', String(bill._id));
    } catch (e) {
      this.logger.warn(`er.left: final bill not requested (${(e as Error).message})`);
    }
  }

  /**
   * Asks the desk to prepare the bill: writes the `:final` task first (the marker that the ask was made), then sends
   * `revenue.final-requested` (the 60-minute clock, real time) through the never-throwing announce. A failed send leaves an
   * open, unannounced task, which the reconcile pass re-sends (R29). Only an open ER or admission bill; a replay finds the task
   * and does nothing. The task names the planned leaving time while the stay's discharge order is in progress: `leavingAt` (the
   * window message's) or, when it is not given, the open order's. Returns true when it asked.
   */
  async request(_actor: Actor | 'agent', billId: string, opts: { leavingAt?: Date | null } = {}): Promise<boolean> {
    if (!isValidObjectId(billId)) return false;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || bill.state !== 'open' || (bill.kind !== 'er' && bill.kind !== 'admission')) return false;
    const link = finalLink(bill._id);
    if (await this.alerts.exists({ link })) return false;
    const leavingAt = opts.leavingAt !== undefined ? opts.leavingAt : await this.leavingFor(bill);
    try {
      await this.alerts.create({ ...this.finalTaskFields(bill, { leavingAt }), link });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return false;
    }
    await this.announce(String(bill._id));
    return true;
  }

  private finalTaskFields(bill: BillDocument, opts: { leavingAt?: Date | null } = {}) {
    const subtitle =
      bill.kind === 'er' ? 'The ER visit has ended' : opts.leavingAt ? `Discharge ordered: leaving ~${hhmm(opts.leavingAt)}` : 'The patient has been discharged';
    return {
      title: `Prepare final bill: ${bill.number}`,
      subtitle,
      patientName: bill.patientName,
      uhid: bill.patientUhid,
      type: 'System',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    };
  }

  /**
   * The reconcile pass: writes the `:final` task of an open ER or admission bill whose final bill was asked for (announcedAt is
   * set only after the request) when the task is missing, naming the planned leaving time while the stay's discharge order is in
   * progress. Never reopens one that exists. Never throws; true when it wrote one.
   */
  async ensureFinalTask(billId: string): Promise<boolean> {
    try {
      const bill = isValidObjectId(billId) ? await this.billModel.findById(billId).exec() : null;
      if (!bill || bill.state !== 'open' || !bill.announcedAt || (bill.kind !== 'er' && bill.kind !== 'admission')) return false;
      const link = finalLink(bill._id);
      const fields = this.finalTaskFields(bill, { leavingAt: await this.leavingFor(bill) });
      const r = await this.alerts.updateOne({ link }, { $setOnInsert: { ...fields, link } }, { upsert: true }).exec();
      return !!r.upsertedCount;
    } catch (e) {
      this.logger.warn(`Final-bill task of ${billId} not restored (${(e as Error).message})`);
      return false;
    }
  }

  /**
   * Sends the message for the bill's current state, after the state is written: `revenue.final-requested` (an open ER or
   * admission bill whose `:final` task is open), `revenue.bill-final` (final) or `revenue.bill-settled` (settled). Each send is
   * deduped; announcedAt is set only when it went. The reconcile pass calls this for a bill with no announcedAt. Never throws.
   * Returns true when it sent.
   */
  async announce(billId: string): Promise<boolean> {
    try {
      const bill = isValidObjectId(billId) ? await this.billModel.findById(billId).exec() : null;
      if (!bill) return false;
      const state = bill.state;
      if (state === 'open') {
        if (bill.kind !== 'er' && bill.kind !== 'admission') return false;
        const task = await this.alerts.findOne({ link: finalLink(bill._id) }).lean<{ status: string; createdAt?: Date }>().exec();
        if (!task || task.status === 'Completed') return false;
        const cfg = await this.settings.get();
        // The clock runs from when the task was written; the real dueAt of the first send is not kept.
        const dueAt = new Date(new Date(task.createdAt ?? Date.now()).getTime() + cfg.clocks.final * 60_000);
        await this.registration.send(
          'revenue.final-requested',
          bill,
          { billId: String(bill._id), billNumber: bill.number, dueAt },
          { text: 'Final bill to prepare', dedupeKey: `final:${String(bill._id)}` },
        );
      } else if (state === 'final') {
        const balance = bill.totals?.balance ?? 0;
        await this.registration.send(
          'revenue.bill-final',
          bill,
          { billId: String(bill._id), billNumber: bill.number, balance },
          { text: balance < 0 ? 'Final bill ready, refund owed' : 'Final bill ready', amount: Math.abs(balance), dedupeKey: `final-ready:${String(bill._id)}:${balance}` },
        );
      } else {
        const total = (bill.totals?.charges ?? 0) - (bill.totals?.discounts ?? 0);
        await this.registration.send(
          'revenue.bill-settled',
          bill,
          { billId: String(bill._id), billNumber: bill.number, total },
          { text: 'Bill settled', amount: total, dedupeKey: `settled:${String(bill._id)}` },
        );
      }
      await this.billModel.updateOne({ _id: bill._id, state }, { $set: { announcedAt: new Date() } }).exec();
      return true;
    } catch (e) {
      this.logger.warn(`Bill ${billId}: Coordinator message not sent; the reconcile pass will send it (${(e as Error).message})`);
      return false;
    }
  }

  /** Things the desk should look at before the bill goes out. Nothing here stops the bill. */
  private async warningsFor(bill: BillDocument): Promise<FinalWarning[]> {
    const out: FinalWarning[] = [];
    if (bill.case) {
      const orders = await this.pharmacyOrders.find({ case: bill.case }).select('_id').lean().exec();
      const approved = orders.length ? await this.pharmacyLines.find({ order: { $in: orders.map((o) => o._id) }, status: 'approved' }).lean().exec() : [];
      if (approved.length) {
        out.push({ kind: 'pharmacy', text: `${approved.length} medicine${approved.length === 1 ? '' : 's'} approved but not issued: ${list(approved.map((l) => l.freeName || l.product || l.medicine || 'medicine'))}` });
      }
      const requests = await this.labRequests.find({ case: bill.case }).select('_id').lean().exec();
      const lines = requests.length ? await this.labLines.find({ request: { $in: requests.map((r) => r._id) }, status: { $in: COLLECTED } }).lean().exec() : [];
      const unbilled: string[] = [];
      for (const l of lines) {
        if (!(await this.chargeLines.exists({ 'source.type': 'lab', 'source.ref': `${l.request}:${l.test}` }).exec())) unbilled.push(l.test);
      }
      if (unbilled.length) out.push({ kind: 'lab', text: `Collected with no charge: ${list(unbilled)}` });
    }
    if (bill.admission && (await this.admissions.exists({ _id: bill.admission, status: 'active' }))) {
      const leaving = await this.leavingAt(bill.admission);
      out.push({ kind: 'admission', text: leaving ? `Discharge ordered, leaving ~${hhmm(leaving)}` : 'The patient is still admitted' });
    }
    const unpriced = await this.chargeLines.find({ bill: bill._id, needsPrice: true, reversed: { $ne: true } }).select('name').lean().exec();
    if (unpriced.length) out.push({ kind: 'needs-price', text: `${unpriced.length} charge${unpriced.length === 1 ? ' has' : 's have'} no price: ${list(unpriced.map((l) => l.name))}` });
    return out;
  }

  /**
   * Marks the bill final and says so (`revenue.bill-final`, with the balance; negative means a refund is owed), which stops
   * the clock and completes the `:final` task. Charges and payments are still accepted afterwards. Safe to repeat.
   */
  async prepare(_actor: Actor, billId: string) {
    const first = await this.bills.get(billId);
    if (first.state === 'settled') throw new ConflictException('This bill is settled');
    await this.billModel.updateOne({ _id: first._id, state: 'open' }, { $set: { state: 'final', finalAt: clinicNow() }, $unset: { announcedAt: 1 } }).exec();
    const bill = await this.billModel.findById(first._id).exec();
    if (!bill) throw new NotFoundException('Bill not found');
    if (bill.state === 'settled') throw new ConflictException('This bill is settled');
    const warnings = await this.warningsFor(bill);
    // R23: a failed send is healed by the reconcile pass (the bill has no announcedAt), so the desk is not stopped by it.
    await this.announce(String(bill._id));
    await this.alerts.updateOne({ link: finalLink(bill._id), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    return { warnings, view: await this.bills.view(billId) };
  }

  /**
   * Settles the bill. The write itself is guarded: it happens only while the bill is open or final and the balance is
   * exactly 0, so a charge that lands first makes this a 409. Every task on the bill is then completed.
   */
  async settle(_actor: Actor | 'agent', billId: string): Promise<BillDocument> {
    const id = isValidObjectId(billId) ? new Types.ObjectId(billId) : null;
    if (!id) throw new NotFoundException('Bill not found');
    // R19: a waiting correction or refund holds the bill open. The check runs again after the write (below), so a request that
    // slips in between is caught either by this pass or by the request's own "settled?" re-check.
    if (await this.bills.hasPendingMoney(id)) throw new ConflictException('A correction or refund is waiting');
    const bill = await this.billModel
      .findOneAndUpdate(
        {
          _id: id,
          'totals.balance': 0,
          // R21: an ER or admission bill settles only once final; OPD and walk-in bills from open or final.
          $or: [{ kind: { $in: ['opd', 'walk-in'] }, state: { $in: ACTIVE_BILL_STATES } }, { kind: { $in: ['er', 'admission'] }, state: 'final' }],
        },
        { $set: { state: 'settled', settledAt: clinicNow() }, $unset: { announcedAt: 1 } },
        { new: true },
      )
      .exec();
    if (!bill) {
      const now = await this.billModel.findById(id).select('state kind').lean().exec();
      if (!now) throw new NotFoundException('Bill not found');
      if (now.state === 'settled') throw new ConflictException('This bill is settled');
      if (now.state === 'open' && (now.kind === 'er' || now.kind === 'admission')) throw new ConflictException('Prepare the final bill first');
      throw new ConflictException('The balance is not zero');
    }
    if (await this.bills.hasPendingMoney(id)) {
      // A request landed between the check and the write: put the bill back as it was, then refuse.
      await this.billModel.updateOne({ _id: id, state: 'settled' }, { $set: { state: bill.finalAt ? 'final' : 'open' }, $unset: { settledAt: 1 } }).exec();
      throw new ConflictException('A correction or refund is waiting');
    }
    try {
      await this.alerts.updateMany({ link: new RegExp(`^revenue-bill:${String(bill._id)}:`), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    } catch (e) {
      this.logger.warn(`Bill ${bill.number} settled, but its tasks were not completed (${(e as Error).message})`);
    }
    // The bill is settled; if the message fails, the reconcile pass tells the Coordinator again.
    await this.announce(String(bill._id));
    return bill;
  }

  /**
   * An OPD visit's bill with nothing due settles by itself once its visits are over (R1, R30): the appointment it belongs to
   * is Completed, and every reception kiosk visit charged on it (an `op-visit` line) has had its token marked done. That covers
   * a kiosk walk-in's bill and the bill of a kiosk visit with another doctor than the appointment's. With `dayOver` (the
   * reconcile pass's backstop for an earlier clinic day's kiosk bill) the visits need not be over. A bill with neither an
   * appointment nor a kiosk visit, such as a walk-in bill of counter charges, never settles by itself. True when it settled.
   */
  async autoSettleOpd(billId: string, opts: { dayOver?: boolean } = {}): Promise<boolean> {
    try {
      if (!isValidObjectId(billId)) return false;
      const bill = await this.billModel.findById(billId).lean().exec();
      if (!bill || (bill.kind !== 'opd' && bill.kind !== 'walk-in') || !ACTIVE_BILL_STATES.includes(bill.state) || (bill.totals?.balance ?? 0) !== 0) return false;
      const kioskVisits = (await this.chargeLines.distinct('source.ref', { bill: bill._id, 'source.type': 'op-visit' }).exec()) as string[];
      if (!bill.appointment && !kioskVisits.length) return false;
      if (!opts.dayOver) {
        if (bill.appointment) {
          const appointment = await this.appointments.findById(bill.appointment).select('status').lean().exec();
          if (appointment?.status !== 'Completed') return false;
        }
        if (kioskVisits.length && !(await this.kioskVisitsOver(kioskVisits))) return false;
      }
      // R20: an unpriced line is not "nothing due"; the desk prices it or settles by hand.
      if (await this.chargeLines.exists({ bill: bill._id, needsPrice: true, reversed: { $ne: true } })) return false;
      await this.settle('agent', String(bill._id));
      return true;
    } catch (e) {
      // A charge or a second settle got there first: not an error.
      if ((e as { status?: number }).status !== 409) this.logger.warn(`OPD auto-settle of ${billId} failed (${(e as Error).message})`);
      return false;
    }
  }

  /** True when every one of these kiosk visits has a token and each token is marked done. */
  private async kioskVisitsOver(visitIds: string[]): Promise<boolean> {
    if (!this.opVisits || !this.tokens || !visitIds.every((id) => isValidObjectId(id))) return false;
    const visits = await this.opVisits.find({ _id: { $in: visitIds } }).select('tokenId').lean().exec();
    if (visits.length !== visitIds.length || !visits.every((v) => v.tokenId && isValidObjectId(v.tokenId))) return false;
    // A patient who already held a token keeps it for a second visit, so two visits may share one.
    const tokenIds = [...new Set(visits.map((v) => v.tokenId!))];
    return (await this.tokens.countDocuments({ _id: { $in: tokenIds }, status: 'completed' }).exec()) === tokenIds.length;
  }

  async autoSettleForAppointment(appointmentId: string): Promise<boolean> {
    if (!isValidObjectId(appointmentId)) return false;
    const bill = await this.billModel
      .findOne({ kind: 'opd', appointment: new Types.ObjectId(appointmentId), state: { $in: ACTIVE_BILL_STATES } })
      .select('_id')
      .lean()
      .exec();
    return bill ? this.autoSettleOpd(String(bill._id)) : false;
  }

  /** R30: a token was marked done; the bills holding the consultation of a kiosk visit with that token settle if nothing is due. Never throws. */
  async autoSettleForToken(tokenId: string): Promise<boolean> {
    try {
      if (!this.opVisits || !isValidObjectId(tokenId)) return false;
      const visits = await this.opVisits.find({ tokenId }).select('_id').lean().exec();
      if (!visits.length) return false;
      const billIds = await this.chargeLines.distinct('bill', { 'source.type': 'op-visit', 'source.ref': { $in: visits.map((v) => String(v._id)) } }).exec();
      let settled = false;
      for (const id of billIds) if (await this.autoSettleOpd(String(id))) settled = true;
      return settled;
    } catch (e) {
      this.logger.warn(`Bills of token ${tokenId} not settled; the reconcile pass will look again (${(e as Error).message})`);
      return false;
    }
  }
}
