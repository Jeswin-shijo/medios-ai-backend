import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { BedsService } from '../beds/beds.service';
import { CasesService } from '../coordinator/cases.service';
import type { LineInput, PreviewResult } from '../pharmacy/pharmacy-orders.service';
import { PharmacyTakeHomeService } from '../pharmacy/pharmacy-take-home.service';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { FollowUpOutcome, SchedulingFollowupsService } from '../scheduling/scheduling-followups.service';
import { CONDITIONS, Condition, DISCHARGE_KINDS, DischargeKind, KIND_LABEL, LINE_KEYS, LINE_RULE, LineKey } from './discharge-catalogue';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargePlansService } from './discharge-plans.service';
import { DIS_ORDER } from './discharge-roles';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService } from './discharge-summary.service';
import { toRealTime, windowStart } from './discharge-time';
import {
  DischargeFollowUp,
  DischargeLineEntry,
  DischargeOrder,
  DischargeOrderDocument,
  LIVE_ORDER_STATES,
  OPEN_ORDER_STATES,
  OrderState,
  takeHomeOrderIds,
} from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';
import { DischargeSummary, DischargeSummaryDocument } from './schemas/discharge-summary.schema';

const MIN_MS = 60_000;
const DUPLICATE_KEY = 11000;
const TEXT_MAX = 300;
const NOTE_MAX = 1000;
const FOLLOW_UP_NOTE_MAX = 300;
const NOT_SAVED = 'Discharge order not saved';
const DEATH_LEAVES_NOW = 'After a death the leaving time is the time of the order.';
const ALREADY_ORDERED = 'This stay already has a discharge order.';
const WINDOW_OPEN_LATER = 'The discharge window is already open. Cancel and re-order to leave later.';
const ORDERED = 'discharge.ordered';
const WINDOW_OPENED = 'discharge.window-opened';
const CANCELLED = 'discharge.cancelled';
/** The message that stops the clocks when an order ends in this state. */
const STOP_MESSAGE: Partial<Record<OrderState, string>> = { cancelled: CANCELLED, left: 'discharge.completed' };
const PLAN_COMPLETE = 'This discharge is complete.';
/** G2: Left without discharge completed the plan while this order was being given. */
const STAY_ENDED = 'The stay already ended';

export interface FollowUpChoice {
  inDays: number;
  /** An OP doctor id; else the department's first active doctor; else the patient's usual doctor (Scheduling decides). */
  doctorId?: string;
  departmentCode?: string;
  note?: string;
}

/** The doctor's discharge order (design 4.2). Times are on the clinic clock. */
export interface OrderInput {
  kind: DischargeKind;
  /** From now to the end of tomorrow; default now + the order-to-leaving target. For Died it is always the order's own time. */
  plannedLeaveAt?: Date | string;
  /** 1 to 300 characters. */
  diagnosis: string;
  /** Not for Died. */
  condition?: Condition;
  /** Died only, required, at or before now. */
  timeOfDeath?: Date | string;
  /** Died only, required. */
  causeOfDeath?: string;
  /** Transfer only, required. */
  receivingHospital?: string;
  /** Transfer only, required. */
  transferReason?: string;
  /** At most 1000 characters; never sent to the AI. */
  note?: string;
  /** Home must choose (lines or 'none'); Transfer and Against advice may; Died takes none. */
  takeHome?: { lines: LineInput[] } | 'none';
  /** Home must choose (a follow-up or 'none'); Against advice may; Transfer and Died take none. */
  followUp?: FollowUpChoice | 'none';
}

/** What the doctor can change while the patient is still in the bed. */
export interface OrderPatch {
  plannedLeaveAt?: Date | string;
  diagnosis?: string;
  condition?: Condition;
  note?: string;
  /** More take-home medicines, as another take-home order, while none of this order's is issued. */
  takeHome?: { lines: LineInput[] };
  /** A follow-up, while none is stored on the order. */
  followUp?: FollowUpChoice;
}

type Choice = 'given' | 'none' | undefined;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const by = (actor: Actor) => ({ id: actor.id, name: actor.name });
const isDuplicate = (e: unknown) => (e as { code?: number })?.code === DUPLICATE_KEY;

/** Trimmed text of `min` to `max` characters, or 400. */
function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new BadRequestException(min ? `${field} must be ${min} to ${max} characters.` : `${field} is at most ${max} characters.`);
  return t;
}

function moment(v: unknown, field: string): Date {
  const d = v instanceof Date ? new Date(v.getTime()) : typeof v === 'string' && v.trim() ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) throw new BadRequestException(`${field} must be a date and time.`);
  return d;
}

/** The planned leaving time must fall from the current minute to the end of tomorrow (clinic clock). */
function leavingTime(v: unknown, now: Date): Date {
  const at = moment(v, 'The planned leaving time');
  const minute = new Date(now.getTime());
  minute.setSeconds(0, 0);
  const afterTomorrow = parseIsoDay(isoDate(now));
  afterTomorrow.setDate(afterTomorrow.getDate() + 2);
  if (at.getTime() < minute.getTime()) throw new BadRequestException('The planned leaving time cannot be in the past.');
  if (at.getTime() >= afterTomorrow.getTime()) throw new BadRequestException('The planned leaving time must be today or tomorrow.');
  return at;
}

function condition(v: unknown): Condition {
  if (typeof v !== 'string' || !(CONDITIONS as readonly string[]).includes(v)) {
    throw new BadRequestException('The condition must be improved, stable, unchanged or deteriorated.');
  }
  return v as Condition;
}

function takeHomeLines(v: unknown): LineInput[] {
  if (!isObj(v) || !Array.isArray(v.lines) || !v.lines.length) throw new BadRequestException('Choose the take-home medicines, or tick No take-home medicines.');
  return v.lines as LineInput[];
}

/** The follow-up the doctor asked for, checked before anything is placed (Scheduling checks the doctor and department). */
function followUpChoice(v: unknown): FollowUpChoice {
  if (!isObj(v)) throw new BadRequestException('Choose a follow-up, or tick No follow-up needed.');
  const inDays = v.inDays;
  if (typeof inDays !== 'number' || !Number.isInteger(inDays) || inDays < 1 || inDays > 365) {
    throw new BadRequestException('"In how many days" must be a whole number from 1 to 365.');
  }
  const out: FollowUpChoice = { inDays };
  if (given(v.doctorId)) {
    if (typeof v.doctorId !== 'string' || !isValidObjectId(v.doctorId)) throw new BadRequestException('Choose a doctor from the list.');
    out.doctorId = v.doctorId;
  }
  if (given(v.departmentCode)) out.departmentCode = text(v.departmentCode, 'The department', 1, 20);
  if (given(v.note)) out.note = text(v.note, 'The follow-up note', 0, FOLLOW_UP_NOTE_MAX);
  return out;
}

const stored = (o: FollowUpOutcome): DischargeFollowUp => ({
  followUpId: o.followUpId,
  status: o.status,
  ...(o.appointmentId ? { appointmentId: o.appointmentId } : {}),
  ...(o.date ? { date: o.date } : {}),
  ...(o.time ? { time: o.time } : {}),
});

const stateRefusal = (state: OrderState | undefined): string =>
  state === 'cancelled' ? 'This discharge order was cancelled.' : state === 'left' ? 'The patient has already left.' : 'Discharge order not found';

type MessageOrder = Pick<DischargeOrder, 'plan' | 'admission' | 'kind' | 'plannedLeaveAt'> & { _id: unknown };

/** The `discharge.ordered` payload, the same for the first send and a re-send. */
const orderedPayload = (o: MessageOrder, bedLabel: string) => ({
  orderId: String(o._id), planId: String(o.plan), admissionId: String(o.admission), bedLabel, kind: o.kind, plannedLeaveAt: o.plannedLeaveAt,
});

/** The `discharge.cancelled` payload; the reason stays on the order. */
const cancelledPayload = (o: Pick<MessageOrder, '_id' | 'admission'>, bedLabel: string) => ({ orderId: String(o._id), admissionId: String(o.admission), bedLabel });

/**
 * The doctor's discharge order: the only door through which a real admission ends. It places the take-home order and
 * books the follow-up when it is sent (A3, A13), marks the bed Leaving soon, and opens the discharge window (A1) when
 * it is due, which starts the clocks. Orders are on the clinic clock; `windowOpenedAt` and clock due times are real.
 */
@Injectable()
export class DischargeOrdersService {
  private readonly logger = new Logger(DischargeOrdersService.name);

  /** The clinic clock (R7); a spec replaces it. */
  clock: () => Date = () => clinicNow();

  /** Summary drafts still running in the background (R36). */
  private readonly drafting = new Set<Promise<void>>();

  constructor(
    private readonly registration: DischargeRegistration,
    private readonly plansService: DischargePlansService,
    private readonly settings: DischargeSettingsService,
    private readonly cases: CasesService,
    private readonly beds: BedsService,
    private readonly takeHome: PharmacyTakeHomeService,
    private readonly followUps: SchedulingFollowupsService,
    /** The checklist, read from the agents' records (it never depends on this service). */
    private readonly lines: DischargeLinesService,
    /** The summary, drafted once the order is saved (it never depends on this service). */
    private readonly summary: DischargeSummaryService,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(DischargeSummary.name) private readonly summaries: Model<DischargeSummaryDocument>,
    /** Read only: whether a take-home medicine was issued. */
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
  ) {}

  /**
   * A doctor or an admin orders the discharge (R4). Everything is checked first, and a plan that already has a live
   * order is 409, before anything is placed. Then the take-home order is placed, the follow-up booked, and the order
   * saved. A failure after the take-home order was placed cancels it ("Discharge order not saved"); a follow-up already
   * booked stays. Then the plan is ordered and its reminder closed, `discharge.ordered` goes, the bed board re-reads,
   * the window opens at once when it is due, and the checklist is read. The summary is drafted in the background
   * (R36): the order never waits for the AI, and a failed draft is logged and never undoes the order.
   */
  async order(actor: Actor, planId: string, input: OrderInput): Promise<DischargeOrderDocument> {
    this.mayOrder(actor);
    const now = this.clock();
    const { leaveMinutes } = await this.settings.get();
    const v = this.checkOrder(input, now, leaveMinutes);
    const plan = await this.planOf(planId);
    if (plan.state === 'completed') throw new ConflictException(PLAN_COMPLETE);
    if (await this.orders.exists({ plan: plan._id, state: { $in: LIVE_ORDER_STATES } }).exec()) throw new ConflictException(ALREADY_ORDERED);
    const caseId = await this.caseOf(plan);
    if (v.takeHomeLines && !caseId) throw new ConflictException('This stay has no case for the take-home medicines. Order them from the Pharmacy Agent.');

    const placed = v.takeHomeLines
      ? (await this.takeHome.place(actor, { patientId: String(plan.patient), caseId: caseId!, plannedLeaveAt: v.plannedLeaveAt, lines: v.takeHomeLines })).id
      : null;
    let saved: DischargeOrderDocument;
    try {
      const outcome = v.followUp ? await this.followUps.order(actor, { patientId: String(plan.patient), ...v.followUp }) : null;
      saved = await this.orders.create({
        plan: plan._id,
        admission: plan.admission,
        ...(caseId ? { case: new Types.ObjectId(caseId) } : {}),
        patient: plan.patient,
        kind: v.kind,
        state: 'ordered',
        plannedLeaveAt: v.plannedLeaveAt,
        windowAt: windowStart(now, v.plannedLeaveAt, leaveMinutes),
        diagnosis: v.diagnosis,
        ...(v.condition ? { condition: v.condition } : {}),
        ...(v.timeOfDeath ? { timeOfDeath: v.timeOfDeath, causeOfDeath: v.causeOfDeath } : {}),
        ...(v.receivingHospital ? { receivingHospital: v.receivingHospital, transferReason: v.transferReason } : {}),
        note: v.note,
        ...(placed ? { takeHomeOrder: new Types.ObjectId(placed) } : {}),
        noTakeHome: v.takeHome === 'none',
        ...(outcome ? { followUp: stored(outcome) } : {}),
        noFollowUp: v.followUpChoice === 'none',
        lines: this.firstLines(v.kind, actor, now, v.takeHome, v.followUpChoice),
        orderedBy: by(actor),
        orderedAt: now,
      });
    } catch (e) {
      if (placed) await this.undoTakeHome(placed);
      // The unique index is the last guard against two orders sent at once.
      if (isDuplicate(e)) throw new ConflictException(ALREADY_ORDERED);
      throw e;
    }

    // G2: guarded on the stay not having ended. A plan still pointing at a just-cancelled order is not completed, so it
    // takes this one; a plan Left without discharge completed after the checks above undoes the order instead.
    const moved = await this.plans.updateOne({ _id: plan._id, state: { $ne: 'completed' } }, { $set: { state: 'ordered', order: saved._id } }).exec();
    if (!moved.matchedCount) await this.stayEnded(actor, saved._id, placed, now);
    await this.plansService.closeReminder(String(plan._id));
    await this.announce(saved, ORDERED, plan.bedLabel, 'Discharge ordered', orderedPayload(saved, plan.bedLabel));
    this.touchBeds();
    if (saved.windowAt.getTime() <= now.getTime()) await this.openWindow(saved._id, now);
    const refreshed = await this.refreshLines(saved._id);
    // R36: the draft waits for the AI, so the order never waits for the draft.
    this.draftSummary(saved._id);
    return refreshed;
  }

  /**
   * While the patient is still in the bed: the planned time (a window not yet open moves with it, and opens now when
   * that is due), the diagnosis, condition and note; more take-home medicines as another take-home order while none of
   * this order's is issued; and a follow-up while none is stored. Checked first, then placed and booked, then saved;
   * a failure after placing cancels the new take-home order.
   */
  async edit(actor: Actor, orderId: string, patch: OrderPatch): Promise<DischargeOrderDocument> {
    this.mayOrder(actor);
    const now = this.clock();
    const order = await this.openOrder(orderId);
    if (!isObj(patch)) throw new BadRequestException('Send the changes to make.');
    const died = order.kind === 'died';
    const set: Record<string, unknown> = {};
    let planned: Date | null = null;
    const { leaveMinutes } = await this.settings.get();
    if (patch.plannedLeaveAt !== undefined) {
      if (died) throw new BadRequestException(DEATH_LEAVES_NOW);
      planned = leavingTime(patch.plannedLeaveAt, now);
      // R29: an open window's clocks are fixed; the time may move earlier, or within the target, never past it.
      if (order.windowOpenedAt && planned.getTime() > order.windowAt.getTime() + leaveMinutes * MIN_MS) throw new ConflictException(WINDOW_OPEN_LATER);
      set.plannedLeaveAt = planned;
    }
    if (patch.diagnosis !== undefined) set.diagnosis = text(patch.diagnosis, 'The diagnosis', 1, TEXT_MAX);
    if (patch.condition !== undefined) {
      if (died) throw new BadRequestException('A death takes no condition at discharge.');
      set.condition = condition(patch.condition);
    }
    if (patch.note !== undefined) set.note = text(patch.note, 'The note', 0, NOTE_MAX);
    const lines = patch.takeHome !== undefined ? takeHomeLines(patch.takeHome) : null;
    if (lines) {
      if (LINE_RULE[order.kind]['take-home'] === '-') throw new BadRequestException(`A ${KIND_LABEL[order.kind].toLowerCase()} order takes no take-home medicines.`);
      if (!order.case) throw new ConflictException('This stay has no case for the take-home medicines. Order them from the Pharmacy Agent.');
      const ids = takeHomeOrderIds(order);
      if (ids.length && (await this.pharmacyLines.exists({ order: { $in: ids }, status: { $in: ['issued', 'stopped'] } }).exec())) {
        throw new ConflictException('Take-home medicines were already issued. Order more from the Pharmacy Agent.');
      }
    }
    const followUp = patch.followUp !== undefined ? followUpChoice(patch.followUp) : null;
    if (followUp) {
      if (LINE_RULE[order.kind]['follow-up'] === '-') throw new BadRequestException(`A ${KIND_LABEL[order.kind].toLowerCase()} order takes no follow-up.`);
      if (order.followUp) throw new ConflictException('A follow-up is already booked. Change it in Scheduling.');
    }

    const placed = lines
      ? (await this.takeHome.place(actor, { patientId: String(order.patient), caseId: String(order.case), plannedLeaveAt: planned ?? order.plannedLeaveAt, lines })).id
      : null;
    try {
      const filter: Record<string, unknown> = { _id: order._id, state: { $in: OPEN_ORDER_STATES } };
      const update: Record<string, unknown> = {};
      if (followUp) {
        const outcome = await this.followUps.order(actor, { patientId: String(order.patient), ...followUp });
        filter.followUp = null;
        Object.assign(set, { followUp: stored(outcome), noFollowUp: false });
      }
      if (placed) {
        set.noTakeHome = false;
        // Matching the first order read, so two edits at once never lose one.
        filter.takeHomeOrder = order.takeHomeOrder ?? null;
        if (order.takeHomeOrder) update.$push = { addedTakeHomeOrders: new Types.ObjectId(placed) };
        else set.takeHomeOrder = new Types.ObjectId(placed);
      }
      if (!Object.keys(set).length) return order;
      update.$set = set;
      if (!(await this.orders.updateOne(filter, update).exec()).matchedCount) {
        const current = await this.orders.findById(order._id).select('state').lean<{ state?: OrderState }>().exec();
        if (!current || !OPEN_ORDER_STATES.includes(current.state!)) throw new ConflictException(stateRefusal(current?.state));
        throw new ConflictException('The order was just changed by someone else. Reload and try again.');
      }
    } catch (e) {
      if (placed) await this.undoTakeHome(placed);
      throw e;
    }
    if (placed) await this.lineWaits(order, 'take-home');
    if (followUp) await this.lineWaits(order, 'follow-up');
    if (planned) {
      this.touchBeds();
      // A window not open yet moves with the planned time; one opened, or started early, stays.
      if (!order.windowOpenedAt && !order.startedNow) {
        const windowAt = windowStart(order.orderedAt, planned, leaveMinutes);
        const moved = await this.orders.updateOne({ _id: order._id, windowOpenedAt: null, startedNow: null }, { $set: { windowAt } }).exec();
        if (moved.matchedCount && windowAt.getTime() <= now.getTime()) await this.openWindow(order._id, now);
      }
    }
    return this.refreshLines(order._id);
  }

  /**
   * A doctor or an admin cancels the order with a reason (1 to 300 characters): the plan is planned again and the bed
   * no longer leaving soon. A signed summary is archived with its document (R35). `discharge.cancelled` stops the
   * clocks, and Pharmacy cancels the take-home lines not yet issued (A12). A booked follow-up stays. The reason stays
   * on the order, never in a message.
   */
  async cancel(actor: Actor, orderId: string, reason: string): Promise<DischargeOrderDocument> {
    this.mayOrder(actor);
    const why = text(reason, 'The reason', 1, TEXT_MAX);
    const order = await this.openOrder(orderId);
    const now = this.clock();
    const cancelled = await this.orders
      .findOneAndUpdate(
        { _id: order._id, state: { $in: OPEN_ORDER_STATES } },
        { $set: { state: 'cancelled', cancelled: { by: by(actor), reason: why, at: now } } },
        { new: true },
      )
      .exec();
    if (!cancelled) throw new ConflictException(stateRefusal((await this.orders.findById(order._id).select('state').lean<{ state?: OrderState }>().exec())?.state));
    // Only while it still points at this order (a new order given meanwhile keeps the plan), and never once the stay has
    // ended (G1): Left without discharge may complete the plan between this order's cancel and this step.
    const reopened = await this.plans
      .updateOne({ _id: order.plan, order: order._id, state: { $ne: 'completed' } }, { $set: { state: 'planned' }, $unset: { order: 1 } })
      .exec();
    if (!reopened.matchedCount && (await this.plans.exists({ _id: order.plan, state: 'completed' }).exec())) {
      this.logger.warn(`Discharge order ${String(order._id)} cancelled after its stay ended: the plan stays completed`);
    }
    // R35: a summary signed for this discharge is no longer the patient's discharge summary.
    await this.archiveSummary(order._id);
    const bedLabel = await this.bedLabelOf(order.plan);
    if (bedLabel) {
      await this.announce(cancelled, CANCELLED, bedLabel, 'Discharge cancelled', cancelledPayload(cancelled, bedLabel));
      // A window claimed but not yet announced was opening as this cancel landed: its window-opened may be stored after
      // this stop, starting clocks nothing stops. Whichever of the two finishes last leaves the stop due again (I1).
      if (cancelled.windowOpenedAt && !cancelled.announced.includes('discharge.window-opened')) await this.stopDueAgain(order._id, 'cancelled');
    }
    this.touchBeds();
    return this.reread(order._id);
  }

  /** Opens the window now (Start now): `windowAt` becomes now. A window already open stays as it is. */
  async startNow(actor: Actor, orderId: string): Promise<DischargeOrderDocument> {
    this.mayOrder(actor);
    const order = await this.openOrder(orderId);
    if (order.windowOpenedAt) return order;
    const now = this.clock();
    const started = await this.orders
      .findOneAndUpdate(
        { _id: order._id, state: { $in: OPEN_ORDER_STATES }, windowOpenedAt: null },
        { $set: { windowAt: now, startedNow: { by: by(actor), at: now } } },
        { new: true },
      )
      .exec();
    if (!started) {
      const current = await this.orders.findById(order._id).exec();
      if (current && OPEN_ORDER_STATES.includes(current.state)) return current;
      throw new ConflictException(stateRefusal(current?.state));
    }
    await this.openWindow(started._id, now);
    return this.refreshLines(order._id);
  }

  /**
   * The one-minute pass: opens every window due by `now` (clinic clock) that is not open yet. Each goes once, however
   * many passes run; one that could not be sent is tried again by the next pass. Returns how many opened.
   */
  async openDueWindows(now: Date = this.clock()): Promise<number> {
    const due = await this.orders
      .find({ state: { $in: OPEN_ORDER_STATES }, windowOpenedAt: null, windowAt: { $lte: now } })
      .sort({ windowAt: 1, _id: 1 })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    let opened = 0;
    for (const o of due) {
      try {
        if (await this.openWindow(o._id, now)) opened += 1;
      } catch (e) {
        this.logger.warn(`Discharge order ${String(o._id)}: window not opened (${(e as Error).message})`);
      }
    }
    return opened;
  }

  /** The order form's live safety flags for take-home lines, on the plan's case (nothing is saved). DIS_ORDER only. */
  async preview(actor: Actor, input: { planId: string; lines: LineInput[] }): Promise<PreviewResult> {
    // The flags show the patient's allergies: the same roles as the order.
    this.mayOrder(actor);
    if (!isObj(input)) throw new BadRequestException('Send the plan and the medicines to check.');
    const plan = await this.planOf(input.planId);
    const caseId = await this.caseOf(plan);
    return this.takeHome.check({ patientId: String(plan.patient), caseId: caseId ?? '', lines: input.lines });
  }

  /** Resolves once every summary draft started in the background has finished (R36). Specs and the seed wait on it. */
  async idle(): Promise<void> {
    while (this.drafting.size) await Promise.all([...this.drafting]);
  }

  // ---------- re-sends (the one-minute pass) ----------

  /**
   * R31: `discharge.ordered` again for an order still in progress whose first send never went, under its own key
   * (`discharge.ordered:<orderId>:resend`). True when it went.
   */
  async resendOrdered(orderId: string): Promise<boolean> {
    const order = await this.found(orderId);
    if (!order || !OPEN_ORDER_STATES.includes(order.state) || order.announced.includes(ORDERED)) return false;
    const bedLabel = await this.bedLabelOf(order.plan);
    if (!bedLabel) return false;
    return this.announce(order, ORDERED, bedLabel, 'Discharge ordered', orderedPayload(order, bedLabel), `${ORDERED}:${String(order._id)}:resend`);
  }

  /**
   * R31: `discharge.window-opened` again for an order still in progress whose window was claimed (`windowOpenedAt`) but
   * never announced (a crash between the claim and the send), under its own key. The payload is rebuilt as the first
   * send builds it, so the clocks start with the same due times. A window that opens on an order no longer in progress
   * is never sent: its clocks would never be stopped. True when it went.
   */
  async resendWindowOpened(orderId: string): Promise<boolean> {
    const order = await this.found(orderId);
    if (!order || !OPEN_ORDER_STATES.includes(order.state) || !order.windowOpenedAt || order.announced.includes(WINDOW_OPENED)) return false;
    if (!(await this.sendWindowOpened(order, `${WINDOW_OPENED}:${String(order._id)}:resend`))) return false;
    await this.afterWindowOpened(order._id);
    return true;
  }

  /**
   * R31: `discharge.cancelled` again for a cancelled order whose stop never went (or was left due again, I1), under its
   * own key. Only while no other live order is on the same plan, or on the same case: Pharmacy cancels every waiting
   * take-home line of the case on this message, so a late one could cancel a newer order's medicines. True when it went.
   */
  async resendCancelled(orderId: string): Promise<boolean> {
    const order = await this.found(orderId);
    if (!order || order.state !== 'cancelled' || order.announced.includes(CANCELLED)) return false;
    const others = [{ plan: order.plan }, ...(order.case ? [{ case: order.case }] : [])];
    if (await this.orders.exists({ _id: { $ne: order._id }, state: { $in: LIVE_ORDER_STATES }, $or: others }).exec()) return false;
    const bedLabel = await this.bedLabelOf(order.plan);
    if (!bedLabel) return false;
    return this.announce(order, CANCELLED, bedLabel, 'Discharge cancelled', cancelledPayload(order, bedLabel), `${CANCELLED}:${String(order._id)}:resend`);
  }

  // ---------- the window ----------

  /**
   * Opens one window (A1, R20): claims it by stamping `windowOpenedAt` (real time) on an open order whose window is
   * due and not open, so two passes never both send; then sends `discharge.window-opened` with the due times (real
   * time, from `windowAt` and Settings → Discharge) and whether the summary is already signed. A send that fails gives
   * the claim back for the next pass. True when it was sent.
   */
  private async openWindow(orderId: Types.ObjectId, now: Date): Promise<boolean> {
    const openedAt = new Date();
    const order = await this.orders
      .findOneAndUpdate(
        { _id: orderId, state: { $in: OPEN_ORDER_STATES }, windowOpenedAt: null, windowAt: { $lte: now } },
        { $set: { windowOpenedAt: openedAt } },
        { new: true },
      )
      .exec();
    if (!order) return false;
    let sent = false;
    try {
      sent = await this.sendWindowOpened(order);
    } catch (e) {
      this.logger.warn(`Discharge order ${String(order._id)}: window-opened not sent (${(e as Error).message})`);
    }
    if (sent) {
      await this.afterWindowOpened(order._id);
      return true;
    }
    await this.orders
      .updateOne({ _id: order._id, windowOpenedAt: openedAt }, { $unset: { windowOpenedAt: 1 } })
      .exec()
      .catch((e: Error) => this.logger.warn(`Discharge order ${String(order._id)}: window claim not released (${e.message})`));
    return false;
  }

  /**
   * `discharge.window-opened` for a claimed window: the due times (real time, from `windowAt` and Settings → Discharge),
   * and whether the summary is already signed (R20). Recorded in `announced` once it went. True when it went; false,
   * with a warning, when the plan has no bed label.
   */
  private async sendWindowOpened(order: DischargeOrderDocument, dedupeKey?: string): Promise<boolean> {
    const [bedLabel, config, summary] = await Promise.all([
      this.bedLabelOf(order.plan),
      this.settings.get(),
      this.summaries.findOne({ order: order._id }).select('signedAt').lean<{ signedAt?: Date }>().exec(),
    ]);
    if (!bedLabel) return false;
    const window = toRealTime(order.windowAt).getTime();
    return this.announce(
      order,
      WINDOW_OPENED,
      bedLabel,
      'Discharge window opened',
      {
        orderId: String(order._id),
        admissionId: String(order.admission),
        bedLabel,
        kind: order.kind,
        plannedLeaveAt: order.plannedLeaveAt,
        leaveDueAt: new Date(window + config.leaveMinutes * MIN_MS),
        summaryDueAt: new Date(window + config.summaryMinutes * MIN_MS),
        summarySigned: !!summary?.signedAt,
      },
      dedupeKey,
    );
  }

  /** I1: a cancel (or a leaving) that landed after the window's claim may have sent its stop before this start. */
  private async afterWindowOpened(orderId: Types.ObjectId): Promise<void> {
    const state = (await this.orders.findById(orderId).select('state').lean<{ state?: OrderState }>().exec())?.state;
    if (state && !OPEN_ORDER_STATES.includes(state)) await this.stopDueAgain(orderId, state);
  }

  /**
   * I1: the order ended while its window was opening, so its stop message may have been stored before
   * `discharge.window-opened` started the clocks, and a stop that comes first is not kept. The stop is taken out of
   * `announced`, so the one-minute pass sends it again. Not here: the Coordinator would drop a repeat within 60 s.
   * Shared with the leaving service, whose Patient left, Body released and Left without discharge end orders too.
   */
  async stopDueAgain(orderId: Types.ObjectId, state: OrderState): Promise<void> {
    const stop = STOP_MESSAGE[state];
    if (!stop) return;
    this.logger.warn(`Discharge order ${String(orderId)}: ${state} while its window was opening; ${stop} is left for the one-minute pass to send again`);
    await this.orders
      .updateOne({ _id: orderId }, { $pull: { announced: stop } })
      .exec()
      .catch((e: Error) => this.logger.warn(`Discharge order ${String(orderId)}: ${stop} not marked to send again (${e.message})`));
  }

  // ---------- helpers ----------

  private mayOrder(actor: Actor): void {
    if (!actor || !DIS_ORDER.includes(actor.role)) throw new ForbiddenException('Only a doctor or an admin can do this.');
  }

  /** Every field of the order checked against its kind, before anything is placed or booked. */
  private checkOrder(input: OrderInput, now: Date, leaveMinutes: number) {
    if (!isObj(input)) throw new BadRequestException('Send the discharge order.');
    const kind = input.kind;
    if (typeof kind !== 'string' || !(DISCHARGE_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException('The kind must be Home, Transfer, Against advice or Died.');
    }
    const died = kind === 'died';
    const transfer = kind === 'transfer';
    const diagnosis = text(input.diagnosis, 'The diagnosis', 1, TEXT_MAX);
    const note = given(input.note) ? text(input.note, 'The note', 0, NOTE_MAX) : '';
    if (died && given(input.condition)) throw new BadRequestException('A death takes no condition at discharge.');
    const cond = given(input.condition) ? condition(input.condition) : undefined;

    let timeOfDeath: Date | undefined;
    let causeOfDeath: string | undefined;
    if (died) {
      if (!given(input.timeOfDeath)) throw new BadRequestException('Give the time of death.');
      timeOfDeath = moment(input.timeOfDeath, 'The time of death');
      if (timeOfDeath.getTime() > now.getTime()) throw new BadRequestException('The time of death cannot be in the future.');
      causeOfDeath = text(input.causeOfDeath ?? '', 'The cause of death', 1, TEXT_MAX);
    } else if (given(input.timeOfDeath) || given(input.causeOfDeath)) {
      throw new BadRequestException('Only a death order has a time and cause of death.');
    }
    let receivingHospital: string | undefined;
    let transferReason: string | undefined;
    if (transfer) {
      receivingHospital = text(input.receivingHospital ?? '', 'The receiving hospital', 1, TEXT_MAX);
      transferReason = text(input.transferReason ?? '', 'The reason for the transfer', 1, TEXT_MAX);
    } else if (given(input.receivingHospital) || given(input.transferReason)) {
      throw new BadRequestException('Only a transfer order has a receiving hospital.');
    }
    // A death leaves at the order's own time; the rest from now to the end of tomorrow.
    if (died && given(input.plannedLeaveAt)) throw new BadRequestException(DEATH_LEAVES_NOW);
    const plannedLeaveAt = died ? now : given(input.plannedLeaveAt) ? leavingTime(input.plannedLeaveAt, now) : new Date(now.getTime() + leaveMinutes * MIN_MS);

    const label = KIND_LABEL[kind as DischargeKind].toLowerCase();
    const takeHomeRule = LINE_RULE[kind as DischargeKind]['take-home'];
    const takeHome: Choice = input.takeHome === 'none' ? 'none' : input.takeHome === undefined ? undefined : 'given';
    if (takeHomeRule === '-' && takeHome === 'given') throw new BadRequestException(`A ${label} order takes no take-home medicines.`);
    // R30: a required take-home line needs the doctor's choice, or it could never be done.
    if (takeHomeRule === 'R' && !takeHome) throw new BadRequestException('Choose the take-home medicines, or tick No take-home medicines.');
    const lines = takeHome === 'given' ? takeHomeLines(input.takeHome) : null;

    const followUpRule = LINE_RULE[kind as DischargeKind]['follow-up'];
    const followUpGiven: Choice = input.followUp === 'none' ? 'none' : input.followUp === undefined ? undefined : 'given';
    if (followUpRule === '-' && followUpGiven === 'given') throw new BadRequestException(`A ${label} order takes no follow-up.`);
    if (followUpRule === 'R' && !followUpGiven) throw new BadRequestException('Choose a follow-up, or tick No follow-up needed.');
    const followUp = followUpGiven === 'given' ? followUpChoice(input.followUp) : null;

    return {
      kind: kind as DischargeKind, diagnosis, note, condition: cond, timeOfDeath, causeOfDeath, receivingHospital, transferReason, plannedLeaveAt,
      takeHome: takeHomeRule === '-' ? undefined : takeHome,
      takeHomeLines: lines,
      followUpChoice: followUpRule === '-' ? undefined : followUpGiven,
      followUp,
    };
  }

  /**
   * The lines at order time: the order line done by the ordering doctor; take-home and follow-up not needed when the
   * doctor chose none; an optional line only when the doctor filled it; every other line of the kind waiting. Lines
   * the kind does not show are left out. The lines service computes the real states afterwards.
   */
  private firstLines(kind: DischargeKind, actor: Actor, now: Date, takeHome: Choice, followUp: Choice): DischargeLineEntry[] {
    const rule = LINE_RULE[kind];
    const out: DischargeLineEntry[] = [];
    for (const key of LINE_KEYS) {
      if (rule[key] === '-') continue;
      if (key === 'order') {
        out.push({ key, state: 'done', by: by(actor), at: now });
        continue;
      }
      const choice = key === 'take-home' ? takeHome : key === 'follow-up' ? followUp : undefined;
      if (rule[key] === 'O' && choice !== 'given') continue;
      out.push(choice === 'none' ? { key, state: 'not-needed', by: by(actor), at: now } : { key, state: 'waiting' });
    }
    return out;
  }

  /** The line waits again (it was not needed), or is added in its place when the order had none (an optional line). */
  private async lineWaits(order: DischargeOrderDocument, key: LineKey): Promise<void> {
    const reset = await this.orders
      .updateOne({ _id: order._id, 'lines.key': key }, { $set: { 'lines.$.state': 'waiting' }, $unset: { 'lines.$.by': 1, 'lines.$.at': 1, 'lines.$.note': 1 } })
      .exec();
    if (reset.matchedCount) return;
    const rank = LINE_KEYS.indexOf(key);
    const position = order.lines.filter((l) => LINE_KEYS.indexOf(l.key) < rank).length;
    await this.orders.updateOne({ _id: order._id, 'lines.key': { $ne: key } }, { $push: { lines: { $each: [{ key, state: 'waiting' }], $position: position } } }).exec();
  }

  /**
   * Sends a Discharge message on the order's case and, once it went, records it in `announced` (the one-minute pass
   * re-sends one a record says is due but is missing there). The summary names the bed and the kind, never the
   * patient. `dedupeKey` is a re-send's own key (R31). True when it went.
   */
  private async announce(
    order: DischargeOrderDocument,
    type: string,
    bedLabel: string,
    what: string,
    payload: Record<string, unknown>,
    dedupeKey?: string,
  ): Promise<boolean> {
    const summary = `${bedLabel}: ${what} (${KIND_LABEL[order.kind]})`;
    const sent = await this.registration.send(type, order.case ? String(order.case) : null, payload, summary, dedupeKey ? { dedupeKey } : {});
    if (!sent) return false;
    await this.orders
      .updateOne({ _id: order._id }, { $addToSet: { announced: type } })
      .exec()
      .catch((e: Error) => this.logger.warn(`Discharge order ${String(order._id)}: ${type} not recorded as sent (${e.message})`));
    return true;
  }

  /**
   * G2: the stay ended (Left without discharge completed the plan) after this order's first checks. Nothing was
   * announced for it yet, and no window opened: the order is cancelled ("The stay already ended") unless Left without
   * discharge already ended it, its take-home order is cancelled through Pharmacy, and the doctor gets 409. A booked
   * follow-up stays (R4).
   */
  private async stayEnded(actor: Actor, orderId: Types.ObjectId, placed: string | null, now: Date): Promise<never> {
    this.logger.warn(`Discharge order ${String(orderId)}: its stay ended while it was being given; the order is cancelled`);
    await this.orders
      .updateOne({ _id: orderId, state: { $in: OPEN_ORDER_STATES } }, { $set: { state: 'cancelled', cancelled: { by: by(actor), reason: STAY_ENDED, at: now } } })
      .exec();
    if (placed) await this.undoTakeHome(placed);
    throw new ConflictException(STAY_ENDED);
  }

  /** Cancels a take-home order whose discharge order was not saved. A failure is logged: the caller's error matters more. */
  private async undoTakeHome(takeHomeOrderId: string): Promise<void> {
    try {
      await this.takeHome.cancelOrder(takeHomeOrderId, NOT_SAVED);
    } catch (e) {
      this.logger.warn(`Take-home order ${takeHomeOrderId}: not cancelled after the discharge order failed (${(e as Error).message})`);
    }
  }

  private touchBeds(): void {
    try {
      this.beds.touch();
    } catch (e) {
      this.logger.warn(`Bed board not refreshed (${(e as Error).message})`);
    }
  }

  private async planOf(planId: string): Promise<DischargePlanDocument> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    if (!plan) throw new NotFoundException('Discharge plan not found');
    return plan;
  }

  /** An order still in progress, else 404 or 409. */
  private async openOrder(orderId: string): Promise<DischargeOrderDocument> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!order) throw new NotFoundException('Discharge order not found');
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    return order;
  }

  /** R24: the plan's case, else the patient's open case, else their newest one; null when they have none. */
  async caseOf(plan: Pick<DischargePlan, 'case' | 'patient'>): Promise<string | null> {
    if (plan.case) return String(plan.case);
    const c = await this.cases.forPatient(String(plan.patient));
    return c ? String(c._id) : null;
  }

  /** The plan's bed now (it follows transfers); null, with a warning, when the plan is gone. */
  private async bedLabelOf(planId: Types.ObjectId): Promise<string | null> {
    const plan = await this.plans.findById(planId).select('bedLabel').lean<{ bedLabel?: string }>().exec();
    if (!plan?.bedLabel) this.logger.warn(`Discharge plan ${String(planId)} not found: no message sent`);
    return plan?.bedLabel ?? null;
  }

  /** The order in any state, or null. */
  private async found(orderId: string): Promise<DischargeOrderDocument | null> {
    return isValidObjectId(orderId) ? this.orders.findById(orderId).exec() : null;
  }

  private async reread(orderId: Types.ObjectId): Promise<DischargeOrderDocument> {
    const order = await this.orders.findById(orderId).exec();
    if (!order) throw new NotFoundException('Discharge order not found');
    return order;
  }

  /**
   * R36: the summary is drafted from the record (design 4.4) in the background once the order is saved, because the
   * draft waits for the AI (up to its timeout). A failure is logged and never undoes the order: drafting is safe to
   * repeat, and the summary view drafts one when there is none. `idle()` waits for it.
   */
  private draftSummary(orderId: Types.ObjectId): void {
    const run: Promise<void> = Promise.resolve()
      .then(() => this.summary.draft(String(orderId)))
      .then(
        () => undefined,
        (e: unknown) => this.logger.warn(`Discharge order ${String(orderId)}: summary not drafted (${e instanceof Error ? e.message : String(e)})`),
      )
      .finally(() => this.drafting.delete(run));
    this.drafting.add(run);
  }

  /** R35: a cancelled order's signed summary is archived with its document. A failure is logged and never undoes the cancel. */
  private async archiveSummary(orderId: Types.ObjectId): Promise<void> {
    try {
      await this.summary.archiveForCancel(String(orderId));
    } catch (e) {
      this.logger.warn(`Discharge order ${String(orderId)}: summary not archived after the cancel (${(e as Error).message})`);
    }
  }

  /**
   * The checklist read again from the agents' records, as the last step of an order, an edit or Start now.
   * A failure is logged and never undoes what was saved: the one-minute pass refreshes every open order.
   */
  private async refreshLines(orderId: Types.ObjectId): Promise<DischargeOrderDocument> {
    try {
      return await this.lines.refresh(String(orderId));
    } catch (e) {
      this.logger.warn(`Discharge order ${String(orderId)}: checklist not refreshed (${(e as Error).message})`);
      return this.reread(orderId);
    }
  }
}
