import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { clinicNow, displayDateTime, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { AgentCall, AgentCallDocument } from '../calls/schemas/agent-call.schema';
import { CallsService } from '../calls/calls.service';
import { toE164India } from '../calls/phone';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { atClinicTime } from '../discharge/discharge-time';
import { DischargePlan, DischargePlanDocument } from '../discharge/schemas/discharge-plan.schema';
import { ErVisitsService } from '../er/er-visits.service';
import { FollowUpDocument, FollowUpItem } from '../follow-ups/schemas/follow-up.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { SchedulingRosterService } from '../scheduling/scheduling-roster.service';
import { SupportBridge, CheckupCallResult } from '../support-bridge/support-bridge';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { CheckupCall, CheckupCallDocument } from './schemas/checkup-call.schema';
import { CARE_GROUPS, CareGroup, CheckupQuestion, questionsFor, SUPPORT_ACTOR } from './support-catalogue';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { SupportFeedbackService } from './support-feedback.service';
import { SUP_READ, SUP_REVIEW } from './support-roles';
import { SupportSettingsService } from './support-settings.service';
import { SupportTextsService } from './support-texts.service';
import { SupportUpdatesService } from './support-updates.service';

const MIN = 60_000;
const COUNTER_KEY = 'support-checkup';
const DUPLICATE_KEY = 11000;
const MAX_TRIES = 3;
const FORBIDDEN = 'Only a doctor, a nurse, the front desk or an admin can do this.';
const REVIEW_FORBIDDEN = 'Only a doctor or an admin can review a check-up.';
const DONE = 'This check-up call is already recorded.';
const WAITING = 'A check-up call can only be recorded once it is due.';
const REPAIR_GRACE_MINUTES = 2;
const ON_CALL = 'The agent is on this call now.';
const DIED = 'This patient has died.';
const OPEN_STATES = ['due', 'calling'];
const TERMINAL_CALL = ['completed', 'failed', 'canceled'];
const QUESTION_FALLBACK = 'The patient has a question for the doctor (see the call transcript).';

export type CheckupTab = 'to-do' | 'needs-doctor' | 'sent-to-er' | 'done' | 'not-reached' | 'coming-up';
export const CHECKUP_TABS: CheckupTab[] = ['to-do', 'needs-doctor', 'sent-to-er', 'done', 'not-reached', 'coming-up'];

export interface CheckupRow {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  case: string | null;
  kind: string;
  group: string;
  state: string;
  result: string | null;
  skipReason: string | null;
  tries: number;
  leftAt: Date;
  dueDay: string;
  nextTryAt: Date | null;
  at: Date | null;
  reviewed: boolean;
}

export interface CheckupDetail extends CheckupRow {
  language: 'en' | 'ta';
  questions: {
    key: string;
    en: string;
    ta: string;
    text: string;
    choices: { key: string; en: string; ta: string; text: string; level: string; short: string | null }[];
  }[];
  followUp: { date: string; time: string; doctor: string } | null;
  emergencyLine: { text: string; en: string };
  answers: Record<string, string>;
  questionText: string;
  worrying: string[];
  emergency: string[];
  rating: number | null;
  comment: string;
  byName: string;
  agentCall: string | null;
  review: { at: Date; byName: string; note: string } | null;
}

export interface SubmitCheckupInput {
  group: CareGroup;
  answers: Record<string, string>;
  questionText?: string;
  rating?: number;
  comment?: string;
  /** Set only by the agent's handler: the call this result came from. */
  agentCallId?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const alertLink = (id: unknown, kind: 'er' | 'doctor') => `support-checkup:${String(id)}:${kind}`;
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const hhmmMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const resultWord = (r: string) => (r === 'fine' ? 'fine' : r === 'needs-doctor' ? 'needs doctor' : r === 'sent-to-er' ? 'sent to the ER' : 'not reached');

/**
 * The day-2 check-up call after a patient goes home: made when the stay ends, due the next clinic days, called by the
 * agent or done by a person. An emergency answer always reaches the ER and a doctor. Times: `leftAt`, `dueDay` and
 * `nextTryAt` are on the clinic clock; `at`, `reviewedAt` and the doctor clock's due time are real time.
 */
@Injectable()
export class SupportCheckupsService implements OnModuleInit {
  private readonly logger = new Logger(SupportCheckupsService.name);

  /** The real clock and the clinic clock; a spec replaces them. */
  clock: () => Date = () => new Date();
  clinic: () => Date = () => clinicNow();
  /** Check-ups examined per repair pass; a spec lowers it. */
  repairBatch = 200;

  constructor(
    private readonly registration: SupportRegistration,
    private readonly messages: MessagesService,
    private readonly facts: SupportFactsService,
    private readonly feedback: SupportFeedbackService,
    private readonly texts: SupportTextsService,
    private readonly updates: SupportUpdatesService,
    private readonly settings: SupportSettingsService,
    private readonly escalations: EscalationsService,
    private readonly calls: CallsService,
    private readonly bridge: SupportBridge,
    private readonly erVisits: ErVisitsService,
    private readonly roster: SchedulingRosterService,
    @InjectModel(CheckupCall.name) private readonly checkups: Model<CheckupCallDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    @InjectModel(AgentCall.name) private readonly agentCalls: Model<AgentCallDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>
  ) {}

  onModuleInit(): void {
    this.registration.onWake('discharge.completed', (id) => this.fromDischarge(id));
    this.bridge.register({ checkupResult: (id, r) => this.fromCall(id, r) });
  }

  // ---- Making check-ups ----

  /** Makes the check-up a stored discharge.completed message calls for. Safe to run twice; never throws. */
  async fromDischarge(messageId: string): Promise<void> {
    try {
      const msg = await this.messages.get(messageId);
      if (!msg || msg.type !== 'discharge.completed') return;
      const p = msg.payload;
      if (p.kind !== 'home' && p.kind !== 'against-advice') return;
      const planId = str(p.planId);
      const plan: any = isValidObjectId(planId) ? await this.plans.findById(planId).lean().exec() : null;
      if (!plan) return;
      const left = new Date(p.leftAt as string);
      await this.scheduleFor(String(plan.patient), isNaN(left.getTime()) ? (plan.completedAt ?? this.clinic()) : left, p.kind, `discharge:${planId}`, {
        planId,
        caseId: msg.case ?? (plan.case ? String(plan.case) : null)
      });
    } catch (e) {
      this.logger.error(`Check-up for message ${messageId} failed: ${(e as Error).message}`);
    }
  }

  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: COUNTER_KEY }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `CU-${String(c.last).padStart(4, '0')}`;
  }

  /** One check-up per source key; a repeat returns the first. The seed uses this directly. */
  async scheduleFor(
    patientId: string,
    leftAt: Date,
    kind: 'home' | 'against-advice',
    sourceKey: string,
    refs: { planId?: string; caseId?: string | null } = {}
  ): Promise<CheckupCallDocument> {
    const existing = await this.checkups.findOne({ sourceKey }).exec();
    if (existing) return existing;
    const patient = isValidObjectId(patientId) ? await this.patients.findById(patientId).exec() : null;
    if (!patient) throw new NotFoundException('Patient not found.');
    const caseId = refs.caseId && isValidObjectId(refs.caseId) ? refs.caseId : null;
    const group = await this.facts.careGroup(patientId, caseId);
    const cfg = await this.settings.get();
    const due = new Date(leftAt.getTime());
    due.setDate(due.getDate() + cfg.checkupDay);
    try {
      return await this.checkups.create({
        number: await this.nextNumber(),
        sourceKey,
        patient: patient._id,
        patientUhid: patient.uhid,
        patientName: patient.name,
        ...(caseId ? { case: new Types.ObjectId(caseId) } : {}),
        ...(refs.planId && isValidObjectId(refs.planId) ? { plan: new Types.ObjectId(refs.planId) } : {}),
        kind,
        leftAt,
        dueDay: isoDate(due),
        group,
        state: 'scheduled'
      });
    } catch (e) {
      if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
      const again = await this.checkups.findOne({ sourceKey }).exec();
      if (again) return again;
      throw e;
    }
  }

  // ---- The minute pass ----

  /** Scheduled check-ups whose day and time have come become due; a death, do-not-contact or no phone skips them. Returns how many became due. */
  async makeDue(now: Date = this.clinic()): Promise<number> {
    const cfg = await this.settings.get();
    const today = isoDate(now);
    const rows = await this.checkups
      .find({ state: 'scheduled', dueDay: { $lte: today } })
      .sort({ dueDay: 1, _id: 1 })
      .exec();
    let made = 0;
    for (const c of rows) {
      try {
        if (now.getTime() < atClinicTime(c.dueDay, cfg.checkupFrom).getTime()) continue;
        if (await this.facts.isDeceased(String(c.patient))) {
          if (await this.skip(c._id, 'deceased')) await this.updates.cancelForDeath(String(c.patient));
          continue;
        }
        const patient: any = await this.patients.findById(c.patient).lean().exec();
        if (patient?.doNotCall === true) {
          await this.skip(c._id, 'do-not-contact');
          continue;
        }
        if (!patient || !toE164India(patient.phone)) {
          await this.skip(c._id, 'no-phone');
          continue;
        }
        const r = await this.checkups.updateOne({ _id: c._id, state: 'scheduled' }, { $set: { state: 'due' } }).exec();
        if (r.modifiedCount) made++;
      } catch (e) {
        this.logger.warn(`${c.number}: not made due: ${(e as Error).message}`);
      }
    }
    await this.skipDueClosed();
    return made;
  }

  /** A check-up already due is still skipped when the patient dies or is marked do-not-contact. Its deferred call, if any, is canceled. */
  private async skipDueClosed(): Promise<void> {
    const rows = await this.checkups.find({ state: 'due' }).sort({ _id: 1 }).exec();
    for (const c of rows) {
      try {
        if (await this.facts.isDeceased(String(c.patient))) {
          if (await this.skip(c._id, 'deceased', ['due'])) {
            await this.cancelDeferred(c.agentCall);
            await this.updates.cancelForDeath(String(c.patient));
          }
          continue;
        }
        const patient: any = await this.patients.findById(c.patient).select('doNotCall').lean().exec();
        if (patient?.doNotCall === true && (await this.skip(c._id, 'do-not-contact', ['due']))) await this.cancelDeferred(c.agentCall);
      } catch (e) {
        this.logger.warn(`${c.number}: not re-checked: ${(e as Error).message}`);
      }
    }
  }

  /** A linked call that has not been placed yet would still dial later: cancel it. A failure is logged. */
  private async cancelDeferred(callId: unknown): Promise<void> {
    if (!callId) return;
    try {
      const call: any = await this.agentCalls.findById(callId).select('status').lean().exec();
      if (call?.status === 'scheduled') await this.calls.cancel(String(callId), SUPPORT_ACTOR.name);
    } catch (e) {
      this.logger.warn(`Deferred check-up call ${String(callId)} not canceled: ${(e as Error).message}`);
    }
  }

  private async skip(id: unknown, reason: 'deceased' | 'do-not-contact' | 'no-phone', states: string[] = ['scheduled', 'due', 'calling']): Promise<boolean> {
    const r = await this.checkups.updateOne({ _id: id, state: { $in: states } }, { $set: { state: 'skipped', skipReason: reason } }).exec();
    return r.modifiedCount > 0;
  }

  /**
   * Places the calls for due check-ups, inside the check-up hours, for patients who agreed to calls, when automated calls
   * work. A refused dial leaves the check-up in To do (and waits an hour before trying again). Returns how many calls were placed.
   */
  async dialDue(now: Date = this.clinic()): Promise<number> {
    if (!this.calls.canCheckupCall()) return 0;
    const cfg = await this.settings.get();
    const t = minutesOf(now);
    if (t < hhmmMinutes(cfg.checkupFrom) || t >= hhmmMinutes(cfg.checkupTo)) return 0;
    const rows = await this.checkups
      .find({ state: 'due', agentCall: null, $or: [{ nextTryAt: null }, { nextTryAt: { $lte: now } }] })
      .sort({ dueDay: 1, _id: 1 })
      .exec();
    let placed = 0;
    for (const c of rows) {
      try {
        if (await this.facts.isDeceased(String(c.patient))) {
          if (await this.skip(c._id, 'deceased', ['due'])) await this.updates.cancelForDeath(String(c.patient));
          continue;
        }
        const contact = await this.facts.contactOf(String(c.patient));
        if (contact.consent.calls !== true) continue;
        let call: AgentCallDocument;
        try {
          call = await this.calls.requestCheckup(
            { checkupId: String(c._id), patientUhid: c.patientUhid, group: c.group as CareGroup, language: contact.preferredLanguage },
            SUPPORT_ACTOR.name
          );
        } catch (e) {
          this.logger.warn(`${c.number}: call not placed: ${(e as Error).message}`);
          await this.holdOff(c._id, now);
          continue;
        }
        if (call.status === 'failed' || call.status === 'canceled') {
          await this.holdOff(c._id, now);
        } else if (call.status === 'scheduled') {
          // It dials at the next calling time; the check-up stays due until the call ends.
          await this.checkups.updateOne({ _id: c._id, state: 'due', agentCall: null }, { $set: { agentCall: call._id } }).exec();
        } else {
          // A simulated call may already have been recorded by now: only a check-up still due moves on.
          const r = await this.checkups
            .updateOne(
              { _id: c._id, state: 'due', agentCall: null },
              { $set: { state: 'calling', agentCall: call._id, ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}) } }
            )
            .exec();
          if (r.modifiedCount) placed++;
        }
      } catch (e) {
        this.logger.warn(`${c.number}: dial failed: ${(e as Error).message}`);
      }
    }
    return placed;
  }

  /** `nextTryAt` doubles as "do not dial before" for a refused dial, so the pass does not retry every minute. */
  private async holdOff(id: unknown, now: Date): Promise<void> {
    await this.checkups.updateOne({ _id: id, state: 'due' }, { $set: { nextTryAt: new Date(now.getTime() + 60 * MIN) } }).exec();
  }

  /**
   * Turns calls that ended without their result being recorded into what they were (R18): an answered call goes back to
   * To do for a person (its call stays linked, to read the transcript); any other ending is a no-answer try.
   */
  async syncCalls(): Promise<number> {
    const rows = await this.checkups
      .find({ $or: [{ state: 'calling' }, { state: 'due', agentCall: { $exists: true, $ne: null } }] })
      .sort({ _id: 1 })
      .exec();
    let changed = 0;
    for (const c of rows) {
      try {
        if (!c.agentCall) continue;
        const call: any = await this.agentCalls.findById(c.agentCall).lean().exec();
        if (!call || !TERMINAL_CALL.includes(call.status)) continue;
        if (call.outcome === 'enquiry') {
          if (c.state === 'calling') {
            const r = await this.checkups.updateOne({ _id: c._id, state: 'calling', agentCall: c.agentCall }, { $set: { state: 'due' } }).exec();
            if (r.modifiedCount) changed++;
          }
        } else if (await this.registerTry(c, c.agentCall)) {
          changed++;
        }
      } catch (e) {
        this.logger.warn(`${c.number}: call not synced: ${(e as Error).message}`);
      }
    }
    return changed;
  }

  // ---- Recording a result ----

  private async load(id: string): Promise<CheckupCallDocument> {
    const c = isValidObjectId(id) ? await this.checkups.findById(id).exec() : null;
    if (!c) throw new NotFoundException('Check-up call not found.');
    return c;
  }

  private checkActor(actor: Actor): void {
    if (!actor || (actor !== SUPPORT_ACTOR && !SUP_READ.includes(actor.role))) throw new ForbiddenException(FORBIDDEN);
  }

  /** Checks the answers against the group's questions. The form stops at the first emergency answer. */
  private readAnswers(
    group: CareGroup,
    given: Record<string, string>,
    input: SubmitCheckupInput
  ): { answers: Record<string, string>; worrying: string[]; emergency: string[]; rating?: number; questionText?: string } {
    if (!given || typeof given !== 'object' || Array.isArray(given)) throw new BadRequestException('Answer the check-up questions.');
    const questions = questionsFor(group);
    const known = new Set(questions.map((q) => q.key));
    for (const k of Object.keys(given)) if (!known.has(k)) throw new BadRequestException('One of the answers is not a question on this list.');
    const answers: Record<string, string> = {};
    const worrying: string[] = [];
    const emergency: string[] = [];
    let rating: number | undefined;
    let questionText: string | undefined;
    let stopped = false;
    for (const q of questions) {
      if (q.key === 'rating') {
        const raw = input.rating ?? (given.rating !== undefined && given.rating !== '' ? Number(given.rating) : undefined);
        if (raw !== undefined) {
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 5) throw new BadRequestException('Give a rating from 1 to 5.');
          rating = raw;
          answers.rating = String(raw);
        }
        continue;
      }
      if (stopped) continue;
      const key = given[q.key];
      const choice = q.choices.find((c) => c.key === key);
      if (!choice) throw new BadRequestException(`Choose an answer for: ${q.en}`);
      answers[q.key] = choice.key;
      if (choice.level === 'worrying') worrying.push(q.key);
      if (choice.level === 'emergency') {
        emergency.push(q.key);
        stopped = true;
      }
      if (q.key === 'question' && choice.key === 'yes') {
        const text = typeof input.questionText === 'string' ? input.questionText.trim() : '';
        if (!text || text.length > 500) throw new BadRequestException("Write the patient's question (up to 500 letters).");
        questionText = text;
      }
    }
    return { answers, worrying, emergency, rating, questionText };
  }

  private shortOf(group: CareGroup, key: string, answers: Record<string, string>): string {
    const q = questionsFor(group).find((x: CheckupQuestion) => x.key === key);
    return q?.choices.find((c) => c.key === answers[key])?.short ?? key;
  }

  /** Records the answers of a check-up call: a person's or the agent's. */
  async submit(actor: Actor, id: string, input: SubmitCheckupInput): Promise<CheckupDetail> {
    this.checkActor(actor);
    const c = await this.load(id);
    if (c.state === 'completed' || c.state === 'not-reached' || c.state === 'skipped') throw new ConflictException(DONE);
    if (!OPEN_STATES.includes(c.state)) throw new ConflictException(WAITING);
    if (c.state === 'calling' && actor !== SUPPORT_ACTOR) throw new ConflictException(ON_CALL);
    if (await this.facts.isDeceased(String(c.patient))) throw new ConflictException(DIED);
    // A person may switch the question list before starting (design 4.5), so a missed cardiac patient still gets the
    // blood-thinner question; the agent keeps the list its call was placed with.
    if (input?.group !== undefined && !(CARE_GROUPS as readonly string[]).includes(input.group))
      throw new BadRequestException('Choose the general or the cardiac list.');
    if (actor === SUPPORT_ACTOR && input?.group && input.group !== c.group) throw new BadRequestException('This check-up uses the other list of questions.');
    const group = (actor !== SUPPORT_ACTOR && input?.group ? input.group : c.group) as CareGroup;
    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
    if (comment.length > 500) throw new BadRequestException('Keep the comment under 500 characters.');
    const read = this.readAnswers(group, input.answers, input);
    const result = read.emergency.length ? 'sent-to-er' : read.worrying.length ? 'needs-doctor' : 'fine';
    const at = this.clock();

    const claimed = await this.checkups
      .findOneAndUpdate(
        { _id: c._id, state: { $in: OPEN_STATES } },
        {
          $set: {
            state: 'completed',
            group,
            result,
            answers: read.answers,
            worrying: read.worrying,
            emergency: read.emergency,
            byName: actor.name,
            at,
            ...(actor === SUPPORT_ACTOR && input.agentCallId ? { resultCall: input.agentCallId } : {}),
            ...(read.questionText ? { questionText: read.questionText } : {}),
            ...(read.rating ? { rating: read.rating } : {}),
            ...(comment ? { comment } : {})
          }
        },
        { new: true }
      )
      .exec();
    if (!claimed) throw new ConflictException(DONE);
    await this.cancelDeferred(c.agentCall);

    // The emergency and doctor paths first: nothing below may hold them up. Each step logs its own failure.
    if (result === 'sent-to-er') await this.sendToEr(claimed);
    else if (result === 'needs-doctor') await this.needsDoctor(claimed, at);
    await this.announceDone(claimed, result);
    if (read.rating) {
      try {
        await this.feedback.record(actor, {
          patientId: String(c.patient),
          checkupId: String(c._id),
          source: 'call',
          overall: read.rating,
          ...(comment ? { comment } : {})
        });
      } catch (e) {
        this.logger.warn(`${c.number}: rating not recorded: ${(e as Error).message}`);
      }
    }
    const said =
      result === 'sent-to-er'
        ? read.emergency.map((k) => this.shortOf(group, k, read.answers)).join('; ')
        : result === 'needs-doctor'
          ? read.worrying.map((k) => this.shortOf(group, k, read.answers)).join('; ')
          : 'No problems reported.';
    await this.facts.timeline(claimed, `Check-up call ${claimed.number}: ${resultWord(result)}`, said);
    return this.detail(id);
  }

  private async holderNames(): Promise<string> {
    try {
      const names = (await this.escalations.holders('duty-doctor')).names;
      return names.length ? names.join(', ') : 'Admins';
    } catch (e) {
      this.logger.warn(`Duty doctor not read: ${(e as Error).message}`);
      return 'Admins';
    }
  }

  private async upsertAlert(link: string, c: CheckupCallDocument, title: string, subtitle: string): Promise<boolean> {
    try {
      const fields = {
        title,
        subtitle,
        patientName: c.patientName,
        uhid: c.patientUhid,
        type: 'Patient Communication',
        category: 'Critical',
        priority: 'High',
        status: 'Pending',
        dueDateTime: displayDateTime(this.clinic())
      };
      try {
        await this.alerts.updateOne({ link }, { $set: fields }, { upsert: true }).exec();
      } catch (e) {
        if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
        await this.alerts.updateOne({ link }, { $set: fields }).exec();
      }
      return true;
    } catch (e) {
      this.logger.error(`${c.number}: alert ${link} not written: ${(e as Error).message}`);
      return false;
    }
  }

  private async mark(id: unknown, what: string): Promise<void> {
    await this.checkups.updateOne({ _id: id }, { $addToSet: { announced: what } }).exec();
  }

  /** An emergency answer: the alert and an expected card in the ER. No doctor clock: the ER takes over. Each step is marked when done, so a repair can redo only what is missing. */
  private async sendToEr(c: CheckupCallDocument): Promise<void> {
    await this.erAlert(c);
    await this.erCard(c);
  }

  private async erAlert(c: CheckupCallDocument): Promise<boolean> {
    let subtitle = `Duty doctor: ${await this.holderNames()}`;
    if (c.group === 'cardiac') {
      try {
        const cardiologist = await this.roster.onCall('cardiology', this.clinic());
        if (cardiologist?.name) subtitle += `; Cardiology on call: ${cardiologist.name}`;
      } catch (e) {
        this.logger.warn(`${c.number}: cardiology on call not read: ${(e as Error).message}`);
      }
    }
    if (!(await this.upsertAlert(alertLink(c._id, 'er'), c, `Check-up ${c.number} sent to the ER`, subtitle))) return false;
    await this.mark(c._id, 'er-alert');
    return true;
  }

  private async erCard(c: CheckupCallDocument): Promise<boolean> {
    try {
      const patient: any = await this.patients.findById(c.patient).lean().exec();
      const letter = patient?.gender === 'Male' ? 'M' : patient?.gender === 'Female' ? 'F' : patient?.gender ? 'O' : '';
      const ageSex = `${typeof patient?.age === 'number' ? patient.age : ''} ${letter}`.trim() || 'Unknown';
      const short = c.emergency.length ? this.shortOf(c.group as CareGroup, c.emergency[0], c.answers) : 'Emergency';
      await this.erVisits.addExpected(SUPPORT_ACTOR, {
        complaint: `Check-up ${c.number}: ${short}`.slice(0, 200),
        ageSex: ageSex.slice(0, 40),
        mode: 'walk-in',
        etaMinutes: 30,
        patientId: String(c.patient)
      });
      await this.mark(c._id, 'er-card');
      return true;
    } catch (e) {
      this.logger.error(`${c.number}: ER expected card not made: ${(e as Error).message}`);
      return false;
    }
  }

  /** A worrying answer: the alert and the 60-minute doctor clock (started by the support.checkup-worrying message). */
  private async needsDoctor(c: CheckupCallDocument, at: Date): Promise<void> {
    await this.doctorAlert(c);
    await this.announceWorrying(c, at);
  }

  private async doctorAlert(c: CheckupCallDocument): Promise<boolean> {
    const labels = c.worrying.map((k) => this.shortOf(c.group as CareGroup, k, c.answers)).join('; ');
    if (!(await this.upsertAlert(alertLink(c._id, 'doctor'), c, `Check-up ${c.number} needs a doctor`, `${labels} · Duty doctor: ${await this.holderNames()}`)))
      return false;
    await this.mark(c._id, 'doctor-alert');
    return true;
  }

  private async announceWorrying(c: CheckupCallDocument, at: Date): Promise<boolean> {
    const sent = await this.registration.send(
      'support.checkup-worrying',
      c.case ? String(c.case) : null,
      { checkupId: String(c._id), number: c.number, dueAt: new Date(at.getTime() + 60 * MIN) },
      `${c.number}: check-up needs a doctor`,
      c.patientName
    );
    if (sent) await this.mark(c._id, 'worrying');
    return sent;
  }

  private async announceDone(c: CheckupCallDocument, outcome: string): Promise<boolean> {
    const sent = await this.registration.send(
      'support.checkup-done',
      c.case ? String(c.case) : null,
      { checkupId: String(c._id), number: c.number, outcome },
      `${c.number}: check-up done (${outcome})`,
      c.patientName
    );
    if (sent) await this.mark(c._id, 'done');
    return sent;
  }

  /** No answer: one more try tomorrow, or after 3 tries not reached. A person or the agent records it. */
  async noAnswer(actor: Actor, id: string): Promise<CheckupDetail> {
    this.checkActor(actor);
    const c = await this.load(id);
    if (!OPEN_STATES.includes(c.state)) throw new ConflictException(c.state === 'scheduled' ? WAITING : DONE);
    if (c.state === 'calling') throw new ConflictException(ON_CALL);
    if (await this.facts.isDeceased(String(c.patient))) throw new ConflictException(DIED);
    if (!(await this.registerTry(c, c.agentCall ?? null))) throw new ConflictException(DONE);
    return this.detail(id);
  }

  /**
   * Counts a no-answer try once (it only applies while the check-up is still open and on the same try). `onlyCall` limits it
   * to a check-up still pointing at that call. Returns false when someone got there first.
   */
  private async registerTry(c: CheckupCallDocument, onlyCall: unknown): Promise<boolean> {
    const tries = c.tries + 1;
    const filter: Record<string, unknown> = { _id: c._id, tries: c.tries, state: { $in: OPEN_STATES } };
    if (onlyCall !== undefined) filter.agentCall = onlyCall;
    if (tries >= MAX_TRIES) {
      const done = await this.checkups
        .findOneAndUpdate(
          filter,
          { $set: { state: 'not-reached', tries, at: this.clock() }, $unset: { nextTryAt: 1, agentCall: 1, providerCallId: 1 } },
          { new: true }
        )
        .exec();
      if (!done) return false;
      await this.cancelDeferred(c.agentCall);
      await this.announceDone(done, 'not-reached');
      await this.facts.timeline(done, `Check-up call ${done.number}: not reached`, `Tried ${tries} times.`);
      return true;
    }
    const day = parseIsoDay(isoDate(this.clinic()));
    day.setDate(day.getDate() + 1);
    const dueDay = isoDate(day);
    const cfg = await this.settings.get();
    const r = await this.checkups
      .updateOne(filter, {
        $set: { state: 'scheduled', tries, dueDay, nextTryAt: atClinicTime(dueDay, cfg.checkupFrom) },
        $unset: { agentCall: 1, providerCallId: 1 }
      })
      .exec();
    if (r.modifiedCount > 0) await this.cancelDeferred(c.agentCall);
    return r.modifiedCount > 0;
  }

  // ---- The call agent's result ----

  /** The bridge's handler: every check-up call outcome reaches here. A throw keeps the answers on the call and raises a review alert. */
  private async fromCall(checkupId: string, r: CheckupCallResult): Promise<void> {
    const c = isValidObjectId(checkupId) ? await this.checkups.findById(checkupId).exec() : null;
    if (!c) return;
    // Only a true duplicate is ignored quietly: this very call's result was already recorded by the agent.
    if (c.state === 'completed' && c.resultCall && c.resultCall === r.agentCallId) return;
    const open = OPEN_STATES.includes(c.state);
    const mine = !c.agentCall || String(c.agentCall) === r.agentCallId;
    if (r.outcome === 'enquiry' && (!open || !mine)) {
      // An answered call must never vanish: throwing keeps the answers on the call and raises Calls' review alert.
      throw new ConflictException('This check-up was closed or is linked to another call, so the answers were not recorded.');
    }
    if (!open || !mine) return;
    if (r.outcome === 'wrong_number') {
      await this.skip(c._id, 'no-phone', OPEN_STATES);
    } else if (r.outcome === 'do_not_call') {
      await this.skip(c._id, 'do-not-contact', OPEN_STATES);
    } else if (r.outcome === 'enquiry') {
      if (isValidObjectId(r.agentCallId)) {
        await this.checkups.updateOne({ _id: c._id, state: { $in: OPEN_STATES } }, { $set: { agentCall: new Types.ObjectId(r.agentCallId) } }).exec();
      }
      const answers = r.answers ?? {};
      const questionText = answers.question === 'yes' ? (r.notes?.trim() || QUESTION_FALLBACK).slice(0, 500) : undefined;
      await this.submit(SUPPORT_ACTOR, checkupId, {
        group: c.group as CareGroup,
        answers,
        rating: r.rating,
        agentCallId: r.agentCallId,
        ...(questionText ? { questionText } : {})
      });
    } else {
      await this.registerTry(c, c.agentCall ?? null);
    }
  }

  // ---- Repair ----

  /**
   * Redoes what a crash or a failed write left undone, once: the ER alert and the ER card of a sent-to-er check-up (the card
   * only when it was never made, since adding one is not idempotent), the doctor alert of a needs-doctor one, and any lost
   * announcement. Returns how many things were redone.
   */
  async repairEffects(): Promise<number> {
    let fixed = 0;
    const settled = new Date(this.clock().getTime() - REPAIR_GRACE_MINUTES * MIN);
    const rows = await this.checkups
      .find({
        state: { $in: ['completed', 'not-reached'] },
        at: { $lte: settled },
        $or: [
          { announced: { $nin: ['done'] } },
          { result: 'sent-to-er', reviewedAt: null, $or: [{ announced: { $nin: ['er-alert'] } }, { announced: { $nin: ['er-card'] } }] },
          { result: 'needs-doctor', reviewedAt: null, $or: [{ announced: { $nin: ['doctor-alert'] } }, { announced: { $nin: ['worrying'] } }] },
          { reviewedAt: { $ne: null }, announced: { $nin: ['reviewed'] } }
        ]
      })
      .sort({ _id: 1 })
      .limit(this.repairBatch)
      .exec();
    for (const c of rows) {
      try {
        const has = (k: string) => c.announced.includes(k);
        const reviewed = !!c.reviewedAt;
        const ok = (done: boolean) => {
          if (done) fixed++;
        };
        if (!reviewed && c.result === 'sent-to-er') {
          if (!has('er-alert')) ok(await this.erAlert(c));
          if (!has('er-card')) ok(await this.erCard(c));
        }
        if (!reviewed && c.result === 'needs-doctor') {
          if (!has('doctor-alert')) ok(await this.doctorAlert(c));
          if (!has('worrying')) ok(await this.announceWorrying(c, c.at ?? this.clock()));
        }
        if (!has('done')) ok(await this.announceDone(c, c.state === 'not-reached' ? 'not-reached' : (c.result ?? 'fine')));
        if (reviewed && !has('reviewed')) {
          const sent = await this.registration.send(
            'support.checkup-reviewed',
            c.case ? String(c.case) : null,
            { checkupId: String(c._id), number: c.number },
            `${c.number}: check-up reviewed`,
            c.patientName
          );
          if (sent) {
            await this.mark(c._id, 'reviewed');
            fixed++;
          }
        }
      } catch (e) {
        this.logger.warn(`${c.number}: effects not repaired: ${(e as Error).message}`);
      }
    }
    return fixed;
  }

  // ---- Review ----

  /** A doctor or admin marks a Needs doctor or Sent to ER check-up reviewed. It closes the alert and the doctor clock. */
  async review(actor: Actor, id: string, note: string): Promise<CheckupDetail> {
    if (!actor || !SUP_REVIEW.includes(actor.role)) throw new ForbiddenException(REVIEW_FORBIDDEN);
    const text = typeof note === 'string' ? note.trim() : '';
    if (!text || text.length > 500) throw new BadRequestException('Write what was done (1 to 500 letters).');
    const c = await this.load(id);
    if (c.result !== 'needs-doctor' && c.result !== 'sent-to-er')
      throw new ConflictException('Only a check-up that needs a doctor or was sent to the ER is reviewed.');
    const claimed = await this.checkups
      .findOneAndUpdate(
        { _id: c._id, result: c.result, reviewedAt: null },
        { $set: { reviewedAt: this.clock(), reviewedByName: actor.name, reviewNote: text } },
        { new: true }
      )
      .exec();
    if (!claimed) throw new ConflictException('This check-up was already reviewed.');
    try {
      await this.alerts
        .updateOne({ link: alertLink(c._id, c.result === 'sent-to-er' ? 'er' : 'doctor'), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } })
        .exec();
    } catch (e) {
      this.logger.warn(`${c.number}: alert not closed: ${(e as Error).message}`);
    }
    const sent = await this.registration.send(
      'support.checkup-reviewed',
      claimed.case ? String(claimed.case) : null,
      { checkupId: String(claimed._id), number: claimed.number },
      `${claimed.number}: check-up reviewed`,
      claimed.patientName
    );
    if (sent) await this.checkups.updateOne({ _id: claimed._id }, { $addToSet: { announced: 'reviewed' } }).exec();
    return this.detail(id);
  }

  // ---- Reading ----

  private row(c: any): CheckupRow {
    return {
      id: String(c._id),
      number: c.number,
      patientId: String(c.patient),
      patientUhid: c.patientUhid,
      patientName: c.patientName,
      case: c.case ? String(c.case) : null,
      kind: c.kind,
      group: c.group,
      state: c.state,
      result: c.result ?? null,
      skipReason: c.skipReason ?? null,
      tries: c.tries ?? 0,
      leftAt: c.leftAt,
      dueDay: c.dueDay,
      nextTryAt: c.nextTryAt ?? null,
      at: c.at ?? null,
      reviewed: !!c.reviewedAt
    };
  }

  async list(tab: CheckupTab): Promise<CheckupRow[]> {
    let filter: Record<string, unknown>;
    let sort: Record<string, 1 | -1> = { at: -1, _id: -1 };
    switch (tab) {
      case 'to-do':
        filter = { state: { $in: OPEN_STATES } };
        sort = { dueDay: 1, _id: 1 };
        break;
      case 'needs-doctor':
        filter = { state: 'completed', result: 'needs-doctor', reviewedAt: null };
        break;
      case 'sent-to-er':
        filter = { state: 'completed', result: 'sent-to-er', reviewedAt: null };
        break;
      case 'done':
        filter = { state: 'completed', $or: [{ result: 'fine' }, { reviewedAt: { $ne: null } }] };
        break;
      case 'not-reached':
        filter = { state: 'not-reached' };
        break;
      case 'coming-up':
        filter = { state: 'scheduled' };
        sort = { dueDay: 1, _id: 1 };
        break;
      default:
        throw new BadRequestException('Unknown check-up list.');
    }
    const rows = await this.checkups.find(filter).sort(sort).limit(200).lean().exec();
    return rows.map((r) => this.row(r));
  }

  async detail(id: string): Promise<CheckupDetail> {
    const c: any = isValidObjectId(id) ? await this.checkups.findById(id).lean().exec() : null;
    if (!c) throw new NotFoundException('Check-up call not found.');
    const patient: any = await this.patients.findById(c.patient).select('preferredLanguage').lean().exec();
    const language: 'en' | 'ta' = patient?.preferredLanguage === 'ta' ? 'ta' : 'en';
    const text = (en: string, ta: string) => (language === 'ta' && ta?.trim() ? ta : en);
    const f: any = await this.followUps.findOne({ uhid: c.patientUhid, status: 'Scheduled' }).sort({ createdAt: -1, _id: -1 }).lean().exec();
    return {
      ...this.row(c),
      language,
      questions: questionsFor(c.group).map((q) => ({
        key: q.key,
        en: q.en,
        ta: q.ta || q.en,
        text: text(q.en, q.ta),
        choices: q.choices.map((x) => ({ key: x.key, en: x.en, ta: x.ta || x.en, text: text(x.en, x.ta), level: x.level, short: x.short ?? null }))
      })),
      followUp: f ? { date: f.followUpDate, time: f.followUpTime ?? '', doctor: f.assignedTo ?? '' } : null,
      emergencyLine: { text: await this.texts.emergencyLine(language), en: await this.texts.emergencyLine('en') },
      answers: c.answers ?? {},
      questionText: c.questionText ?? '',
      worrying: c.worrying ?? [],
      emergency: c.emergency ?? [],
      rating: c.rating ?? null,
      comment: c.comment ?? '',
      byName: c.byName ?? '',
      agentCall: c.agentCall ? String(c.agentCall) : null,
      review: c.reviewedAt ? { at: c.reviewedAt, byName: c.reviewedByName ?? '', note: c.reviewNote ?? '' } : null
    };
  }
}
