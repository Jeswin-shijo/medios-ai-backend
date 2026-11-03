import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { MessagesService } from '../coordinator/messages.service';
import { LabLine, LabLineDocument } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
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
  ) {
    // A.2: the ER trigger is er.left with any reason but `admitted` (the stay's own bill asks at bed.discharged).
    registration.capture.set('er.left', (id) => this.onErLeft(id));
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
   * Asks the desk to prepare the bill: sends `revenue.final-requested` (the 60-minute clock, real time) and raises the
   * `:final` task. Only an open ER or admission bill; a replay finds the task and does nothing. Returns true when it asked.
   */
  async request(_actor: Actor | 'agent', billId: string): Promise<boolean> {
    if (!isValidObjectId(billId)) return false;
    const bill = await this.billModel.findById(billId).exec();
    if (!bill || bill.state !== 'open' || (bill.kind !== 'er' && bill.kind !== 'admission')) return false;
    const link = finalLink(bill._id);
    if (await this.alerts.exists({ link })) return false;
    const cfg = await this.settings.get();
    const dueAt = new Date(Date.now() + cfg.clocks.final * 60_000);
    // The message first: its dedupe key makes a retry after a crash safe, and the clock starts from it.
    await this.registration.send(
      'revenue.final-requested',
      bill,
      { billId: String(bill._id), billNumber: bill.number, dueAt },
      { text: 'Final bill to prepare', dedupeKey: `final:${String(bill._id)}` },
    );
    try {
      await this.alerts.create({
        title: `Prepare final bill: ${bill.number}`,
        subtitle: bill.kind === 'er' ? 'The ER visit has ended' : 'The patient has been discharged',
        patientName: bill.patientName,
        uhid: bill.patientUhid,
        type: 'System',
        category: 'System',
        priority: 'Medium',
        status: 'Pending',
        link,
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return false;
    }
    return true;
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
      out.push({ kind: 'admission', text: 'The patient is still admitted' });
    }
    const unpriced = await this.chargeLines.find({ bill: bill._id, needsPrice: true }).select('name').lean().exec();
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
    await this.billModel.updateOne({ _id: first._id, state: 'open' }, { $set: { state: 'final', finalAt: clinicNow() } }).exec();
    const bill = await this.billModel.findById(first._id).exec();
    if (!bill) throw new NotFoundException('Bill not found');
    if (bill.state === 'settled') throw new ConflictException('This bill is settled');
    const warnings = await this.warningsFor(bill);
    const balance = bill.totals?.balance ?? 0;
    await this.registration.send(
      'revenue.bill-final',
      bill,
      { billId: String(bill._id), billNumber: bill.number, balance },
      { text: balance < 0 ? 'Final bill ready, refund owed' : 'Final bill ready', amount: Math.abs(balance), dedupeKey: `final-ready:${String(bill._id)}:${balance}` },
    );
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
    const bill = await this.billModel
      .findOneAndUpdate({ _id: id, state: { $in: ACTIVE_BILL_STATES }, 'totals.balance': 0 }, { $set: { state: 'settled', settledAt: clinicNow() } }, { new: true })
      .exec();
    if (!bill) {
      const now = await this.billModel.findById(id).select('state').lean().exec();
      if (!now) throw new NotFoundException('Bill not found');
      throw new ConflictException(now.state === 'settled' ? 'This bill is settled' : 'The balance is not zero');
    }
    try {
      await this.alerts.updateMany({ link: new RegExp(`^revenue-bill:${String(bill._id)}:`), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
      await this.registration.send(
        'revenue.bill-settled',
        bill,
        { billId: String(bill._id), billNumber: bill.number, total: (bill.totals?.charges ?? 0) - (bill.totals?.discounts ?? 0) },
        { text: 'Bill settled', amount: (bill.totals?.charges ?? 0) - (bill.totals?.discounts ?? 0), dedupeKey: `settled:${String(bill._id)}` },
      );
    } catch (e) {
      // The bill is settled; the reconcile pass (Task 11) tells the Coordinator again.
      this.logger.warn(`Bill ${bill.number} settled, but its tasks or message failed (${(e as Error).message})`);
    }
    return bill;
  }

  /** An OPD bill with nothing due settles by itself once the visit is Completed. True when it settled. */
  async autoSettleOpd(billId: string): Promise<boolean> {
    try {
      if (!isValidObjectId(billId)) return false;
      const bill = await this.billModel.findById(billId).lean().exec();
      if (!bill || bill.kind !== 'opd' || !ACTIVE_BILL_STATES.includes(bill.state) || (bill.totals?.balance ?? 0) !== 0 || !bill.appointment) return false;
      const appointment = await this.appointments.findById(bill.appointment).select('status').lean().exec();
      if (appointment?.status !== 'Completed') return false;
      await this.settle('agent', String(bill._id));
      return true;
    } catch (e) {
      // A charge or a second settle got there first: not an error.
      if ((e as { status?: number }).status !== 409) this.logger.warn(`OPD auto-settle of ${billId} failed (${(e as Error).message})`);
      return false;
    }
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
}
