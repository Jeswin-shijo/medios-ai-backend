import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, mongo, UpdateQuery } from 'mongoose';
import { QueueToken, QueueTokenDocument, TokenStatus } from './schemas/queue-token.schema';
import { QueueSequence, QueueSequenceDocument } from './schemas/queue-sequence.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { SettingsService } from '../settings/settings.service';
import { QueueEvents } from './queue-events';
import { AppointmentEvents, AppointmentStatusChange } from '../appointments/appointment-events';
import { Subscription } from 'rxjs';
import { displayName, QueueSettings, resolveQueueSettings } from './queue-settings';
import { OpdService } from '../opd/opd.service';
import { formatTokenLabel, newSecret } from '../reception/format';
import { clinicNow, clockMinutes, displayTime, isoDate } from '../../common/utils/clinic-time';

/** Appointment statuses a token can still check in. */
const CHECKABLE = ['Scheduled', 'Checked In', 'Waiting'];
const SEEING = [...CHECKABLE, 'In Consultation'];

const activeKey = (date: string, uhid: string) => `${date}:${uhid}`;
const isDuplicate = (err: unknown, field: string) =>
  err instanceof mongo.MongoServerError && err.code === 11000 && field in (err.keyPattern ?? {});

/** Serving order: priority tokens first, then by number. */
const byServingOrder = (a: QueueToken, b: QueueToken) => Number(b.priority) - Number(a.priority) || a.number - b.number;

export interface QueueBoard {
  date: string;
  settings: QueueSettings;
  /** Token JSON plus `position`: place in line for a waiting token, else null. */
  tokens: Record<string, unknown>[];
  stats: Record<'issued' | 'waiting' | 'called' | 'skipped' | 'completed' | 'cancelled', number> & { averageWaitMinutes: number | null };
}

export interface IssueRequest {
  uhid?: string;
  appointmentId?: string;
  priority?: boolean;
  note?: string;
  /** The doctor's line to join; the default doctor when omitted. */
  doctorId?: string;
  /** Join the line without checking in the patient's appointment. */
  skipAppointment?: boolean;
}

/** Match a series; old tokens and sequences have none, which counts as the hospital-wide '' line. */
const seriesFilter = (series: string) => (series ? { series } : { series: { $in: ['', null] } });

/** Ignore "no such index" and "no such collection" when dropping an old index. */
const IGNORED_DROP_CODES = [26, 27];

/** Appointment statuses that end the visit, and what they do to its token. */
const ENDS_TOKEN: Record<string, { status: TokenStatus; from: TokenStatus[] }> = {
  Completed: { status: 'completed', from: ['waiting', 'called', 'skipped'] },
  Canceled: { status: 'cancelled', from: ['waiting', 'skipped'] },
  'No Show': { status: 'cancelled', from: ['waiting', 'skipped'] },
};

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private appointmentChanges?: Subscription;

  constructor(
    @InjectModel(QueueToken.name) private readonly tokens: Model<QueueTokenDocument>,
    @InjectModel(QueueSequence.name) private readonly sequences: Model<QueueSequenceDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    private readonly settings: SettingsService,
    private readonly events: QueueEvents,
    private readonly appointmentEvents: AppointmentEvents,
    private readonly opd: OpdService,
  ) {}

  async onModuleInit() {
    this.appointmentChanges = this.appointmentEvents.statusChanges$.subscribe((change) =>
      this.followAppointment(change).catch((err) => this.logger.warn(`Appointment ${change.id} → ${change.status}: ${(err as Error).message}`)),
    );
    // Numbers now restart per doctor, so the hospital-wide unique keys must go.
    await this.dropIndex(this.tokens, 'date_1_number_1');
    await this.dropIndex(this.sequences, 'date_1');
    // Old records have no series; give them '' so upserts can match on plain equality.
    await this.sequences.updateMany({ series: { $exists: false } }, { $set: { series: '' } }).exec();
    await this.tokens.updateMany({ series: { $exists: false } }, { $set: { series: '' } }).exec();
  }

  private async dropIndex(model: Model<any>, name: string) {
    try {
      await model.collection.dropIndex(name);
    } catch (err) {
      if (!IGNORED_DROP_CODES.includes((err as { code?: number }).code ?? 0)) throw err;
    }
  }

  onModuleDestroy() {
    this.appointmentChanges?.unsubscribe();
  }

  /**
   * A visit finished or called off outside the queue (say, a consultation completed
   * in the mobile app) ends its token, so the display stops listing the patient.
   */
  private async followAppointment({ id, status }: AppointmentStatusChange) {
    const end = ENDS_TOKEN[status];
    if (!end) return;
    const now = new Date();
    const token = await this.tokens
      .findOneAndUpdate(
        { appointmentId: id, status: { $in: end.from } },
        { $set: { status: end.status, ...(end.status === 'completed' && { completedAt: now }) }, $unset: { activeKey: 1 } },
        { new: true },
      )
      .exec();
    if (token) this.events.changed();
  }

  /** The clinic's current day; tokens are numbered per day. */
  today() {
    return isoDate(clinicNow());
  }

  async queueSettings(): Promise<QueueSettings> {
    const s = (await this.settings.getSettings()) as unknown as Record<string, any>;
    return resolveQueueSettings(s.queue);
  }

  // ---------------------------------------------------------------- reading

  /** Every token of the day in number order, waiting ones with their place in line. */
  async board(date = this.today()): Promise<QueueBoard> {
    const [tokens, settings] = await Promise.all([this.tokens.find({ date }).sort({ number: 1 }).exec(), this.queueSettings()]);
    const waiting = tokens.filter((t) => t.status === 'waiting').sort(byServingOrder);
    const place = new Map<string, number>(); // next place in line, per series
    const position = new Map(
      waiting.map((t) => {
        const n = (place.get(t.series ?? '') ?? 0) + 1;
        place.set(t.series ?? '', n);
        return [String(t._id), n];
      }),
    );

    const waits = tokens.filter((t) => t.firstCalledAt).map((t) => t.firstCalledAt!.getTime() - (t as any).createdAt.getTime());
    const count = (status: TokenStatus) => tokens.filter((t) => t.status === status).length;

    return {
      date,
      settings,
      tokens: tokens.map((t) => ({ ...t.toJSON(), position: position.get(String(t._id)) ?? null })),
      stats: {
        issued: tokens.length,
        waiting: count('waiting'),
        called: count('called'),
        skipped: count('skipped'),
        completed: count('completed'),
        cancelled: count('cancelled'),
        averageWaitMinutes: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60_000) : null,
      },
    };
  }

  /**
   * What the waiting-room display shows: token numbers, the room each called token
   * should go to, and (only if the settings allow) a shortened name. Nothing else
   * about the patient leaves the server.
   */
  async displaySnapshot() {
    const date = this.today();
    const [s, tokens] = await Promise.all([
      this.settings.getSettings() as unknown as Promise<Record<string, any>>,
      this.tokens.find({ date, status: { $in: ['waiting', 'called'] } }).exec(),
    ]);
    const settings = resolveQueueSettings(s.queue);
    const name = (t: QueueToken) => (settings.showNamesOnDisplay ? displayName(t.patientName) : undefined);
    const waiting = tokens.filter((t) => t.status === 'waiting').sort(byServingOrder);

    return {
      hospitalName: String(s.hospital?.name ?? ''),
      date,
      announce: settings.announce,
      nowServing: tokens
        .filter((t) => t.status === 'called')
        .sort((a, b) => b.calledAt!.getTime() - a.calledAt!.getTime())
        .map((t) => ({ label: t.label, counter: t.counter, calledAt: t.calledAt, recalls: t.recalls, name: name(t) })),
      upcoming: waiting.slice(0, settings.upcomingOnDisplay).map((t) => ({ label: t.label, priority: t.priority, room: t.room, name: name(t) })),
      waitingCount: waiting.length,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * What a check-in kiosk shows after a tap: the token, a short name, and how many
   * people are ahead. No UHID and no full name, as anyone at the kiosk can see it.
   */
  async kioskView(token: QueueTokenDocument, existing: boolean) {
    const waiting =
      token.status === 'waiting'
        ? await this.tokens.find({ date: token.date, status: 'waiting', ...seriesFilter(token.series ?? '') }).select('number priority').exec()
        : [];
    return {
      label: token.label,
      name: displayName(token.patientName),
      status: token.status,
      existing,
      ahead: waiting.filter((t) => byServingOrder(t, token) < 0).length,
      counter: token.status === 'called' ? token.counter : undefined,
      room: token.room,
      doctorName: token.doctorName,
      department: token.department,
      trackCode: token.trackCode,
      appointmentTime: token.appointmentTime,
      issuedAt: (token as unknown as { createdAt: Date }).createdAt,
    };
  }

  async tokenById(id: string): Promise<QueueTokenDocument | null> {
    return this.tokens.findById(id).exec().catch(() => null); // a malformed id is just "not found"
  }

  /** The token the patient holds today (waiting, called or skipped), if any. */
  activeTokenFor(uhid: string): Promise<QueueTokenDocument | null> {
    return this.tokens.findOne({ activeKey: activeKey(this.today(), uhid) }).exec();
  }

  /** Waiting tokens per series (doctor id; '' for the hospital-wide line) on a day. */
  async waitingCountsBySeries(date = this.today()): Promise<Map<string, number>> {
    const rows = await this.tokens
      .aggregate<{ _id: string; count: number }>([
        { $match: { date, status: 'waiting' } },
        { $group: { _id: { $ifNull: ['$series', ''] }, count: { $sum: 1 } } },
      ])
      .exec();
    return new Map(rows.map((r) => [r._id, r.count]));
  }

  // ---------------------------------------------------------------- issuing

  /**
   * Gives the patient a token for today. A patient already holding one gets it back
   * (a skipped one goes back in the queue), so a repeated check-in or card tap is
   * harmless. Checking in today's appointment marks it Checked In.
   */
  async issue(req: IssueRequest, actor: string, source: 'front-desk' | 'kiosk' = 'front-desk') {
    if (!req.uhid && !req.appointmentId) throw new BadRequestException('Give the patient UHID or the appointment to check in');
    const date = this.today();
    const doctor = await this.doctorFor(req.doctorId);
    const found = await this.appointmentFor(req, date);
    const uhid = req.uhid?.trim() || found!.uhid;
    // Only the default doctor's line checks an appointment in.
    const defaultDoctor = doctor ? await this.opd.defaultDoctor() : null;
    const appointment = req.skipAppointment !== true && (!doctor || String(doctor._id) === String(defaultDoctor?._id)) ? found : null;

    const patient = await this.patients.findOne({ uhid }).exec();
    if (!patient && !found) throw new NotFoundException(`${uhid} is not a registered patient. Register them first.`);

    const held = await this.tokens.findOne({ activeKey: activeKey(date, uhid) }).exec();
    if (held) return { token: await this.reclaim(held), existing: true };

    const settings = await this.queueSettings();
    const series = doctor ? String(doctor._id) : '';
    const number = await this.nextNumber(date, series);
    let token: QueueTokenDocument;
    try {
      token = await this.tokens.create({
        date,
        number,
        series,
        label: doctor ? formatTokenLabel(doctor.tokenPrefix, number) : `${settings.tokenPrefix}${number}`,
        ...(doctor && {
          doctorId: series,
          doctorName: doctor.name,
          department: await this.departmentName(doctor.departmentCode),
          room: doctor.room,
        }),
        trackCode: newSecret(16),
        uhid,
        patientName: patient?.name ?? found!.patientName,
        appointmentId: appointment ? String(appointment._id) : undefined,
        appointmentTime: appointment?.time ?? '',
        priority: req.priority === true,
        note: req.note?.trim() ?? '',
        source,
        issuedBy: actor,
        activeKey: activeKey(date, uhid),
      });
    } catch (err) {
      // Checked in twice at the same moment: the other request's token stands.
      if (!isDuplicate(err, 'activeKey')) throw err;
      const other = await this.tokens.findOne({ activeKey: activeKey(date, uhid) }).exec();
      if (!other) throw err;
      return { token: other, existing: true };
    }

    if (appointment) {
      await this.syncAppointment(token, 'Checked In', ['Scheduled'], { checkedInTime: displayTime(clinicNow()) });
    }
    this.events.changed();
    return { token, existing: false };
  }

  /** The appointment being checked in: the one named, or the patient's next one today. */
  private async appointmentFor(req: IssueRequest, date: string): Promise<AppointmentDocument | null> {
    if (req.appointmentId) {
      const appointment = await this.appointments.findById(req.appointmentId).exec();
      if (!appointment) throw new NotFoundException('Appointment not found');
      if (req.uhid && appointment.uhid !== req.uhid.trim()) throw new BadRequestException('That appointment belongs to another patient');
      if (appointment.date !== date) throw new ConflictException(`That appointment is on ${appointment.date}, not today`);
      if (!SEEING.includes(appointment.status)) throw new ConflictException(`That appointment is ${appointment.status}`);
      return appointment;
    }
    const today = await this.appointments.find({ uhid: req.uhid!.trim(), date, status: { $in: CHECKABLE } }).exec();
    return today.sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time))[0] ?? null;
  }

  /** The asked-for doctor (must be active), else the default doctor; null when the hospital has no doctors (one hospital-wide line). */
  private async doctorFor(doctorId?: string) {
    if (doctorId) {
      const doctor = await this.opd.getDoctor(doctorId);
      if (!doctor.active) throw new ConflictException(`${doctor.name} is not seeing patients`);
      return doctor;
    }
    return this.opd.defaultDoctor();
  }

  private async departmentName(code: string) {
    return (await this.opd.listDepartments()).find((d) => d.code === code)?.name ?? code;
  }

  private async nextNumber(date: string, series: string): Promise<number> {
    const seq = await this.sequences
      .findOneAndUpdate({ date, series }, { $inc: { last: 1 } }, { upsert: true, new: true })
      .exec();
    return seq!.last;
  }

  /** A patient checking in again while holding a token: a skipped token rejoins the queue. */
  private async reclaim(token: QueueTokenDocument) {
    if (token.status !== 'skipped') return token;
    const requeued = await this.tokens.findOneAndUpdate({ _id: token._id, status: 'skipped' }, { $set: { status: 'waiting' } }, { new: true }).exec();
    if (!requeued) return (await this.tokens.findById(token._id).exec()) ?? token;
    this.events.changed();
    return requeued;
  }

  // ---------------------------------------------------------------- calling

  /**
   * Calls a token to a room: the next in line, or `tokenId` out of turn (a waiting
   * or skipped one). The room's current token, named in `finish`, is completed first.
   */
  async call(counter: string, actor: string, finish?: string, tokenId?: string) {
    const settings = await this.queueSettings();
    if (!settings.counters.includes(counter)) throw new BadRequestException(`"${counter}" is not one of the rooms in the queue settings`);
    const date = this.today();
    const now = new Date();

    const current = await this.tokens.findOne({ date, counter, status: 'called' }).exec();
    let completed: QueueTokenDocument | null = null;
    if (current) {
      if (String(current._id) !== finish) {
        throw new ConflictException(
          finish
            ? `${counter} is now seeing ${current.label}. Refresh the queue.`
            : `${counter} is still seeing ${current.label}. Mark it done or skipped first.`,
        );
      }
      completed = await this.finish(current, now);
    }

    const filter: FilterQuery<QueueTokenDocument> = tokenId
      ? { _id: tokenId, date, status: { $in: ['waiting', 'skipped'] } }
      : { date, status: 'waiting', $or: [{ room: counter }, { room: { $exists: false } }, { room: '' }] };
    let called: QueueTokenDocument | null;
    try {
      called = await this.tokens
        .findOneAndUpdate(
          filter,
          { $set: { status: 'called', counter, calledAt: now, calledBy: actor, recalls: 0 }, $min: { firstCalledAt: now } },
          { sort: { priority: -1, createdAt: 1 }, new: true },
        )
        .exec();
    } catch (err) {
      if (isDuplicate(err, 'counter')) throw new ConflictException(`${counter} has just called another token. Refresh the queue.`);
      throw err;
    }
    if (tokenId && !called) throw new ConflictException('That token is no longer waiting');

    if (called) await this.syncAppointment(called, 'In Consultation', CHECKABLE);
    if (completed || called) this.events.changed();
    return { called, completed };
  }

  /** Announces the called token again. */
  async recall(id: string) {
    const token = await this.transition(id, ['called'], { $set: { calledAt: new Date() }, $inc: { recalls: 1 } }, 'Only a called token can be announced again');
    this.events.changed();
    return token;
  }

  /** The called patient did not come; they keep their number and can be put back. */
  async skip(id: string) {
    const token = await this.transition(id, ['called'], { $set: { status: 'skipped' } }, 'Only a called token can be skipped');
    await this.syncAppointment(token, 'Checked In', ['In Consultation']);
    this.events.changed();
    return token;
  }

  async requeue(id: string) {
    const token = await this.transition(id, ['skipped'], { $set: { status: 'waiting' } }, 'Only a skipped token can go back in the queue');
    this.events.changed();
    return token;
  }

  async complete(id: string) {
    const token = await this.tokens.findById(id).exec();
    if (!token) throw new NotFoundException('Token not found');
    if (token.status !== 'called') throw new ConflictException(`Token ${token.label} is ${token.status}, not with a doctor`);
    const done = await this.finish(token, new Date());
    if (!done) throw new ConflictException(`Token ${token.label} has just changed. Refresh the queue.`);
    this.events.changed();
    return done;
  }

  /** Withdraws a token that is not with a doctor; the appointment is left as it is. */
  async cancel(id: string) {
    const token = await this.transition(
      id,
      ['waiting', 'skipped'],
      { $set: { status: 'cancelled' }, $unset: { activeKey: 1 } },
      'Only a waiting or skipped token can be cancelled',
    );
    this.events.changed();
    return token;
  }

  private async finish(token: QueueTokenDocument, at: Date) {
    const done = await this.tokens
      .findOneAndUpdate({ _id: token._id, status: 'called' }, { $set: { status: 'completed', completedAt: at }, $unset: { activeKey: 1 } }, { new: true })
      .exec();
    if (done) await this.syncAppointment(done, 'Completed', SEEING);
    return done;
  }

  /** Applies `update` if the token is still in one of the `from` statuses; otherwise explains why not. */
  private async transition(id: string, from: TokenStatus[], update: UpdateQuery<QueueTokenDocument>, refusal: string) {
    const token = await this.tokens.findOneAndUpdate({ _id: id, status: { $in: from } }, update, { new: true }).exec();
    if (token) return token;
    if (!(await this.tokens.exists({ _id: id }))) throw new NotFoundException('Token not found');
    throw new ConflictException(refusal);
  }

  /** Keeps the appointment's status in step with the token, if it is still in one of `from`. */
  private async syncAppointment(token: QueueToken, status: string, from: string[], extra: Record<string, unknown> = {}) {
    if (!token.appointmentId) return;
    try {
      await this.appointments.updateOne({ _id: token.appointmentId, status: { $in: from } }, { $set: { status, ...extra } }).exec();
    } catch (err) {
      this.logger.warn(`Token ${token.label}: could not mark appointment ${token.appointmentId} ${status}: ${(err as Error).message}`);
    }
  }
}
