import { Logger, NotFoundException } from '@nestjs/common';
import { Model, isValidObjectId } from 'mongoose';
import type { Priority as CasePriority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { Priority, medicineByKey } from './pharmacy-catalogue';
import { PharmacySettingsService } from './pharmacy-settings.service';
import type { PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import type { PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

export const CASE_PRIORITY: Record<Priority, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };

/** The messages that carry a line (see the registration for their payloads). */
export type LineMessageType =
  | 'pharmacy.to-check'
  | 'pharmacy.approved'
  | 'pharmacy.to-issue'
  | 'pharmacy.query'
  | 'pharmacy.query-answered'
  | 'pharmacy.rejected'
  | 'pharmacy.issued'
  | 'pharmacy.cancelled'
  | 'pharmacy.stopped';

export interface ClockState {
  checkRound: number;
  checkDueAt: Date;
  issueRound: number;
  issueDueAt: Date;
}

export interface LineEvent {
  type: LineMessageType;
  lineId: string;
  extra?: Record<string, unknown>;
  dedupeKey: string;
}

const MIN_MS = 60_000;
/** How many times syncRounds re-reads after a guarded write changed or lost a race. */
const SYNC_TRIES = 5;
const SUMMARY_MAX = 140;
const WHAT: Record<LineMessageType, string> = {
  'pharmacy.to-check': 'to check',
  'pharmacy.approved': 'approved',
  'pharmacy.to-issue': 'ready to issue',
  'pharmacy.query': 'query raised',
  'pharmacy.query-answered': 'query answered',
  'pharmacy.rejected': 'rejected',
  'pharmacy.issued': 'issued',
  'pharmacy.cancelled': 'cancelled',
  'pharmacy.stopped': 'stopped',
};

/** The name a message uses for a line's medicine: an unlisted one is never named. */
export const medicineLabel = (medicine: string | null): string => (medicine ? (medicineByKey(medicine)?.name ?? medicine) : 'Unlisted medicine');

const doseText = (l: { dose: number | null; unit: string }): string => (l.dose === null ? '' : ` ${l.dose} ${l.unit}`.trimEnd());

/** "MO-0001: Aspirin 300 mg to check (STAT)": the order number, medicine, dose and priority, never a name. */
export function lineSummary(number: string, line: { medicine: string | null; dose: number | null; unit: string }, type: LineMessageType, priority: Priority): string {
  return `${number}: ${medicineLabel(line.medicine)}${doseText(line)} ${WHAT[type]} (${priority.toUpperCase()})`.slice(0, SUMMARY_MAX);
}

/** "MO-0001: Aspirin, Clopidogrel ordered (STAT)", cut with "+N more" to fit. */
export function orderSummary(number: string, labels: string[], priority: Priority): string {
  const tail = ` ordered (${priority.toUpperCase()})`;
  const full = `${number}: ${labels.join(', ')}${tail}`;
  if (full.length <= SUMMARY_MAX) return full;
  for (let keep = labels.length - 1; keep >= 1; keep--) {
    const s = `${number}: ${labels.slice(0, keep).join(', ')} +${labels.length - keep} more${tail}`;
    if (s.length <= SUMMARY_MAX) return s;
  }
  return `${number}: ${labels.length} medicines${tail}`.slice(0, SUMMARY_MAX);
}

/** Dedupe key of the message that starts a line's wait: `…:<lineId>:<time it started waiting, ms>`. */
export const startKey = (type: 'pharmacy.to-check' | 'pharmacy.to-issue', line: { _id: unknown; enteredCheckAt?: Date; issueFrom?: Date }): string =>
  `${type}:${String(line._id)}:${new Date((type === 'pharmacy.to-check' ? line.enteredCheckAt : line.issueFrom) ?? 0).getTime()}`;

const earliest = (dates: Date[]): Date | null => (dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null);
const same = (a?: Date | null, b?: Date | null) => !!a && !!b && new Date(a).getTime() === new Date(b).getTime();

type Clock = 'check' | 'issue';

/**
 * The clock rounds of an order and the messages about its lines. A round opens when something waits and
 * closes when nothing does; every write is guarded on the round it read, and a round's clock ref carries
 * its number, so a message about an older round can never move or stop a newer one.
 */
export class PharmacyRounds {
  private readonly logger = new Logger(PharmacyRounds.name);

  constructor(
    private readonly orders: Model<PharmacyOrderDocument>,
    private readonly lines: Model<PharmacyLineDocument>,
    private readonly messages: MessagesService,
    private readonly settings: PharmacySettingsService,
  ) {}

  /** Opens, moves or closes the order's check and issue rounds to match what waits now. */
  async syncRounds(orderId: string): Promise<{ state: ClockState; closed: { check?: number; issue?: number } }> {
    const closed: { check?: number; issue?: number } = {};
    let order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!order) throw new NotFoundException('Pharmacy order not found');
    const targets = await this.settings.targets();
    let settled = false;
    for (let pass = 0; pass < SYNC_TRIES; pass++) {
      const waiting = await this.lines
        .find({ order: order._id, status: { $in: ['to-check', 'approved'] } })
        .select('status enteredCheckAt issueFrom waitingForStock')
        .lean<{ status: string; enteredCheckAt?: Date; issueFrom?: Date; waitingForStock?: boolean }[]>()
        .exec();
      const created = order.createdAt ?? new Date();
      const checkDue = earliest(waiting.filter((l) => l.status === 'to-check').map((l) => new Date(new Date(l.enteredCheckAt ?? created).getTime() + targets.check[order!.priority] * MIN_MS)));
      const issueDue =
        order.setting === 'OPD'
          ? null
          : earliest(waiting.filter((l) => l.status === 'approved' && !l.waitingForStock).map((l) => new Date(new Date(l.issueFrom ?? created).getTime() + targets.issue[order!.priority] * MIN_MS)));
      const a = await this.step(order, 'check', checkDue, closed);
      const b = await this.step(order, 'issue', issueDue, closed);
      order = (await this.orders.findById(order._id).exec()) ?? order;
      if (!a && !b) {
        settled = true;
        break;
      }
    }
    if (!settled) this.logger.warn(`Rounds of order ${orderId} did not settle after ${SYNC_TRIES} tries`);
    const created = order.createdAt ?? new Date();
    return {
      state: {
        checkRound: order.checkRound,
        checkDueAt: order.checkDueAt ?? created,
        issueRound: order.issueRound,
        issueDueAt: order.issueDueAt ?? created,
      },
      closed,
    };
  }

  /** One clock of one order. Returns true when something changed or a guarded write lost a race (the caller re-reads and tries again). */
  private async step(order: PharmacyOrderDocument, clock: Clock, due: Date | null, closed: { check?: number; issue?: number }): Promise<boolean> {
    const round = order[`${clock}Round`];
    const open = order[`${clock}Open`];
    const dueAt = order[`${clock}DueAt`];
    if (due && !open) {
      await this.orders.updateOne({ _id: order._id, [`${clock}Round`]: round, [`${clock}Open`]: false }, { $set: { [`${clock}Round`]: round + 1, [`${clock}Open`]: true, [`${clock}DueAt`]: due } }).exec();
      return true;
    }
    if (due && open) {
      if (same(dueAt, due)) return false;
      await this.orders.updateOne({ _id: order._id, [`${clock}Round`]: round, [`${clock}Open`]: true }, { $set: { [`${clock}DueAt`]: due } }).exec();
      return true;
    }
    if (!due && open) {
      const r = await this.orders.updateOne({ _id: order._id, [`${clock}Round`]: round, [`${clock}Open`]: true }, { $set: { [`${clock}Open`]: false } }).exec();
      if (r.modifiedCount > 0) closed[clock] = round;
      return true;
    }
    return false;
  }

  /**
   * Syncs the rounds, sends each event with the line as it is now and the clock state, then sends the
   * done message of each round this call closed. Every state change calls this after its guarded update.
   */
  async publish(orderId: string, events: LineEvent[]): Promise<ClockState> {
    const { state, closed } = await this.syncRounds(orderId);
    const order = (await this.orders.findById(orderId).exec())!;
    for (const ev of events) {
      const line = isValidObjectId(ev.lineId) ? await this.lines.findById(ev.lineId).exec() : null;
      if (!line) continue;
      await this.messages.send({
        case: String(order.case),
        from: 'pharmacy',
        to: ['coordinator'],
        type: ev.type,
        priority: CASE_PRIORITY[order.priority],
        summary: lineSummary(order.number, line, ev.type, order.priority),
        payload: this.linePayload(order, line, state, ev),
        dedupeKey: ev.dedupeKey,
      });
    }
    if (closed.check !== undefined) await this.sendDone(orderId, 'check', closed.check);
    if (closed.issue !== undefined) await this.sendDone(orderId, 'issue', closed.issue);
    return state;
  }

  private linePayload(order: PharmacyOrderDocument, line: PharmacyLineDocument, state: ClockState, ev: LineEvent): Record<string, unknown> {
    const base: Record<string, unknown> = {
      orderId: String(order._id),
      orderNumber: order.number,
      lineId: String(line._id),
      medicine: line.medicine ?? 'unlisted',
      priority: order.priority,
      setting: order.setting,
      version: line.version,
      ...state,
    };
    const q = line.query;
    if (ev.type === 'pharmacy.query') Object.assign(base, { querySeq: q?.seq ?? line.querySeq, kind: q?.kind ?? 'other', queryDueAt: q?.dueAt ?? new Date() });
    if (ev.type === 'pharmacy.query-answered') Object.assign(base, { querySeq: q?.seq ?? line.querySeq, outcome: q?.answer?.outcome ?? 'keep' });
    if (ev.type === 'pharmacy.issued') {
      const qty = line.issued?.batches?.reduce((n, b) => n + b.qty, 0) ?? line.quantity ?? 0;
      Object.assign(base, { store: line.issued?.store ?? '', quantity: qty });
    }
    if (ev.type === 'pharmacy.cancelled' || ev.type === 'pharmacy.stopped') Object.assign(base, { querySeq: line.querySeq });
    return { ...base, ...(ev.extra ?? {}) };
  }

  /** Sends pharmacy.check-done or pharmacy.issue-done for a round; the key holds the round, so an older round's message is its own. */
  async sendDone(orderId: string, clock: Clock, round: number): Promise<void> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!order) throw new NotFoundException('Pharmacy order not found');
    const type = clock === 'check' ? 'pharmacy.check-done' : 'pharmacy.issue-done';
    await this.messages.send({
      case: String(order.case),
      from: 'pharmacy',
      to: ['coordinator'],
      type,
      priority: CASE_PRIORITY[order.priority],
      summary: `${order.number}: ${clock === 'check' ? 'all medicines checked' : 'all medicines issued'} (${order.priority.toUpperCase()})`,
      payload: { orderId: String(order._id), orderNumber: order.number, [clock === 'check' ? 'checkRound' : 'issueRound']: round },
      dedupeKey: `${type}:${String(order._id)}:${round}`,
    });
  }

  /** Re-sends the start message of the earliest waiting line, with that line's own dedupe key. False when nothing waits. */
  async resendStart(orderId: string, clock: Clock): Promise<boolean> {
    const order = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!order) throw new NotFoundException('Pharmacy order not found');
    if (clock === 'issue' && order.setting === 'OPD') return false;
    const line =
      clock === 'check'
        ? await this.lines.findOne({ order: order._id, status: 'to-check' }).sort({ enteredCheckAt: 1, _id: 1 }).exec()
        : await this.lines.findOne({ order: order._id, status: 'approved', waitingForStock: { $ne: true } }).sort({ issueFrom: 1, _id: 1 }).exec();
    if (!line) return false;
    const type = clock === 'check' ? 'pharmacy.to-check' : 'pharmacy.to-issue';
    await this.publish(orderId, [{ type, lineId: String(line._id), dedupeKey: startKey(type, line) }]);
    return true;
  }

  /**
   * Sends pharmacy.ordered for an order the Coordinator has not heard about. Claims `announcedAt` first,
   * so of two racing callers only one sends, and releases the claim if the send fails. Returns whether it sent.
   */
  async announceOrdered(order: PharmacyOrderDocument): Promise<boolean> {
    if (order.announcedAt) return false;
    const claimed = await this.orders.findOneAndUpdate({ _id: order._id, announcedAt: { $exists: false } }, { $set: { announcedAt: new Date() } }, { new: true }).exec();
    if (!claimed) return false;
    try {
      const lines = await this.lines.find({ order: claimed._id }).sort({ _id: 1 }).exec();
      await this.messages.send({
        case: String(claimed.case),
        from: 'pharmacy',
        to: ['coordinator'],
        type: 'pharmacy.ordered',
        priority: CASE_PRIORITY[claimed.priority],
        summary: orderSummary(claimed.number, lines.map((l) => medicineLabel(l.medicine)), claimed.priority),
        payload: {
          orderId: String(claimed._id),
          orderNumber: claimed.number,
          priority: claimed.priority,
          setting: claimed.setting,
          source: claimed.source,
          medicines: lines.map((l) => l.medicine ?? 'unlisted'),
        },
        dedupeKey: `pharmacy.ordered:${String(claimed._id)}`,
      });
    } catch (e) {
      await this.orders.updateOne({ _id: claimed._id }, { $unset: { announcedAt: '' } }).exec().catch(() => undefined);
      throw e;
    }
    order.announcedAt = claimed.announcedAt;
    return true;
  }
}
