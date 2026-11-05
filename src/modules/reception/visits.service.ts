import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, isValidObjectId, Model, mongo } from 'mongoose';
import { setTimeout as sleep } from 'node:timers/promises';
import { clinicNow, displayDateTime, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { Availability, doctorAvailability } from '../opd/availability';
import { OpdService } from '../opd/opd.service';
import { OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { QueueService } from '../queue/queue.service';
import { QueueTokenDocument } from '../queue/schemas/queue-token.schema';
import { RevenueKioskService } from '../revenue/revenue-kiosk.service';
import { SchedulingDoctorsService } from '../scheduling/scheduling-doctors.service';
import { SettingsService } from '../settings/settings.service';
import { formatOpNumber, newSecret, paymentCode } from './format';
import { RECEPTION_CLOCK, ReceptionIdentityService } from './identity.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider';
import { resolveReceptionSettings } from './reception-settings';
import { KioskDoctorView, KioskRef, KioskTokenView, VisitView } from './reception.types';
import { OpSequence, OpSequenceDocument } from './schemas/op-sequence.schema';
import { OpVisit, OpVisitDocument, PAYMENT_METHODS, PaymentMethod, VisitStatus } from './schemas/op-visit.schema';
import { resolveTrackingBase, toKioskTokenView } from './token-view';

const MINUTE_MS = 60 * 1000;
/** How long a visit stays open before a payment method is chosen. */
const UNCHOSEN_MINUTES = 15;
/** Cash waits for the counter longer than a UPI or card order (5 min, set by the provider). */
const CASH_MINUTES = 30;
/** How long the request that won the payment has to add the OP number, token and bill before another may take over. */
const FINISH_LEASE_MS = 30 * 1000;
/** How long a repeat request waits for that work before answering with the visit as it stands. */
const SETTLE_WAIT_MS = 5 * 1000;
const SETTLE_POLL_MS = 50;
/** How many stuck paid visits one staff list call finishes. */
const FINISH_PER_LIST = 5;
/** How many days back a paid visit still missing only its bill is put on one (the Revenue Agent's reconcile window). */
const BILL_RETRY_DAYS = 7;
/** Tries at creating a visit when a request for the same patient races it. */
const CREATE_ATTEMPTS = 3;

/** The method as the receipt names it. */
const MODE: Record<PaymentMethod, string> = { UPI: 'UPI', CASH: 'Cash', CARD: 'Card' };
/** The method as written in a sentence. */
const SAID: Record<PaymentMethod, string> = { UPI: 'UPI', CASH: 'cash', CARD: 'card' };

const CLOSED: Record<Exclude<VisitStatus, 'awaiting-payment'>, string> = {
  paid: 'This visit is already paid.',
  cancelled: 'This visit was cancelled. Please start again.',
  expired: 'The time to pay has run out. Please start again.',
};
const visitClosed = (status: VisitStatus) => new ConflictException({ message: CLOSED[status as keyof typeof CLOSED], code: 'VISIT_CLOSED' });
const visitNotFound = () => new NotFoundException('Visit not found');

const kioskActor = (kiosk: KioskRef) => `Kiosk: ${kiosk.name}`;
const after = (from: Date, ms: number) => new Date(from.getTime() + ms);
/** The clinic day `n` days before `day` (YYYY-MM-DD). */
const daysBefore = (day: string, n: number) => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() - n);
  return isoDate(d);
};
/**
 * How the patient paid, for the Revenue receipt: the payment's mode is `kiosk`, so the real method and its reference
 * go here, and sample mode says so.
 */
const paymentReference = (visit: OpVisit) =>
  visit.method === 'CASH'
    ? 'Cash at counter'
    : [MODE[visit.method!], visit.transactionId || visit.orderId, visit.provider === 'sample' ? 'SAMPLE' : ''].filter(Boolean).join(' · ');
const isDuplicate = (err: unknown) => err instanceof mongo.MongoServerError && err.code === 11000;
/** Paid and given everything payment brings: the OP number, the token and the bill. */
const isFinished = (visit: OpVisit) => Boolean(visit.opNumber && visit.tokenId && visit.billId);
/** The query form of "not finished". */
const UNFINISHED: FilterQuery<OpVisit> = { $or: [{ opNumber: { $exists: false } }, { billId: { $exists: false } }, { tokenId: { $exists: false } }] };

/** `needs-attention`: paid visits still missing their bill or token. */
export type VisitListStatus = 'awaiting-cash' | 'paid' | 'needs-attention' | 'all';

/**
 * OP visits booked at the reception kiosk. A visit is made for an identified patient
 * and a bookable doctor, then paid by UPI, card (both through the payment provider) or
 * cash (confirmed by staff). Payment is one atomic switch from awaiting-payment to paid,
 * so exactly one completion wins against any other completion, a cancel or expiry; the
 * winner then adds the OP number, the doctor-wise token and the bill, which the Revenue
 * Agent keeps (R26). A patient has at most one open visit.
 */
@Injectable()
export class OpVisitsService {
  private readonly logger = new Logger(OpVisitsService.name);

  constructor(
    @InjectModel(OpVisit.name) private readonly visits: Model<OpVisitDocument>,
    @InjectModel(OpSequence.name) private readonly sequences: Model<OpSequenceDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    private readonly identity: ReceptionIdentityService,
    private readonly opd: OpdService,
    private readonly queue: QueueService,
    private readonly revenue: RevenueKioskService,
    private readonly scheduling: SchedulingDoctorsService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
    @Optional() @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider | null,
    @Optional() @Inject(RECEPTION_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- kiosk

  /** The active doctors of a department (all when none is given) with today's availability, as the kiosk lists them. */
  async kioskDoctors(departmentCode?: string): Promise<KioskDoctorView[]> {
    const [doctors, departments] = await Promise.all([this.opd.listDoctors({ activeOnly: true, departmentCode }), this.opd.listDepartments()]);
    const names = new Map(departments.map((d) => [d.code, d.name]));
    const availability = await this.availabilityOf(doctors);
    return doctors.map((d) => ({
      id: String(d._id),
      name: d.name,
      qualifications: d.qualifications,
      department: names.get(d.departmentCode) ?? d.departmentCode,
      departmentCode: d.departmentCode,
      fee: d.fee,
      room: d.room,
      availability: availability.get(String(d._id))!,
    }));
  }

  async create(kiosk: KioskRef, session: string, doctorId: string): Promise<VisitView> {
    const { uhid, via } = await this.identity.resolveSession(kiosk, session);
    const held = await this.queue.activeTokenFor(uhid);
    if (held) {
      const token = await this.tokenView(held, await this.trackingBase());
      throw new ConflictException({ message: `You already have token ${held.label} today.`, code: 'HAS_TOKEN', token });
    }
    await this.expireDue();
    await this.refuseIfCashPending(uhid);
    const patient = await this.patients.findOne({ uhid }).exec();
    if (!patient) throw new NotFoundException('Patient not found');

    const doctor = await this.opd.getDoctor(doctorId);
    const availability = (await this.availabilityOf([doctor])).get(String(doctor._id))!;
    if (!doctor.active || !availability.bookable) {
      throw new ConflictException({ message: `${doctor.name} cannot be booked now. Please choose another doctor.`, code: 'DOCTOR_NOT_BOOKABLE' });
    }
    const department = (await this.opd.listDepartments()).find((d) => d.code === doctor.departmentCode)?.name ?? doctor.departmentCode;

    // One open visit per patient (a unique index backs this): an unpaid UPI, card or unchosen one is replaced.
    for (let attempt = 1; ; attempt++) {
      const now = this.now();
      await this.visits
        .updateMany(
          { uhid, status: 'awaiting-payment', method: { $ne: 'CASH' } },
          { $set: { status: 'cancelled' }, $push: { history: { at: now, event: 'Replaced by a new visit', by: kioskActor(kiosk) } } },
        )
        .exec();
      try {
        const visit = await this.visits.create({
          date: this.queue.today(),
          uhid,
          patientName: patient.name,
          doctorId: String(doctor._id),
          doctorName: doctor.name,
          department,
          departmentCode: doctor.departmentCode,
          room: doctor.room,
          fee: doctor.fee,
          status: 'awaiting-payment',
          provider: this.payments?.name ?? 'none',
          kioskId: kiosk.id,
          kioskName: kiosk.name,
          via,
          expiresAt: after(now, UNCHOSEN_MINUTES * MINUTE_MS),
          history: [{ at: now, event: `Booked with ${doctor.name}, fee ₹${doctor.fee}`, by: kioskActor(kiosk) }],
        });
        return this.view(visit);
      } catch (err) {
        // Another visit for the patient was made at the same moment (a double tap): replace it too, unless it now waits for cash.
        if (!isDuplicate(err) || attempt === CREATE_ATTEMPTS) throw err;
        await this.refuseIfCashPending(uhid);
      }
    }
  }

  /** Chooses (or changes) how the patient pays; a new choice replaces the earlier order. */
  async pay(kiosk: KioskRef, visitId: string, method: PaymentMethod): Promise<VisitView> {
    const visit = await this.kioskVisit(kiosk, visitId);
    if (visit.status !== 'awaiting-payment') throw visitClosed(visit.status);

    const settings = await this.settingsRecord();
    const reception = resolveReceptionSettings(settings.reception);
    const on = PAYMENT_METHODS.includes(method) && reception.methods[method.toLowerCase() as 'upi' | 'cash' | 'card'];
    if (!on || (method !== 'CASH' && !this.payments)) {
      throw new BadRequestException({ message: 'This payment method is not available. Please choose another.', code: 'METHOD_OFF' });
    }

    const terms = await this.paymentTerms(visit, method, reception.upiPayeeName || String(settings.hospital?.name ?? ''));
    const now = this.now();
    const updated = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, status: 'awaiting-payment', expiresAt: { $gt: now } },
        { $set: { method, ...terms.set }, $unset: terms.unset, $push: { history: { at: now, event: `Chose ${SAID[method]}`, by: kioskActor(kiosk) } } },
        { new: true },
      )
      .exec();
    if (updated) return this.view(updated);
    // Paid, cancelled or out of time since it was read.
    await this.expireDue();
    throw visitClosed((await this.visits.findById(visit._id).exec())?.status ?? 'expired');
  }

  /** Simulates the provider confirming a UPI or card payment; only the sample provider allows it. */
  async sampleComplete(kiosk: KioskRef, visitId: string): Promise<VisitView> {
    const visit = await this.kioskVisit(kiosk, visitId);
    const method = visit.method;
    if (this.payments?.name !== 'sample' || visit.provider !== 'sample' || (method !== 'UPI' && method !== 'CARD')) {
      throw new BadRequestException('Only sample UPI and card payments can be simulated.');
    }
    return this.completeWith(visitId, { actor: kioskActor(kiosk), transactionId: `SAMPLE-${method}-${newSecret(6)}` }, [method]);
  }

  /** The kiosk's own visit; a paid one is returned with its OP number, token and bill (once recorded). */
  async getForKiosk(kiosk: KioskRef, visitId: string): Promise<VisitView> {
    const visit = await this.kioskVisit(kiosk, visitId);
    if (visit.status !== 'paid') return this.view(visit);
    // A read answers with the visit as stored even if finishing it fails here.
    const settled = await this.settle(visit).catch(async (err: Error) => {
      this.logger.warn(`Visit ${visit._id}: could not finish (${err.message})`);
      return (await this.visits.findById(visit._id).exec()) ?? visit;
    });
    return this.view(settled);
  }

  // ---------------------------------------------------------------- payment

  /** The payment arrived (provider, sample simulation or staff). Repeating it returns the same result. */
  complete(visitId: string, by: { actor: string; transactionId?: string }): Promise<VisitView> {
    return this.completeWith(visitId, by, PAYMENT_METHODS);
  }

  /** Staff took the cash at the counter. Also works after the kiosk has moved on. */
  confirmCash(visitId: string, actor: string): Promise<VisitView> {
    return this.completeWith(visitId, { actor }, ['CASH']);
  }

  /**
   * Cancels an unpaid visit. A kiosk may cancel only its own, and never a cash visit
   * (the patient may be on the way to the counter): that is refused with CASH_PENDING
   * and the visit stays as it is. Staff may cancel any unpaid visit.
   */
  async cancel(visitId: string, by: { actor: string; kioskId?: string }): Promise<VisitView> {
    const id = this.visitId(visitId);
    const own = by.kioskId ? { kioskId: by.kioskId } : {};
    const now = this.now();
    const cancelled = await this.visits
      .findOneAndUpdate(
        { _id: id, ...own, status: 'awaiting-payment', ...(by.kioskId ? { method: { $ne: 'CASH' } } : {}) },
        { $set: { status: 'cancelled' }, $push: { history: { at: now, event: 'Cancelled', by: by.actor } } },
        { new: true },
      )
      .exec();
    if (cancelled) return this.view(cancelled);

    const visit = await this.visits.findOne({ _id: id, ...own }).exec();
    if (!visit) throw visitNotFound();
    if (visit.status === 'paid') throw visitClosed('paid');
    if (by.kioskId && visit.status === 'awaiting-payment' && visit.method === 'CASH') {
      throw new ConflictException({ message: 'This visit waits for payment at the counter. Only the staff there can cancel it.', code: 'CASH_PENDING' });
    }
    return this.view(visit);
  }

  // ---------------------------------------------------------------- staff

  /**
   * A day's visits (default today), newest first. `awaiting-cash` is the counter's list;
   * `needs-attention` is paid visits still missing their bill or token that no request is
   * finishing right now, from any day unless a date is given. Each call first finishes a
   * few of today's stuck visits.
   */
  async list(query: { date?: string; status?: VisitListStatus } = {}): Promise<VisitView[]> {
    if (query.date) parseIsoDay(query.date); // 400 unless YYYY-MM-DD
    await this.expireDue();
    await this.finishStuck();
    const attention = query.status === 'needs-attention';
    const filter: FilterQuery<OpVisitDocument> = attention && !query.date ? {} : { date: query.date ?? this.queue.today() };
    if (query.status === 'awaiting-cash') Object.assign(filter, { status: 'awaiting-payment', method: 'CASH' });
    if (query.status === 'paid') filter.status = 'paid';
    if (attention) Object.assign(filter, { status: 'paid', ...UNFINISHED, finishingUntil: { $not: { $gt: this.now() } } });
    const visits = await this.visits.find(filter).sort({ createdAt: -1, _id: -1 }).exec();
    const base = await this.trackingBase();
    return Promise.all(visits.map((v) => this.view(v, base)));
  }

  // ---------------------------------------------------------------- completion

  private async completeWith(visitId: string, by: { actor: string; transactionId?: string }, methods: readonly PaymentMethod[]): Promise<VisitView> {
    const id = this.visitId(visitId);
    const now = this.now();
    // The one switch every completion, cancel and expiry races on.
    const won = await this.visits
      .findOneAndUpdate(
        { _id: id, status: 'awaiting-payment', method: { $in: methods }, expiresAt: { $gt: now } },
        {
          $set: {
            status: 'paid',
            paidAt: now,
            confirmedBy: by.actor,
            finishingUntil: after(now, FINISH_LEASE_MS),
            ...(by.transactionId ? { transactionId: by.transactionId } : {}),
          },
          $push: { history: { at: now, event: by.transactionId ? `Payment received (${by.transactionId})` : 'Payment received', by: by.actor } },
        },
        { new: true },
      )
      .exec();
    if (won) return this.view(await this.finish(won));

    await this.expireDue();
    const visit = await this.visits.findById(id).exec();
    if (!visit) throw visitNotFound();
    if (visit.status === 'paid' && methods.includes(visit.method!)) return this.view(await this.settle(visit));
    if (visit.status !== 'awaiting-payment') throw visitClosed(visit.status);
    if (!visit.method || !methods.includes(visit.method)) {
      throw new ConflictException(methods.length === 1 ? `This visit is not waiting for a ${SAID[methods[0]]} payment.` : 'Choose a payment method first.');
    }
    throw new ConflictException('This visit has just changed. Please try again.');
  }

  /**
   * Adds the OP number, the token and then the bill to a paid visit, storing each as it
   * goes so a later request picks up where this stopped. The bill comes last: a paid visit
   * always gets its token (R8) whatever the Revenue Agent does, and the bill needs to know
   * whether the token checked in an appointment. A failed bill is logged and left for a
   * later request (the staff list heals it); it never fails the payment. Only the holder of
   * the visit's finishing lease runs this, and it gives the lease up at the end, done or
   * failed, so a retry need not wait.
   */
  private async finish(visit: OpVisitDocument): Promise<OpVisitDocument> {
    const by = visit.confirmedBy || 'System';
    let current = visit;
    try {
      if (!current.opNumber) current = await this.assignOpNumber(current, by);
      if (!current.tokenId) current = await this.issueToken(current, by);
      if (!current.billId) {
        try {
          current = await this.recordBill(current, by);
        } catch (err) {
          this.logger.warn(`Visit ${visit._id}: paid and given its token, but not yet on a bill (${(err as Error).message}); tried again later`);
        }
      }
      return current;
    } finally {
      // Only our own lease: if this ran past it, another request may hold a newer one.
      await this.visits.updateOne({ _id: visit._id, finishingUntil: visit.finishingUntil }, { $unset: { finishingUntil: 1 } }).exec();
    }
  }

  /** Takes the finishing lease of an unfinished paid visit when no live request holds it, and finishes it; null otherwise. */
  private async takeOver(id: unknown): Promise<OpVisitDocument | null> {
    const now = this.now();
    const claimed = await this.visits
      .findOneAndUpdate(
        { _id: id, status: 'paid', ...UNFINISHED, finishingUntil: { $not: { $gt: now } } },
        { $set: { finishingUntil: after(now, FINISH_LEASE_MS) } },
        { new: true },
      )
      .exec();
    return claimed ? this.finish(claimed) : null;
  }

  /**
   * Today's paid visits left without their token or bill (finishing failed, or the server
   * stopped part-way) and whose lease has run out: a few are finished on each call, so the
   * staff list, polled all day, heals them. Failures are logged and tried again next call.
   * An earlier day's visit is healed only when the bill alone is missing (the last week):
   * a token is for its own day and is never issued late.
   */
  private async finishStuck() {
    const today = this.queue.today();
    const billOnly = { date: { $gte: daysBefore(today, BILL_RETRY_DAYS), $lt: today }, opNumber: { $exists: true }, tokenId: { $exists: true }, billId: { $exists: false } };
    const stuck = await this.visits
      .find({ status: 'paid', finishingUntil: { $not: { $gt: this.now() } }, $or: [{ date: today, ...UNFINISHED }, billOnly] })
      .sort({ paidAt: 1, _id: 1 })
      .limit(FINISH_PER_LIST)
      .select('_id')
      .exec();
    await Promise.all(stuck.map((v) => this.takeOver(v._id).catch((err: Error) => this.logger.warn(`Visit ${v._id}: could not finish (${err.message})`))));
  }

  /**
   * A paid visit with everything payment brings. While another request is still
   * adding it, waits for that request; once that request's lease has run out (it
   * stopped part-way), takes over and finishes the visit itself.
   */
  private async settle(visit: OpVisitDocument): Promise<OpVisitDocument> {
    const giveUpAt = Date.now() + SETTLE_WAIT_MS;
    let current = visit;
    while (!isFinished(current)) {
      const finished = await this.takeOver(current._id);
      if (finished) return finished;
      if (Date.now() >= giveUpAt) break;
      await sleep(SETTLE_POLL_MS);
      current = (await this.visits.findById(current._id).exec()) ?? current;
    }
    return current;
  }

  /** The clinic day's next OP number; numbers are only taken by a paid visit, so they have no gaps. */
  private async assignOpNumber(visit: OpVisitDocument, by: string) {
    const day = this.queue.today();
    const sequence = await this.sequences.findOneAndUpdate({ date: day }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    const opNumber = formatOpNumber(day, sequence!.last);
    return this.store(visit, 'opNumber', { opNumber }, `OP number ${opNumber}`, by);
  }

  /** The doctor-wise token. A patient given one elsewhere in the meantime keeps it, and no second one is made. */
  private async issueToken(visit: OpVisitDocument, by: string) {
    // Paid for: the token is issued even if the doctor was made inactive after booking.
    const { token, existing } = await this.queue.issue({ uhid: visit.uhid, doctorId: visit.doctorId, allowInactiveDoctor: true }, by, 'kiosk');
    const event = existing ? `Patient already held token ${token.label}; no new token was issued` : `Token ${token.label} issued`;
    return this.store(visit, 'tokenId', { tokenId: String(token._id), tokenLabel: token.label }, event, by);
  }

  /**
   * Puts the visit on a Revenue bill (R26): its consultation and the kiosk payment, once per visit, so a repeat or a
   * heal never records twice. When the token checked in the patient's appointment with this doctor, the consultation is
   * that appointment's own check-in charge; otherwise the visit's own line, on the bill Revenue picks for the day.
   */
  private async recordBill(visit: OpVisitDocument, by: string) {
    const token = visit.tokenId ? await this.queue.tokenById(visit.tokenId) : null;
    const appointmentId = token?.appointmentId && token.doctorId === visit.doctorId ? token.appointmentId : undefined;
    const record = await this.revenue.record({
      visitId: String(visit._id),
      uhid: visit.uhid,
      doctorId: visit.doctorId,
      doctorName: visit.doctorName,
      fee: visit.fee,
      day: visit.date,
      appointmentId,
      reference: paymentReference(visit),
      by,
      at: clinicNow(visit.paidAt ?? this.now()),
    });
    const event = record.receiptNumber
      ? `Bill ${record.billNumber}: ₹${visit.fee} paid by ${SAID[visit.method!]}, receipt ${record.receiptNumber}`
      : `Bill ${record.billNumber}: consultation with nothing to pay`;
    const set: Partial<OpVisit> = { billId: record.billId, billNumber: record.billNumber, ...(record.receiptNumber ? { receiptNumber: record.receiptNumber } : {}) };
    return this.store(visit, 'billId', set, event, by);
  }

  /** Saves one finishing step unless it is already saved; returns the visit as stored. */
  private async store(visit: OpVisitDocument, step: 'opNumber' | 'tokenId' | 'billId', set: Partial<OpVisit>, event: string, by: string) {
    const saved = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, [step]: { $exists: false } },
        { $set: set, $push: { history: { at: this.now(), event, by } } },
        { new: true },
      )
      .exec();
    return saved ?? (await this.visits.findById(visit._id).exec())!;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Today's availability of each doctor at the kiosk: their OP sessions and queue, and Scheduling's leave (R27), so the
   * list and booking agree. A doctor on leave today is off, the state the tablet already greys out.
   */
  private async availabilityOf(doctors: OpDoctorDocument[]): Promise<Map<string, Availability>> {
    const now = clinicNow(this.now());
    const ids = doctors.map((d) => String(d._id));
    const [waiting, onLeave] = await Promise.all([this.queue.waitingCountsBySeries(), this.scheduling.doctorsOnLeave(isoDate(now), ids)]);
    return new Map(doctors.map((d, i) => [ids[i], doctorAvailability(d.sessions, now, waiting.get(ids[i]) ?? 0, d.avgConsultMinutes, onLeave.has(ids[i]))]));
  }

  /** A patient sent to the counter must pay there, or have staff cancel it, before starting again. */
  private async refuseIfCashPending(uhid: string) {
    const cash = await this.visits.findOne({ uhid, status: 'awaiting-payment', method: 'CASH' }).exec();
    if (cash) {
      throw new ConflictException({
        message: `You have a payment waiting at the counter (code ${cash.paymentCode}). Please pay there or ask the staff to cancel it.`,
        code: 'CASH_PENDING',
      });
    }
  }

  /** The order for the chosen method, and the fields of an earlier choice it clears. */
  private async paymentTerms(visit: OpVisitDocument, method: PaymentMethod, payeeName: string): Promise<{ set: Partial<OpVisit>; unset: Record<string, 1> }> {
    const visitId = String(visit._id);
    if (method === 'CASH') {
      return { set: { provider: 'cash', paymentCode: paymentCode(), expiresAt: after(this.now(), CASH_MINUTES * MINUTE_MS) }, unset: { orderId: 1, upiUri: 1 } };
    }
    if (method === 'UPI') {
      const order = await this.payments!.createUpiOrder({ visitId, amount: visit.fee, payeeName });
      return { set: { provider: this.payments!.name, orderId: order.orderId, upiUri: order.upiUri, expiresAt: order.expiresAt }, unset: { paymentCode: 1 } };
    }
    const order = await this.payments!.createCardRequest({ visitId, amount: visit.fee });
    return { set: { provider: this.payments!.name, orderId: order.orderId, expiresAt: order.expiresAt }, unset: { upiUri: 1, paymentCode: 1 } };
  }

  /** Unpaid visits past their time become expired; applied whenever visits are read. */
  private async expireDue() {
    const now = this.now();
    await this.visits
      .updateMany({ status: 'awaiting-payment', expiresAt: { $lte: now } }, { $set: { status: 'expired' }, $push: { history: { at: now, event: 'Expired', by: 'System' } } })
      .exec();
  }

  /** One of this kiosk's visits, with expiry applied; another kiosk's is "not found". */
  private async kioskVisit(kiosk: KioskRef, visitId: string): Promise<OpVisitDocument> {
    const id = this.visitId(visitId);
    await this.expireDue();
    const visit = await this.visits.findOne({ _id: id, kioskId: kiosk.id }).exec();
    if (!visit) throw visitNotFound();
    return visit;
  }

  /** A malformed id is just "not found". */
  private visitId(visitId: string): string {
    if (!isValidObjectId(visitId)) throw visitNotFound();
    return visitId;
  }

  private settingsRecord() {
    return this.settings.getSettings() as unknown as Promise<Record<string, any>>;
  }

  private async trackingBase(): Promise<string> {
    const settings = await this.settingsRecord();
    return resolveTrackingBase(resolveReceptionSettings(settings.reception), this.config.get<string>('reception.publicWebUrl'));
  }

  private async tokenView(token: QueueTokenDocument, trackingBase: string): Promise<KioskTokenView> {
    return toKioskTokenView(await this.queue.kioskView(token, false), trackingBase);
  }

  private async view(visit: OpVisitDocument, trackingBase?: string): Promise<VisitView> {
    const token = visit.tokenId ? await this.queue.tokenById(visit.tokenId) : null;
    return {
      id: String(visit._id),
      status: visit.status,
      method: visit.method,
      fee: visit.fee,
      sample: visit.provider === 'sample',
      doctor: { id: visit.doctorId, name: visit.doctorName, department: visit.department, room: visit.room },
      patient: { name: visit.patientName, uhid: visit.uhid },
      paymentCode: visit.paymentCode,
      upiUri: visit.upiUri,
      expiresAt: visit.expiresAt.toISOString(),
      paidAt: visit.paidAt?.toISOString(),
      paidAtDisplay: visit.paidAt ? displayDateTime(clinicNow(visit.paidAt)) : undefined,
      transactionId: visit.transactionId,
      opNumber: visit.opNumber,
      billNumber: visit.billNumber,
      receiptNumber: visit.receiptNumber,
      token: token ? await this.tokenView(token, trackingBase ?? (await this.trackingBase())) : undefined,
      kioskName: visit.kioskName,
      via: visit.via,
      createdAt: (visit as unknown as { createdAt: Date }).createdAt.toISOString(),
    };
  }
}
