import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueOpdService } from './revenue-opd.service';
import { PaymentsService } from './revenue-payments.service';
import { BillDocument } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';
import { Payment, PaymentDocument } from './schemas/payment.schema';

const BY = { name: 'Revenue Agent' };

/** An OP visit the reception kiosk was paid for, as Revenue needs it. */
export interface KioskVisitInput {
  visitId: string;
  uhid: string;
  doctorId: string;
  doctorName: string;
  /** Whole rupees, as the kiosk charged it. */
  fee: number;
  /** The visit's clinic day, YYYY-MM-DD: it picks the OPD or walk-in bill. */
  day: string;
  /** The appointment the visit's token checked in, with the same doctor: its own check-in charge is the consultation. */
  appointmentId?: string;
  /** How the patient paid, for the receipt: `Cash at counter`, `UPI · <ref> · SAMPLE`. */
  reference: string;
  /** Who took the payment: the kiosk, or the staff member who took the cash. */
  by: string;
  /** When the money came in (clinic clock). */
  at: Date;
}

/** Where the visit was recorded. No receipt when there was nothing to pay (a fee of 0). */
export interface KioskVisitRecord {
  billId: string;
  billNumber: string;
  receiptNumber?: string;
}

/** The payment's source key for an OP visit. */
export const kioskSource = (visitId: string) => `op-visit:${visitId}`;

/**
 * The reception kiosk's entry into the Revenue Agent (spec 4.5, ruling R26): the consultation and the kiosk payment of one
 * OP visit, once per visit, so a retry, a heal or a replay never records twice. The charge is made before the payment, so the
 * payment never lands on a missing bill or leaves the bill in credit. The reception module calls this; Revenue never calls it.
 */
@Injectable()
export class RevenueKioskService {
  constructor(
    private readonly opd: RevenueOpdService,
    private readonly bills: RevenueBillsService,
    private readonly payments: PaymentsService,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
  ) {}

  async record(visit: KioskVisitInput): Promise<KioskVisitRecord> {
    const source = kioskSource(visit.visitId);
    // A replay finds its payment first, so it never charges or pays twice.
    const paid = await this.paymentModel.findOne({ source }).lean().exec();
    if (paid) return this.recordOf(await this.bills.get(String(paid.bill)), paid.receiptNumber);
    const bill = await this.consultationBill(visit);
    // A fee of 0 is a Needs-price line (spec 4.3); there is nothing to pay.
    if (visit.fee < 1) return this.recordOf(bill);
    const payment = await this.payments.recordKiosk(String(bill._id), { amount: visit.fee, reference: visit.reference, source, by: visit.by, at: visit.at });
    return this.recordOf(bill, payment.receiptNumber);
  }

  /** The bill holding the visit's consultation, charged now if it is not yet. */
  private async consultationBill(visit: KioskVisitInput): Promise<BillDocument> {
    if (visit.appointmentId) {
      // The appointment's own check-in charge: Revenue's check-in hook, arriving before or after, finds it and adds nothing.
      await this.opd.chargeFee(visit.appointmentId);
      const line = await this.chargeLines.findOne({ 'source.type': 'opd-fee', 'source.ref': visit.appointmentId }).lean().exec();
      if (!line) throw new ConflictException(`The consultation of appointment ${visit.appointmentId} is not on a bill yet`);
      return this.bills.get(String(line.bill));
    }
    const source = { type: 'op-visit', ref: visit.visitId };
    // A replay finds the line first, so it never opens an empty bill.
    const charged = await this.chargeLines.findOne({ 'source.type': source.type, 'source.ref': source.ref }).lean().exec();
    if (charged) return this.bills.get(String(charged.bill));
    const patient = await this.patients.findOne({ uhid: visit.uhid }).select('_id').lean().exec();
    if (!patient) throw new NotFoundException(`Patient ${visit.uhid} not found`);
    // Spec 4.1: the patient's OPD visit bill for the day, else a walk-in bill.
    const bill = await this.bills.forCharge({ patientId: String(patient._id), day: visit.day });
    const { line } = await this.bills.addCharge(String(bill._id), {
      code: `opd:${visit.doctorId}`,
      name: `Consultation - ${visit.doctorName}`,
      category: 'consultation',
      qty: 1,
      unitPrice: visit.fee,
      needsPrice: !(visit.fee > 0),
      source,
      by: BY,
    });
    // Two at once: the line that won may be on the other request's bill.
    return String(line.bill) === String(bill._id) ? bill : this.bills.get(String(line.bill));
  }

  private recordOf(bill: BillDocument, receiptNumber?: string): KioskVisitRecord {
    return { billId: String(bill._id), billNumber: bill.number, ...(receiptNumber ? { receiptNumber } : {}) };
  }
}
