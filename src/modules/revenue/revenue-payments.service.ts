import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import { FinalBillService } from './revenue-final.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { clinicDayWindow } from './revenue-overview.service';
import { Bill, BillDocument } from './schemas/bill.schema';
import { RevenueSettingsService } from './revenue-settings.service';
import { Payment, PaymentDocument, PaymentKind, PAYMENT_KINDS } from './schemas/payment.schema';

export interface PaymentInput {
  amount: number;
  mode: 'cash' | 'upi' | 'card';
  reference?: string;
  kind: PaymentKind;
}

/** A payment the reception kiosk took. */
export interface KioskPaymentInput {
  amount: number;
  /** How the patient paid, as the receipt shows it: `Cash at counter`, `UPI · <ref> · SAMPLE`. */
  reference: string;
  /** One payment per source: `op-visit:<id>`. */
  source: string;
  /** Who received it (R34): for cash the staff member who took it at the counter, for UPI and card the kiosk device. */
  by: { id: string; name: string };
  /** When the money came in (clinic clock). */
  at: Date;
}

export const MAX_PAYMENT = 1_000_000;
/** `kiosk` is the reception kiosk's own mode (recordKiosk) and is not accepted from the desk. */
const DESK_MODES = ['cash', 'upi', 'card'];

const checkAmount = (amount: number) => {
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_PAYMENT) throw new BadRequestException('The amount must be a whole number of rupees, from 1 to 10,00,000');
};

/** Desk payments and their receipts. A payment is never deleted: cancelling it is a separate, admin-only record. */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly registration: RevenueCoordinatorRegistration,
    private readonly settings: RevenueSettingsService,
    private readonly bills: RevenueBillsService,
    private readonly final: FinalBillService,
    @InjectModel(Payment.name) private readonly payments: Model<PaymentDocument>,
  ) {}

  /** Records a payment and gives the receipt number (RC-0001). Refused on a settled bill. */
  async record(actor: Actor, billId: string, input: PaymentInput): Promise<PaymentDocument> {
    const { amount, mode, kind } = input;
    checkAmount(amount);
    if (!DESK_MODES.includes(mode)) throw new BadRequestException('The payment mode must be cash, upi or card');
    if (!PAYMENT_KINDS.includes(kind)) throw new BadRequestException('The payment kind must be deposit, part or settlement');
    const bill = await this.bills.get(billId);
    if (bill.state === 'settled') throw new ConflictException('This bill is settled');
    const payment = await this.payments.create({
      receiptNumber: await this.bills.nextNumber('revenue-receipt', 'RC'),
      bill: bill._id,
      amount,
      mode,
      reference: (input.reference ?? '').trim().slice(0, 80),
      kind,
      by: { id: actor.id, name: actor.name },
      at: clinicNow(),
    });
    return this.book(bill, payment);
  }

  /**
   * A payment the reception kiosk took (spec 4.5): mode `kiosk`, the real method in the reference, and a settlement of the
   * fee, as the desk records an OPD fee. Once per source: a repeat, or two at once, give back the first. Refused on a settled bill.
   */
  async recordKiosk(billId: string, input: KioskPaymentInput): Promise<PaymentDocument> {
    const earlier = await this.payments.findOne({ source: input.source }).exec();
    if (earlier) return earlier;
    checkAmount(input.amount);
    const bill = await this.bills.get(billId);
    if (bill.state === 'settled') throw new ConflictException('This bill is settled');
    let payment: PaymentDocument;
    try {
      payment = await this.payments.create({
        receiptNumber: await this.bills.nextNumber('revenue-receipt', 'RC'),
        bill: bill._id,
        amount: input.amount,
        mode: 'kiosk',
        reference: input.reference.trim().slice(0, 80),
        source: input.source,
        kind: 'settlement',
        by: { id: input.by.id, name: input.by.name },
        at: input.at,
      });
    } catch (e) {
      const err = e as { code?: number; keyPattern?: Record<string, unknown> };
      if (err.code === 11000 && err.keyPattern && 'source' in err.keyPattern) {
        const won = await this.payments.findOne({ source: input.source }).exec();
        if (won) return won;
      }
      throw e;
    }
    return this.book(bill, payment);
  }

  /** Puts a new payment on the bill's totals, then tells the Coordinator and settles an OPD bill that is now done. */
  private async book(bill: BillDocument, payment: PaymentDocument): Promise<PaymentDocument> {
    try {
      // Guarded: a bill that settled a moment ago takes no payment, and the receipt is removed again.
      await this.bills.adjust(String(bill._id), { payments: payment.amount }, { onlyActive: true });
    } catch (e) {
      await this.payments.deleteOne({ _id: payment._id }).exec();
      throw e;
    }
    // The money is recorded; if the message fails, the reconcile pass re-sends it.
    await this.announce(String(payment._id));
    // R18: a payment that brings an OPD bill to 0 after the visit ended settles it.
    await this.final.autoSettleOpd(String(bill._id));
    return payment;
  }

  /**
   * Sends `revenue.payment` for a payment and sets its announcedAt only when the send went. A cancelled payment is not
   * announced. The reconcile pass calls this for a payment with no announcedAt. Never throws; true when it sent.
   */
  async announce(paymentId: string): Promise<boolean> {
    try {
      const payment = isValidObjectId(paymentId) ? await this.payments.findById(paymentId).exec() : null;
      if (!payment || payment.cancelled) return false;
      const bill = await this.bills.get(String(payment.bill));
      await this.registration.send(
        'revenue.payment',
        bill,
        { billId: String(bill._id), billNumber: bill.number, receiptNumber: payment.receiptNumber, amount: payment.amount, mode: payment.mode },
        { text: `Payment ${payment.receiptNumber} received by ${payment.mode}`, amount: payment.amount, dedupeKey: `payment:${String(payment._id)}` },
      );
      await this.payments.updateOne({ _id: payment._id }, { $set: { announcedAt: new Date() } }).exec();
      return true;
    } catch (e) {
      this.logger.warn(`Payment ${paymentId}: Coordinator message not sent (${(e as Error).message})`);
      return false;
    }
  }

  /** Admin only, active bill only (after settling, money back is a refund). Keeps the payment and says who, when and why. */
  async cancel(actor: Actor, paymentId: string, reason: string): Promise<PaymentDocument> {
    if (actor.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can cancel a payment');
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Say why the payment is cancelled');
    if (why.length > 300) throw new BadRequestException('The reason is too long (300 characters at most)');
    const found = isValidObjectId(paymentId) ? await this.payments.findById(paymentId).exec() : null;
    if (!found) throw new NotFoundException('Payment not found');
    if (found.cancelled) throw new ConflictException('This payment is already cancelled');
    const bill = await this.bills.get(String(found.bill));
    if (bill.state === 'settled') throw new ConflictException('This bill is settled');
    const claimed = await this.payments
      .findOneAndUpdate({ _id: found._id, cancelled: { $exists: false } }, { $set: { cancelled: { at: clinicNow(), by: { id: actor.id, name: actor.name }, reason: why } } }, { new: true })
      .exec();
    if (!claimed) throw new ConflictException('This payment is already cancelled');
    try {
      await this.bills.adjust(String(bill._id), { payments: -found.amount }, { onlyActive: true });
    } catch (e) {
      await this.payments.updateOne({ _id: found._id }, { $unset: { cancelled: 1 } }).exec();
      throw e;
    }
    return claimed;
  }

  /** The clinic day's payments, newest first (R35). */
  async list(filter: { day?: string } = {}) {
    const day = filter.day ?? isoDate(clinicNow());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isoDate(parseIsoDay(day)) !== day) throw new BadRequestException('day must be a date as YYYY-MM-DD');
    const { from, to } = clinicDayWindow(day);
    const rows = await this.payments.find({ at: { $gte: from, $lt: to } }).sort({ at: -1, _id: -1 }).lean().exec();
    const billModel = this.payments.db.model<BillDocument>(Bill.name);
    const found = await billModel.find({ _id: { $in: [...new Set(rows.map((r) => String(r.bill)))] } }).select('number kind state patientName patientUhid').lean().exec();
    const byId = new Map(found.map((b) => [String(b._id), b]));
    return rows.map((p) => {
      const b = byId.get(String(p.bill));
      return {
        id: String(p._id),
        receiptNumber: p.receiptNumber,
        billId: String(p.bill),
        billNumber: b?.number ?? '',
        billKind: b?.kind ?? '',
        // The bill's state now: no cancel on a settled bill (R18), and the balance worded by it (R39).
        billState: b?.state ?? '',
        patientName: b?.patientName ?? '',
        patientUhid: b?.patientUhid ?? '',
        amount: p.amount,
        mode: p.mode,
        kind: p.kind,
        reference: p.reference,
        receivedBy: p.by?.name ?? '',
        at: p.at,
        cancelled: !!p.cancelled,
        cancelledReason: p.cancelled?.reason ?? null,
      };
    });
  }

  /** What the receipt prints. */
  async receipt(paymentId: string) {
    const payment = isValidObjectId(paymentId) ? await this.payments.findById(paymentId).lean().exec() : null;
    if (!payment) throw new NotFoundException('Payment not found');
    const [bill, cfg] = await Promise.all([this.bills.get(String(payment.bill)), this.settings.get()]);
    return {
      header: cfg.receiptHeader,
      receiptNumber: payment.receiptNumber,
      billNumber: bill.number,
      patientName: bill.patientName,
      patientUhid: bill.patientUhid,
      amount: payment.amount,
      mode: payment.mode,
      reference: payment.reference,
      kind: payment.kind,
      receivedBy: payment.by.name,
      at: payment.at,
      balance: bill.totals?.balance ?? 0,
      // The bill's state now, so a reprint words the balance as the bill stands (R39).
      billState: bill.state,
      cancelled: payment.cancelled ? { at: payment.cancelled.at, by: payment.cancelled.by.name, reason: payment.cancelled.reason } : null,
    };
  }
}
