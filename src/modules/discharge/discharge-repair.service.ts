import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WAITING } from '../pharmacy/pharmacy-checks.service';
import { PharmacyTakeHomeService } from '../pharmacy/pharmacy-take-home.service';
import { PharmacyLine, PharmacyLineDocument } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from '../pharmacy/schemas/pharmacy-order.schema';
import { DischargeLeavingService, STALE_CLAIM_MS } from './discharge-leaving.service';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService } from './discharge-orders.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeSummaryService } from './discharge-summary.service';
import { DischargeOrder, DischargeOrderDocument, OPEN_ORDER_STATES, OrderState } from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';
import { DischargeSummary, DischargeSummaryDocument } from './schemas/discharge-summary.schema';

/** Records younger than this are left alone by re-sends and back-fills: the request that wrote them may still be sending. */
export const REPAIR_GRACE_MS = 30_000;
/**
 * Half-ended stays and orphan take-home orders are repaired only once their record is this old (R52's N, 10 minutes).
 * An ending or an order being saved takes seconds, so the pass never finishes or undoes work still in flight.
 */
export const ENDING_GRACE_MS = 10 * 60_000;
/** Re-sends, back-fills and repairs look at records changed within this long, and never before the agent's first start (R17). */
export const REPAIR_WINDOW_MS = 7 * 24 * 60 * 60_000;
const NOT_SAVED = 'Discharge order not saved';
const BATCH = 300;

const ORDERED = 'discharge.ordered';
const WINDOW_OPENED = 'discharge.window-opened';
const READY = 'discharge.ready';
const SIGNED = 'discharge.summary-signed';
const CANCELLED = 'discharge.cancelled';
const COMPLETED = 'discharge.completed';

type Row = { _id: Types.ObjectId };

/**
 * Steps 5 to 8 of the Discharge one-minute pass (R52): what a failed send or a crash left undone. Each public method is
 * one step; it counts what it repaired, catches each record on its own (one bad record never stops the rest), and is
 * safe to run again: a second run finds nothing left to do and sends nothing new. Messages are rebuilt by the service
 * that owns them, under each re-send's own key (R31). The agent's start stamp (`start`) bounds every step: nothing
 * written before the agent first ran is re-sent, back-filled or repaired (R17). `realNow` is the real clock (R7).
 */
@Injectable()
export class DischargeRepairService {
  private readonly logger = new Logger(DischargeRepairService.name);

  /** The real clock, for the grace and the window; a spec replaces it. */
  realNow: () => number = () => Date.now();

  constructor(
    private readonly plansService: DischargePlansService,
    private readonly ordersService: DischargeOrdersService,
    private readonly lines: DischargeLinesService,
    private readonly summary: DischargeSummaryService,
    private readonly leaving: DischargeLeavingService,
    private readonly takeHome: PharmacyTakeHomeService,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(DischargeSummary.name) private readonly summaries: Model<DischargeSummaryDocument>,
    /** Read only: take-home orders, and whether any of their lines still wait. */
    @InjectModel(PharmacyOrder.name) private readonly pharmacyOrders: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly pharmacyLines: Model<PharmacyLineDocument>,
  ) {}

  // ---------- step 5: re-send missing messages ----------

  /**
   * Every Discharge message a record says is due but whose send never went (R31): `discharge.planned` (no
   * `announcedAt`), `discharge.ordered`, `discharge.window-opened`, `discharge.ready` and `discharge.summary-signed`
   * for orders still in progress, `discharge.cancelled` (only while no other live order is on the plan or the case),
   * and `discharge.completed` (from the order's `announced`, or the plan's Left-without-discharge record with no order).
   * Records changed in the last 30 seconds, or before `start`, are left alone. Returns how many went.
   */
  async resendMissing(start: Date): Promise<number> {
    const recent = this.recent(start, REPAIR_GRACE_MS);
    const open = { $in: OPEN_ORDER_STATES };
    let n = 0;
    n += await this.each(ORDERED, this.orders, { ...recent, state: open, announced: { $ne: ORDERED } }, (id) => this.ordersService.resendOrdered(id));
    n += await this.each(WINDOW_OPENED, this.orders, { ...recent, state: open, windowOpenedAt: { $ne: null }, announced: { $ne: WINDOW_OPENED } }, (id) =>
      this.ordersService.resendWindowOpened(id),
    );
    n += await this.each(READY, this.orders, { ...recent, state: 'ready', announced: { $ne: READY } }, (id) => this.lines.resendReady(id));
    n += await this.resendSigned(recent);
    n += await this.each(CANCELLED, this.orders, { ...recent, state: 'cancelled', announced: { $ne: CANCELLED } }, (id) => this.ordersService.resendCancelled(id));
    n += await this.resendCompleted(recent);
    n += await this.each('discharge.planned', this.plans, { ...recent, state: { $ne: 'completed' }, announcedAt: null }, (id) => this.plansService.resendPlanned(id));
    return n;
  }

  /** A signed summary (current, not archived) changed in the window, of an order in progress that never announced it. */
  private async resendSigned(recent: Record<string, unknown>): Promise<number> {
    let n = 0;
    await this.walk(this.summaries, { ...recent, signedAt: { $ne: null }, archivedAt: null }, 'order', async (rows) => {
      const waiting = await this.orders
        .find({ _id: { $in: rows.map((r) => r.order) }, state: { $in: OPEN_ORDER_STATES }, announced: { $ne: SIGNED } })
        .select('_id')
        .lean<Row[]>()
        .exec();
      for (const o of waiting) n += await this.one(SIGNED, o._id, () => this.summary.resendSigned(String(o._id)));
    });
    return n;
  }

  /** The stay's end announced nowhere: an order that left, or a Left without discharge with no order, on a completed plan. */
  private async resendCompleted(recent: Record<string, unknown>): Promise<number> {
    const plansDone = new Set<string>();
    let n = 0;
    await this.walk(this.orders, { ...recent, state: 'left', announced: { $ne: COMPLETED } }, 'plan', async (rows) => {
      for (const o of rows) plansDone.add(String(o.plan));
    });
    await this.walk(
      this.plans,
      { ...recent, state: 'completed', 'leftWithoutDischarge.at': { $exists: true }, 'leftWithoutDischarge.announcedAt': null },
      '_id',
      async (rows) => {
        for (const p of rows) plansDone.add(String(p._id));
      },
    );
    for (const planId of plansDone) n += await this.one(COMPLETED, planId, () => this.leaving.resendCompleted(planId));
    return n;
  }

  // ---------- step 6: summary repairs ----------

  /**
   * R35: a cancelled order whose signed summary was never archived (archived now, with its document); Task 10 M6: a
   * kept signed version whose document is still Signed; Task 10 M8: an order in progress with no summary (a background
   * draft was lost), drafted now. Records before `start` are left alone. Returns how many it repaired.
   */
  async repairSummaries(start: Date): Promise<number> {
    const recent = this.recent(start, REPAIR_GRACE_MS);
    let n = 0;
    await this.walk(this.orders, { ...recent, state: 'cancelled' }, '_id', async (rows) => {
      const signed = await this.summaries
        .find({ order: { $in: rows.map((r) => r._id) }, signedAt: { $ne: null }, archivedAt: null })
        .select('order')
        .lean<{ order: Types.ObjectId }[]>()
        .exec();
      for (const s of signed) n += await this.one('summary archive', s.order, () => this.summary.archiveForCancel(String(s.order)));
    });
    await this.walk(this.summaries, { ...recent, 'versions.documentId': { $exists: true } }, 'order', async (rows) => {
      for (const s of rows) n += await this.one('version archive', s.order, async () => (await this.summary.archiveVersions(String(s.order))) > 0);
    });
    await this.walk(this.orders, { ...recent, state: { $in: OPEN_ORDER_STATES } }, '_id', async (rows) => {
      const drafted = new Set(
        ((await this.summaries.distinct('order', { order: { $in: rows.map((r) => r._id) } }).exec()) as Types.ObjectId[]).map(String),
      );
      for (const o of rows) {
        if (drafted.has(String(o._id))) continue;
        n += await this.one('summary draft', o._id, async () => !!(await this.summary.draft(String(o._id))));
      }
    });
    return n;
  }

  // ---------- step 7: order and plan consistency ----------

  /**
   * Task 8 M2: an order in progress whose plan still reads `planned` (the plan step after the order failed) gets the
   * plan pointed at it, in the order's state, and the morning reminder closed; B1-M2: a cancelled order whose plan still
   * reads `ordered` or `ready` and points at it (the cancel's plan step was lost) has the plan put back to `planned`, so
   * the stay is reminded and can be ordered again (an order that left is step 8's); a take-home order whose discharge order
   * was never saved (an orphan, at least 10 minutes old) has its waiting lines cancelled through Pharmacy ("Discharge
   * order not saved"). Records before `start` are left alone. Returns how many it repaired.
   */
  async repairOrdersAndPlans(start: Date): Promise<number> {
    let n = 0;
    await this.walk(this.orders, { ...this.recent(start, REPAIR_GRACE_MS), state: { $in: OPEN_ORDER_STATES } }, 'plan state', async (rows) => {
      const behind = await this.plans
        .find({ _id: { $in: rows.map((r) => r.plan) }, state: 'planned' })
        .select('_id')
        .lean<Row[]>()
        .exec();
      const lagging = new Set(behind.map((p) => String(p._id)));
      for (const o of rows) {
        if (!lagging.has(String(o.plan))) continue;
        n += await this.one('plan state', o._id, async () => {
          const moved = await this.plans.updateOne({ _id: o.plan, state: 'planned' }, { $set: { state: o.state, order: o._id } }).exec();
          if (!moved.modifiedCount) return false;
          // 13b review M4: a cancel that landed after the walk read the order found the plan not pointing at it, so its own
          // plan step changed nothing. The order is read again, and a plan now pointing at an order no longer in progress
          // is put back (the cancel's own step, guarded on this order).
          const now = (await this.orders.findById(o._id).select('state').lean<{ state?: OrderState }>().exec())?.state;
          if (!now || !OPEN_ORDER_STATES.includes(now)) {
            await this.plans
              .updateOne({ _id: o.plan, order: o._id, state: { $ne: 'completed' } }, { $set: { state: 'planned' }, $unset: { order: 1 } })
              .exec();
            return false;
          }
          this.logger.warn(`Discharge plan ${String(o.plan)} was still planned under order ${String(o._id)}; it follows the order now`);
          await this.plansService.closeReminder(String(o.plan));
          return true;
        });
      }
    });
    await this.walk(this.orders, { ...this.recent(start, REPAIR_GRACE_MS), state: 'cancelled' }, 'plan', async (rows) => {
      const stuck = await this.plans
        .find({ _id: { $in: rows.map((r) => r.plan) }, state: { $in: ['ordered', 'ready'] }, order: { $in: rows.map((r) => r._id) } })
        .select('_id order')
        .lean<(Row & { order: Types.ObjectId })[]>()
        .exec();
      for (const p of stuck) {
        n += await this.one('cancelled plan', p._id, async () => {
          // The cancel's own step, guarded on this order: a new order given meanwhile keeps the plan.
          const reset = await this.plans
            .updateOne({ _id: p._id, order: p.order, state: { $in: ['ordered', 'ready'] } }, { $set: { state: 'planned' }, $unset: { order: 1 } })
            .exec();
          if (!reset.modifiedCount) return false;
          this.logger.warn(`Discharge plan ${String(p._id)} still pointed at cancelled order ${String(p.order)}; it is planned again`);
          return true;
        });
      }
    });
    await this.walk(this.pharmacyOrders, { ...this.recent(start, ENDING_GRACE_MS, 'createdAt'), takeHome: true }, '_id', async (rows) => {
      const ids = rows.map((r) => r._id);
      const owners = await this.orders
        .find({ $or: [{ takeHomeOrder: { $in: ids } }, { addedTakeHomeOrders: { $in: ids } }] })
        .select('takeHomeOrder addedTakeHomeOrders')
        .lean<{ takeHomeOrder?: Types.ObjectId; addedTakeHomeOrders?: Types.ObjectId[] }[]>()
        .exec();
      const owned = new Set(owners.flatMap((o) => [...(o.takeHomeOrder ? [String(o.takeHomeOrder)] : []), ...(o.addedTakeHomeOrders ?? []).map(String)]));
      const orphans = ids.filter((id) => !owned.has(String(id)));
      if (!orphans.length) return;
      const waiting = (await this.pharmacyLines.distinct('order', { order: { $in: orphans }, status: { $in: WAITING } }).exec()) as Types.ObjectId[];
      for (const id of waiting) {
        n += await this.one('orphan take-home order', id, async () => {
          const cancelled = await this.takeHome.cancelOrder(String(id), NOT_SAVED);
          if (cancelled) this.logger.warn(`Take-home order ${String(id)} had no discharge order: ${cancelled} waiting line(s) cancelled`);
          return cancelled > 0;
        });
      }
    });
    return n;
  }

  // ---------- step 8: half-ended stays ----------

  /**
   * Task 11 M2, each decided from stored state by the leaving service: an order that left on a plan that never completed
   * (`repairLeft`: finished, or put back to Ready when the stay is untouched); a Left-without-discharge claim at least
   * 10 minutes old on a plan that never completed (`repairClaim`: undone, or finished when the stay already ended); and
   * every completed stay checked once (`checkEnding`: the admission discharged, the status set, `bed.discharged` and
   * `discharge.completed` sent). Only records at least 10 minutes old and written since `start`. `now` is the clinic
   * clock. Returns how many it repaired.
   */
  async repairEndings(now: Date, start: Date): Promise<number> {
    const settled = this.recent(start, ENDING_GRACE_MS);
    let n = 0;
    await this.walk(this.orders, { ...settled, state: 'left' }, 'plan', async (rows) => {
      const open = await this.plans
        .find({ _id: { $in: rows.map((r) => r.plan) }, state: { $ne: 'completed' } })
        .select('_id')
        .lean<Row[]>()
        .exec();
      const unfinished = new Set(open.map((p) => String(p._id)));
      for (const o of rows) {
        if (unfinished.has(String(o.plan))) n += await this.one('left order', o._id, async () => !!(await this.leaving.repairLeft(String(o._id))));
      }
    });
    const claimedBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    await this.walk(
      this.plans,
      { ...this.recent(start, 0), state: { $ne: 'completed' }, 'leftWithoutDischarge.at': { $lte: claimedBefore } },
      '_id',
      async (rows) => {
        for (const p of rows) n += await this.one('stale claim', p._id, async () => !!(await this.leaving.repairClaim(String(p._id), now)));
      },
    );
    await this.walk(this.plans, { ...settled, state: 'completed', completedKind: { $exists: true }, endingCheckedAt: null }, '_id', async (rows) => {
      for (const p of rows) n += await this.one('ending check', p._id, () => this.leaving.checkEnding(String(p._id)));
    });
    return n;
  }

  // ---------- helpers ----------

  /**
   * Written at or after `start` and within the window, and at least `grace` ago (real time), on `field` (`updatedAt`
   * unless said otherwise).
   */
  private recent(start: Date, grace: number, field: 'updatedAt' | 'createdAt' = 'updatedAt'): Record<string, unknown> {
    const now = this.realNow();
    const since = new Date(Math.max(start.getTime(), now - REPAIR_WINDOW_MS));
    return { [field]: { $gte: since, $lte: new Date(now - grace) } };
  }

  /** Every row of a filter, a page at a time in _id order, with only the fields named (space-separated). */
  private async walk(model: Model<any>, filter: Record<string, unknown>, fields: string, each: (rows: any[]) => Promise<void>): Promise<void> {
    let last: unknown = null;
    for (;;) {
      const rows = await model
        .find(last ? { ...filter, _id: { $gt: last } } : filter)
        .sort({ _id: 1 })
        .limit(BATCH)
        .select(fields)
        .lean()
        .exec();
      if (!rows.length) return;
      await each(rows);
      if (rows.length < BATCH) return;
      last = rows[rows.length - 1]._id;
    }
  }

  /** Runs `fn` on every row's id; returns how many said true. */
  private async each(what: string, model: Model<any>, filter: Record<string, unknown>, fn: (id: string) => Promise<boolean>): Promise<number> {
    let n = 0;
    await this.walk(model, filter, '_id', async (rows) => {
      for (const r of rows) n += await this.one(what, r._id, () => fn(String(r._id)));
    });
    return n;
  }

  /** One record's repair: 1 when it did something, 0 when not or when it failed (logged, never thrown). */
  private async one(what: string, id: unknown, fn: () => Promise<boolean>): Promise<number> {
    try {
      return (await fn()) ? 1 : 0;
    } catch (e) {
      this.logger.warn(`Discharge repair (${what}) of ${String(id)} failed: ${(e as Error).message}`);
      return 0;
    }
  }
}
