import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Subscription } from 'rxjs';
import { clinicNow, displayDate, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { Ward, WardDocument } from '../beds/schemas/ward.schema';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { Case, CaseDocument } from '../coordinator/schemas/case.schema';
import { PatientEvents } from '../patients/patient-events';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DIS_ORDER } from './discharge-roles';
import { DischargeSettingsService } from './discharge-settings.service';
import { atClinicTime } from './discharge-time';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;
const NOTE_MAX = 300;
const PLAN_COMPLETE = 'This discharge is complete: its target date can no longer change.';
/** A target day a doctor sets is due at this clinic time. */
const TARGET_TIME = '11:00';
const REMINDER_RULE = 'discharge-morning-reminder';
/** A plan younger than this is never dropped as an orphan: the Bed Agent may still be placing its stay. */
const ORPHAN_GRACE_MS = 10 * 60_000;

type Msg = { case: string | null; payload: Record<string, unknown> };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** "29 Sep 2026" for "2026-09-29". */
const dayText = (day: string) => displayDate(parseIsoDay(day));
const reminderLink = (planId: unknown) => `discharge-plan:${String(planId)}:reminder`;
/** Names the bed, never the patient. */
const reminderTitle = (bedLabel: string) => `Discharge due today, no order yet: ${bedLabel}`;
const reminderSubtitle = (doctor: string) =>
  doctor ? `For ${doctor} · give the discharge order, or move the target date` : 'Give the discharge order, or move the target date';

/**
 * One discharge plan per real admission. It opens on bed.assigned (or in the one-minute catch-up), follows the stay to
 * a new bed, holds the target date a doctor or an admin can move, and raises one morning reminder on the target day
 * while there is no order. Plans are on the clinic clock; `announcedAt` is real time. Message handlers never throw.
 */
@Injectable()
export class DischargePlansService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DischargePlansService.name);
  private patientSub?: Subscription;
  /** Admissions whose bed or ward could not be read: warned about once per process, as the catch-up retries every minute. */
  private readonly warnedNoBed = new Set<string>();

  /** The clinic clock (R7); a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly registration: DischargeRegistration,
    private readonly messages: MessagesService,
    private readonly rules: RulesService,
    private readonly settings: DischargeSettingsService,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(Bed.name) private readonly beds: Model<BedDocument>,
    @InjectModel(Ward.name) private readonly wards: Model<WardDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    /** Absent only where the service is built by hand (seeds, specs). */
    private readonly patientEvents?: PatientEvents,
  ) {
    registration.wake.set('bed.assigned', (id) => this.run('bed.assigned', id, (m) => this.onAssigned(m)));
    registration.wake.set('bed.transferred', (id) =>
      this.run('bed.transferred', id, async (m) => {
        const admissionId = await this.admissionIdOf(m);
        if (!admissionId) return;
        // Opens a plan the agent missed, or gives a caseless one the message's case, before it follows the move.
        await this.ensurePlan(admissionId, m.case);
        await this.onTransferred(admissionId);
      }),
    );
    registration.wake.set('bed.discharged', (id) => this.run('bed.discharged', id, (m) => this.onDischarged(m)));
  }

  onModuleInit(): void {
    // R15: an ER placeholder ("Unknown male, ER-0012") admitted and named later must not keep the old name on its plan.
    this.patientSub = this.patientEvents?.detailsChanged$.subscribe((change) => void this.refreshPatient(change.id));
  }

  onModuleDestroy(): void {
    this.patientSub?.unsubscribe();
  }

  /**
   * The admission's plan, opened when it has none: due at admission + expected stay, with `discharge.planned` sent
   * once, by the call that created it. Two calls at once make one plan (the unique index). `caseId` is the message's
   * case; without one, the case that holds the admission, if any. A plan that has no case yet takes it then. Null for
   * a sample, a missing or an ended admission; for one still being placed (its bed does not point back to it yet);
   * and for one whose bed or ward can't be read (a data error, retried by the catch-up).
   */
  async ensurePlan(admissionId: string, caseId: string | null): Promise<DischargePlanDocument | null> {
    return (await this.open(admissionId, caseId))?.plan ?? null;
  }

  private async open(admissionId: string, caseId: string | null): Promise<{ plan: DischargePlanDocument; created: boolean } | null> {
    if (!isValidObjectId(admissionId)) return null;
    const id = new Types.ObjectId(admissionId);
    const existing = await this.plans.findOne({ admission: id }).exec();
    if (existing) return { plan: await this.withCase(existing, admissionId, caseId), created: false };
    const admission = await this.admissions.findById(id).lean().exec();
    if (!admission || admission.sample || admission.status !== 'active') return null;
    const place = await this.placeOf(admission.bed);
    if (!place) {
      if (!this.warnedNoBed.has(admissionId)) {
        this.warnedNoBed.add(admissionId);
        this.logger.warn(`Admission ${admissionId}: its bed or ward was not found, so it has no discharge plan yet (retried)`);
      }
      return null;
    }
    // BedsService writes the admission before it takes the bed, and deletes the admission when the bed is lost (the
    // hold ran out, the bed was just taken, a twin-room clash). Until the bed points back to it the stay is still
    // being placed: no plan yet, and its own bed.assigned plans it.
    if (place.holds !== admissionId) return null;
    const [patient, caseRef] = await Promise.all([
      this.patients.findById(admission.patient).select('name uhid').lean<{ name?: string; uhid?: string }>().exec(),
      this.caseOf(admissionId, caseId),
    ]);
    const targetAt = new Date(new Date(admission.admittedAt).getTime() + admission.expectedStayDays * DAY_MS);
    let plan: DischargePlanDocument;
    try {
      plan = await this.plans.create({
        admission: id,
        ...(caseRef ? { case: caseRef } : {}),
        patient: admission.patient,
        // The patient record rather than the admission's copy: an ER placeholder may have been named since (R15).
        patientUhid: patient?.uhid || admission.patientUhid,
        patientName: patient?.name || admission.patientName,
        bedLabel: place.bedLabel,
        wardName: place.wardName,
        doctor: admission.doctor ?? '',
        targetDay: isoDate(targetAt),
        targetAt,
        state: 'planned',
      });
    } catch (e) {
      if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
      // Another delivery opened it a moment ago, and that call announces it.
      const raced = await this.plans.findOne({ admission: id }).exec();
      return raced ? { plan: await this.withCase(raced, admissionId, caseId), created: false } : null;
    }
    await this.announce(plan, `${plan.bedLabel}: Discharge planned for ${dayText(plan.targetDay)}`);
    return { plan, created: true };
  }

  /**
   * A plan opened before its case held the admission (the bed bridge adds the ref on its own queue, after the
   * admission exists) takes the case from a later message, or from the ref once it is there. A case once set stays.
   */
  private async withCase(plan: DischargePlanDocument, admissionId: string, caseId: string | null): Promise<DischargePlanDocument> {
    if (plan.case) return plan;
    const ref = await this.caseOf(admissionId, caseId);
    if (!ref) return plan;
    // `case: null` also matches a plan with no case field at all.
    const updated = await this.plans.findOneAndUpdate({ _id: plan._id, case: null }, { $set: { case: ref } }, { new: true }).exec();
    return updated ?? (await this.plans.findById(plan._id).exec()) ?? plan;
  }

  /**
   * The plan follows its stay to the new bed: the bed label and ward name change, and so does an open reminder's
   * title. A stay with no plan is left to the bed.transferred handler and the catch-up, which open one.
   */
  async onTransferred(admissionId: string): Promise<void> {
    if (!isValidObjectId(admissionId)) return;
    const admission = await this.admissions.findById(admissionId).select('bed sample').lean().exec();
    if (!admission || admission.sample) return;
    const place = await this.placeOf(admission.bed);
    if (!place) {
      this.logger.warn(`Admission ${admissionId}: its new bed or ward was not found; the discharge plan keeps the old one`);
      return;
    }
    const plan = await this.plans
      .findOneAndUpdate({ admission: admission._id, state: { $ne: 'completed' } }, { $set: { bedLabel: place.bedLabel, wardName: place.wardName } }, { new: true })
      .exec();
    if (!plan) return;
    await this.alerts.updateOne({ link: reminderLink(plan._id), status: { $ne: 'Completed' } }, { $set: { title: reminderTitle(plan.bedLabel) } }).exec();
  }

  /**
   * A doctor or an admin moves the target to a day from today on (clinic clock). The plan is then due that day at
   * 11:00, the change is logged, an open reminder closes, and `discharge.planned` names the new day. The same day
   * again changes nothing. 403 for other roles; 400 for a past, impossible or malformed day, or a note over 300
   * characters; 404 for an unknown plan; 409 once the discharge is complete.
   */
  async setTarget(actor: Actor, planId: string, targetDay: string, note?: string): Promise<DischargePlanDocument> {
    if (!actor || !DIS_ORDER.includes(actor.role)) throw new ForbiddenException('Only a doctor or an admin can change the target date.');
    const targetAt = atClinicTime(targetDay, TARGET_TIME);
    const now = this.clock();
    if (targetDay < isoDate(now)) throw new BadRequestException('The target date cannot be before today.');
    if (note != null && typeof note !== 'string') throw new BadRequestException('The note must be text.');
    const text = (note ?? '').trim();
    if (text.length > NOTE_MAX) throw new BadRequestException(`The note is at most ${NOTE_MAX} characters.`);
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    if (!plan) throw new NotFoundException('Discharge plan not found');
    if (plan.state === 'completed') throw new ConflictException(PLAN_COMPLETE);
    if (plan.targetDay === targetDay) return plan;
    const updated = await this.plans
      .findOneAndUpdate(
        // Matching the day read, so the log's "from" is the day this replaces.
        { _id: plan._id, state: { $ne: 'completed' }, targetDay: plan.targetDay },
        {
          $set: { targetDay, targetAt },
          $push: { targetLog: { from: plan.targetDay, to: targetDay, by: { id: actor.id, name: actor.name }, at: now, ...(text ? { note: text } : {}) } },
          // The new day is not announced yet: a failed send leaves it for the one-minute pass.
          $unset: { announcedAt: 1 },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      const current = await this.plans.findById(plan._id).select('state').lean<{ state?: string }>().exec();
      if (current?.state === 'completed') throw new ConflictException(PLAN_COMPLETE);
      throw new ConflictException('The target date was just changed by someone else. Reload and try again.');
    }
    await this.closeReminder(String(updated._id));
    await this.announce(updated, `${updated.bedLabel}: Discharge target moved to ${dayText(targetDay)}`);
    return updated;
  }

  /**
   * The morning reminder (rule `discharge-morning-reminder`, time from Settings → Discharge): on a plan's target day,
   * from the reminder time, while the plan has no order, one task "Discharge due today, no order yet: <bed>". One per
   * plan per target day, however often this runs; the task closed for an earlier target day opens again for the new
   * one. Returns how many this run raised.
   */
  async remindDue(now: Date = this.clock()): Promise<number> {
    if (!(await this.rules.isOn(REMINDER_RULE))) return 0;
    const today = isoDate(now);
    const { reminderTime } = await this.settings.get();
    if (now.getTime() < atClinicTime(today, reminderTime).getTime()) return 0;
    const due = await this.plans.find({ state: 'planned', targetDay: today, remindedDay: { $ne: today } }).exec();
    let raised = 0;
    for (const plan of due) {
      try {
        if (await this.remind(plan, today)) raised += 1;
      } catch (e) {
        this.logger.warn(`Discharge plan ${String(plan._id)}: morning reminder not raised (${(e as Error).message})`);
      }
    }
    return raised;
  }

  /**
   * Writes (or reopens) the plan's reminder, then marks the day. A task written twice is still one (the link), so a
   * crash between the two only repeats the write. An order or a new day that landed meanwhile closes it again.
   */
  private async remind(plan: DischargePlanDocument, day: string): Promise<boolean> {
    const fields = {
      title: reminderTitle(plan.bedLabel),
      subtitle: reminderSubtitle(plan.doctor),
      patientName: plan.patientName,
      uhid: plan.patientUhid,
      type: 'System',
      category: 'Follow-up',
      priority: 'Medium',
      status: 'Pending',
    };
    try {
      await this.alerts.updateOne({ link: reminderLink(plan._id) }, { $set: fields }, { upsert: true }).exec();
    } catch (e) {
      // A pass running beside this one wrote it first.
      if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
    }
    const marked = await this.plans.updateOne({ _id: plan._id, remindedDay: { $ne: day } }, { $set: { remindedDay: day } }).exec();
    if (!(await this.plans.exists({ _id: plan._id, state: 'planned', targetDay: day }).exec())) await this.closeReminder(String(plan._id));
    return marked.modifiedCount === 1;
  }

  /** Closes the plan's morning reminder, if it is open. Safe to repeat; a failure is logged, never thrown. */
  async closeReminder(planId: string): Promise<void> {
    try {
      await this.alerts.updateOne({ link: reminderLink(planId), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    } catch (e) {
      this.logger.warn(`Discharge plan ${planId}: reminder not closed (${(e as Error).message})`);
    }
  }

  /**
   * Opens a plan for every active, non-sample admission that has none, whatever its admission time (R17): the order
   * is the only way a real stay ends, so a stay admitted before the agent first ran must be dischargeable too. The
   * agent's start stamp therefore bounds nothing here. Each new plan announces itself; one bad admission never stops
   * the rest. Returns how many plans it opened.
   */
  async catchUp(): Promise<number> {
    const active = await this.admissions.find({ status: 'active', sample: { $ne: true } }).select('_id').lean().exec();
    if (!active.length) return 0;
    const planned = await this.plans.find({ admission: { $in: active.map((a) => a._id) } }).select('admission').lean().exec();
    const has = new Set(planned.map((p) => String(p.admission)));
    let opened = 0;
    for (const a of active) {
      const id = String(a._id);
      if (has.has(id)) continue;
      try {
        if ((await this.open(id, null))?.created) opened += 1;
      } catch (e) {
        this.logger.warn(`Admission ${id}: no discharge plan opened (${(e as Error).message})`);
      }
    }
    return opened;
  }

  /** Loads the message and runs the handler. Nothing escapes: the one-minute pass repairs what a failure missed. */
  private async run(type: string, messageId: string, fn: (m: Msg) => Promise<void>): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message) {
        this.logger.warn(`${type}: message ${messageId} not found`);
        return;
      }
      await fn({ case: message.case ?? null, payload: message.payload ?? {} });
    } catch (e) {
      this.logger.warn(`${type} (message ${messageId}): ${(e as Error).message}`);
    }
  }

  /** bed.assigned: the stay's plan, on the message's case. */
  private async onAssigned(m: Msg): Promise<void> {
    const admissionId = await this.admissionIdOf(m);
    if (admissionId) await this.ensurePlan(admissionId, m.case);
  }

  /**
   * bed.discharged (R23). The agent's own endings (Patient left, Body released, Left without discharge) free the bed
   * first and then complete the plan with its kind, so this message can come first: a plan with an order (ordered or
   * ready), or a patient already marked Left without discharge, is left to them. A plan still `planned` whose
   * admission was discharged outside the agent (the bed route of an older API) is completed at the admission's
   * discharge time, with no kind, and its reminder closed. Samples and missing admissions are ignored.
   */
  private async onDischarged(m: Msg): Promise<void> {
    const admissionId = await this.admissionIdOf(m);
    if (!admissionId) return;
    const admission = await this.admissions.findById(admissionId).select('patient status dischargedAt sample').lean().exec();
    if (!admission || admission.sample || admission.status !== 'discharged') return;
    const patient = await this.patients.findById(admission.patient).select('status').lean<{ status?: string }>().exec();
    if (patient?.status === 'Left without discharge') return;
    const plan = await this.plans
      .findOneAndUpdate(
        { admission: admission._id, state: 'planned' },
        { $set: { state: 'completed', ...(admission.dischargedAt ? { completedAt: admission.dischargedAt } : {}) } },
        { new: true },
      )
      .exec();
    if (!plan) return;
    this.logger.warn(`Discharge plan ${String(plan._id)} completed: admission ${admissionId} was discharged outside the Discharge Agent`);
    await this.closeReminder(String(plan._id));
  }

  /** The admission a bed message names, else the one its case holds. */
  private async admissionIdOf(m: Msg): Promise<string | null> {
    const named = str(m.payload.admissionId);
    if (named && isValidObjectId(named)) return named;
    if (!m.case || !isValidObjectId(m.case)) return null;
    const c = await this.cases.findById(m.case).select('refs').lean<{ refs?: { admissionId?: string } }>().exec();
    const ref = c?.refs?.admissionId;
    return ref && isValidObjectId(ref) ? ref : null;
  }

  /** The message's case, else (the catch-up) the case that holds the admission. A plan may have none. */
  private async caseOf(admissionId: string, caseId: string | null): Promise<Types.ObjectId | null> {
    if (caseId && isValidObjectId(caseId)) return new Types.ObjectId(caseId);
    const c = await this.cases.findOne({ 'refs.admissionId': admissionId }).sort({ openedAt: -1, _id: -1 }).select('_id').lean().exec();
    return c ? (c._id as Types.ObjectId) : null;
  }

  /**
   * A bed's label (as the bed messages carry it), its ward's name and the admission it holds (`holds`, null when it
   * holds none); null when the bed or its ward can't be read.
   */
  private async placeOf(bedId: unknown): Promise<{ bedLabel: string; wardName: string; holds: string | null } | null> {
    if (!bedId || !isValidObjectId(bedId)) return null;
    const bed = await this.beds
      .findById(bedId)
      .select('label ward admission')
      .lean<{ label?: string; ward?: Types.ObjectId; admission?: Types.ObjectId | null }>()
      .exec();
    const ward = bed?.ward ? await this.wards.findById(bed.ward).select('name').lean<{ name?: string }>().exec() : null;
    return bed?.label && ward?.name ? { bedLabel: bed.label, wardName: ward.name, holds: bed.admission ? String(bed.admission) : null } : null;
  }

  /**
   * Sends `discharge.planned` for the plan's current target and, once it went, stamps `announcedAt` (real time). A
   * send that fails leaves the stamp unset, for the one-minute pass to send again. `dedupeKey` is the re-send's own
   * key (R31). True when it went. Never throws.
   */
  private async announce(plan: DischargePlanDocument, summary: string, dedupeKey?: string): Promise<boolean> {
    const payload = { planId: String(plan._id), admissionId: String(plan.admission), bedLabel: plan.bedLabel, targetDay: plan.targetDay };
    if (!(await this.registration.send('discharge.planned', plan.case ? String(plan.case) : null, payload, summary, dedupeKey ? { dedupeKey } : {}))) return false;
    const at = new Date();
    try {
      // Only for the day it named: a change that landed meanwhile is announced by its own call.
      await this.plans.updateOne({ _id: plan._id, targetDay: plan.targetDay }, { $set: { announcedAt: at } }).exec();
      plan.announcedAt = at;
    } catch (e) {
      this.logger.warn(`Discharge plan ${String(plan._id)}: announcedAt not stamped (${(e as Error).message})`);
    }
    return true;
  }

  /**
   * The one-minute pass (R31): `discharge.planned` again for a plan whose current target day was never announced, under
   * a key of its own for that day (`discharge.planned:<planId>:<targetDay>:resend`), so the Coordinator's minute filter
   * never takes it for an earlier send. A completed plan, or one already announced, is left alone. True when it went.
   */
  async resendPlanned(planId: string): Promise<boolean> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    if (!plan || plan.state === 'completed' || plan.announcedAt) return false;
    const what = plan.targetLog?.length ? 'Discharge target moved to' : 'Discharge planned for';
    return this.announce(plan, `${plan.bedLabel}: ${what} ${dayText(plan.targetDay)}`, `discharge.planned:${String(plan._id)}:${plan.targetDay}:resend`);
  }

  /**
   * Task 4 R1-B2: a plan opened in the twin-room gap stays planned after the Bed Agent deleted its admission (the bed was
   * lost), with nothing to discharge. The one-minute pass drops such a plan once it is past the grace (never one with an
   * order), and closes its reminder. Returns how many it dropped; one bad plan never stops the rest.
   */
  async dropOrphans(): Promise<number> {
    const old = new Date(Date.now() - ORPHAN_GRACE_MS);
    const planned = await this.plans.find({ state: 'planned', order: null, createdAt: { $lte: old } }).select('admission').lean().exec();
    if (!planned.length) return 0;
    const present = await this.admissions.find({ _id: { $in: planned.map((p) => p.admission) } }).select('_id').lean().exec();
    const has = new Set(present.map((a) => String(a._id)));
    let dropped = 0;
    for (const p of planned) {
      if (has.has(String(p.admission))) continue;
      try {
        // Read again, just before: the admission is gone for good, not still being written.
        if (await this.admissions.exists({ _id: p.admission }).exec()) continue;
        const res = await this.plans.deleteOne({ _id: p._id, state: 'planned', order: null }).exec();
        if (!res.deletedCount) continue;
        dropped += 1;
        this.logger.warn(`Discharge plan ${String(p._id)} dropped: its admission ${String(p.admission)} no longer exists`);
        await this.closeReminder(String(p._id));
      } catch (e) {
        this.logger.warn(`Discharge plan ${String(p._id)}: not dropped (${(e as Error).message})`);
      }
    }
    return dropped;
  }

  /** R15: the patient's plans take the record's current name and UHID. Never throws. */
  private async refreshPatient(patientId: string): Promise<void> {
    try {
      if (!isValidObjectId(patientId)) return;
      const p = await this.patients.findById(patientId).select('name uhid').lean<{ _id: Types.ObjectId; name: string; uhid: string }>().exec();
      if (!p) return;
      await this.plans
        .updateMany({ patient: p._id, $or: [{ patientName: { $ne: p.name } }, { patientUhid: { $ne: p.uhid } }] }, { $set: { patientName: p.name, patientUhid: p.uhid } })
        .exec();
    } catch (e) {
      this.logger.warn(`Discharge plans of patient ${patientId} keep the old name (${(e as Error).message})`);
    }
  }
}
