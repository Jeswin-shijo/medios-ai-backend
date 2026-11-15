import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { AgentCall, AgentCallDocument, CallOutcome, CallPurpose } from './schemas/agent-call.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { FollowUpItem, FollowUpDocument } from '../follow-ups/schemas/follow-up.schema';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { SettingsService } from '../settings/settings.service';
import { SlotsService } from './slots.service';
import { SchedulingAppointmentsService } from '../scheduling/scheduling-appointments.service';
import { SchedulingWaitlistService } from '../scheduling/scheduling-waitlist.service';
import { SupportBridge } from '../support-bridge/support-bridge';
import { CallAgentSettings, nextCallingTime, resolveCallAgentSettings, withinCallingHours } from './call-agent-settings';
import { CallResult, ProviderCheck, ProviderError, VOICE_PROVIDER, VoiceProvider } from './providers/voice-provider';
import { InboundService } from './inbound.service';
import { AGENT_SCRIPTS } from './agent-scripts';
import { maskPhone, toE164India } from './phone';
import {
  appointmentStart,
  clinicNow,
  displayDate,
  displayDateTime,
  displayTime,
  isoDate,
  parseIsoDay,
  spokenDay,
} from '../../common/utils/clinic-time';

const isDuplicateKey = (e: any) => e?.code === 11000;
const LIVE_STATUSES = ['scheduled', 'calling'];
/** A placed call with no result after this long is given up on. */
const RESULT_TIMEOUT_MS = 30 * 60_000;
/** Calls placed per scheduler run, so a backlog does not dial everyone at once. */
const DIAL_BATCH = 10;
/** Too close to the appointment for a confirmation call to help. */
const MIN_CONFIRM_LEAD_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;

/** What an outcome led to. retryAt/callbackAt schedule the next call. */
interface Effect {
  outcome: CallOutcome;
  action: string;
  appointmentId?: string;
  retryAt?: Date;
  callbackAt?: Date;
}

export interface BookingRequest {
  uhid: string;
  visitReason?: string;
  appointmentType?: string;
  fromDate?: string;
  followUpId?: string;
}

/** Patient Support's check-up call a few days after going home. */
export interface CheckupRequest {
  checkupId: string;
  patientUhid: string;
  group: 'general' | 'cardiac';
  language: 'en' | 'ta';
}

export interface ListCallsFilter {
  purpose?: string;
  status?: string;
  outcome?: string;
  uhid?: string;
  appointmentId?: string;
  limit?: number;
}

/**
 * Milliseconds between real time and the clinic's (pinned) day; 0 in production.
 * Appointment times live on the clinic's calendar, call timestamps on the real one.
 */
const clinicOffsetMs = () => Date.now() - clinicNow().getTime();

const slotWhen = (date: string, time: string) => `${displayDate(parseIsoDay(date))}, ${time}`;

/** "10:45 AM" today, or "27 Sep 2026, 09:00 AM" on another day. */
const when = (at: Date) => (at.toDateString() === new Date().toDateString() ? displayTime(at) : displayDateTime(at));

/**
 * The AI call agent: places confirmation and booking calls through the configured
 * voice provider, applies each call's outcome to the appointment book, and schedules
 * retries and callbacks. Every call is one AgentCall record; staff see the log,
 * transcripts and what was done in the web app's AI Call Agent screen.
 */
@Injectable()
export class CallsService implements OnModuleInit {
  private readonly logger = new Logger('CallAgent');
  private running = false;

  constructor(
    @InjectModel(AgentCall.name) private readonly calls: Model<AgentCallDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    private readonly tasks: TasksAlertsService,
    private readonly settings: SettingsService,
    private readonly slots: SlotsService,
    private readonly inbound: InboundService,
    private readonly config: ConfigService,
    @Inject(VOICE_PROVIDER) private readonly provider: VoiceProvider,
    private readonly scheduling?: SchedulingAppointmentsService,
    private readonly waitlist?: SchedulingWaitlistService,
    @Optional() private readonly bridge?: SupportBridge,
  ) {}

  onModuleInit() {
    this.provider.attachResultHandler?.((result) => this.recordResult(result));
  }

  get providerInfo() {
    return { provider: this.provider.name, live: this.provider.live };
  }

  async agentSettings(): Promise<CallAgentSettings> {
    return (await this.context()).cfg;
  }

  /** The agents' scripts; the inbound agent's variables come with this hospital's values as defaults. */
  async scripts() {
    const { common } = await this.context();
    return Object.values(AGENT_SCRIPTS).map((script) =>
      script.purpose === 'inbound' ? { ...script, defaults: Object.fromEntries(script.variables.map((v) => [v, common[v as keyof typeof common] ?? ''])) } : script,
    );
  }

  /** Whether check-up calls can be automated: simulated calls, or SnapServe with a check-up agent. */
  canCheckupCall(): boolean {
    if (this.provider.name === 'simulated') return true;
    return this.provider.name === 'snapserve' && !!this.config.get<string>('callAgent.snapserve.checkupAgentId');
  }

  /** Proves the provider's key and agent ids without placing a call. */
  async checkProvider(): Promise<ProviderCheck> {
    if (this.provider.check) return this.provider.check();
    return {
      provider: this.provider.name,
      ok: this.provider.name !== 'none',
      agents: [],
      detail: this.provider.name === 'simulated' ? 'Simulated calls: nothing to connect to.' : 'No call provider is configured.',
    };
  }

  // ---------------------------------------------------------------- reading

  async list(filter: ListCallsFilter) {
    const query: Record<string, unknown> = {};
    for (const key of ['purpose', 'status', 'outcome', 'uhid', 'appointmentId'] as const) {
      if (filter[key]) query[key] = filter[key];
    }
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    return this.calls.find(query, { transcript: 0, variables: 0, rawResult: 0 }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /** One call; the provider's raw payload (rawResult) only when asked for (admins). */
  async findOne(id: string, withRawResult = true): Promise<AgentCallDocument> {
    const call = isValidObjectId(id) ? await this.calls.findById(id, withRawResult ? undefined : { rawResult: 0 }).exec() : null;
    if (!call) throw new NotFoundException(`Call ${id} not found`);
    return call;
  }

  async stats() {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const today = await this.calls.find({ createdAt: { $gte: since } }, { status: 1, outcome: 1 }).lean().exec();
    const completed = today.filter((c) => c.status === 'completed');
    const answered = completed.filter((c) => !['no_answer', 'busy', 'failed'].includes(c.outcome ?? '')).length;
    const count = (...outcomes: string[]) => today.filter((c) => outcomes.includes(c.outcome ?? '')).length;

    const now = clinicNow();
    const tomorrow = new Date(now.getTime() + DAY_MS);
    const [unconfirmed, needsAttention, active] = await Promise.all([
      this.appointments
        .find({ status: 'Scheduled', confirmation: { $in: [null, 'Unconfirmed'] }, date: { $gte: isoDate(now), $lte: isoDate(tomorrow) } }, { date: 1, time: 1 })
        .lean()
        .exec(),
      this.appointments.countDocuments({ status: 'Scheduled', confirmation: { $in: ['Reschedule Requested', 'Unreachable'] }, date: { $gte: isoDate(now) } }),
      this.calls.countDocuments({ status: { $in: LIVE_STATUSES } }),
    ]);

    return {
      callsToday: today.length,
      inboundToday: await this.calls.countDocuments({ purpose: 'inbound', createdAt: { $gte: since } }),
      answeredToday: answered,
      contactRate: completed.length ? Math.round((answered / completed.length) * 100) : null,
      confirmedToday: count('confirmed', 'rescheduled'),
      bookedToday: count('booked'),
      cancelledToday: count('cancelled'),
      escalatedToday: count('escalated'),
      unansweredToday: count('no_answer', 'busy'),
      active,
      // Today's and tomorrow's appointments still ahead that nobody has confirmed.
      upcomingUnconfirmed: unconfirmed.filter((a) => appointmentStart(a.date, a.time) > now).length,
      needsAttention,
    };
  }

  /** Free slots the booking agent would offer, starting at `from` (YYYY-MM-DD). */
  async freeSlots(from?: string, count = 2) {
    const { cfg } = await this.context();
    const doctor = await this.slots.doctorFor();
    return this.slots.findFree(cfg, this.searchStart(from), Math.min(Math.max(count, 1), 6), undefined, doctor ? String(doctor._id) : undefined);
  }

  // ---------------------------------------------------------------- requesting calls

  async requestConfirmation(appointmentId: string, requestedBy: string, trigger: 'manual' | 'scheduler' | 'retry' = 'manual', attempt = 1, at?: Date) {
    this.assertProvider();
    const apt = await this.appointmentById(appointmentId);
    if (!apt) throw new NotFoundException(`Appointment ${appointmentId} not found`);
    if (apt.status !== 'Scheduled') throw new BadRequestException(`Only scheduled appointments can be confirmed; this one is ${apt.status}.`);
    if (appointmentStart(apt.date, apt.time) <= clinicNow()) throw new BadRequestException('This appointment time has already passed.');
    const phone = await this.callablePhone(apt.uhid, apt.phone, apt.patientName);

    const { cfg, common } = await this.context();
    // Two alternatives, in case the patient cannot come. The appointment holds its own slot, so it is never offered.
    const doctor = await this.slots.doctorFor({ doctorId: apt.doctorId, uhid: apt.uhid });
    const alternatives = await this.slots.findFree(cfg, clinicNow(), 2, undefined, doctor ? String(doctor._id) : undefined);
    return this.schedule(
      {
        purpose: 'confirmation',
        uhid: apt.uhid,
        patientName: apt.patientName,
        phone,
        appointmentId: String(apt._id),
        offeredSlots: alternatives,
        trigger,
        requestedBy,
        attempt,
        variables: {
          ...common,
          patient_name: apt.patientName,
          call_recipient: apt.age < 18 ? 'guardian' : 'patient',
          appointment_day: spokenDay(parseIsoDay(apt.date)),
          appointment_time: apt.time,
          appointment_type: apt.type || 'consultation',
          alt_slot_1: alternatives[0]?.label ?? '',
          alt_slot_2: alternatives[1]?.label ?? '',
        },
      },
      cfg,
      at,
    );
  }

  async requestBooking(request: BookingRequest, requestedBy: string, trigger: 'manual' | 'retry' | 'callback' = 'manual', attempt = 1, at?: Date) {
    this.assertProvider();
    const patient = await this.patients.findOne({ uhid: request.uhid }).exec();
    if (!patient) throw new NotFoundException(`Patient ${request.uhid} not found`);
    const phone = await this.callablePhone(patient.uhid, patient.phone, patient.name);

    let followUp: FollowUpDocument | null = null;
    if (request.followUpId) {
      followUp = isValidObjectId(request.followUpId) ? await this.followUps.findById(request.followUpId).exec() : null;
      if (!followUp || followUp.uhid !== patient.uhid) throw new BadRequestException('That follow-up does not belong to this patient.');
    }

    const { cfg, common } = await this.context();
    const doctor = await this.slots.doctorFor({ uhid: patient.uhid });
    const offered = await this.slots.findFree(cfg, this.searchStart(request.fromDate), 2, undefined, doctor ? String(doctor._id) : undefined);
    if (!offered.length) throw new ConflictException('No free slots in the next 14 days to offer. Open more sessions in the call agent settings.');

    const visitReason = request.visitReason?.trim() || followUp?.followUpType || 'a follow-up visit';
    return this.schedule(
      {
        purpose: 'booking',
        uhid: patient.uhid,
        patientName: patient.name,
        phone,
        followUpId: request.followUpId,
        visitReason,
        appointmentType: request.appointmentType?.trim() || 'Follow-up',
        offeredSlots: offered,
        trigger,
        requestedBy,
        attempt,
        variables: {
          ...common,
          patient_name: patient.name,
          call_recipient: patient.age < 18 ? 'guardian' : 'patient',
          visit_reason: visitReason,
          slot_1: offered[0].label,
          slot_2: offered[1]?.label ?? '',
        },
      },
      cfg,
      at,
    );
  }

  /**
   * Patient Support's check-up call. The checks of every call apply (do-not-call, a
   * usable number, the test safety list); a check-up with a live call gets that call back.
   */
  async requestCheckup(input: CheckupRequest, requestedBy: string): Promise<AgentCallDocument> {
    this.assertProvider();
    if (!input.checkupId) throw new BadRequestException('A check-up call needs its check-up.');
    const patient = await this.patients.findOne({ uhid: input.patientUhid }).exec();
    if (!patient) throw new NotFoundException(`Patient ${input.patientUhid} not found`);
    const phone = await this.callablePhone(patient.uhid, patient.phone, patient.name);
    const live = await this.calls.findOne({ activeKey: `checkup:${input.checkupId}` }).exec();
    if (live) return live;

    const { cfg } = await this.context();
    return this.schedule(
      {
        purpose: 'checkup',
        uhid: patient.uhid,
        patientName: patient.name,
        phone,
        checkupId: input.checkupId,
        trigger: 'scheduler',
        requestedBy,
        variables: {
          patient_name: patient.name,
          question_list: input.group === 'cardiac' ? 'cardiac' : 'general',
          language: input.language === 'ta' ? 'ta' : 'en',
        },
      },
      cfg,
    );
  }

  /** Withdraws a call that has not been placed yet. */
  async cancel(id: string, by: string) {
    const call = await this.findOne(id);
    const canceled = await this.calls
      .findOneAndUpdate(
        { _id: call._id, status: 'scheduled' },
        { $set: { status: 'canceled', endedAt: new Date(), actionTaken: `Canceled by ${by} before it was placed.` }, $unset: { activeKey: 1 } },
        { new: true },
      )
      .exec();
    if (!canceled) throw new ConflictException(`Only scheduled calls can be canceled; this one is ${call.status}.`);
    return canceled;
  }

  /** Lets the agent call a patient again (after the number was fixed, or with their agreement). */
  async allowCalls(uhid: string) {
    const res = await this.patients.updateOne({ uhid }, { doNotCall: false, doNotCallReason: '' }).exec();
    if (!res.matchedCount) throw new NotFoundException(`Patient ${uhid} not found`);
    return { uhid, doNotCall: false };
  }

  // ---------------------------------------------------------------- scheduler

  /**
   * One scheduler pass: gives up on calls whose result never arrived, queues automatic
   * confirmation calls, and places due calls inside the calling window.
   */
  async runDue() {
    const report = { expired: 0, queued: 0, placed: 0, withinCallingHours: false };
    if (this.provider.name === 'none' || this.running) return report;
    this.running = true;
    try {
      const { cfg } = await this.context();
      report.expired = await this.expireStale();
      report.withinCallingHours = withinCallingHours(new Date(), cfg);
      if (cfg.autoConfirm) report.queued = await this.queueDueConfirmations(cfg);
      if (report.withinCallingHours) report.placed = await this.dialDue();
      return report;
    } finally {
      this.running = false;
    }
  }

  private async queueDueConfirmations(cfg: CallAgentSettings): Promise<number> {
    const now = clinicNow();
    const horizon = new Date(now.getTime() + cfg.confirmHoursBefore * 3_600_000);
    const candidates = await this.appointments
      .find({ status: 'Scheduled', confirmation: { $in: [null, 'Unconfirmed'] }, date: { $gte: isoDate(now), $lte: isoDate(horizon) } })
      .exec();

    let queued = 0;
    for (const apt of candidates) {
      const start = appointmentStart(apt.date, apt.time);
      if (start > horizon || start.getTime() - now.getTime() < MIN_CONFIRM_LEAD_MS) continue;
      // Once per appointment: retries are scheduled by the outcome, and staff decide after that.
      if (await this.calls.exists({ purpose: 'confirmation', appointmentId: String(apt._id) })) continue;
      try {
        await this.requestConfirmation(String(apt._id), 'Scheduler', 'scheduler');
        queued++;
      } catch (err) {
        this.logger.debug(`No automatic confirmation for appointment ${apt._id}: ${(err as Error).message}`);
      }
    }
    return queued;
  }

  private async dialDue(): Promise<number> {
    let placed = 0;
    while (placed < DIAL_BATCH) {
      const call = await this.calls
        .findOneAndUpdate(
          { status: 'scheduled', scheduledFor: { $lte: new Date() } },
          { $set: { status: 'calling', startedAt: new Date() } },
          { new: true, sort: { scheduledFor: 1 } },
        )
        .exec();
      if (!call) break;
      await this.place(call);
      placed++;
    }
    return placed;
  }

  private async expireStale(): Promise<number> {
    const stale = await this.calls.find({ status: 'calling', startedAt: { $lt: new Date(Date.now() - RESULT_TIMEOUT_MS) } }).exec();
    for (const call of stale) {
      const ended = await this.finish(
        call,
        {
          status: 'failed',
          outcome: 'failed',
          error: 'No result arrived from the call provider within 30 minutes.',
          actionTaken: "Nothing was changed. Check the provider's call log for this call.",
        },
        'calling',
      );
      // Patient Support counts it as a try nobody answered, so the check-up is not left waiting.
      if (call.purpose === 'checkup' && ended.status === 'failed') await this.toPatientSupport(ended, { outcome: 'failed' });
    }
    return stale.length;
  }

  // ---------------------------------------------------------------- placing calls

  private async schedule(data: Partial<AgentCall>, cfg: CallAgentSettings, at?: Date): Promise<AgentCallDocument> {
    const now = new Date();
    const scheduledFor = nextCallingTime(at && at > now ? at : now, cfg);
    const _id = new Types.ObjectId();
    let call: AgentCallDocument;
    try {
      call = await this.calls.create({
        ...data,
        _id,
        variables: { ...data.variables, call_ref: String(_id) },
        status: 'scheduled',
        scheduledFor,
        provider: this.provider.name,
        activeKey: `${data.purpose}:${data.purpose === 'confirmation' ? data.appointmentId : data.purpose === 'checkup' ? data.checkupId : data.uhid}`,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException(
          data.purpose === 'confirmation'
            ? 'A confirmation call for this appointment is already scheduled or in progress.'
            : data.purpose === 'checkup'
              ? `A check-up call to ${data.patientName} is already scheduled or in progress.`
              : `A booking call to ${data.patientName} is already scheduled or in progress.`,
        );
      }
      throw err;
    }
    if (scheduledFor > now) return call;
    const claimed = await this.calls
      .findOneAndUpdate({ _id, status: 'scheduled' }, { $set: { status: 'calling', startedAt: new Date() } }, { new: true })
      .exec();
    return claimed ? this.place(claimed) : call;
  }

  /** Places a call already claimed (status 'calling'). Never retried automatically on error. */
  private async place(call: AgentCallDocument): Promise<AgentCallDocument> {
    try {
      const { cfg } = await this.context();
      const skip = await this.reasonNotToCall(call, cfg);
      if (skip) return this.finish(call, { status: 'canceled', actionTaken: skip });
      if (!withinCallingHours(new Date(), cfg)) {
        // The window closed between scheduling and dialling.
        const next = nextCallingTime(new Date(), cfg);
        await this.calls.updateOne({ _id: call._id }, { $set: { status: 'scheduled', scheduledFor: next }, $unset: { startedAt: 1 } }).exec();
        return (await this.calls.findById(call._id).exec())!;
      }
      const refused = this.refuseToDial(call);
      if (refused) return this.finish(call, { status: 'failed', outcome: 'failed', error: refused, actionTaken: 'Call not placed; nothing was changed.' });

      const { providerCallId } = await this.provider.startCall({
        callId: String(call._id),
        purpose: call.purpose as CallPurpose,
        toNumber: call.phone,
        variables: call.variables,
        simulation: cfg.simulatedResponse,
      });
      await this.calls.updateOne({ _id: call._id }, { providerCallId }).exec();
      this.logger.log(`${call.purpose} call ${call._id} placed to ${maskPhone(call.phone)} via ${this.provider.name}`);
      return (await this.calls.findById(call._id).exec())!;
    } catch (err) {
      const known = err instanceof ProviderError || err instanceof HttpException;
      if (!known) this.logger.error(`Placing call ${call._id} failed: ${(err as Error).message}`);
      return this.finish(call, {
        status: 'failed',
        outcome: 'failed',
        error: known ? (err as Error).message : 'The call could not be placed.',
        actionTaken: 'Call not placed; nothing was changed. Retry once the problem is fixed.',
      });
    }
  }

  /** Last checks before the phone rings: the call's provider, and the test safety list. */
  private refuseToDial(call: AgentCallDocument): string | null {
    if (call.provider !== this.provider.name) return 'Queued under another call provider';
    if (!this.onSafetyList(call.phone)) return 'Not on the test safety list';
    return null;
  }

  /** Re-checks at dial time, since hours may have passed since the call was scheduled. */
  private async reasonNotToCall(call: AgentCallDocument, cfg: CallAgentSettings): Promise<string | null> {
    const patient = await this.patients.findOne({ uhid: call.uhid }, { doNotCall: 1, doNotCallReason: 1 }).lean().exec();
    if (patient?.doNotCall) return `Not called: ${patient.doNotCallReason || 'the patient is marked do-not-call'}.`;
    // A check-up offers no appointment slots.
    if (call.purpose === 'checkup') return null;

    let changed = false;
    let aptDoctorId: string | undefined;
    if (call.purpose === 'confirmation') {
      const apt = await this.appointmentById(call.appointmentId);
      if (!apt) return 'Not called: the appointment no longer exists.';
      if (apt.status !== 'Scheduled') return `Not called: the appointment is now ${apt.status}.`;
      if (call.trigger !== 'manual' && apt.confirmation === 'Confirmed') return 'Not called: the appointment was confirmed meanwhile.';
      if (appointmentStart(apt.date, apt.time) <= clinicNow()) return 'Not called: the appointment time has passed.';
      aptDoctorId = apt.doctorId;
      // The appointment may have moved since the call was queued (an inbound call, the front desk).
      const day = spokenDay(parseIsoDay(apt.date));
      if (call.variables.appointment_day !== day || call.variables.appointment_time !== apt.time) {
        call.variables = { ...call.variables, appointment_day: day, appointment_time: apt.time };
        changed = true;
      }
    }

    // Offered slots can be booked by someone else before the call goes out.
    const doctor = await this.slots.doctorFor({ doctorId: aptDoctorId, uhid: call.uhid });
    const doctorId = doctor ? String(doctor._id) : undefined;
    const free = await Promise.all(call.offeredSlots.map((s) => this.slots.isFree(cfg, s.date, s.time, undefined, doctorId)));
    if (!free.every(Boolean) || !call.offeredSlots.length) {
      const firstDay = call.offeredSlots[0]?.date;
      const fresh = await this.slots.findFree(cfg, this.searchStart(firstDay), 2, undefined, doctorId);
      if (call.purpose === 'booking' && !fresh.length) return 'Not called: no free slots left to offer.';
      const [a, b] = call.purpose === 'confirmation' ? ['alt_slot_1', 'alt_slot_2'] : ['slot_1', 'slot_2'];
      call.offeredSlots = fresh;
      call.variables = { ...call.variables, [a]: fresh[0]?.label ?? '', [b]: fresh[1]?.label ?? '' };
      changed = true;
    }
    if (changed) await call.save();
    return null;
  }

  private async finish(call: AgentCallDocument, patch: Partial<AgentCall>, onlyIfStatus?: string) {
    const filter: Record<string, unknown> = { _id: call._id };
    if (onlyIfStatus) filter.status = onlyIfStatus;
    const updated = await this.calls
      .findOneAndUpdate(filter, { $set: { endedAt: new Date(), ...patch }, $unset: { activeKey: 1 } }, { new: true })
      .exec();
    return updated ?? call;
  }

  // ---------------------------------------------------------------- results

  /**
   * Applies a finished call's result once (a webhook delivered twice is ignored),
   * then schedules the retry or callback it calls for.
   */
  async recordResult(result: CallResult): Promise<{ matched: boolean; duplicate?: boolean }> {
    const providerCallId = result.providerCallId != null ? String(result.providerCallId) : undefined;
    let found = result.callId && isValidObjectId(result.callId) ? await this.calls.findById(result.callId).exec() : null;
    if (!found && providerCallId) found = await this.calls.findOne({ providerCallId, provider: this.provider.name }).exec();
    if (!found) {
      // Patients phoning the hospital: we did not place the call, so it is logged now.
      const inboundAgentId = this.config.get<string>('callAgent.snapserve.inboundAgentId');
      if (result.direction === 'inbound' || (inboundAgentId && result.agentId === inboundAgentId)) return this.inbound.recordCall(result, this.provider.name);
      this.logger.warn(`Result for an unknown call (${providerCallId ?? result.callId ?? 'no id'}) ignored`);
      return { matched: false };
    }

    const call = await this.calls
      .findOneAndUpdate(
        { _id: found._id, status: { $in: LIVE_STATUSES } },
        {
          $set: {
            status: result.outcome === 'failed' && !result.unrecognised ? 'failed' : 'completed',
            outcome: result.outcome,
            summary: result.summary,
            transcript: result.transcript,
            durationSec: result.durationSec,
            endedAt: result.endedAt ?? new Date(),
            result: { chosenSlot: result.chosenSlot, callbackAt: result.callbackAt, notes: result.notes },
            ...(providerCallId && { providerCallId }),
            ...(result.raw && { rawResult: result.raw }),
          },
          $unset: { activeKey: 1 },
        },
        { new: true },
      )
      .exec();
    if (!call) return { matched: true, duplicate: true };
    if (call.purpose === 'checkup') return this.checkupResult(call, result);

    const { cfg } = await this.context();
    let effect: Effect;
    try {
      effect = call.purpose === 'confirmation' ? await this.applyConfirmation(call, result, cfg) : await this.applyBooking(call, result, cfg);
    } catch (err) {
      this.logger.error(`Applying the result of call ${call._id} failed: ${(err as Error).message}`);
      effect = { outcome: result.outcome, action: `Outcome recorded, but updating the records failed: ${(err as Error).message}` };
    }

    let action = effect.action;
    const next = effect.retryAt ?? effect.callbackAt;
    if (next) {
      try {
        if (call.purpose === 'confirmation') {
          await this.requestConfirmation(call.appointmentId!, 'Retry', 'retry', call.attempt + 1, next);
        } else {
          const request = { uhid: call.uhid, visitReason: call.visitReason, appointmentType: call.appointmentType, followUpId: call.followUpId };
          // A callback counts as an attempt too, so it shares the retry cap.
          await this.requestBooking(request, effect.retryAt ? 'Retry' : 'Callback', effect.retryAt ? 'retry' : 'callback', call.attempt + 1, next);
        }
      } catch (err) {
        action += ` The next call could not be scheduled: ${(err as Error).message}`;
      }
    }

    await this.calls
      .updateOne({ _id: call._id }, { outcome: effect.outcome, actionTaken: action, ...(effect.appointmentId && { appointmentId: effect.appointmentId }) })
      .exec();
    this.logger.log(`${call.purpose} call ${call._id} ended: ${effect.outcome}`);
    return { matched: true };
  }

  /**
   * A check-up call's result, answered or not, goes to Patient Support, which decides
   * what follows (no booking and no retry here). Do-not-call and a wrong number still
   * mark the patient, as on every call.
   */
  private async checkupResult(call: AgentCallDocument, r: CallResult): Promise<{ matched: boolean }> {
    let marked = '';
    if (r.outcome === 'wrong_number' || r.outcome === 'do_not_call') {
      try {
        marked = `${(await this.otherOutcome(call, r)).action} `;
      } catch (err) {
        this.logger.error(`Marking the patient of check-up call ${call._id} do-not-call failed: ${(err as Error).message}`);
      }
    }
    const passed = await this.toPatientSupport(call, r);
    await this.calls.updateOne({ _id: call._id }, { outcome: r.outcome, actionTaken: marked + passed }).exec();
    this.logger.log(`checkup call ${call._id} ended: ${r.outcome}`);
    return { matched: true };
  }

  /** Hands a check-up call's end to Patient Support; returns what happened, for the call log. Never throws. */
  private async toPatientSupport(call: AgentCallDocument, r: Pick<CallResult, 'outcome' | 'answers' | 'rating' | 'notes'>): Promise<string> {
    const handler = this.bridge?.handlers.checkupResult;
    if (!handler) {
      this.logger.warn(`Check-up call ${call._id} ended (${r.outcome}), but Patient Support is not listening.`);
      return 'Patient Support is not running, so the result is only logged here.';
    }
    try {
      await handler(call.checkupId ?? '', { outcome: r.outcome, answers: r.answers ?? {}, rating: r.rating, notes: r.notes, agentCallId: String(call._id) });
      return 'Result passed to Patient Support.';
    } catch (err) {
      this.logger.error(`Patient Support could not take the result of check-up call ${call._id}: ${(err as Error).message}`);
      return `Patient Support could not take the result: ${(err as Error).message}`;
    }
  }

  private async applyConfirmation(call: AgentCallDocument, r: CallResult, cfg: CallAgentSettings): Promise<Effect> {
    const apt = await this.appointmentById(call.appointmentId);
    if (!apt) return { outcome: r.outcome, action: 'The appointment no longer exists; nothing was changed.' };
    const booked = slotWhen(apt.date, apt.time);

    switch (r.outcome) {
      case 'confirmed':
        apt.confirmation = 'Confirmed';
        apt.confirmedAt = new Date();
        await apt.save();
        return { outcome: 'confirmed', action: `Appointment on ${booked} confirmed.` };

      case 'rescheduled': {
        const slot = r.chosenSlot ? call.offeredSlots[r.chosenSlot - 1] : undefined;
        if (!slot) return this.rescheduleRequest(call, apt, r);
        const doctor = await this.slots.doctorFor({ doctorId: apt.doctorId, uhid: apt.uhid });
        if (!(await this.slots.isFree(cfg, slot.date, slot.time, String(apt._id), doctor ? String(doctor._id) : undefined))) return this.rescheduleRequest(call, apt, r, slot.label);
        const moved = slotWhen(slot.date, slot.time);
        const old = { id: String(apt._id), doctorId: apt.doctorId, date: apt.date, time: apt.time };
        apt.date = slot.date;
        apt.time = slot.time;
        const newFields = this.slots.fieldsFor(doctor, slot.date, slot.time);
        await this.slots.releaseStale(newFields);
        Object.assign(apt, newFields);
        apt.confirmation = 'Confirmed';
        apt.confirmedAt = new Date();
        apt.notes = [apt.notes, `Moved by AI call from ${booked}.`].filter(Boolean).join('\n');
        try {
          await apt.save();
        } catch (e) {
          if (!isDuplicateKey(e)) throw e;
          // Someone took the slot between the check and the save: ask the front desk, with the appointment as it was.
          const current = await this.appointmentById(call.appointmentId);
          return current ? this.rescheduleRequest(call, current, r, slot.label) : { outcome: 'slot_taken', action: `${slot.label} was booked meanwhile.` };
        }
        await this.freed(old);
        await this.patients.updateOne({ uhid: apt.uhid }, { nextAppointment: moved.replace(',', '') }).exec();
        return { outcome: 'rescheduled', action: `Moved from ${booked} to ${moved} and confirmed.` };
      }

      case 'reschedule_requested':
        return this.rescheduleRequest(call, apt, r);

      case 'cancelled':
        apt.status = 'Canceled';
        apt.confirmation = 'Cancelled by Patient';
        apt.set('slotKey', undefined); // releases the slot for the database guard
        await apt.save();
        await this.freed({ id: String(apt._id), doctorId: apt.doctorId, date: apt.date, time: apt.time });
        await this.alert(call, {
          title: `Appointment cancelled by ${call.patientName}`,
          subtitle: [`The ${booked} slot is free again.`, r.notes].filter(Boolean).join(' '),
          priority: 'Low',
          category: 'Follow-up',
        });
        return { outcome: 'cancelled', action: `Appointment on ${booked} cancelled; the slot is free again.` };

      case 'no_answer':
      case 'busy':
      // Someone else answered and the patient was not available: try again later.
      case 'callback':
        return this.unanswered(call, r.outcome, cfg, apt);

      default:
        return this.otherOutcome(call, r, apt);
    }
  }

  private async rescheduleRequest(call: AgentCallDocument, apt: AppointmentDocument, r: CallResult, takenSlot?: string): Promise<Effect> {
    apt.confirmation = 'Reschedule Requested';
    await apt.save();
    await this.waitlisted(apt);
    const booked = slotWhen(apt.date, apt.time);
    await this.alert(call, {
      title: `Reschedule request: ${call.patientName}`,
      subtitle: [takenSlot ? `Chose ${takenSlot}, but it was booked meanwhile.` : `Cannot come on ${booked}.`, r.notes, 'Call to agree a new time.']
        .filter(Boolean)
        .join(' '),
      priority: 'Medium',
      category: 'Follow-up',
    });
    return {
      outcome: takenSlot ? 'slot_taken' : 'reschedule_requested',
      action: takenSlot ? `${takenSlot} was booked meanwhile; front desk asked to call.` : 'Front desk asked to call and agree a new time.',
    };
  }

  private async applyBooking(call: AgentCallDocument, r: CallResult, cfg: CallAgentSettings): Promise<Effect> {
    switch (r.outcome) {
      case 'booked': {
        const slot = r.chosenSlot ? call.offeredSlots[r.chosenSlot - 1] : undefined;
        if (!slot) return this.otherOutcome(call, { ...r, unrecognised: 'booked, without a chosen slot' });
        const doctor = await this.slots.doctorFor({ uhid: call.uhid });
        const slotTaken = async (): Promise<Effect> => {
          await this.alert(call, {
            title: `Rebook ${call.patientName}`,
            subtitle: `Chose ${slot.label}, but it was booked meanwhile. Call to offer another time (${call.visitReason}).`,
            priority: 'Medium',
            category: 'Follow-up',
          });
          return { outcome: 'slot_taken', action: `${slot.label} was booked meanwhile; front desk asked to call.` };
        };
        if (!(await this.slots.isFree(cfg, slot.date, slot.time, undefined, doctor ? String(doctor._id) : undefined))) return slotTaken();
        const patient = await this.patients.findOne({ uhid: call.uhid }).exec();
        if (!patient) return { outcome: 'booked', action: 'The patient record no longer exists; nothing was booked.' };

        let apt: AppointmentDocument;
        try {
          await this.slots.releaseStale(this.slots.fieldsFor(doctor, slot.date, slot.time));
          apt = await this.appointments.create({
            uhid: patient.uhid,
            patientName: patient.name,
            age: patient.age,
            gender: patient.gender,
            avatar: patient.avatar,
            phone: patient.phone,
            date: slot.date,
            time: slot.time,
            type: call.appointmentType || 'Follow-up',
            condition: call.visitReason,
            status: 'Scheduled',
            confirmation: 'Confirmed',
            confirmedAt: new Date(),
            bookedVia: 'AI call',
            notes: r.notes ? `AI call: ${r.notes}` : '',
            tags: patient.conditions ?? [],
            ...this.slots.fieldsFor(doctor, slot.date, slot.time),
          });
        } catch (e) {
          if (isDuplicateKey(e)) return slotTaken(); // the database guard: someone took it between the check and the save
          throw e;
        }
        const booked = slotWhen(slot.date, slot.time);
        await this.patients.updateOne({ uhid: patient.uhid }, { nextAppointment: booked.replace(',', '') }).exec();
        if (call.followUpId) {
          await this.followUps
            .updateOne({ _id: call.followUpId }, { followUpDate: displayDate(parseIsoDay(slot.date)), followUpTime: slot.time, status: 'Scheduled' })
            .exec();
        }
        return { outcome: 'booked', action: `Booked ${booked} (${apt.type}).`, appointmentId: String(apt._id) };
      }

      case 'callback': {
        // Counted like an unanswered attempt: a relative who always answers must not mean a call every day.
        if (call.attempt >= cfg.maxAttempts) {
          await this.alert(call, {
            title: `Call ${call.patientName} to book`,
            subtitle: `Asked for a call back on ${call.attempt} AI call${call.attempt > 1 ? 's' : ''} to book: ${call.visitReason}. Please call ${call.phone}.`,
            priority: 'Medium',
            category: 'Follow-up',
          });
          return { outcome: 'callback', action: `Asked for a call back after ${call.attempt} attempt${call.attempt > 1 ? 's' : ''}; front desk asked to call.` };
        }
        const wanted = r.callbackAt && r.callbackAt.getTime() > Date.now() && r.callbackAt.getTime() < Date.now() + 14 * DAY_MS ? r.callbackAt : undefined;
        const at = nextCallingTime(wanted ?? new Date(Date.now() + DAY_MS), cfg);
        return { outcome: 'callback', action: `Call back scheduled for ${when(at)} (attempt ${call.attempt + 1} of ${cfg.maxAttempts}).`, callbackAt: at };
      }

      case 'declined':
        return { outcome: 'declined', action: 'Does not want an appointment now; no further calls.' };

      case 'no_answer':
      case 'busy':
        return this.unanswered(call, r.outcome, cfg);

      default:
        return this.otherOutcome(call, r);
    }
  }

  /** Retries with growing gaps; after the last attempt (or too close to the appointment) a person takes over. */
  private async unanswered(call: AgentCallDocument, outcome: CallOutcome, cfg: CallAgentSettings, apt?: AppointmentDocument): Promise<Effect> {
    const retryAt = nextCallingTime(new Date(Date.now() + cfg.retryMinutes * call.attempt * 60_000), cfg);
    const deadline = apt ? appointmentStart(apt.date, apt.time).getTime() + clinicOffsetMs() - MIN_CONFIRM_LEAD_MS : Infinity;
    const missed = outcome === 'busy' ? 'Line busy' : outcome === 'callback' ? 'Patient not available' : 'No answer';

    if (call.attempt < cfg.maxAttempts && retryAt.getTime() <= deadline) {
      return { outcome, action: `${missed}. Attempt ${call.attempt + 1} of ${cfg.maxAttempts} at ${when(retryAt)}.`, retryAt };
    }
    if (apt) {
      apt.confirmation = 'Unreachable';
      await apt.save();
    }
    await this.alert(call, {
      title: `Could not reach ${call.patientName}`,
      subtitle: `${call.attempt} AI call attempt${call.attempt > 1 ? 's' : ''} unanswered ${apt ? `for the ${slotWhen(apt.date, apt.time)} appointment` : `to book: ${call.visitReason}`}. Please call ${call.phone}.`,
      priority: 'Medium',
      category: 'Follow-up',
    });
    return { outcome, action: `${missed} after ${call.attempt} attempt${call.attempt > 1 ? 's' : ''}; front desk asked to call.` };
  }

  /** Outcomes handled the same way for both purposes. */
  private async otherOutcome(call: AgentCallDocument, r: CallResult, apt?: AppointmentDocument): Promise<Effect> {
    switch (r.outcome) {
      case 'wrong_number':
      case 'do_not_call': {
        const wrong = r.outcome === 'wrong_number';
        const reason = wrong ? `Wrong number on file (${call.phone})` : 'Asked not to be called';
        await this.patients.updateOne({ uhid: call.uhid }, { doNotCall: true, doNotCallReason: `${reason}, ${displayDate(clinicNow())}` }).exec();
        if (apt) {
          apt.confirmation = 'Unreachable';
          await apt.save();
        }
        await this.alert(call, {
          title: wrong ? `Wrong phone number: ${call.patientName}` : `${call.patientName} asked not to be called`,
          subtitle: wrong
            ? 'Correct the number in the patient record, then allow AI calls again from the AI Call Agent screen.'
            : 'The AI agent will not call this patient again. Use another way to reach them.',
          priority: 'Medium',
          category: 'Follow-up',
        });
        return { outcome: r.outcome, action: 'Patient marked do-not-call; the agent will not call again.' };
      }

      case 'escalated':
        await this.alert(call, {
          title: `Call back urgently: ${call.patientName}`,
          subtitle: r.notes || r.summary || 'Asked to speak to a staff member during an AI call.',
          priority: 'High',
          category: 'Critical',
        });
        return { outcome: 'escalated', action: 'Care team alerted (high priority) to call back.' };

      default:
        await this.alert(call, {
          title: `Review AI call to ${call.patientName}`,
          subtitle: r.unrecognised
            ? `The call ended with "${r.unrecognised}", which the system cannot act on. Read the transcript and follow up.`
            : 'The call result could not be applied automatically. Read the transcript and follow up.',
          priority: 'Low',
          category: 'System',
        });
        return { outcome: 'failed', action: 'Result not understood; staff asked to review the transcript.' };
    }
  }

  // ---------------------------------------------------------------- helpers

  private assertProvider() {
    if (this.provider.name === 'none') {
      throw new ServiceUnavailableException('The AI call agent is not configured. Set CALL_PROVIDER on the server (see the backend README).');
    }
  }

  private async appointmentById(id?: string): Promise<AppointmentDocument | null> {
    return id && isValidObjectId(id) ? this.appointments.findById(id).exec() : null;
  }

  /** The patient's current number in E.164, refusing do-not-call patients and unusable numbers. */
  private async callablePhone(uhid: string, fallbackPhone: string, name: string): Promise<string> {
    const patient = await this.patients.findOne({ uhid }, { phone: 1, doNotCall: 1, doNotCallReason: 1 }).lean().exec();
    if (patient?.doNotCall) {
      throw new ConflictException(`${name} cannot be called by the AI agent: ${patient.doNotCallReason || 'marked do-not-call'}.`);
    }
    const raw = patient?.phone || fallbackPhone;
    const phone = toE164India(raw);
    if (!phone) throw new UnprocessableEntityException(`${name} has no valid phone number on record ("${raw || 'none'}").`);
    if (!this.onSafetyList(phone)) {
      throw new ConflictException(`Test mode: only the numbers in CALL_ALLOWED_NUMBERS can be called, and ${name}'s number is not one of them.`);
    }
    return phone;
  }

  /** Testing real calls: when CALL_ALLOWED_NUMBERS is set, only those numbers ring, never a demo record's. */
  private onSafetyList(phone: string): boolean {
    const allowed = (this.config.get<string[]>('callAgent.allowedNumbers') ?? []).map((n) => toE164India(n)).filter(Boolean);
    return !allowed.length || allowed.includes(toE164India(phone));
  }

  /** A reschedule request goes on the waitlist (once; a repeat finds the open item). A failure never stops the call result. */
  private async waitlisted(apt: AppointmentDocument) {
    if (!this.waitlist) return;
    try {
      await this.waitlist.add({ kind: 'appointment', refId: String(apt._id), reason: 'patient-request', priority: 'routine' });
    } catch (e) {
      this.logger.warn(`Could not put the reschedule request on the waitlist: ${(e as Error).message}`);
    }
  }

  /** A slot the call agent's cancel or reschedule gave up goes to the same listeners as a front-desk cancel (the waitlist). */
  private async freed(slot: { id: string; doctorId?: string; date: string; time: string }) {
    if (!slot.doctorId || !this.scheduling) return;
    await this.scheduling.slotFreed({ id: slot.id, doctorId: slot.doctorId, date: slot.date, time: slot.time });
  }

  /** Slot search start: `from` (YYYY-MM-DD) when it is later than now. */
  private searchStart(from?: string): Date {
    const now = clinicNow();
    if (!from) return now;
    const day = parseIsoDay(from);
    return day > now ? day : now;
  }

  private alert(call: AgentCallDocument, task: { title: string; subtitle: string; priority: 'High' | 'Medium' | 'Low'; category: string }) {
    return this.tasks.create({
      ...task,
      patientName: call.patientName,
      uhid: call.uhid,
      type: 'Patient Communication',
      dueDateTime: displayDateTime(clinicNow()),
      status: 'Pending',
    });
  }

  private async context() {
    const s = (await this.settings.getSettings()) as unknown as Record<string, any>;
    const cfg = resolveCallAgentSettings(s.callAgent);
    const hospital = s.hospital ?? {};
    const common = {
      agent_name: cfg.agentName,
      hospital_name: hospital.name || 'the hospital',
      hospital_phone: hospital.phone || 'the hospital front desk',
      hospital_address: String(hospital.address ?? '').replace(/\s*\n\s*/g, ' '),
      doctor_name: s.profile?.name || 'the doctor',
      language_style: cfg.language,
    };
    return { cfg, common };
  }
}
