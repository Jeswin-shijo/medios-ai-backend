import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { BedsService, DischargeBedOptions } from '../beds/beds.service';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { Bed, BedDocument } from '../beds/schemas/bed.schema';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { Bill, BillDocument, BillState } from '../revenue/schemas/bill.schema';
import { UserRole } from '../users/schemas/user.schema';
import { CompletionKind, KIND_LABEL, LINE_LABEL } from './discharge-catalogue';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLinesService, missing, readyLinesFilter } from './discharge-lines.service';
import { DischargeOrdersService } from './discharge-orders.service';
import { DischargePlansService } from './discharge-plans.service';
import { DIS_LEAVE, DIS_WARD } from './discharge-roles';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeOrder, DischargeOrderDocument, OPEN_ORDER_STATES, OrderState } from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';

const GATE_PASS_COUNTER = 'discharge-gatepass';
const GATE_PASS_PREFIX = 'GP';
const COMPLETED = 'discharge.completed';
const WINDOW_OPENED = 'discharge.window-opened';
const READY = 'discharge.ready';
const LEFT_WITHOUT: CompletionKind = 'left-without-discharge';
/** A16: absconding is a safety event, so it reaches the Duty administrator, then the Medical superintendent. */
const LEFT_WITHOUT_LADDER = 'default';
const REASON_MAX = 300;
const NOT_FINISHED = "The checklist isn't finished";
const CHANGED = 'Something changed on the checklist';
const PLAN_COMPLETE = 'This discharge is complete.';
const ALREADY_LEFT = 'The patient has already left.';
/**
 * R45/R51: a stay with no valid gate pass to reprint: it ended with none (a death, Left without discharge with no pass),
 * or it ended as Left without discharge even though a pass was printed while it was Ready (the patient walked out
 * without a discharge, so that pass is not valid).
 */
const NO_PASS = 'No gate pass was printed for this discharge.';
/** R44: a deceased patient is never marked Left without discharge. */
const DEATH_IS_RELEASED = 'Use Body released for a death.';

/** How each ending leaves the patient's status (A7). */
const PATIENT_STATUS: Record<CompletionKind, NonNullable<DischargeBedOptions['patientStatus']>> = {
  home: 'Discharged',
  transfer: 'Discharged',
  'against-advice': 'Discharged',
  died: 'Deceased',
  'left-without-discharge': 'Left without discharge',
};
/**
 * R52: a Left-without-discharge claim this old, on a plan that never completed, was cut short by a crash: recording it
 * takes seconds. Measured from the claim's own `at` (clinic clock). Ten minutes is far past any request still in flight.
 */
export const STALE_CLAIM_MS = 10 * 60_000;
/** Who the one-minute pass acts as when an ending's record names no one. */
const REPAIR_ACTOR = { id: 'discharge-agent', name: 'Discharge Agent' };
/** The ending, as `discharge.completed` summaries name it. */
const endingWhat = (kind: CompletionKind) => (kind === 'died' ? 'Body released' : 'Patient left');

const BALANCE_DUE = 'Balance due: billing informed';
const REFUND_DUE = 'Refund due: billing informed';
const NO_BILL = 'No bill: cleared by an admin';

/**
 * What the gate pass says about money. Home and Against advice reach the pass only with nothing due, so for them it
 * is one of the last four; a transfer never waits for the bill, so it may say the balance is due and billing knows.
 * "Nothing due" is a final bill with nothing owed that the desk has not settled yet; "No bill" the admin's override
 * on a stay Revenue never billed.
 */
export type GatePassBillLine = `Bill settled: ${string}` | `Nothing due: ${string}` | typeof BALANCE_DUE | typeof REFUND_DUE | typeof NO_BILL;

/** The printed gate pass (A5 paper). Only the `patient` block names the patient: the pass is a staff printout. */
export interface GatePassView {
  /** GP-0001. */
  number: string;
  /** Printed before: the pass says REPRINT. */
  reprint: boolean;
  patient: { name: string; uhid: string };
  bedLabel: string;
  /** Clinic clock. */
  admittedAt: Date;
  /** Clinic clock. */
  plannedLeaveAt: Date;
  /** The stay's bills as they stand at this print; after leaving, the line the patient's pass said (R49). */
  billLine: GatePassBillLine;
  /** Who printed it first, and when (clinic clock): a reprint is a copy of that pass. */
  issuedBy: string;
  issuedAt: Date;
  /** Settings → Discharge. */
  header: string;
}

export interface LeftWithoutDischargeInput {
  /** 1 to 300 characters. Kept on the plan, never in a message or an escalation. */
  reason: string;
  /** Clinic clock: from the admission to now. */
  lastSeenAt: Date | string;
}

type BillFacts = { number: string; state: BillState; totals?: { balance?: number } };
type AdmissionFacts = { bed: Types.ObjectId; admittedAt: Date; status: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const by = (actor: Actor) => ({ id: actor.id, name: actor.name });

/** Trimmed text of `min` to `max` characters, or 400. */
function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new BadRequestException(`${field} must be ${min} to ${max} characters.`);
  return t;
}

function moment(v: unknown, field: string): Date {
  const d = v instanceof Date ? new Date(v.getTime()) : typeof v === 'string' && v.trim() ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) throw new BadRequestException(`${field} must be a date and time.`);
  return d;
}

const stateRefusal = (state: OrderState | undefined): string =>
  state === 'cancelled' ? 'This discharge order was cancelled.' : state === 'left' ? ALREADY_LEFT : 'Discharge order not found';

/**
 * Where a stay ends (design 4.5, 4.6). The gate pass prints only while the order is Ready, so a Home or Against-advice
 * patient never gets one while money is owed (a transfer and a death never wait for the bill). Patient left (after a
 * printed pass) and Body released (a death, no pass) read the checklist again, end the order in one guarded move, and
 * end the stay through the Bed Agent's own discharge; Left without discharge records a patient who has already gone,
 * on any stay, with or without an order. Each ending completes the plan with its kind and sends `discharge.completed`,
 * which stops the clocks and makes Pharmacy cancel what still waits. A stay ends once: of two presses at once, one
 * wins and the other is 409; a Bed Agent failure puts the order back only while the stored stay is untouched. Times are
 * on the clinic clock.
 */
@Injectable()
export class DischargeLeavingService {
  private readonly logger = new Logger(DischargeLeavingService.name);

  /** The clinic clock (R7); a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly registration: DischargeRegistration,
    private readonly plansService: DischargePlansService,
    /** For the shared window-race step (I1) and the case rule (R24). */
    private readonly ordersService: DischargeOrdersService,
    private readonly lines: DischargeLinesService,
    private readonly settings: DischargeSettingsService,
    private readonly beds: BedsService,
    private readonly escalations: EscalationsService,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    /** Read only: the stay's bed and admission time. */
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    /** Read only: whether the stay's bed still holds it, after a Bed Agent step failed (review I1). */
    @InjectModel(Bed.name) private readonly bedDocs: Model<BedDocument>,
    /** Read only: the stay's admission bills, for the gate pass. */
    @InjectModel(Bill.name) private readonly bills: Model<BillDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    /**
     * Read only: whether `bed.discharged` went for a stay, for the one-minute pass. Absent only where the service is
     * built by hand (specs); without it a stay's announcement is taken as sent.
     */
    private readonly messages?: MessagesService,
  ) {}

  // ---------- the gate pass ----------

  /**
   * Prints the gate pass (Home, Transfer, Against advice) once the order is Ready, after reading the checklist again:
   * a change no agent announces (a charge on a final bill, say) must never print one. The first print takes the next
   * GP number; every print is recorded, and a later one is a REPRINT of the same pass. R45: once the patient has left,
   * the stored pass reprints ("Left today"), with no Ready check and no new number; a stay that ended without one, or
   * as Left without discharge (R51), is 409. 403 for other roles than a nurse, the front desk or an admin; 400 for a death; 409 "The checklist isn't
   * finished: <lines>".
   */
  async gatePass(actor: Actor, orderId: string): Promise<GatePassView> {
    this.mayLeave(actor);
    const order = await this.orderOf(orderId);
    if (order.state === 'left') return this.reprintLeft(order);
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    if (order.kind === 'died') throw new BadRequestException('A death has no gate pass: use Body released.');
    const fresh = await this.lines.refresh(String(order._id));
    this.mustBeReady(fresh, NOT_FINISHED);
    const [plan, admission, billLine] = await Promise.all([this.planOf(fresh.plan), this.admissionOf(fresh.admission), this.billLine(fresh)]);
    const now = this.clock();
    let printed: DischargeOrderDocument | null = null;
    let reprint = !!fresh.gatePass?.number;
    if (!reprint) {
      const number = await this.nextNumber();
      printed = await this.orders
        .findOneAndUpdate(
          { _id: fresh._id, state: 'ready', gatePass: null },
          { $set: { gatePass: { number, printedAt: [now], by: by(actor), billLine } } },
          { new: true },
        )
        .exec();
      // Another first print got there a moment ago: this is its reprint, and the number taken here is skipped.
      reprint = !printed;
    }
    // R49: every print while Ready stores the money line it printed, so the pass the patient leaves with is kept.
    printed ??= await this.orders
      .findOneAndUpdate(
        { _id: fresh._id, state: 'ready', 'gatePass.number': { $exists: true } },
        { $push: { 'gatePass.printedAt': now }, $set: { 'gatePass.billLine': billLine } },
        { new: true },
      )
      .exec();
    if (!printed?.gatePass) throw await this.lost(fresh._id);
    return this.passView(printed, reprint, plan, admission, billLine);
  }

  /**
   * R45: the pass of a patient who has left, printed again. The same number; each print is still recorded. R49: it is a
   * copy of the pass the patient left with, so its money line is the one stored at the last print while Ready, never
   * today's bills (a late charge on a continuation bill does not rewrite it). A pass printed before R49 stored none: it
   * falls back to the bills as they stand.
   */
  private async reprintLeft(order: DischargeOrderDocument): Promise<GatePassView> {
    // R51: a patient who walked out without a discharge has no valid pass, even one printed while the order was Ready.
    if (!order.gatePass?.number || order.endedAs === LEFT_WITHOUT) throw new ConflictException(NO_PASS);
    const [plan, admission] = await Promise.all([this.planOf(order.plan), this.admissionOf(order.admission)]);
    const printed = await this.orders
      .findOneAndUpdate({ _id: order._id, state: 'left', 'gatePass.number': order.gatePass.number }, { $push: { 'gatePass.printedAt': this.clock() } }, { new: true })
      .exec();
    if (!printed?.gatePass) throw await this.lost(order._id);
    const billLine = (printed.gatePass.billLine as GatePassBillLine | undefined) ?? (await this.billLine(printed));
    return this.passView(printed, true, plan, admission, billLine);
  }

  /** What the printed pass says: the stay's facts, the first print's issuer and time, and the money line given. */
  private async passView(
    printed: DischargeOrderDocument,
    reprint: boolean,
    plan: DischargePlanDocument,
    admission: AdmissionFacts,
    billLine: GatePassBillLine,
  ): Promise<GatePassView> {
    const gatePass = printed.gatePass!;
    const config = await this.settings.get();
    return {
      number: gatePass.number,
      reprint,
      patient: { name: plan.patientName, uhid: plan.patientUhid },
      bedLabel: plan.bedLabel,
      admittedAt: admission.admittedAt,
      plannedLeaveAt: printed.plannedLeaveAt,
      billLine,
      issuedBy: gatePass.by.name,
      issuedAt: gatePass.printedAt[0],
      header: config.gatePassHeader,
    };
  }

  /**
   * The money line, from the stay's admission bills as they stand: settled (with the numbers), nothing due on a final
   * bill not yet settled, a refund owed (the hospital's money never holds anyone), or, for a transfer whose bill line
   * is not done, a balance billing already knows about. The admin's no-bill override says so.
   */
  private async billLine(order: DischargeOrderDocument): Promise<GatePassBillLine> {
    const bills = await this.bills
      .find({ kind: 'admission', admission: order.admission })
      .sort({ openedAt: 1, _id: 1 })
      .select('number state totals')
      .lean<BillFacts[]>()
      .exec();
    const balance = (b: BillFacts) => b.totals?.balance ?? 0;
    // Only a transfer gets here with the line not done: Home and Against advice are not Ready without it.
    if (order.lines.find((l) => l.key === 'bill')?.state !== 'done' || bills.some((b) => balance(b) > 0 || b.state === 'open')) return BALANCE_DUE;
    if (!bills.length) return NO_BILL;
    if (bills.some((b) => balance(b) < 0)) return REFUND_DUE;
    const numbers = bills.map((b) => b.number).join(', ');
    return bills.every((b) => b.state === 'settled') ? `Bill settled: ${numbers}` : `Nothing due: ${numbers}`;
  }

  // ---------- leaving ----------

  /**
   * Patient left (Home, Transfer, Against advice), after the gate pass. 403 for other roles than a nurse, the front
   * desk or an admin; 400 for a death; 409 with no printed pass, or "Something changed on the checklist: <lines>" when
   * the checklist read again is no longer Ready. The patient's status becomes Discharged.
   */
  async left(actor: Actor, orderId: string): Promise<DischargeOrderDocument> {
    this.mayLeave(actor);
    const order = await this.openOrder(orderId);
    if (order.kind === 'died') throw new BadRequestException('For a death, use Body released.');
    if (!order.gatePass?.number) throw new ConflictException('Print the gate pass first.');
    return this.leave(actor, order, CHANGED, 'Discharged', 'Patient left');
  }

  /**
   * Body released (Died), with no gate pass. The bill never holds a body (it shows, never blocks). 403 as for Patient
   * left; 400 for an order that is not a death; 409 "The checklist isn't finished: <lines>". The patient's status
   * becomes Deceased. The bill stays Revenue's task, and the case stays open until it is settled.
   */
  async bodyReleased(actor: Actor, orderId: string): Promise<DischargeOrderDocument> {
    this.mayLeave(actor);
    const order = await this.openOrder(orderId);
    if (order.kind !== 'died') throw new BadRequestException('Body released is only for a death. Use Patient left.');
    return this.leave(actor, order, NOT_FINISHED, 'Deceased', 'Body released');
  }

  /**
   * The checklist is read again (the backstop for changes no agent announces), then `ready → left` is one guarded
   * move, also guarded on the stored lines still holding Ready (a refresh may have just written a waiting line and not
   * yet moved the order), so two presses at once end the stay once; the Bed Agent's own guard (admission plus bed) is
   * the second line. The bed is freed through `BedsService.discharge` (the admission discharged at this moment, the bed
   * to cleaning, the patient's status, `bed.discharged`). If it fails, the stored stay decides (review I1): untouched,
   * the order is put back and the error reported; already ended (a later Bed Agent step failed), the leaving stands.
   * Then the plan completes with the kind and `discharge.completed` goes.
   */
  private async leave(
    actor: Actor,
    order: DischargeOrderDocument,
    refusal: string,
    patientStatus: NonNullable<DischargeBedOptions['patientStatus']>,
    what: string,
  ): Promise<DischargeOrderDocument> {
    const fresh = await this.lines.refresh(String(order._id));
    this.mustBeReady(fresh, refusal);
    const [plan, admission] = await Promise.all([this.planOf(fresh.plan), this.admissionOf(fresh.admission)]);
    const now = this.clock();
    const ended = await this.orders
      .findOneAndUpdate(
        { _id: fresh._id, state: 'ready', ...readyLinesFilter(fresh.kind) },
        { $set: { state: 'left', leftAt: now, leftBy: by(actor), endedAs: fresh.kind } },
        { new: true },
      )
      .exec();
    if (!ended) throw await this.lost(fresh._id);
    try {
      await this.beds.discharge(String(admission.bed), actor, String(fresh.admission), { viaDischarge: true, at: now, patientStatus });
    } catch (e) {
      if (await this.stayUntouched(fresh.admission)) {
        await this.reopen(ended._id, now, 'ready');
        throw e;
      }
      this.logger.error(`Discharge order ${String(ended._id)}: the stay ended, but a later Bed Agent step failed (${(e as Error).message}); the leaving stands`);
    }
    await this.complete(plan, fresh.kind, now);
    await this.announce(plan, ended, fresh.kind, now, what);
    return this.reread(ended._id);
  }

  /**
   * Left without discharge (design 4.6, A16): records a patient who has already gone, on any stay not yet complete,
   * with or without an order. A nurse or an admin only (403); a reason of 1 to 300 characters and a last-seen time from
   * the admission to now (400); 409 once the discharge is complete. The plan is claimed first, so it is recorded once.
   * An open order ends as `left` (ended as Left without discharge, so it is never timed); the stay ends through the Bed
   * Agent at the last-seen time, which stops bed days there, and the patient's status says what happened. The plan
   * completes with that kind, an escalation goes to the Duty administrator (the reason stays on the plan, never in the
   * escalation), and `discharge.completed` stops the clocks (`orderId` is '' with no order). Revenue asks for the final
   * bill on its own `bed.discharged`. 409 for a death order (R44: use Body released). A Bed Agent failure that left the
   * stay untouched undoes the claim and the order; one after the stay ended lets it stand (review I1).
   */
  async leftWithoutDischarge(actor: Actor, planId: string, input: LeftWithoutDischargeInput): Promise<DischargePlanDocument> {
    if (!actor || !DIS_WARD.includes(actor.role)) throw new ForbiddenException('Only a nurse or an admin can record a patient who left without discharge.');
    if (!isObj(input)) throw new BadRequestException('Send the reason and when the patient was last seen.');
    const reason = text(input.reason, 'The reason', 1, REASON_MAX);
    const lastSeenAt = moment(input.lastSeenAt, 'The last-seen time');
    const plan = await this.planOf(planId);
    if (plan.state === 'completed') throw new ConflictException(PLAN_COMPLETE);
    const admission = await this.admissionOf(plan.admission);
    const now = this.clock();
    if (lastSeenAt.getTime() > now.getTime()) throw new BadRequestException('The last-seen time cannot be in the future.');
    if (lastSeenAt.getTime() < new Date(admission.admittedAt).getTime()) throw new BadRequestException('The last-seen time cannot be before the admission.');
    if (admission.status !== 'active') throw new ConflictException('This stay has already ended.');
    if (await this.orders.exists({ plan: plan._id, state: { $in: OPEN_ORDER_STATES }, kind: 'died' }).exec()) throw new ConflictException(DEATH_IS_RELEASED);

    // `null` also matches a plan with no record at all.
    const claimed = await this.plans
      .findOneAndUpdate(
        { _id: plan._id, state: { $ne: 'completed' }, leftWithoutDischarge: null },
        { $set: { leftWithoutDischarge: { reason, lastSeenAt, by: by(actor), at: now } } },
        { new: true },
      )
      .exec();
    if (!claimed) {
      const state = (await this.plans.findById(plan._id).select('state').lean<{ state?: string }>().exec())?.state;
      throw new ConflictException(state === 'completed' ? PLAN_COMPLETE : 'Someone is recording this already. Reload and try again.');
    }
    let ended: DischargeOrderDocument | null = null;
    /** Undoes what this call changed: the order back as it was, and the claim. */
    const undo = async () => {
      if (ended) await this.reopen(ended._id as Types.ObjectId, lastSeenAt, ended.state);
      await this.plans
        .updateOne({ _id: claimed._id, 'leftWithoutDischarge.at': now, 'leftWithoutDischarge.by.id': actor.id }, { $unset: { leftWithoutDischarge: 1 } })
        .exec()
        .catch((err: Error) => this.logger.error(`Discharge plan ${String(claimed._id)}: Left without discharge not undone (${err.message})`));
    };
    try {
      ended = await this.endWithout(claimed._id as Types.ObjectId, lastSeenAt, actor);
      if (!ended) {
        // A Patient left (or Body released) in progress holds the order: that one ends the stay.
        if (await this.orders.exists({ plan: claimed._id, state: 'left' }).exec()) throw new ConflictException(ALREADY_LEFT);
        // R44: a death order given after the check above.
        if (await this.orders.exists({ plan: claimed._id, state: { $in: OPEN_ORDER_STATES }, kind: 'died' }).exec()) throw new ConflictException(DEATH_IS_RELEASED);
      }
    } catch (e) {
      await undo();
      throw e;
    }
    try {
      await this.beds.discharge(String(admission.bed), actor, String(plan.admission), { viaDischarge: true, at: lastSeenAt, patientStatus: 'Left without discharge' });
    } catch (e) {
      if (await this.stayUntouched(plan.admission)) {
        await undo();
        throw e;
      }
      this.logger.error(`Discharge plan ${String(claimed._id)}: the stay ended, but a later Bed Agent step failed (${(e as Error).message}); Left without discharge stands`);
    }
    await this.complete(claimed, LEFT_WITHOUT, lastSeenAt);
    // An order the doctor gave while this was being recorded (after the check above) is ended the same way.
    if (!ended) {
      try {
        ended = await this.endWithout(claimed._id as Types.ObjectId, lastSeenAt, actor);
      } catch (e) {
        this.logger.error(`Discharge plan ${String(claimed._id)}: an order given meanwhile was not ended (${(e as Error).message})`);
      }
    }
    await this.raiseLeft(claimed, ended);
    await this.announce(claimed, ended, LEFT_WITHOUT, lastSeenAt, 'Patient left');
    return this.planOf(claimed._id as Types.ObjectId);
  }

  /**
   * Ends the plan's open order as Left without discharge, in one guarded move; never a death order (R44). Returns the
   * order as it was before, or null.
   */
  private endWithout(planId: Types.ObjectId, lastSeenAt: Date, actor: Actor): Promise<DischargeOrderDocument | null> {
    return this.orders
      .findOneAndUpdate(
        { plan: planId, state: { $in: OPEN_ORDER_STATES }, kind: { $ne: 'died' } },
        { $set: { state: 'left', leftAt: lastSeenAt, leftBy: by(actor), endedAs: LEFT_WITHOUT } },
        { new: false },
      )
      .exec();
  }

  /** A16: the escalation the Duty administrator acknowledges in Tasks & Alerts (its own link, not a `discharge-` one). Never names the patient. */
  private async raiseLeft(plan: DischargePlanDocument, order: DischargeOrderDocument | null): Promise<void> {
    await this.quietly(`Discharge plan ${String(plan._id)}: the Left without discharge escalation was not raised`, async () => {
      await this.escalations.raise({
        ladder: LEFT_WITHOUT_LADDER,
        case: await this.caseFor(plan, order),
        reason: `Left without discharge — ${plan.bedLabel}`,
        source: { kind: 'discharge-left', id: String(plan._id) },
      });
    });
  }

  // ---------- the end of a stay ----------

  /**
   * The plan completes with how the stay ended (set here on every ending, R23a), and any morning reminder closes. The
   * bed is already freed, so a failure is logged, never thrown.
   */
  private async complete(plan: DischargePlanDocument, kind: CompletionKind, at: Date): Promise<void> {
    await this.quietly(`Discharge plan ${String(plan._id)}: not completed after the stay ended`, async () => {
      await this.plans.updateOne({ _id: plan._id }, { $set: { state: 'completed', completedAt: at, completedKind: kind } }).exec();
    });
    await this.plansService.closeReminder(String(plan._id));
  }

  /**
   * `discharge.completed`, naming the bed and the kind, never the patient, on the order's case (R24: else the plan's,
   * else the patient's). An order records it in `announced`; a stay with no order on its Left-without-discharge record.
   * I1: when the order ended while its window was claimed but not yet announced, its window-opened may start clocks
   * after this stop, so the stop is left due again for the one-minute pass. Never throws.
   */
  private async announce(plan: DischargePlanDocument, order: DischargeOrderDocument | null, kind: CompletionKind, leftAt: Date, what: string): Promise<void> {
    await this.quietly(`Discharge plan ${String(plan._id)}: ${COMPLETED} not sent`, async () => {
      await this.sendCompleted(plan, order, kind, leftAt, what);
      if (order?.windowOpenedAt && !order.announced.includes(WINDOW_OPENED)) await this.ordersService.stopDueAgain(order._id as Types.ObjectId, 'left');
    });
  }

  /**
   * `discharge.completed`, the same for the first send and a re-send (whose own `dedupeKey` keeps the Coordinator's
   * minute filter from taking it for the first, R31). Recorded once it went: in the order's `announced`, or on the
   * plan's Left-without-discharge record when no order ended the stay. True when it went.
   */
  private async sendCompleted(
    plan: DischargePlanDocument,
    order: DischargeOrderDocument | null,
    kind: CompletionKind,
    leftAt: Date,
    what: string,
    dedupeKey?: string,
  ): Promise<boolean> {
    const payload = {
      planId: String(plan._id),
      orderId: order ? String(order._id) : '',
      admissionId: String(plan.admission),
      bedLabel: plan.bedLabel,
      kind,
      leftAt,
    };
    const summary = `${plan.bedLabel}: ${what} (${KIND_LABEL[kind]})`;
    if (!(await this.registration.send(COMPLETED, await this.caseFor(plan, order), payload, summary, dedupeKey ? { dedupeKey } : {}))) return false;
    if (order) await this.orders.updateOne({ _id: order._id }, { $addToSet: { announced: COMPLETED } }).exec();
    else await this.plans.updateOne({ _id: plan._id }, { $set: { 'leftWithoutDischarge.announcedAt': new Date() } }).exec();
    return true;
  }

  // ---------- the one-minute pass ----------

  /**
   * R31: `discharge.completed` again for a completed stay whose message never went, under its own key: for the order
   * that ended it (from its `announced`), or for a Left without discharge with no order (from the plan's record). Only
   * once the plan is completed: an order that left on a plan that never completed is a half-ended stay, for
   * `repairLeft` to finish or put back. True when it went.
   */
  async resendCompleted(planId: string): Promise<boolean> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    if (plan?.state !== 'completed' || !plan.completedKind) return false;
    const order = await this.orders.findOne({ plan: plan._id, state: 'left' }).exec();
    if (!this.completedDue(plan, order)) return false;
    const kind = order ? (order.endedAs ?? order.kind) : plan.completedKind;
    return this.sendCompleted(plan, order, kind, this.endedAt(plan, order), endingWhat(kind), this.completedKey(plan, order));
  }

  /**
   * Task 11 M2, case "left with the bed still occupied" and its neighbours: an order that left (Patient left or Body
   * released) on a plan that never completed. A crash came between the guarded `ready → left` and the end of the
   * ending. The stored stay decides, as `leave` does after a Bed Agent failure (review I1): untouched (the admission
   * active, its bed holding it) and its end never announced, the order goes back to Ready, for the nurse to press
   * again; ended or half-ended (the bed freed, the admission discharged), or already announced, the ending is finished
   * (`finishEnding`). An order Left without discharge ended is its plan's claim's to decide (`repairClaim`). Returns
   * what it did, or null.
   */
  async repairLeft(orderId: string): Promise<'reopened' | 'finished' | null> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (order?.state !== 'left' || !order.leftAt) return null;
    const kind = order.endedAs ?? order.kind;
    if (kind === LEFT_WITHOUT) return null;
    const plan = await this.plans.findById(order.plan).exec();
    if (!plan || plan.state === 'completed') return null;
    const stay = await this.stayOf(order.admission);
    if (stay.status === 'active' && stay.holds && !order.announced.includes(COMPLETED)) {
      const back = await this.orders
        .updateOne({ _id: order._id, state: 'left', leftAt: order.leftAt }, { $set: { state: 'ready' }, $unset: { leftAt: 1, leftBy: 1, endedAs: 1 } })
        .exec();
      if (!back.modifiedCount) return null;
      this.logger.warn(`Discharge order ${String(order._id)}: left, but the stay never ended (a crash before the bed was freed); put back to Ready`);
      await this.refreshQuietly(order._id);
      return 'reopened';
    }
    await this.finishEnding(plan, order, kind, order.leftAt, order.leftBy);
    return 'finished';
  }

  /**
   * Task 11 M2, a stale Left-without-discharge claim: a plan that never completed whose claim is at least
   * `STALE_CLAIM_MS` old (R52), so a crash came after the claim. The stored stay decides (review I1): untouched and never
   * announced, the claim is undone, and an order it ended goes back to Ordered (its lines then decide Ready again); the
   * stay already ended or half-ended, the Left without discharge is finished: an open order ends the same way, the stay
   * ends at the last-seen time, the plan completes, the escalation is raised and `discharge.completed` goes. `now` is
   * the clinic clock. Returns what it did, or null (nothing to do, or not stale yet).
   */
  async repairClaim(planId: string, now: Date): Promise<'undone' | 'finished' | null> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    const claim = plan?.leftWithoutDischarge;
    if (!plan || plan.state === 'completed' || !claim?.at) return null;
    if (now.getTime() - new Date(claim.at).getTime() < STALE_CLAIM_MS) return null;
    const ended = await this.orders.findOne({ plan: plan._id, state: 'left', endedAs: LEFT_WITHOUT, leftAt: claim.lastSeenAt }).exec();
    const stay = await this.stayOf(plan.admission);
    if (stay.status === 'active' && stay.holds && !claim.announcedAt && !ended?.announced.includes(COMPLETED)) {
      // The order first, then the claim, as Left without discharge's own undo does.
      if (ended) {
        await this.orders
          .updateOne(
            { _id: ended._id, state: 'left', endedAs: LEFT_WITHOUT },
            { $set: { state: 'ordered' }, $unset: { leftAt: 1, leftBy: 1, endedAs: 1 }, $pull: { announced: READY } },
          )
          .exec();
      }
      const undone = await this.plans
        .updateOne({ _id: plan._id, state: { $ne: 'completed' }, 'leftWithoutDischarge.at': claim.at }, { $unset: { leftWithoutDischarge: 1 } })
        .exec();
      if (ended) await this.refreshQuietly(ended._id as Types.ObjectId);
      if (!undone.modifiedCount) return null;
      this.logger.warn(`Discharge plan ${String(plan._id)}: a Left without discharge claim was never finished (a crash after the claim); undone`);
      return 'undone';
    }
    const actor = { id: claim.by?.id ?? REPAIR_ACTOR.id, name: claim.by?.name ?? REPAIR_ACTOR.name, role: UserRole.ADMIN };
    // An order the claim never reached (given meanwhile) ends the same way.
    const open = await this.endWithout(plan._id as Types.ObjectId, claim.lastSeenAt, actor);
    const order = open ? await this.orders.findById(open._id).exec() : ended;
    await this.finishEnding(plan, order, LEFT_WITHOUT, claim.lastSeenAt, claim.by);
    await this.raiseLeft(plan, order);
    this.logger.warn(`Discharge plan ${String(plan._id)}: a Left without discharge cut short after the stay ended; finished`);
    return 'finished';
  }

  /**
   * Task 11 M2, a completed stay checked once (`endingCheckedAt`): the stay must have ended the way the plan says. An
   * admission still active is ended, in its bed through the Bed Agent's discharge, or, its bed already freed, by
   * `BedsService.finishDischarge`; a patient whose status was never set gets it; a missing `bed.discharged` or
   * `discharge.completed` goes. A plan completed outside the agent (no kind) is not the agent's ending. True when it
   * changed anything.
   */
  async checkEnding(planId: string): Promise<boolean> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    if (plan?.state !== 'completed' || !plan.completedKind || plan.endingCheckedAt) return false;
    const order = await this.orders.findOne({ plan: plan._id, state: 'left' }).exec();
    return this.finishEnding(plan, order, plan.completedKind, this.endedAt(plan, order), order?.leftBy ?? plan.leftWithoutDischarge?.by);
  }

  /**
   * Makes an ending whole from the stored stay, as the ending itself would have: an admission still in its bed ends
   * through `BedsService.discharge`; any other real admission goes to `BedsService.finishDischarge`, which ends one
   * whose bed was already freed, sets a status never set, and announces `bed.discharged` when none went for the stay.
   * Then the plan completes with the kind, `discharge.completed` goes if it never did, and the plan is marked checked.
   * A Bed Agent failure throws, before the mark, so the next pass tries again. True when it changed anything.
   */
  private async finishEnding(
    plan: DischargePlanDocument,
    order: DischargeOrderDocument | null,
    kind: CompletionKind,
    at: Date,
    who?: { id?: string; name: string },
  ): Promise<boolean> {
    const actor = { id: who?.id || REPAIR_ACTOR.id, name: who?.name || REPAIR_ACTOR.name, role: UserRole.ADMIN };
    const patientStatus = PATIENT_STATUS[kind];
    const stay = await this.stayOf(plan.admission);
    let changed = false;
    if (stay.status === 'active' && stay.holds) {
      await this.beds.discharge(String(stay.bed), actor, String(plan.admission), { viaDischarge: true, at, patientStatus });
      changed = true;
    } else if (stay.status && !stay.sample) {
      const announce = !(await this.bedAnnounced(plan.admission));
      changed = await this.beds.finishDischarge(String(plan.admission), actor, { at, patientStatus, announce });
    }
    if (plan.state !== 'completed') {
      await this.complete(plan, kind, at);
      changed = true;
    }
    const [current, ending] = await Promise.all([this.plans.findById(plan._id).exec(), order ? this.orders.findById(order._id).exec() : null]);
    if (current && this.completedDue(current, ending) && (await this.sendCompleted(current, ending, kind, at, endingWhat(kind), this.completedKey(current, ending)))) {
      changed = true;
    }
    await this.plans.updateOne({ _id: plan._id }, { $set: { endingCheckedAt: new Date() } }).exec();
    return changed;
  }

  /** Whether the stay's `discharge.completed` is still to go: the ending order's `announced` lacks it, or, with no order, the plan's record. */
  private completedDue(plan: DischargePlanDocument, order: DischargeOrderDocument | null): boolean {
    if (order) return !order.announced.includes(COMPLETED);
    return !!plan.leftWithoutDischarge?.at && !plan.leftWithoutDischarge.announcedAt;
  }

  /** A re-sent `discharge.completed`'s own key (R31). */
  private completedKey(plan: DischargePlanDocument, order: DischargeOrderDocument | null): string {
    return order ? `${COMPLETED}:${String(order._id)}:resend` : `${COMPLETED}:plan:${String(plan._id)}:resend`;
  }

  /** When the stay ended (clinic clock): the order's leaving, else the last-seen time, else the plan's completion. */
  private endedAt(plan: DischargePlanDocument, order: DischargeOrderDocument | null): Date {
    return order?.leftAt ?? plan.leftWithoutDischarge?.lastSeenAt ?? plan.completedAt ?? this.clock();
  }

  /** The stay as stored: the admission's status (null when it is gone), whether it is a sample, its bed, and whether that bed still holds it. */
  private async stayOf(admissionId: Types.ObjectId): Promise<{ status: string | null; sample: boolean; bed?: Types.ObjectId; holds: boolean }> {
    const a = await this.admissions.findById(admissionId).select('status bed sample').lean<{ status: string; bed?: Types.ObjectId; sample?: boolean }>().exec();
    if (!a) return { status: null, sample: false, holds: false };
    const holds = a.bed ? !!(await this.bedDocs.exists({ _id: a.bed, admission: admissionId }).exec()) : false;
    return { status: a.status, sample: !!a.sample, bed: a.bed, holds };
  }

  /** Whether the Bed Agent's `bed.discharged` for this stay is in the Coordinator's message log. */
  private async bedAnnounced(admissionId: Types.ObjectId): Promise<boolean> {
    if (!this.messages) return true;
    return !!(await this.messages.findOne('bed.discharged', { admissionId: String(admissionId) }));
  }

  /** The checklist read again after an order was put back; a failure is logged, and the pass refreshes it next minute. */
  private async refreshQuietly(orderId: Types.ObjectId): Promise<void> {
    try {
      await this.lines.refresh(String(orderId));
    } catch (e) {
      this.logger.warn(`Discharge order ${String(orderId)}: checklist not refreshed after it was put back (${(e as Error).message})`);
    }
  }

  /**
   * Review I1: after `BedsService.discharge` threw, whether the stay is exactly as it was, read from the stored records:
   * the admission still active and its bed still holding it. Its writes go bed, admission, patient status, message, so
   * a throw after the first leaves the stay ended, and putting the order back would loop on "not occupied" forever. A
   * read that fails counts as untouched: the order is put back, and a retry decides from the records again.
   */
  private async stayUntouched(admissionId: Types.ObjectId): Promise<boolean> {
    try {
      const admission = await this.admissions.findById(admissionId).select('status bed').lean<{ status?: string; bed?: Types.ObjectId }>().exec();
      if (admission?.status !== 'active' || !admission.bed) return false;
      return !!(await this.bedDocs.exists({ _id: admission.bed, admission: admissionId }).exec());
    } catch (e) {
      this.logger.error(`Admission ${String(admissionId)}: not read after the Bed Agent failed (${(e as Error).message}); treated as untouched`);
      return true;
    }
  }

  /** Puts an order the bed could not follow back as it was. Logged when even that fails. */
  private async reopen(orderId: Types.ObjectId, leftAt: Date, state: OrderState): Promise<void> {
    try {
      await this.orders
        .updateOne({ _id: orderId, state: 'left', leftAt }, { $set: { state }, $unset: { leftAt: 1, leftBy: 1, endedAs: 1 } })
        .exec();
    } catch (e) {
      this.logger.error(`Discharge order ${String(orderId)}: the bed was not freed and the order could not be put back (${(e as Error).message})`);
    }
  }

  // ---------- helpers ----------

  private mayLeave(actor: Actor): void {
    if (!actor || !DIS_LEAVE.includes(actor.role)) throw new ForbiddenException('Only a nurse, the front desk or an admin can do this.');
  }

  /** 409 unless the order (just read again) is still open and Ready, naming the required lines not done. */
  private mustBeReady(order: DischargeOrderDocument, refusal: string): void {
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    const gaps = missing(order);
    if (gaps.length) throw new ConflictException(`${refusal}: ${gaps.map((k) => LINE_LABEL(k, order.kind)).join(', ')}`);
    if (order.state !== 'ready') throw new ConflictException(`${CHANGED}. Reload and try again.`);
  }

  /** Why a guarded move on an order missed: it ended meanwhile, or its checklist moved. */
  private async lost(orderId: Types.ObjectId): Promise<ConflictException> {
    const state = (await this.orders.findById(orderId).select('state').lean<{ state?: OrderState }>().exec())?.state;
    return new ConflictException(state && OPEN_ORDER_STATES.includes(state) ? `${CHANGED}. Reload and try again.` : stateRefusal(state));
  }

  /** GP-0001 style numbers from the shared counter collection (Revenue's `nextNumber`). Atomic; a lost race skips one. */
  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: GATE_PASS_COUNTER }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `${GATE_PASS_PREFIX}-${String(c.last).padStart(4, '0')}`;
  }

  /** R24: the order's case, else the plan's, else the patient's open (or newest) case; null when there is none. */
  private async caseFor(plan: DischargePlanDocument, order: DischargeOrderDocument | null): Promise<string | null> {
    if (order?.case) return String(order.case);
    return this.ordersService.caseOf(plan);
  }

  /** After the stay ended nothing undoes it: a failed step is logged, for the one-minute pass to repair. */
  private async quietly(what: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (e) {
      this.logger.error(`${what} (${(e as Error).message})`);
    }
  }

  /** The order, in any state, else 404. */
  private async orderOf(orderId: string): Promise<DischargeOrderDocument> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!order) throw new NotFoundException('Discharge order not found');
    return order;
  }

  /** An order still in progress, else 404 or 409. */
  private async openOrder(orderId: string): Promise<DischargeOrderDocument> {
    const order = await this.orderOf(orderId);
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    return order;
  }

  private async planOf(planId: string | Types.ObjectId): Promise<DischargePlanDocument> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).exec() : null;
    if (!plan) throw new NotFoundException('Discharge plan not found');
    return plan;
  }

  private async admissionOf(admissionId: Types.ObjectId): Promise<AdmissionFacts> {
    const admission = await this.admissions.findById(admissionId).select('bed admittedAt status').lean<AdmissionFacts>().exec();
    if (!admission) throw new NotFoundException('The admission of this stay was not found');
    return admission;
  }

  private async reread(orderId: unknown): Promise<DischargeOrderDocument> {
    const order = await this.orders.findById(orderId).exec();
    if (!order) throw new NotFoundException('Discharge order not found');
    return order;
  }
}
