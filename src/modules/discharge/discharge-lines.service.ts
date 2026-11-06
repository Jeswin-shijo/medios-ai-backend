import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { MessagesService } from '../coordinator/messages.service';
import { FollowUpDocument, FollowUpItem } from '../follow-ups/schemas/follow-up.schema';
import { LabLine, LabLineDocument, LabLineStatus } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { PharmacyLine, PharmacyLineDocument, PharmacyLineStatus } from '../pharmacy/schemas/pharmacy-line.schema';
import { Bill, BillDocument, BillState } from '../revenue/schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from '../revenue/schemas/charge-line.schema';
import { UserRole } from '../users/schemas/user.schema';
import { KIND_LABEL, LINE_KEYS, LINE_LABEL, LINE_OWNER, LINE_RULE, LineKey } from './discharge-catalogue';
import { DischargeRegistration, WAKE_TYPES } from './discharge-coordinator.registration';
import {
  DischargeLineEntry,
  DischargeOrder,
  DischargeOrderDocument,
  LineState,
  OPEN_ORDER_STATES,
  OrderState,
  takeHomeOrderIds,
} from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';
import { DischargeSummary, DischargeSummaryDocument } from './schemas/discharge-summary.schema';

/** DIS_ORDER: the doctor's lines, "follow up later" and the "not needed" choices. */
const ORDER_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.DOCTOR];
/** DIS_WARD: the nurse's hand-ticked lines. */
const WARD_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.NURSE];
const READY = 'discharge.ready';
const NOTE_MAX = 300;
const REASON_MAX = 300;
const RECEIVER_MAX = 100;
/** A line in one of these states never holds Ready. */
const COMPLETE: readonly LineState[] = ['done', 'not-needed'];
/** Lines a person ticks done. */
const HAND_LINES: readonly LineKey[] = ['ama-form', 'teaching', 'death-certificate', 'body-handover'];
/** Agent lines the doctor may mark not needed. */
const CHOICE_LINES: readonly LineKey[] = ['take-home', 'follow-up'];
/** A Lab test with nothing more to come. */
const LAB_ENDED: readonly LabLineStatus[] = ['released', 'cancelled'];
/** A take-home medicine that is no longer waiting in Pharmacy. */
const TAKE_HOME_ENDED: readonly PharmacyLineStatus[] = ['issued', 'stopped', 'rejected', 'cancelled'];
const CHECK_WITH_BILLING = 'Check with billing';
const OVERRIDDEN = 'No bill found: marked done by an admin';

type ActorRefLike = { id?: string; name: string };
type LeanOrder = DischargeOrder & { _id: Types.ObjectId };
type Msg = { case: string | null; payload: Record<string, unknown> };
type BillFacts = { _id: Types.ObjectId; state: BillState; totals?: { balance?: number } };

export interface TickInput {
  state: 'done' | 'not-needed';
  /** At most 300 characters. */
  note?: string;
  /** Body handed over (Died) only, required: who received the body. */
  receiver?: { name: string; relationship: string };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const by = (actor: Actor) => ({ id: actor.id, name: actor.name });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The panel's short text: the parts that apply, joined by " · ". */
const joined = (parts: (string | false | null | undefined)[]): string | undefined => parts.filter(Boolean).join(' · ') || undefined;

/** Trimmed text of `min` to `max` characters, or 400. */
function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new BadRequestException(min ? `${field} must be ${min} to ${max} characters.` : `${field} is at most ${max} characters.`);
  return t;
}

/** A line as it is stored: only the fields it has, so an unchanged line compares equal. */
function entry(l: { key: LineKey; state: LineState; by?: ActorRefLike; at?: Date; note?: string; detail?: string }): DischargeLineEntry {
  return {
    key: l.key,
    state: l.state,
    ...(l.by ? { by: { id: l.by.id ?? '', name: l.by.name } } : {}),
    ...(l.at ? { at: new Date(l.at) } : {}),
    ...(l.note ? { note: l.note } : {}),
    ...(l.detail ? { detail: l.detail } : {}),
  };
}

function sameLine(a: DischargeLineEntry, b: DischargeLineEntry): boolean {
  const time = (d?: Date) => (d ? new Date(d).getTime() : null);
  return (
    a.state === b.state &&
    (a.detail ?? null) === (b.detail ?? null) &&
    (a.note ?? null) === (b.note ?? null) &&
    (a.by?.id ?? null) === (b.by?.id ?? null) &&
    (a.by?.name ?? null) === (b.by?.name ?? null) &&
    time(a.at) === time(b.at)
  );
}

/** Not needed, keeping who said so (the order form's choice, or a doctor's tick). */
const keepChoice = (key: LineKey, prev?: DischargeLineEntry): DischargeLineEntry =>
  entry({ key, state: 'not-needed', by: prev?.by, at: prev?.at, note: prev?.note });

const stateRefusal = (state: OrderState | undefined): string =>
  state === 'cancelled' ? 'This discharge order was cancelled.' : state === 'left' ? 'The patient has already left.' : 'Discharge order not found';

/**
 * The required lines (R) of the order's kind that are not done or not needed yet, in checklist order; a required
 * line missing from the record is missing too. Optional (O) and shown (S) lines never count: so a Transfer or a death
 * is never held for the bill.
 */
export function missing(order: Pick<DischargeOrder, 'kind' | 'lines'>): LineKey[] {
  const rule = LINE_RULE[order.kind];
  const states = new Map((order.lines ?? []).map((l) => [l.key, l.state]));
  return LINE_KEYS.filter((k) => rule[k] === 'R' && !COMPLETE.includes(states.get(k) as LineState));
}

/** Ready to leave: every required line is done or not needed. The gate pass and the leaving need it. */
export function isReady(order: Pick<DischargeOrder, 'kind' | 'lines'>): boolean {
  return missing(order).length === 0;
}

/**
 * The checklist (design 4.3). Agent lines are read from that agent's own records, the source of truth: Lab requests
 * and lines, Pharmacy take-home lines, the Scheduling follow-up, and Revenue's admission bills of the stay. The other
 * agents' messages only wake it, and the one-minute pass refreshes every open order. Hand lines are ticked by a person
 * and kept. Nothing here writes another agent's records. When every required line is done or not needed the order
 * moves `ordered → ready` and says so (`discharge.ready`, once per time it becomes ready); when one is no longer done it
 * moves back. Ticks and the override are on the clinic clock. Message handlers never throw.
 */
@Injectable()
export class DischargeLinesService {
  private readonly logger = new Logger(DischargeLinesService.name);

  /** The clinic clock (R7); a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly registration: DischargeRegistration,
    private readonly messages: MessagesService,
    private readonly cases: CasesService,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeSummary.name) private readonly summaries: Model<DischargeSummaryDocument>,
    /** Read only, each: the other agents' records the lines are read from. */
    @InjectModel(LabRequest.name) private readonly labRequests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly labLines: Model<LabLineDocument>,
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
    @InjectModel(FollowUpItem.name) private readonly followUps: Model<FollowUpDocument>,
    @InjectModel(Bill.name) private readonly bills: Model<BillDocument>,
    @InjectModel(ChargeLine.name) private readonly chargeLines: Model<ChargeLineDocument>,
  ) {
    // The bed.* types are the plans service's; every other type only wakes this one, which reads the records again.
    for (const type of WAKE_TYPES) {
      if (type.startsWith('bed.')) continue;
      const onMessage = type.startsWith('revenue.') ? (m: Msg) => this.onBill(m) : (m: Msg) => this.onCase(m);
      registration.wake.set(type, (id) => this.run(type, id, onMessage));
    }
  }

  /**
   * Reads every agent line again by the done rules and keeps the hand ticks, then moves the order `ordered ↔ ready`
   * (and its plan with it). A required line missing from the record is put back. Each line is written only over the
   * line as it was read, so a tick or the override that lands meanwhile is never undone. An order no longer open is
   * left as it is. 404 for an unknown order.
   */
  async refresh(orderId: string): Promise<DischargeOrderDocument> {
    const id = isValidObjectId(orderId) ? new Types.ObjectId(orderId) : null;
    const order = id ? await this.orders.findById(id).lean<LeanOrder>().exec() : null;
    if (!order) throw new NotFoundException('Discharge order not found');
    if (OPEN_ORDER_STATES.includes(order.state)) {
      const plan = await this.plans.findById(order.plan).select('case bedLabel').lean<{ case?: Types.ObjectId; bedLabel?: string }>().exec();
      const caseId = await this.caseOf(order, plan);
      await this.write(order, await this.wanted(order, caseId));
      await this.settleReady(order, caseId, plan?.bedLabel ?? null);
    }
    return this.reread(id!);
  }

  /** Refreshes the open orders of the case, or of its patient (an order may have no case of its own, R24). Returns how many. */
  async refreshCase(caseId: string): Promise<number> {
    if (!isValidObjectId(caseId)) return 0;
    const c = await this.cases.get(caseId);
    const or: Record<string, unknown>[] = [{ case: new Types.ObjectId(caseId) }];
    if (c?.patient) or.push({ patient: c.patient });
    return this.refreshEach(await this.orders.find({ state: { $in: OPEN_ORDER_STATES }, $or: or }).select('_id').lean().exec());
  }

  /** Refreshes the stay's open orders. Returns how many. */
  async refreshAdmission(admissionId: string): Promise<number> {
    if (!isValidObjectId(admissionId)) return 0;
    const open = await this.orders.find({ admission: new Types.ObjectId(admissionId), state: { $in: OPEN_ORDER_STATES } }).select('_id').lean().exec();
    return this.refreshEach(open);
  }

  /**
   * A person ticks a line. Hand lines (against-advice form, teaching and documents, cause-of-death certificate, body
   * handed over) are only marked done; take-home medicines and the follow-up only marked not needed (the doctor's
   * choice, kept as `noTakeHome` / `noFollowUp`, so every later refresh keeps it). A doctor's line or a "not needed"
   * needs a doctor or an admin; a nurse's line a nurse or an admin (403). The body handover names who received the
   * body. Stored with who, when (clinic clock) and the note. A line already in that state stays as the first tick left it.
   */
  async tick(actor: Actor, orderId: string, key: LineKey, input: TickInput): Promise<DischargeOrderDocument> {
    if (!(LINE_KEYS as readonly string[]).includes(key)) throw new BadRequestException('Unknown checklist line.');
    const hand = HAND_LINES.includes(key);
    if (!hand && !CHOICE_LINES.includes(key)) throw new BadRequestException("This line is read from the agents' records; it can't be ticked.");
    const nurseLine = LINE_OWNER[key] === 'nurse';
    if (!actor || !(nurseLine ? WARD_ROLES : ORDER_ROLES).includes(actor.role)) {
      throw new ForbiddenException(nurseLine ? 'Only a nurse or an admin can tick this line.' : 'Only a doctor or an admin can do this.');
    }
    if (!isObj(input)) throw new BadRequestException("Send the line's new state.");
    if (hand && input.state !== 'done') throw new BadRequestException('This line can only be marked done.');
    if (!hand && input.state !== 'not-needed') throw new BadRequestException("This line is done from the agent's records; it can only be marked not needed.");
    const note = given(input.note) ? text(input.note, 'The note', 0, NOTE_MAX) : '';
    if (key !== 'body-handover' && input.receiver !== undefined) throw new BadRequestException('Only the body handover names who received the body.');
    const receiver = key === 'body-handover' ? this.receiver(input.receiver) : null;

    const order = await this.openOrder(orderId);
    const line = order.lines.find((l) => l.key === key);
    if (LINE_RULE[order.kind][key] === '-' || !line) throw new BadRequestException(`${LINE_LABEL(key, order.kind)} is not on this checklist.`);
    if (line.state === input.state) return order;
    const set: Record<string, unknown> = { 'lines.$': entry({ key, state: input.state, by: by(actor), at: this.clock(), note }) };
    if (receiver) set.bodyReceiver = receiver;
    if (key === 'take-home') set.noTakeHome = true;
    if (key === 'follow-up') set.noFollowUp = true;
    const res = await this.orders
      .updateOne({ _id: order._id, state: { $in: OPEN_ORDER_STATES }, lines: { $elemMatch: { key, state: { $ne: input.state } } } }, { $set: set })
      .exec();
    if (!res.matchedCount) {
      const current = await this.orders.findById(order._id).exec();
      if (!current || !OPEN_ORDER_STATES.includes(current.state)) throw new ConflictException(stateRefusal(current?.state));
      if (current.lines.find((l) => l.key === key)?.state === input.state) return current;
      throw new ConflictException('The checklist just changed. Reload and try again.');
    }
    return this.refresh(String(order._id));
  }

  /**
   * A doctor or an admin puts a Lab request on the stay's case off as "follow up later": its results still arrive in
   * the Lab Agent as usual, but no longer hold the Lab line. A request with a critical result not yet acknowledged is
   * 409: a critical result is never put off. 400 for a kind with no Lab line; 404 for a request not on this stay.
   */
  async followUpLater(actor: Actor, orderId: string, requestId: string): Promise<DischargeOrderDocument> {
    if (!actor || !ORDER_ROLES.includes(actor.role)) throw new ForbiddenException('Only a doctor or an admin can put a result off to follow up later.');
    const order = await this.openOrder(orderId);
    if (LINE_RULE[order.kind].lab === '-') throw new BadRequestException(`A ${KIND_LABEL[order.kind].toLowerCase()} discharge has no Lab results line.`);
    const request = isValidObjectId(requestId)
      ? await this.labRequests.findById(requestId).select('case').lean<{ _id: Types.ObjectId; case?: Types.ObjectId }>().exec()
      : null;
    const plan = await this.plans.findById(order.plan).select('case').lean<{ case?: Types.ObjectId }>().exec();
    const caseId = await this.caseOf(order, plan);
    if (!request || !caseId || String(request.case) !== caseId) throw new NotFoundException('Lab request not found on this stay.');
    if (await this.labLines.exists({ request: request._id, 'critical.active': true, 'critical.ackAt': null }).exec()) {
      throw new ConflictException('A critical result on this request is not acknowledged yet. It must be acknowledged, never put off.');
    }
    const res = await this.orders
      .updateOne({ _id: order._id, state: { $in: OPEN_ORDER_STATES } }, { $addToSet: { followUpLater: String(request._id) } })
      .exec();
    if (!res.matchedCount) throw new ConflictException(stateRefusal((await this.orders.findById(order._id).select('state').lean<{ state?: OrderState }>().exec())?.state));
    return this.refresh(String(order._id));
  }

  /**
   * An admin marks the bill line done with a reason (1 to 300 characters) when the stay has no admission bill at all
   * (Revenue was down when the stay began, say). It holds only while there is no bill: once Revenue opens one, the line
   * follows it again. 403 for other roles; 409 when a bill exists.
   */
  async overrideBill(actor: Actor, orderId: string, reason: string): Promise<DischargeOrderDocument> {
    if (!actor || actor.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can mark the bill line done.');
    const why = text(reason, 'The reason', 1, REASON_MAX);
    const order = await this.openOrder(orderId);
    if (await this.bills.exists({ kind: 'admission', admission: order.admission }).exec()) {
      throw new ConflictException('This stay has a bill: the line follows it.');
    }
    const line = order.lines.find((l) => l.key === 'bill');
    if (!line) throw new BadRequestException('Nothing due on the bill is not on this checklist.');
    if (line.state === 'done') return order;
    const res = await this.orders
      .updateOne(
        { _id: order._id, state: { $in: OPEN_ORDER_STATES }, lines: { $elemMatch: { key: 'bill', state: { $ne: 'done' } } } },
        { $set: { 'lines.$': entry({ key: 'bill', state: 'done', by: by(actor), at: this.clock(), note: why, detail: OVERRIDDEN }) } },
      )
      .exec();
    if (!res.matchedCount) {
      const current = await this.orders.findById(order._id).exec();
      if (!current || !OPEN_ORDER_STATES.includes(current.state)) throw new ConflictException(stateRefusal(current?.state));
      if (current.lines.find((l) => l.key === 'bill')?.state === 'done') return current;
      throw new ConflictException('The checklist just changed. Reload and try again.');
    }
    return this.refresh(String(order._id));
  }

  /** See the exported `isReady`. */
  isReady(order: Pick<DischargeOrder, 'kind' | 'lines'>): boolean {
    return isReady(order);
  }

  /** See the exported `missing`. */
  missing(order: Pick<DischargeOrder, 'kind' | 'lines'>): LineKey[] {
    return missing(order);
  }

  // ---------- the lines ----------

  /**
   * The lines the order should have now, as the records say: the agent lines read again, a missing required hand
   * line waiting. Lines the kind does not show are left out, and an optional line only once it is filled in (or
   * already shown). A hand line already on the record is not here: refresh never touches a tick.
   */
  private async wanted(order: LeanOrder, caseId: string | null): Promise<DischargeLineEntry[]> {
    const rule = LINE_RULE[order.kind];
    const stored = new Map(order.lines.map((l) => [l.key, l]));
    const out: DischargeLineEntry[] = [];
    for (const key of LINE_KEYS) {
      if (rule[key] === '-') continue;
      const prev = stored.get(key);
      const filled = key === 'take-home' ? takeHomeOrderIds(order).length > 0 : key === 'follow-up' ? !!order.followUp : false;
      if (rule[key] === 'O' && !prev && !filled) continue;
      switch (key) {
        case 'order':
          // R5: done from the order's creation, by the ordering doctor.
          out.push(entry({ key, state: 'done', by: prev?.by ?? order.orderedBy, at: prev?.at ?? order.orderedAt }));
          break;
        case 'summary':
          out.push(await this.summaryLine(order));
          break;
        case 'lab':
          out.push(await this.labLine(order, caseId));
          break;
        case 'take-home':
          out.push(await this.takeHomeLine(order, prev));
          break;
        case 'follow-up':
          out.push(await this.followUpLine(order, prev));
          break;
        case 'bill':
          out.push(await this.billLine(order, prev));
          break;
        default:
          if (!prev) out.push(entry({ key, state: 'waiting' }));
      }
    }
    return out;
  }

  /** R5: done once the summary is signed (by and when); waiting again after "Edit and re-sign" unlocks it. */
  private async summaryLine(order: LeanOrder): Promise<DischargeLineEntry> {
    const s = await this.summaries
      .findOne({ order: order._id })
      .select('signedAt signedBy versions')
      .lean<{ signedAt?: Date; signedBy?: ActorRefLike; versions?: unknown[] }>()
      .exec();
    if (s?.signedAt) return entry({ key: 'summary', state: 'done', by: s.signedBy, at: s.signedAt });
    return entry({ key: 'summary', state: 'waiting', detail: s?.versions?.length ? 'Unlocked: sign it again' : undefined });
  }

  /**
   * Done when every test of the stay case's requests is released or cancelled, or belongs to a request put off as
   * "follow up later"; and no critical result anywhere on the case waits for its acknowledgement (that holds the line
   * even on a request put off).
   */
  private async labLine(order: LeanOrder, caseId: string | null): Promise<DischargeLineEntry> {
    const requests = caseId ? await this.labRequests.find({ case: new Types.ObjectId(caseId) }).select('_id').lean().exec() : [];
    const tests = requests.length
      ? await this.labLines
          .find({ request: { $in: requests.map((r) => r._id) } })
          .select('request status critical')
          .lean<{ request: Types.ObjectId; status: LabLineStatus; critical?: { active?: boolean; ackAt?: Date } }[]>()
          .exec()
      : [];
    const later = new Set((order.followUpLater ?? []).map(String));
    let waiting = 0;
    let putOff = 0;
    let critical = 0;
    for (const t of tests) {
      if (t.critical?.active && !t.critical.ackAt) critical += 1;
      if (LAB_ENDED.includes(t.status)) continue;
      if (later.has(String(t.request))) putOff += 1;
      else waiting += 1;
    }
    if (waiting || critical) {
      return entry({
        key: 'lab',
        state: 'waiting',
        detail: joined([critical && `${plural(critical, 'critical result')} to acknowledge`, waiting && `${plural(waiting, 'result')} waiting`]),
      });
    }
    return entry({ key: 'lab', state: 'done', detail: putOff ? `${plural(putOff, 'result')} to follow up later` : undefined });
  }

  /**
   * Not needed when the doctor chose no take-home medicines. Otherwise done when every line of every take-home order
   * is issued, stopped, rejected or cancelled. Never done with nothing to read: no take-home order, or one whose
   * medicines can't be found, waits.
   */
  private async takeHomeLine(order: LeanOrder, prev?: DischargeLineEntry): Promise<DischargeLineEntry> {
    if (order.noTakeHome) return keepChoice('take-home', prev);
    const ids = takeHomeOrderIds(order).filter((i) => isValidObjectId(i));
    if (!ids.length) return entry({ key: 'take-home', state: 'waiting', detail: 'No take-home medicines ordered yet' });
    const medicines = await this.pharmacyLines
      .find({ order: { $in: ids.map((i) => new Types.ObjectId(i)) } })
      .select('status')
      .lean<{ status: PharmacyLineStatus }[]>()
      .exec();
    if (!medicines.length) return entry({ key: 'take-home', state: 'waiting', detail: 'The take-home order has no medicines' });
    const open = medicines.filter((l) => !TAKE_HOME_ENDED.includes(l.status)).length;
    if (open) return entry({ key: 'take-home', state: 'waiting', detail: `${plural(open, 'medicine')} waiting in Pharmacy` });
    const count = (s: PharmacyLineStatus) => medicines.filter((l) => l.status === s).length;
    return entry({ key: 'take-home', state: 'done', detail: joined(TAKE_HOME_ENDED.map((s) => count(s) > 0 && `${count(s)} ${s}`)) });
  }

  /**
   * Not needed when the doctor said so. Otherwise done while Scheduling's follow-up is Scheduled (booked) or Pending
   * (on the waitlist: the desk will call with a time); anything else, or no follow-up at all, waits.
   */
  private async followUpLine(order: LeanOrder, prev?: DischargeLineEntry): Promise<DischargeLineEntry> {
    if (order.noFollowUp) return keepChoice('follow-up', prev);
    const followUpId = order.followUp?.followUpId;
    if (!followUpId) return entry({ key: 'follow-up', state: 'waiting', detail: 'No follow-up booked yet' });
    const item = isValidObjectId(followUpId)
      ? await this.followUps.findById(followUpId).select('status followUpDate followUpTime').lean<{ status: string; followUpDate?: string; followUpTime?: string }>().exec()
      : null;
    if (!item) return entry({ key: 'follow-up', state: 'waiting', detail: 'The follow-up was not found in Scheduling' });
    if (item.status === 'Scheduled') {
      const when = item.followUpDate ? `${item.followUpDate}${item.followUpTime ? ` at ${item.followUpTime}` : ''}` : '';
      return entry({ key: 'follow-up', state: 'done', detail: when ? `Booked: ${when}` : 'Booked' });
    }
    if (item.status === 'Pending') return entry({ key: 'follow-up', state: 'done', detail: 'On the waitlist: the desk will call' });
    return entry({ key: 'follow-up', state: 'waiting', detail: `The follow-up is ${String(item.status).toLowerCase()} in Scheduling` });
  }

  /**
   * Nothing due from the patient: every admission bill of the stay (continuation bills included; never a walk-in, OPD
   * or another stay's bill) is final or settled with a balance of zero or less. A refund owed never holds it (money the
   * hospital owes). R32 (Revenue's R20): an unpriced line is not "nothing due", so a final bill with a Needs price line
   * that is not reversed waits whatever its balance, a refund owed included; a settled bill is done whatever its lines
   * say, as settling is the desk's own decision. With no bill at all it needs a person, "Check with billing", unless an
   * admin overrode it, which holds while there is still no bill. A Transfer or a death shows it, never waits for it
   * (see `missing`).
   */
  private async billLine(order: LeanOrder, prev?: DischargeLineEntry): Promise<DischargeLineEntry> {
    const bills = await this.bills.find({ kind: 'admission', admission: order.admission }).select('state totals').lean<BillFacts[]>().exec();
    if (!bills.length) {
      // Only overrideBill sets `by` on the bill line.
      if (prev?.state === 'done' && prev.by) return entry({ ...prev, detail: OVERRIDDEN });
      return entry({ key: 'bill', state: 'needs-person', detail: CHECK_WITH_BILLING });
    }
    const balance = (b: BillFacts) => b.totals?.balance ?? 0;
    const due = bills.reduce((sum, b) => sum + Math.max(0, balance(b)), 0);
    // A settled bill's lines are never counted: the desk settled it as it was.
    const unsettled = bills.filter((b) => b.state !== 'settled').map((b) => b._id);
    const unpriced = unsettled.length
      ? await this.chargeLines.find({ bill: { $in: unsettled }, needsPrice: true, reversed: { $ne: true } }).select('bill').lean<{ bill: Types.ObjectId }[]>().exec()
      : [];
    const unpricedBills = new Set(unpriced.map((l) => String(l.bill)));
    const clear = (b: BillFacts) =>
      balance(b) <= 0 && (b.state === 'settled' || (b.state === 'final' && !unpricedBills.has(String(b._id))));
    if (bills.every(clear)) {
      const head = bills.some((b) => balance(b) < 0)
        ? 'Refund due: billing informed'
        : bills.every((b) => b.state === 'settled')
          ? 'Bill settled'
          : 'Final bill ready: nothing due';
      return entry({ key: 'bill', state: 'done', detail: head });
    }
    const open = bills.some((b) => b.state === 'open');
    const priceNote = unpriced.length > 0 && `${plural(unpriced.length, 'line')} ${unpriced.length === 1 ? 'needs' : 'need'} a price`;
    return entry({ key: 'bill', state: 'waiting', detail: joined([due > 0 ? `${formatRupees(due)} due` : open && 'Final bill not prepared yet', priceNote]) });
  }

  /**
   * Writes each line that changed, only over the line as it was read (its state and detail): a tick, the override or
   * a fresher refresh that landed meanwhile wins, and the next refresh reads again. A missing line is put back in
   * checklist order.
   */
  private async write(order: LeanOrder, wanted: DischargeLineEntry[]): Promise<void> {
    const keys = order.lines.map((l) => l.key);
    for (const next of wanted) {
      const prev = order.lines.find((l) => l.key === next.key);
      if (!prev) {
        const rank = LINE_KEYS.indexOf(next.key);
        const position = keys.filter((k) => LINE_KEYS.indexOf(k) < rank).length;
        const added = await this.orders
          .updateOne(
            { _id: order._id, state: { $in: OPEN_ORDER_STATES }, 'lines.key': { $ne: next.key } },
            { $push: { lines: { $each: [next], $position: position } } },
          )
          .exec();
        if (added.modifiedCount) keys.splice(position, 0, next.key);
        continue;
      }
      if (sameLine(entry(prev), next)) continue;
      await this.orders
        .updateOne(
          { _id: order._id, state: { $in: OPEN_ORDER_STATES }, lines: { $elemMatch: { key: next.key, state: prev.state, detail: prev.detail ?? null } } },
          { $set: { 'lines.$': next } },
        )
        .exec();
    }
  }

  /**
   * Moves the order to match its lines as they are stored now, each move guarded on those lines, so two refreshes
   * at once move it once. Becoming Ready counts the time (`readyCount`) and announces `discharge.ready` under that
   * count's key (R31); losing it takes the announcement off `announced`. The plan follows the order.
   */
  private async settleReady(order: LeanOrder, caseId: string | null, bedLabel: string | null): Promise<void> {
    const required = LINE_KEYS.filter((k) => LINE_RULE[order.kind][k] === 'R');
    const notDone = { key: { $in: required }, state: { $nin: COMPLETE } };
    const gained = await this.orders
      .findOneAndUpdate(
        { _id: order._id, state: 'ordered', 'lines.key': { $all: required }, $nor: [{ lines: { $elemMatch: notDone } }] },
        { $set: { state: 'ready' }, $inc: { readyCount: 1 }, $pull: { announced: READY } },
        { new: true },
      )
      .lean<LeanOrder>()
      .exec();
    if (gained) {
      await this.announceReady(gained, caseId, bedLabel);
    } else {
      await this.orders
        .updateOne(
          { _id: order._id, state: 'ready', $or: [{ lines: { $elemMatch: notDone } }, ...required.map((k) => ({ 'lines.key': { $ne: k } }))] },
          { $set: { state: 'ordered' }, $pull: { announced: READY } },
        )
        .exec();
    }
    await this.syncPlan(order);
  }

  /** `discharge.ready` for the n-th time the order became ready; recorded in `announced` once it went, if still that time. */
  private async announceReady(order: LeanOrder, caseId: string | null, bedLabel: string | null): Promise<void> {
    const orderId = String(order._id);
    if (!bedLabel) {
      this.logger.warn(`Discharge order ${orderId} is ready, but its plan has no bed label: discharge.ready not sent`);
      return;
    }
    const n = order.readyCount;
    const sent = await this.registration.send(READY, caseId, { orderId, bedLabel, kind: order.kind }, `${bedLabel}: Ready to leave (${KIND_LABEL[order.kind]})`, {
      dedupeKey: `${READY}:${orderId}:${n}`,
    });
    if (!sent) return;
    await this.orders
      .updateOne({ _id: order._id, state: 'ready', readyCount: n }, { $addToSet: { announced: READY } })
      .exec()
      .catch((e: Error) => this.logger.warn(`Discharge order ${orderId}: ${READY} not recorded as sent (${e.message})`));
  }

  /** The plan shows the order's state (Ordered or Ready to leave) while it points at this order. */
  private async syncPlan(order: LeanOrder): Promise<void> {
    const state = (await this.orders.findById(order._id).select('state').lean<{ state?: OrderState }>().exec())?.state;
    if (state !== 'ordered' && state !== 'ready') return;
    await this.plans.updateOne({ _id: order.plan, order: order._id, state: state === 'ready' ? 'ordered' : 'ready' }, { $set: { state } }).exec();
  }

  // ---------- waking ----------

  /** Loads the message and runs the handler. Nothing escapes: the one-minute pass repairs what a failure missed. */
  private async run(type: string, messageId: string, fn: (m: Msg) => Promise<unknown>): Promise<void> {
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

  /** A Lab, Pharmacy or Scheduling message: the case's open orders read their lines again. A message with no case is ignored. */
  private async onCase(m: Msg): Promise<void> {
    if (m.case) await this.refreshCase(m.case);
  }

  /**
   * revenue.bill-final / revenue.bill-settled: only an admission bill whose stay has an open order matters. Anything
   * else, such as a kiosk walk-in bill (they settle all day), is a quiet no-op.
   */
  private async onBill(m: Msg): Promise<void> {
    const billId = str(m.payload.billId);
    if (!billId || !isValidObjectId(billId)) return;
    const bill = await this.bills.findById(billId).select('kind admission').lean<{ kind: string; admission?: Types.ObjectId }>().exec();
    if (bill?.kind !== 'admission' || !bill.admission) return;
    if (!(await this.orders.exists({ admission: bill.admission, state: { $in: OPEN_ORDER_STATES } }).exec())) return;
    await this.refreshAdmission(String(bill.admission));
  }

  private async refreshEach(orders: { _id: unknown }[]): Promise<number> {
    let refreshed = 0;
    for (const o of orders) {
      try {
        await this.refresh(String(o._id));
        refreshed += 1;
      } catch (e) {
        this.logger.warn(`Discharge order ${String(o._id)}: checklist not refreshed (${(e as Error).message})`);
      }
    }
    return refreshed;
  }

  // ---------- helpers ----------

  /** Who received the body: a name and a relationship, 1 to 100 characters each. */
  private receiver(v: unknown): { name: string; relationship: string } {
    if (!isObj(v)) throw new BadRequestException('Give the name and the relationship of the person who received the body.');
    return { name: text(v.name, "The receiver's name", 1, RECEIVER_MAX), relationship: text(v.relationship, "The receiver's relationship", 1, RECEIVER_MAX) };
  }

  /** An order still in progress, else 404 or 409. */
  private async openOrder(orderId: string): Promise<DischargeOrderDocument> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!order) throw new NotFoundException('Discharge order not found');
    if (!OPEN_ORDER_STATES.includes(order.state)) throw new ConflictException(stateRefusal(order.state));
    return order;
  }

  /** R24: the order's case, else its plan's, else the patient's open case (or newest); null when there is none. */
  private async caseOf(order: { case?: unknown; patient: unknown }, plan?: { case?: unknown } | null): Promise<string | null> {
    if (order.case) return String(order.case);
    if (plan?.case) return String(plan.case);
    const c = await this.cases.forPatient(String(order.patient));
    return c ? String(c._id) : null;
  }

  private async reread(orderId: Types.ObjectId): Promise<DischargeOrderDocument> {
    const order = await this.orders.findById(orderId).exec();
    if (!order) throw new NotFoundException('Discharge order not found');
    return order;
  }
}
