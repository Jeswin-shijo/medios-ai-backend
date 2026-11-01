import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CasesService } from '../coordinator/cases.service';
import { MessagesService } from '../coordinator/messages.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { contrastWhen } from './pharmacy-rules';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';
import { PharmacyProcedureNote, PharmacyProcedureNoteDocument } from './schemas/pharmacy-procedure-note.schema';

/** Lines that still count as the patient's medicines: never stopped, rejected or cancelled. */
const LIVE = ['to-check', 'query', 'approved', 'issued'];
const P2Y12 = ['clopidogrel', 'ticagrelor'];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Two checks that Scheduling's procedure messages start. Pharmacy reads only the message and its own records:
 * - contrast dye: an amber flag on metformin lines (the rule is in pharmacy-rules.ts) and a Medication alert for the ordering doctors;
 * - dual antiplatelet medicines after a coronary angioplasty: a Critical alert when aspirin and a P2Y12 medicine are not both active.
 */
@Injectable()
export class PharmacyProceduresService {
  constructor(
    @InjectModel(PharmacyProcedureNote.name) private readonly notes: Model<PharmacyProcedureNoteDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly orders: PharmacyOrdersService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
  ) {}

  /** scheduling.procedure-booked (also a re-booking after a bump: the note takes the new time). */
  async onBooked(messageId: string): Promise<void> {
    const m = await this.read(messageId);
    if (!m) return;
    const { patient, payload: p } = m;
    const bookingId = str(p.bookingId);
    const start = p.start instanceof Date || typeof p.start === 'string' ? new Date(p.start) : null;
    // A procedure without contrast adds nothing.
    if (!bookingId || p.contrast !== true || !start || isNaN(start.getTime())) return;
    const number = str(p.number) ?? '';
    await this.notes
      .updateOne({ bookingId }, { $set: { patient: patient.id, number, procedure: str(p.procedure) ?? '', contrast: true, start, status: 'booked' } }, { upsert: true })
      .exec();
    await this.orders.recheckPatient(patient.id, 'procedure', { kinds: ['procedure'] });
    await this.syncContrastAlert(bookingId, patient, number, start);
  }

  /** scheduling.procedure-cancelled and -bumped: the hold goes. */
  async onCancelled(messageId: string): Promise<void> {
    const m = await this.read(messageId);
    const bookingId = m && str(m.payload.bookingId);
    if (!m || !bookingId) return;
    const note = await this.notes.findOneAndUpdate({ bookingId }, { $set: { status: 'cancelled' } }).exec();
    if (!note) return;
    await this.orders.recheckPatient(String(note.patient), 'procedure', { kinds: ['procedure'] });
    await this.alerts.updateOne({ link: `pharmacy-contrast:${bookingId}` }, { $set: { status: 'Completed' } }).exec();
  }

  /** scheduling.procedure-done: the contrast hold stays for 48 hours; an angioplasty also checks the dual antiplatelet medicines. */
  async onDone(messageId: string): Promise<void> {
    const m = await this.read(messageId);
    const bookingId = m && str(m.payload.bookingId);
    if (!m || !bookingId) return;
    const note = await this.notes.findOneAndUpdate({ bookingId, status: 'booked' }, { $set: { status: 'done' } }).exec();
    if (note) await this.orders.recheckPatient(String(note.patient), 'procedure', { kinds: ['procedure'] });
    if (m.payload.procedure !== 'coronary-angioplasty') return;

    const live = await this.lines.find({ patient: m.patient.id, status: { $in: LIVE } }).select('medicine').lean<{ medicine: string | null }[]>().exec();
    const keys = new Set(live.map((l) => l.medicine));
    if (keys.has('aspirin') && P2Y12.some((k) => keys.has(k))) return;
    const number = str(m.payload.number) ?? '';
    await this.upsertAlert(`pharmacy-dapt:${bookingId}`, {
      title: `No dual antiplatelet medicines after the stent (${number}). Please review.`,
      subtitle: number,
      patientName: m.patient.name,
      uhid: m.patient.uhid,
      type: 'Medication Alert',
      category: 'Critical',
      priority: 'High',
      status: 'Pending',
    });
  }

  /** One alert per booking, for the ordering doctors of the patient's metformin lines. None while there is no metformin line; completed when the last one goes. */
  private async syncContrastAlert(bookingId: string, patient: Subject, number: string, start: Date): Promise<void> {
    const link = `pharmacy-contrast:${bookingId}`;
    const metformin = await this.lines.find({ patient: patient.id, medicine: 'metformin', status: { $in: LIVE } }).select('order').lean<{ order: unknown }[]>().exec();
    if (!metformin.length) {
      await this.alerts.updateOne({ link }, { $set: { status: 'Completed' } }).exec();
      return;
    }
    const orders = await this.orderDocs.find({ _id: { $in: metformin.map((l) => l.order) } }).sort({ _id: 1 }).select('orderedBy').lean<{ orderedBy: { name: string } }[]>().exec();
    const doctors = [...new Set(orders.map((o) => o.orderedBy.name))].join(', ');
    await this.upsertAlert(link, {
      title: `Contrast dye on ${contrastWhen(start)}: hold metformin`,
      subtitle: `For ${doctors} · ${number}`,
      patientName: patient.name,
      uhid: patient.uhid,
      type: 'Medication Alert',
      category: 'System',
      priority: 'Medium',
      status: 'Pending',
    });
  }

  private async upsertAlert(link: string, fields: Record<string, string>): Promise<void> {
    await this.alerts.updateOne({ link }, { $set: fields }, { upsert: true }).exec();
  }

  private async read(messageId: string): Promise<{ payload: Record<string, unknown>; patient: Subject } | null> {
    const message = await this.messages.get(messageId);
    if (!message?.case) return null;
    const theCase = await this.cases.get(String(message.case));
    if (!theCase) return null;
    return { payload: (message.payload ?? {}) as Record<string, unknown>, patient: { id: String(theCase.patient), name: theCase.patientName, uhid: theCase.patientUhid } };
  }
}

interface Subject {
  id: string;
  name: string;
  uhid: string;
}
