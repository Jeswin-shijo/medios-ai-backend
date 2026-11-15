import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { clinicNow, displayTime, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import { Actor } from '../beds/actor';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { maskPhone } from '../calls/phone';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { AgentMessage, MessageDocument } from '../coordinator/schemas/agent-message.schema';
import { DischargeOrder, DischargeOrderDocument } from '../discharge/schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from '../discharge/schemas/discharge-plan.schema';
import { FollowUpDocument, FollowUpItem } from '../follow-ups/schemas/follow-up.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { Bill, BillDocument } from '../revenue/schemas/bill.schema';
import { procedureByKey } from '../scheduling/scheduling-catalogue';
import { ProcedureBooking, ProcedureBookingDocument } from '../scheduling/schemas/procedure-booking.schema';
import { SettingsService } from '../settings/settings.service';
import { SupportRegistration, WAKE_TYPES } from './support-coordinator.registration';
import { PatientUpdate, PatientUpdateDocument } from './schemas/patient-update.schema';
import { SupportConfig, TRIGGER_LABEL, Trigger } from './support-catalogue';
import { SupportFactsService } from './support-facts.service';
import { SUP_ADMIN, SUP_SEND } from './support-roles';
import { MESSAGE_SENDER, MessageSender } from './support-sender';
import { SupportSettingsService } from './support-settings.service';
import { SupportTextsService } from './support-texts.service';
import { quietUntil } from './support-time';

/** The message that wakes each trigger. The two reminders have no message: the evening pass reads records. */
const TRIGGER_OF_MESSAGE: Record<string, Trigger> = {
  'bed.assigned': 'admitted',
  'bed.transferred': 'transferred',
  'scheduling.procedure-booked': 'procedure-booked',
  'scheduling.procedure-done': 'procedure-done',
  'revenue.estimate-ready': 'estimate-ready',
  'revenue.bill-final': 'bill-final',
  'discharge.completed': 'discharge-pack',
  'scheduling.followup-booked': 'followup-booked'
};

const STALE_TRIGGERS: Trigger[] = ['admitted', 'procedure-booked'];
const CLAIM_MS = 5 * 60_000;
const NO_FOLLOW_UP = 'as written on your discharge summary';
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const CATCH_UP_KEY = 'support-catchup';

/** What an event gives: the patient, the case, the once-per-event key, and the placeholder values read from records. */
interface Source {
  patient: any;
  caseId: string | null;
  dedupeKey: string;
  sourceRef: string;
  values: Record<string, string>;
  /** A procedure update: its name, and the key of its approved `prep:` text. */
  procedure?: { key: string; name: string };
  /** A discharge pack: the group of the patient's warning signs. */
  signsGroup?: 'general' | 'cardiac';
}

export interface PatientUpdateView {
  id: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  case: string | null;
  trigger: string;
  triggerLabel: string;
  template: string;
  language: string;
  text: string;
  to: string | null;
  toLabel: string;
  status: string;
  reason: string | null;
  note: string | null;
  sendAt: Date | null;
  sentAt: Date | null;
  sourceRef: string;
  createdAt: Date;
}

export interface UpdateQuery {
  status?: string;
  reason?: string;
  trigger?: string;
  patientId?: string;
  limit?: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
/** A `YYYY-MM-DD` clinic day at noon, so no zone shift moves the day. */
const dayAtNoon = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};
/** The booking id inside a procedure update's dedupe key (`<trigger>:<bookingId>[:<start>]`). */
const bookingIdOf = (dedupeKey: unknown): string => String(dedupeKey).split(':')[1] ?? '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Family updates. An event makes at most one update (a unique key), filled from an approved template. Sending happens
 * only on the minute pass, and consent, do-not-contact and death are read again at send time. Nothing here throws into
 * another agent's handler, and no text is written by the agent itself.
 */
@Injectable()
export class SupportUpdatesService implements OnModuleInit {
  private readonly logger = new Logger(SupportUpdatesService.name);

  /** The real clock; a spec replaces it. */
  clock: () => Date = () => new Date();

  /** Messages examined per catch-up pass; a spec lowers it. */
  catchUpBatch = 500;

  constructor(
    private readonly registration: SupportRegistration,
    private readonly messages: MessagesService,
    private readonly texts: SupportTextsService,
    private readonly facts: SupportFactsService,
    private readonly supportSettings: SupportSettingsService,
    private readonly settings: SettingsService,
    private readonly rules: RulesService,
    @Optional() @Inject(MESSAGE_SENDER) private readonly sender: MessageSender | null,
    @InjectModel(PatientUpdate.name) private readonly updates: Model<PatientUpdateDocument>,
    @InjectModel(AgentMessage.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(Bill.name) private readonly bills: Model<BillDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>
  ) {}

  onModuleInit(): void {
    for (const type of WAKE_TYPES) this.registration.onWake(type, (id) => this.fromMessage(id));
  }

  // ---- Making updates ----

  /** Makes the update a stored message calls for. Safe to run twice; never throws; never sends. */
  async fromMessage(messageId: string): Promise<void> {
    try {
      const msg = await this.messages.get(messageId);
      const trigger = msg ? TRIGGER_OF_MESSAGE[msg.type] : undefined;
      if (!msg || !trigger) return;
      const source = await this.sourceOf(trigger, msg);
      if (source) await this.make(trigger, source, messageId);
    } catch (e) {
      this.logger.error(`Family update for message ${messageId} failed: ${(e as Error).message}`);
    }
  }

  private async patientById(id: unknown): Promise<any | null> {
    return isValidObjectId(id) ? this.patients.findById(id).exec() : null;
  }

  private async hospitalName(): Promise<string> {
    return str(((await this.settings.getSettings()).hospital as any)?.name);
  }

  private async sourceOf(trigger: Trigger, msg: { case: string | null; payload: Record<string, unknown> }): Promise<Source | null> {
    const p = msg.payload;
    switch (trigger) {
      case 'admitted':
      case 'transferred':
        return this.bedSource(trigger, msg.case, p);
      case 'procedure-booked':
      case 'procedure-done':
        return this.procedureSource(trigger, msg.case, str(p.bookingId));
      case 'estimate-ready':
      case 'bill-final':
        return this.billSource(trigger, msg.case, p);
      case 'discharge-pack':
        return this.dischargeSource(msg.case, p);
      case 'followup-booked':
        return this.followUpSource('followup-booked', msg.case, str(p.appointmentId), isDay(p.date) ? p.date : undefined, str(p.time), str(p.doctor));
      default:
        return null;
    }
  }

  private async baseValues(patient: any): Promise<Record<string, string>> {
    const cfg = await this.supportSettings.get();
    return { patient: patient.name, hospital: await this.hospitalName(), visiting: cfg.visitingHours };
  }

  private async bedSource(trigger: 'admitted' | 'transferred', caseId: string | null, p: Record<string, unknown>): Promise<Source | null> {
    const admissionId = str(p.admissionId);
    if (!isValidObjectId(admissionId)) return null;
    const admission: any = await this.admissions.findById(admissionId).lean().exec();
    if (!admission || admission.sample === true) return null;
    const patient = await this.patientById(admission.patient);
    if (!patient) return null;
    const bed = await this.facts.bedFacts(admissionId);
    return {
      patient,
      caseId,
      dedupeKey: trigger === 'admitted' ? `admitted:${admissionId}` : `transferred:${admissionId}:${str(p.bedId)}`,
      sourceRef: str(p.bedLabel),
      values: { ...(await this.baseValues(patient)), ward: bed?.ward ?? '', bed: bed?.bed ?? '', floor: bed?.floor ?? '' }
    };
  }

  private async procedureSource(
    trigger: 'procedure-booked' | 'procedure-done' | 'procedure-reminder',
    caseId: string | null,
    bookingId: string
  ): Promise<Source | null> {
    const booking: any = isValidObjectId(bookingId) ? await this.bookings.findById(bookingId).lean().exec() : null;
    if (!booking) return null;
    if ((trigger === 'procedure-booked' || trigger === 'procedure-reminder') && (booking.status !== 'booked' || !booking.start)) return null;
    const patient = await this.patientById(booking.patient);
    if (!patient) return null;
    const name = procedureByKey(booking.procedure)?.name ?? booking.procedure;
    const start: Date | undefined = booking.start ? new Date(booking.start) : undefined;
    const values: Record<string, string> = { ...(await this.baseValues(patient)), procedure: name };
    if (start) Object.assign(values, { date: spokenDay(start), time: displayTime(start) });
    const dedupeKey = trigger === 'procedure-done' ? `procedure-done:${bookingId}` : `${trigger}:${bookingId}:${start!.toISOString()}`;
    return {
      patient,
      caseId: caseId ?? (booking.case ? String(booking.case) : null),
      dedupeKey,
      sourceRef: str(booking.number),
      values,
      procedure: { key: booking.procedure, name }
    };
  }

  private async billSource(trigger: 'estimate-ready' | 'bill-final', caseId: string | null, p: Record<string, unknown>): Promise<Source | null> {
    const billId = str(p.billId);
    const bill: any = isValidObjectId(billId) ? await this.bills.findById(billId).lean().exec() : null;
    const patient = bill ? await this.patientById(bill.patient) : null;
    if (!bill || !patient) return null;
    const values = await this.baseValues(patient);
    if (trigger === 'bill-final') values.amount = formatRupees(Math.max(0, typeof p.balance === 'number' ? p.balance : Number(bill.totals?.balance ?? 0)));
    return { patient, caseId, dedupeKey: `${trigger}:${billId}`, sourceRef: str(bill.number), values };
  }

  private async dischargeSource(caseId: string | null, p: Record<string, unknown>): Promise<Source | null> {
    if (p.kind !== 'home' && p.kind !== 'against-advice') return null;
    const planId = str(p.planId);
    const plan: any = isValidObjectId(planId) ? await this.plans.findById(planId).lean().exec() : null;
    const patient = plan ? await this.patientById(plan.patient) : null;
    if (!plan || !patient) return null;
    const orderId = str(p.orderId);
    const order: any = orderId && isValidObjectId(orderId) ? await this.orders.findById(orderId).lean().exec() : null;
    let followUp = NO_FOLLOW_UP;
    const f = order?.followUp;
    if (f?.status === 'booked' && isDay(f.date) && f.time) {
      const appointment: any = isValidObjectId(f.appointmentId) ? await this.appointments.findById(f.appointmentId).lean().exec() : null;
      followUp = `${spokenDay(dayAtNoon(f.date))} at ${f.time}${appointment?.doctorName ? ` with ${appointment.doctorName}` : ''}`;
    }
    const group = await this.facts.careGroup(String(patient._id), caseId);
    return {
      patient,
      caseId,
      dedupeKey: `discharge-pack:${planId}`,
      sourceRef: str(plan.bedLabel),
      values: { ...(await this.baseValues(patient)), followUp },
      signsGroup: group
    };
  }

  private async followUpSource(
    trigger: 'followup-booked' | 'followup-reminder',
    caseId: string | null,
    appointmentId: string,
    date?: string,
    time?: string,
    doctor?: string
  ): Promise<Source | null> {
    const apt: any = isValidObjectId(appointmentId) ? await this.appointments.findById(appointmentId).lean().exec() : null;
    const patient = apt ? await this.patients.findOne({ uhid: apt.uhid }).exec() : null;
    if (!apt || !patient) return null;
    const day = date ?? apt.date;
    const values = { ...(await this.baseValues(patient)), date: spokenDay(dayAtNoon(day)), time: time || apt.time, doctor: doctor || apt.doctorName };
    return { patient, caseId, dedupeKey: `${trigger}:${appointmentId}`, sourceRef: apt.uhid, values };
  }

  /** Fills the template and stores the update, or notes why it is skipped or held. True when a new row was made. */
  private async make(trigger: Trigger, src: Source, sourceMessage: string | null): Promise<boolean> {
    if (await this.updates.exists({ dedupeKey: src.dedupeKey })) return false;
    const now = this.clock();
    const cfg = await this.supportSettings.get();
    const language = src.patient.preferredLanguage === 'ta' ? 'ta' : 'en';
    const recipient = this.facts.recipientOf(src.patient);

    let status: string = 'waiting';
    let reason: string | undefined;
    let note: string | undefined;
    let text = '';
    let values = src.values;
    let sendAt: Date | undefined;

    if (!cfg.triggers[trigger]) {
      status = 'skipped';
      reason = 'trigger-off';
    } else {
      const filled = await this.fill(trigger, src, language);
      values = filled.values;
      note = filled.note;
      if (!filled.rendered) {
        status = 'held';
        reason = 'no-template';
      } else if (filled.rendered.missing.length) {
        status = 'held';
        reason = 'missing-detail';
        note = [note, `Missing: ${filled.rendered.missing.join(', ')}`].filter(Boolean).join('. ');
        text = filled.rendered.text;
      } else {
        text = filled.rendered.text;
        if (!(await this.rules.isOn('support-auto-updates'))) {
          status = 'held';
          reason = 'auto-off';
        } else {
          sendAt = quietUntil(now, cfg.quietStart, cfg.quietEnd) ?? now;
        }
      }
    }

    let doc: any;
    try {
      doc = await this.updates.create({
        patient: src.patient._id,
        patientUhid: src.patient.uhid,
        patientName: src.patient.name,
        ...(src.caseId ? { case: new Types.ObjectId(src.caseId) } : {}),
        trigger,
        dedupeKey: src.dedupeKey,
        ...(sourceMessage ? { sourceMessage: new Types.ObjectId(sourceMessage) } : {}),
        sourceRef: src.sourceRef,
        template: trigger,
        language,
        values,
        text,
        toLabel: recipient.label,
        channel: 'message',
        status,
        ...(reason ? { reason } : {}),
        ...(note ? { note } : {}),
        ...(sendAt ? { sendAt } : {}),
        announced: [],
        createdAt: now
      } as any);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false;
      throw e;
    }
    if (status === 'skipped') await this.announce(doc, 'skipped');
    return true;
  }

  /** Renders the template, with the approved nested texts (preparation, warning signs) filled in the patient's language. */
  private async fill(trigger: Trigger, src: Pick<Source, 'values' | 'procedure' | 'signsGroup'>, language: 'en' | 'ta') {
    const values = { ...src.values };
    let note: string | undefined;
    if (src.procedure) {
      const prep = await this.texts.render(`prep:${src.procedure.key}`, language, {});
      values.instructions = prep?.text ?? '';
      if (!prep) note = `No approved instructions for ${src.procedure.name}`;
    }
    if (src.signsGroup) {
      const signs = await this.texts.render(`signs:${src.signsGroup}`, language, {});
      values.warningSigns = signs?.text ?? '';
    }
    const rendered = await this.texts.render(trigger, language, values, ['instructions', 'followUp']);
    return { rendered, values, note };
  }

  /** The evening pass: tomorrow's procedure and follow-up reminders, once each. Returns how many it made. */
  async remindDue(now: Date = this.clock()): Promise<number> {
    const cfg = await this.supportSettings.get();
    if (now.getHours() * 60 + now.getMinutes() < minutesOf(cfg.eveningAt)) return 0;
    const today = parseIsoDay(isoDate(clinicNow(now)));
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const tomorrow = isoDate(from);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    let made = 0;

    const bookings: any[] = await this.bookings
      .find({ status: 'booked', start: { $gte: from, $lt: to } })
      .lean()
      .exec();
    for (const b of bookings)
      made += await this.attempt(async () => this.makeFrom(await this.procedureSource('procedure-reminder', null, String(b._id)), 'procedure-reminder'));

    const appointments: any[] = await this.appointments
      .find({ date: tomorrow, status: { $ne: 'Canceled' } })
      .select('_id')
      .lean()
      .exec();
    if (appointments.length) {
      const items: any[] = await this.followUps
        .find({ status: 'Scheduled', appointmentId: { $in: appointments.map((a) => a._id) } })
        .select('appointmentId')
        .lean()
        .exec();
      for (const i of items)
        made += await this.attempt(async () =>
          this.makeFrom(await this.followUpSource('followup-reminder', null, String(i.appointmentId)), 'followup-reminder')
        );
    }
    return made;
  }

  private async makeFrom(src: Source | null, trigger: Trigger): Promise<boolean> {
    return src ? this.make(trigger, src, null) : false;
  }

  /** One item of a pass: a failure is logged and counts as nothing made. */
  private async attempt(run: () => Promise<boolean>): Promise<number> {
    try {
      return (await run()) ? 1 : 0;
    } catch (e) {
      this.logger.error(`Family update reminder failed: ${(e as Error).message}`);
      return 0;
    }
  }

  // ---- Sending ----

  /** The minute pass: sends what is due. Returns how many reached a final status (sent, sample, failed or skipped). */
  async sendDue(now: Date = this.clock()): Promise<number> {
    const cfg = await this.supportSettings.get();
    const due: any[] = await this.updates
      .find({ status: 'waiting', sendAt: { $lte: now } })
      .sort({ sendAt: 1 })
      .limit(200)
      .lean()
      .exec();
    let done = 0;
    for (const u of due) {
      try {
        if (await this.process(u, now, cfg)) done++;
      } catch (e) {
        this.logger.error(`Family update ${String(u._id)} failed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /** The send-time checks, in order. Consent and death are read again here, not trusted from when the update was made. */
  private async process(u: any, now: Date, cfg: SupportConfig): Promise<boolean> {
    const quiet = quietUntil(now, cfg.quietStart, cfg.quietEnd);
    if (quiet) {
      await this.updates.updateOne({ _id: u._id, status: 'waiting' }, { $set: { sendAt: quiet } }).exec();
      return false;
    }
    // Claim it: a second pass at the same moment finds the send time moved on.
    const claimed = await this.updates
      .findOneAndUpdate({ _id: u._id, status: 'waiting', sendAt: u.sendAt }, { $set: { sendAt: new Date(now.getTime() + CLAIM_MS) } })
      .exec();
    if (!claimed) return false;

    const trigger = u.trigger as Trigger;
    if (STALE_TRIGGERS.includes(trigger) && now.getTime() - new Date(u.createdAt).getTime() > cfg.staleHours * 3600_000) return this.skip(u, 'stale');
    if (await this.superseded(u)) return this.skip(u, 'superseded');
    if (!cfg.triggers[trigger]) return this.skip(u, 'trigger-off');
    if (await this.facts.isDeceased(String(u.patient))) {
      await this.cancelForDeath(String(u.patient));
      return true;
    }
    const patient: any = await this.patients.findById(u.patient).lean().exec();
    if (!patient) return this.skip(u, 'no-consent');
    if (patient.doNotCall === true) return this.skip(u, 'do-not-contact');
    if (patient.consent?.messages !== true) return this.skip(u, 'no-consent');
    const recipient = this.facts.recipientOf(patient);
    if (!recipient.to) return this.skip(u, 'no-phone');
    if (!this.sender) return this.skip(u, 'messaging-off');

    // The template must still be approved now: the text is made again, with fresh nested texts, in the patient's current language.
    const fresh = await this.refill(u, patient);
    if (!fresh.rendered || fresh.rendered.missing.length) {
      const reason = fresh.rendered ? 'missing-detail' : 'no-template';
      const note = fresh.rendered ? [fresh.note, `Missing: ${fresh.rendered.missing.join(', ')}`].filter(Boolean).join('. ') : fresh.note;
      await this.updates
        .updateOne({ _id: u._id, status: 'waiting' }, { $set: { status: 'held', reason, ...(note ? { note } : {}) }, $unset: { sendAt: '' } })
        .exec();
      return true;
    }
    u.text = fresh.rendered.text;
    await this.updates
      .updateOne(
        { _id: u._id, status: 'waiting' },
        { $set: { text: fresh.rendered.text, language: fresh.rendered.language, values: fresh.values, ...(fresh.note ? { note: fresh.note } : {}) } }
      )
      .exec();

    let ok = false;
    try {
      ok = (await this.sender.send(recipient.to, u.text)).ok;
    } catch (e) {
      this.logger.warn(`Family update ${String(u._id)} not sent: ${(e as Error).message}`);
    }
    const status = !ok ? 'failed' : this.sender.name === 'sample' ? 'sample' : 'sent';
    const saved: any = await this.updates
      .findOneAndUpdate(
        { _id: u._id, status: 'waiting' },
        { $set: { status, to: recipient.to, toLabel: recipient.label, sentAt: now }, $unset: { sendAt: '' } },
        { new: true }
      )
      .lean()
      .exec();
    if (!saved) return false;
    if (status === 'sample') await this.facts.timeline(saved, `Update (sample, not sent): ${TRIGGER_LABEL[trigger]}`, saved.text);
    if (status === 'sent') await this.facts.timeline(saved, `Update sent to ${recipient.label}: ${TRIGGER_LABEL[trigger]}`, saved.text);
    if (status !== 'failed') await this.announce(saved, 'sent');
    return true;
  }

  /** Makes the text again from the stored values: fresh preparation or warning-signs text, the patient's current language. */
  private async refill(u: any, patient: any) {
    const language = patient?.preferredLanguage === 'ta' ? 'ta' : 'en';
    const src: Pick<Source, 'values' | 'procedure' | 'signsGroup'> = { values: { ...(u.values ?? {}) } };
    const trigger = u.trigger as Trigger;
    if (trigger === 'procedure-booked' || trigger === 'procedure-reminder' || trigger === 'procedure-done') {
      const booking: any = isValidObjectId(bookingIdOf(u.dedupeKey)) ? await this.bookings.findById(bookingIdOf(u.dedupeKey)).lean().exec() : null;
      if (booking) src.procedure = { key: booking.procedure, name: procedureByKey(booking.procedure)?.name ?? booking.procedure };
    }
    if (trigger === 'discharge-pack') src.signsGroup = await this.facts.careGroup(String(u.patient), u.case ? String(u.case) : null);
    return { ...(await this.fill(trigger, src, language)), language };
  }

  /** True when the record an update was made from has moved on: a booking no longer booked or moved, an appointment cancelled or moved. */
  private async superseded(u: any): Promise<boolean> {
    const trigger = u.trigger as Trigger;
    if (trigger === 'procedure-booked' || trigger === 'procedure-reminder') {
      const m = /^[a-z-]+:[0-9a-f]{24}:(.+)$/.exec(String(u.dedupeKey));
      const id = bookingIdOf(u.dedupeKey);
      const booking: any = isValidObjectId(id) ? await this.bookings.findById(id).lean().exec() : null;
      return !booking || booking.status !== 'booked' || !booking.start || !m || new Date(booking.start).toISOString() !== m[1];
    }
    if (trigger === 'followup-booked' || trigger === 'followup-reminder') {
      const id = String(u.dedupeKey).split(':')[1];
      const apt: any = isValidObjectId(id) ? await this.appointments.findById(id).lean().exec() : null;
      if (!apt || apt.status === 'Canceled' || apt.status === 'No Show') return true;
      return !isDay(apt.date) || spokenDay(dayAtNoon(apt.date)) !== u.values?.date || apt.time !== u.values?.time;
    }
    return false;
  }

  /** Writes `skipped` with its reason, and tells the Coordinator once. False when the row was no longer waiting or held. */
  private async skip(u: any, reason: string, from: string[] = ['waiting']): Promise<boolean> {
    const saved: any = await this.updates
      .findOneAndUpdate({ _id: u._id, status: { $in: from } }, { $set: { status: 'skipped', reason }, $unset: { sendAt: '' } }, { new: true })
      .lean()
      .exec();
    if (!saved) return false;
    await this.announce(saved, 'skipped');
    return true;
  }

  /** One `support.update-sent` or `support.update-skipped` per update; the claim is written before the send. */
  private async announce(u: any, kind: 'sent' | 'skipped'): Promise<void> {
    const type = kind === 'sent' ? 'support.update-sent' : 'support.update-skipped';
    const claimed = await this.updates.findOneAndUpdate({ _id: u._id, announced: { $ne: type } }, { $addToSet: { announced: type } }).exec();
    if (!claimed) return;
    const label = TRIGGER_LABEL[u.trigger as Trigger] ?? u.trigger;
    const payload =
      kind === 'sent'
        ? { updateId: String(u._id), trigger: u.trigger, mode: u.status }
        : { updateId: String(u._id), trigger: u.trigger, reason: u.reason ?? '' };
    const summary =
      kind === 'sent'
        ? `${u.patientUhid}: ${label} update (${u.status === 'sample' ? 'Sample' : 'Sent'})`
        : `${u.patientUhid}: ${label} update skipped (${u.reason})`;
    const ok = await this.registration.send(type, u.case ? String(u.case) : null, payload, summary, u.patientName);
    if (!ok) await this.updates.updateOne({ _id: u._id }, { $pull: { announced: type } }).exec();
  }

  // ---- Staff actions ----

  private async held(actor: Actor, updateId: string): Promise<any> {
    if (!actor || !SUP_SEND.includes(actor.role)) throw new ForbiddenException('Only the front desk or an admin can do this.');
    const u: any = isValidObjectId(updateId) ? await this.updates.findById(updateId).lean().exec() : null;
    if (!u) throw new NotFoundException('Update not found.');
    return u;
  }

  /** Sends a held update that only waited for the automatic switch: it re-renders its text and waits for the next pass. */
  async sendNow(actor: Actor, updateId: string): Promise<PatientUpdateView> {
    const u = await this.held(actor, updateId);
    if (u.status !== 'held' || u.reason !== 'auto-off') throw new ConflictException('Only an update held by the automatic switch can be sent now.');
    const patient: any = await this.patients.findById(u.patient).lean().exec();
    const fresh = await this.refill(u, patient);
    const rendered = fresh.rendered;
    if (!rendered || rendered.missing.length) throw new ConflictException('This update has no approved text to send.');
    const saved: any = await this.updates
      .findOneAndUpdate(
        { _id: u._id, status: 'held', reason: 'auto-off' },
        { $set: { status: 'waiting', sendAt: this.clock(), text: rendered.text, language: rendered.language, values: fresh.values }, $unset: { reason: '' } },
        { new: true }
      )
      .lean()
      .exec();
    if (!saved) throw new ConflictException('This update was already handled.');
    return this.view(saved, actor);
  }

  /** A held update the desk will not send. */
  async dismiss(actor: Actor, updateId: string): Promise<PatientUpdateView> {
    const u = await this.held(actor, updateId);
    if (u.status !== 'held') throw new ConflictException('Only a held update can be dismissed.');
    if (!(await this.skip(u, 'dismissed', ['held']))) throw new ConflictException('This update was already handled.');
    return this.view((await this.updates.findById(u._id).lean().exec()) as any, actor);
  }

  /** A death stops the patient's waiting and held updates. Returns how many it stopped. */
  async cancelForDeath(patientId: string): Promise<number> {
    if (!isValidObjectId(patientId)) return 0;
    const open: any[] = await this.updates
      .find({ patient: new Types.ObjectId(patientId), status: { $in: ['waiting', 'held'] } })
      .lean()
      .exec();
    let n = 0;
    for (const u of open) if (await this.skip(u, 'deceased', ['waiting', 'held'])) n++;
    return n;
  }

  // ---- Reading ----

  private view(u: any, viewer: Actor): PatientUpdateView {
    const full = !!viewer && SUP_ADMIN.includes(viewer.role);
    return {
      id: String(u._id),
      patientId: String(u.patient),
      patientUhid: u.patientUhid,
      patientName: u.patientName,
      case: u.case ? String(u.case) : null,
      trigger: u.trigger,
      triggerLabel: TRIGGER_LABEL[u.trigger as Trigger] ?? u.trigger,
      template: u.template,
      language: u.language,
      text: u.text,
      to: u.to ? (full ? u.to : maskPhone(u.to)) : null,
      toLabel: u.toLabel,
      status: u.status,
      reason: u.reason ?? null,
      note: u.note ?? null,
      sendAt: u.sendAt ?? null,
      sentAt: u.sentAt ?? null,
      sourceRef: u.sourceRef,
      createdAt: u.createdAt
    };
  }

  async list(q: UpdateQuery, viewer: Actor): Promise<PatientUpdateView[]> {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.reason) filter.reason = q.reason;
    if (q.trigger) filter.trigger = q.trigger;
    if (q.patientId) {
      if (!isValidObjectId(q.patientId)) return [];
      filter.patient = new Types.ObjectId(q.patientId);
    }
    const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const rows: any[] = await this.updates.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean().exec();
    return rows.map((u) => this.view(u, viewer));
  }

  // ---- Catch-up ----

  /**
   * Replays stored messages (oldest first, one batch) that have no update yet, starting at the later of `since` and a
   * persisted cursor (the createdAt of the last message examined), so messages that make no update cannot stall the
   * pass. Messages after the cursor are read with a strict `>`; a batch that ends inside a millisecond leaves that
   * millisecond for the next pass, so a tie at the boundary is never skipped (a batch that is all one millisecond is kept whole). Returns how many new updates it made.
   */
  async catchUp(since: Date): Promise<number> {
    const cursor = await this.counters.findOne({ key: CATCH_UP_KEY }).lean().exec();
    const from = new Date(Math.max(since.getTime(), cursor?.last ?? 0));
    const stored: any[] = await this.messageModel
      .find({ type: { $in: [...WAKE_TYPES] }, createdAt: cursor && cursor.last >= since.getTime() ? { $gt: from } : { $gte: from } })
      .sort({ createdAt: 1, _id: 1 })
      .limit(this.catchUpBatch + 1)
      .select('_id createdAt')
      .lean()
      .exec();
    if (!stored.length) return 0;
    // The extra row only tells whether the batch ends inside a millisecond: if so, leave that millisecond for the next pass.
    if (stored.length > this.catchUpBatch) {
      const extra = stored.pop();
      const edge = new Date(stored[stored.length - 1].createdAt).getTime();
      if (new Date(extra.createdAt).getTime() === edge) {
        const kept = stored.filter((m) => new Date(m.createdAt).getTime() < edge);
        if (kept.length) stored.splice(0, stored.length, ...kept);
      }
    }
    const seen = new Set(
      (
        await this.updates
          .find({ sourceMessage: { $in: stored.map((m) => m._id) } })
          .select('sourceMessage')
          .lean()
          .exec()
      ).map((u: any) => String(u.sourceMessage))
    );
    const before = await this.updates.countDocuments().exec();
    for (const m of stored) if (!seen.has(String(m._id))) await this.fromMessage(String(m._id));
    const last = new Date(stored[stored.length - 1].createdAt).getTime();
    await this.counters.findOneAndUpdate({ key: CATCH_UP_KEY }, { $max: { last } }, { upsert: true }).exec();
    return (await this.updates.countDocuments().exec()) - before;
  }
}
