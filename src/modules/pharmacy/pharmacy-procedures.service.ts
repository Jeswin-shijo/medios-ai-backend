import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CasesService } from '../coordinator/cases.service';
import { MessagesService } from '../coordinator/messages.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { ACTIVE_ISSUED_MS, PharmacyOrdersService } from './pharmacy-orders.service';
import { PharmacyPatientsService } from './pharmacy-patients.service';
import { contrastWhen } from './pharmacy-rules';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';
import { PharmacyProcedureNote, PharmacyProcedureNoteDocument } from './schemas/pharmacy-procedure-note.schema';

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
    private readonly facts: PharmacyPatientsService,
  ) {
    // A metformin line ordered after the booking tells its own doctor too.
    this.orders.onAdded((order, added) => this.onLinesAdded(order, added));
  }

  private async onLinesAdded(order: PharmacyOrderDocument, added: PharmacyLineDocument[]): Promise<void> {
    if (!added.some((l) => l.medicine === 'metformin' && (l.flags ?? []).some((f) => f.key === 'procedure.contrast'))) return;
    const c = (await this.facts.facts(String(order.patient))).contrast;
    if (!c?.bookingId) return;
    await this.syncContrastAlert(c.bookingId, { id: String(order.patient), name: order.patientName, uhid: order.patientUhid }, c.number, c.at, false);
  }

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
    const before = await this.notes
      .findOneAndUpdate({ bookingId }, { $set: { patient: patient.id, number, procedure: str(p.procedure) ?? '', contrast: true, start, status: 'booked' } }, { upsert: true })
      .lean<{ status: string; start: Date } | null>()
      .exec();
    await this.orders.recheckPatient(patient.id, 'procedure', { kinds: ['procedure'] });
    // Only a new booking, a re-booking after a cancel or bump, or a new time reopens a completed alert.
    const changed = !before || before.status === 'cancelled' || new Date(before.start).getTime() !== start.getTime();
    await this.syncContrastAlert(bookingId, patient, number, start, changed);
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

    // The same "issued is still active" window the other Pharmacy checks use.
    const issuedSince = new Date(Date.now() - ACTIVE_ISSUED_MS);
    const live = await this.lines
      .find({ patient: m.patient.id, $or: [{ status: { $in: ['to-check', 'query', 'approved'] } }, { status: 'issued', 'issued.realAt': { $gte: issuedSince } }] }).select('medicine').lean<{ medicine: string | null }[]>().exec();
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
  private async syncContrastAlert(bookingId: string, patient: Subject, number: string, start: Date, reopen: boolean): Promise<void> {
    const link = `pharmacy-contrast:${bookingId}`;
    const issuedSince = new Date(Date.now() - ACTIVE_ISSUED_MS);
    const metformin = await this.lines
      .find({ patient: patient.id, medicine: 'metformin', $or: [{ status: { $in: ['to-check', 'query', 'approved'] } }, { status: 'issued', 'issued.realAt': { $gte: issuedSince } }] }).select('order').lean<{ order: unknown }[]>().exec();
    if (!metformin.length) {
      await this.alerts.updateOne({ link }, { $set: { status: 'Completed' } }).exec();
      return;
    }
    const orders = await this.orderDocs.find({ _id: { $in: metformin.map((l) => l.order) } }).sort({ _id: 1 }).select('orderedBy').lean<{ orderedBy: { name: string } }[]>().exec();
    const doctors = [...new Set(orders.map((o) => o.orderedBy.name))].join(', ');
    const subtitle = `For ${doctors} · ${number}`;
    // A new doctor on the alert also reopens it.
    const existing = await this.alerts.findOne({ link }).select('subtitle').lean<{ subtitle: string }>().exec();
    await this.upsertAlert(link, {
      title: `Contrast dye on ${contrastWhen(start)}: hold metformin`,
      subtitle,
      patientName: patient.name,
      uhid: patient.uhid,
      type: 'Medication Alert',
      category: 'System',
      priority: 'Medium',
      ...(reopen || !existing || existing.subtitle !== subtitle ? { status: 'Pending' } : {}),
    }, { status: 'Pending' });
  }

  /** Writes the fields; `onInsert` applies only when the alert is new. */
  private async upsertAlert(link: string, fields: Record<string, string>, onInsert: Record<string, string> = {}): Promise<void> {
    const insert = Object.fromEntries(Object.entries(onInsert).filter(([k]) => !(k in fields)));
    await this.alerts.updateOne({ link }, { $set: fields, ...(Object.keys(insert).length ? { $setOnInsert: insert } : {}) }, { upsert: true }).exec();
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
