import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ErVisit, ErVisitDocument } from '../er/schemas/er-visit.schema';
import { LabLine, LabLineDocument } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { MessagesService } from '../coordinator/messages.service';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
import { ConsultRequest, ConsultRequestDocument } from '../scheduling/schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { PriceListService } from './price-list.service';
import { consultCode, labCode, medCode, PriceCategory, procCode } from './revenue-catalogue';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';

const BY = { name: 'Revenue Agent' };

export interface SuggestedReversal {
  billId: string;
  /** The ChargeLine _id (not the lab line's). */
  lineId: string;
  reason: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Charges that collect themselves from ER, Lab, Pharmacy and Scheduling messages. Every handler is safe to run twice
 * (the charge source key is unique) and never throws: a problem is logged and the handler returns.
 */
@Injectable()
export class RevenueCaptureService {
  private readonly logger = new Logger(RevenueCaptureService.name);

  /** Task 10 subscribes: a charged lab test was cancelled, so a person may want to reverse the charge. */
  readonly onSuggestedReversal: ((e: SuggestedReversal) => void | Promise<void>)[] = [];

  constructor(
    private readonly messages: MessagesService,
    private readonly prices: PriceListService,
    private readonly bills: RevenueBillsService,
    registration: RevenueCoordinatorRegistration,
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    @InjectModel(LabRequest.name) private readonly labRequests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly labLines: Model<LabLineDocument>,
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly pharmacyOrders: Model<PharmacyOrderDocument>,
    @InjectModel(ProcedureBooking.name) private readonly procedures: Model<ProcedureBookingDocument>,
    @InjectModel(ConsultRequest.name) private readonly consults: Model<ConsultRequestDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
  ) {
    const on = (type: string, fn: (message: { case: string | null; payload: Record<string, unknown> }) => Promise<void>) =>
      registration.capture.set(type, (id) => this.run(type, id, fn));
    on('er.arrived', (m) => this.erArrived(m));
    on('er.doctor-seen', (m) => this.erDoctorSeen(m));
    on('lab.collected', (m) => this.labCollected(m));
    on('lab.cancelled', (m) => this.labCancelled(m));
    on('pharmacy.issued', (m) => this.pharmacyIssued(m));
    on('scheduling.procedure-done', (m) => this.procedureDone(m));
    on('scheduling.consult-seen', (m) => this.consultSeen(m));
  }

  /** Loads the message and runs the handler. Nothing escapes. */
  private async run(
    type: string,
    messageId: string,
    fn: (message: { case: string | null; payload: Record<string, unknown> }) => Promise<void>,
  ): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message) {
        this.logger.warn(`${type}: message ${messageId} not found`);
        return;
      }
      await fn({ case: message.case ?? null, payload: message.payload ?? {} });
    } catch (e) {
      this.logger.warn(`${type}: no charge made (${(e as Error).message})`);
    }
  }

  /** The price, or 0 with needsPrice when the lookup fails. */
  private async price(code: string): Promise<{ price: number; name: string; needsPrice: boolean }> {
    try {
      return await this.prices.priceFor(code);
    } catch (e) {
      this.logger.warn(`Price lookup for ${code} failed (${(e as Error).message}); charging 0`);
      return { price: 0, name: code, needsPrice: true };
    }
  }

  private async charge(
    billId: string,
    code: string,
    category: PriceCategory,
    qty: number,
    source: { type: string; ref: string },
    name?: string,
  ): Promise<void> {
    const p = await this.price(code);
    await this.bills.addCharge(billId, {
      code,
      name: name ?? p.name,
      category,
      qty,
      unitPrice: p.price,
      source,
      needsPrice: p.needsPrice,
      by: BY,
    });
  }

  private async erVisit(payload: Record<string, unknown>) {
    const visitId = str(payload.visitId);
    const visit = visitId ? await this.visits.findById(visitId).lean().exec() : null;
    if (!visit) {
      this.logger.warn(`ER visit ${visitId ?? '(none)'} not found; no charge`);
      return null;
    }
    return visit;
  }

  private async erBill(visit: { _id: unknown; patient: unknown }, caseId: string | null) {
    return this.bills.open({ kind: 'er', erVisitId: String(visit._id), caseId, patientId: String(visit.patient) });
  }

  private async erArrived(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const visit = await this.erVisit(m.payload);
    if (!visit) return;
    const bill = await this.erBill(visit, m.case);
    await this.charge(String(bill._id), 'er:registration', 'er', 1, { type: 'er.arrived', ref: String(visit._id) });
  }

  private async erDoctorSeen(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const visit = await this.erVisit(m.payload);
    if (!visit) return;
    const bill = await this.erBill(visit, m.case);
    await this.charge(String(bill._id), 'er:doctor', 'er', 1, { type: 'er.doctor-seen', ref: String(visit._id) });
  }

  private async labCollected(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const requestId = str(m.payload.requestId);
    const tests = Array.isArray(m.payload.tests) ? m.payload.tests.filter((t): t is string => typeof t === 'string') : [];
    const request = requestId ? await this.labRequests.findById(requestId).lean().exec() : null;
    if (!request) {
      this.logger.warn(`Lab request ${requestId ?? '(none)'} not found; no charge`);
      return;
    }
    const lines = await this.labLines.find({ request: request._id, test: { $in: tests }, status: { $ne: 'cancelled' } }).lean().exec();
    if (!lines.length) return;
    const bill = await this.bills.forCharge({ patientId: String(request.patient), caseId: m.case });
    for (const line of lines) {
      try {
        await this.charge(String(bill._id), labCode(line.test), 'lab', 1, { type: 'lab', ref: `${request._id}:${line.test}` });
      } catch (e) {
        this.logger.warn(`Lab test ${line.test}: no charge made (${(e as Error).message})`);
      }
    }
  }

  private async labCancelled(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const requestId = str(m.payload.requestId);
    const test = str(m.payload.test);
    if (!requestId || !test) return;
    const charged = await this.chargeLines.findOne({ 'source.type': 'lab', 'source.ref': `${requestId}:${test}` }).lean().exec();
    if (!charged) return;
    const event: SuggestedReversal = {
      billId: String(charged.bill),
      lineId: String(charged._id),
      reason: `Lab test ${test} was cancelled after it was charged`,
    };
    for (const fn of this.onSuggestedReversal) {
      try {
        await fn(event);
      } catch (e) {
        this.logger.warn(`A suggested-reversal listener failed: ${(e as Error).message}`);
      }
    }
  }

  private async pharmacyIssued(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const lineId = str(m.payload.lineId);
    const line = lineId ? await this.pharmacyLines.findById(lineId).lean().exec() : null;
    if (!line) {
      this.logger.warn(`Pharmacy line ${lineId ?? '(none)'} not found; no charge`);
      return;
    }
    const order = await this.pharmacyOrders.findById(line.order).select('patient').lean().exec();
    const patientId = String(order?.patient ?? line.patient);
    const raw = Number(m.payload.quantity);
    const qty = Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : 1;
    const bill = await this.bills.forCharge({ patientId, caseId: m.case });
    const source = { type: 'pharmacy.issued', ref: String(line._id) };
    if (!line.product) {
      await this.bills.addCharge(String(bill._id), {
        code: 'med:unlisted',
        name: line.freeName || 'Unlisted medicine',
        category: 'pharmacy',
        qty,
        unitPrice: 0,
        source,
        needsPrice: true,
        by: BY,
      });
      return;
    }
    const code = medCode(line.product);
    const p = await this.price(code);
    // A missing catalogue item is named after the code; show the medicine instead.
    const name = p.name === code ? line.freeName || line.medicine || line.product : p.name;
    await this.bills.addCharge(String(bill._id), { code, name, category: 'pharmacy', qty, unitPrice: p.price, source, needsPrice: p.needsPrice, by: BY });
  }

  private async procedureDone(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const id = str(m.payload.bookingId);
    const booking = id ? await this.procedures.findById(id).lean().exec() : null;
    if (!booking) {
      this.logger.warn(`Procedure booking ${id ?? '(none)'} not found; no charge`);
      return;
    }
    const bill = await this.bills.forCharge({ patientId: String(booking.patient), caseId: m.case });
    await this.charge(String(bill._id), procCode(booking.procedure), 'procedure', 1, { type: 'procedure', ref: String(booking._id) });
  }

  private async consultSeen(m: { case: string | null; payload: Record<string, unknown> }): Promise<void> {
    const id = str(m.payload.consultId);
    const consult = id ? await this.consults.findById(id).lean().exec() : null;
    if (!consult) {
      this.logger.warn(`Consult ${id ?? '(none)'} not found; no charge`);
      return;
    }
    const bill = await this.bills.forCharge({ patientId: String(consult.patient), caseId: m.case });
    await this.charge(String(bill._id), consultCode(consult.priority), 'consultation', 1, { type: 'consult', ref: String(consult._id) });
  }
}
