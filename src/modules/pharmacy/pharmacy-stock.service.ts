import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { clinicNow, displayDateTime, isoDate } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { STORE_LABEL, Store, productByKey } from './pharmacy-catalogue';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { startKey } from './pharmacy-rounds';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyBatch, PharmacyBatchDocument } from './schemas/pharmacy-batch.schema';
import { ADJUST_REASONS, AdjustReason, PharmacyMovement, PharmacyMovementDocument } from './schemas/pharmacy-movement.schema';
import { PharmacyStockLevel, PharmacyStockLevelDocument } from './schemas/pharmacy-stock-level.schema';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

export const STORES = Object.keys(STORE_LABEL) as Store[];
const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_QTY = 100_000;

/** Today's clinic date, `YYYY-MM-DD`: a batch is usable when its expiry is on or after it. */
export const today = (): string => isoDate(clinicNow());

export const isStore = (v: unknown): v is Store => typeof v === 'string' && (STORES as string[]).includes(v);
export const lowAlertLink = (product: string, store: string) => `pharmacy-stock:${product}:${store}`;

export interface BatchView {
  id: string;
  batchNo: string;
  expiry: string;
  quantity: number;
  expired: boolean;
  nearExpiry: boolean;
}

export interface StockRow {
  product: string;
  label: string;
  medicine: string;
  store: Store;
  /** Quantity in unexpired batches. */
  usable: number;
  reorderLevel: number;
  low: boolean;
  /** Batches holding stock, oldest expiry first. */
  batches: BatchView[];
  /** Quantity in unexpired batches that expire within the near-expiry window. */
  nearExpiry: number;
  /** Quantity left in expired batches. */
  expired: number;
}

export interface MovementView {
  id: string;
  batch: string;
  product: string;
  label: string;
  store: Store;
  change: number;
  kind: string;
  reason: string;
  line: string | null;
  by: { id: string; name: string };
  at: string;
}

const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const validDay = (v: unknown): v is string => {
  const m = typeof v === 'string' ? ISO_DAY.exec(v) : null;
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
};
const addDays = (day: string, n: number) => {
  const m = ISO_DAY.exec(day)!;
  return isoDate(new Date(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() + n * DAY_MS + 3_600_000));
};

/** Stock: batches, receiving and adjusting, reorder levels, the low-stock alert and the movement log. */
@Injectable()
export class PharmacyStockService {
  private readonly logger = new Logger(PharmacyStockService.name);

  constructor(
    @InjectModel(PharmacyBatch.name) private readonly batches: Model<PharmacyBatchDocument>,
    @InjectModel(PharmacyMovement.name) private readonly movementDocs: Model<PharmacyMovementDocument>,
    @InjectModel(PharmacyStockLevel.name) private readonly levels: Model<PharmacyStockLevelDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly orders: PharmacyOrdersService,
    private readonly settings: PharmacySettingsService,
  ) {}

  // ---------- reads ----------

  /** The sum of the unexpired quantities of a product in a store. */
  async usable(product: string, store: Store): Promise<number> {
    const [row] = await this.batches
      .aggregate<{ total: number }>([{ $match: { product, store, expiry: { $gte: today() }, quantity: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$quantity' } } }])
      .exec();
    return row?.total ?? 0;
  }

  async stock(store?: string): Promise<StockRow[]> {
    if (store !== undefined && !isStore(store)) throw new BadRequestException('Choose the Main pharmacy or the ER');
    const filter = store ? { store } : {};
    const [batches, levels, window] = await Promise.all([
      this.batches.find({ ...filter, quantity: { $gt: 0 } }).sort({ expiry: 1, batchNo: 1 }).lean<PharmacyBatchDocument[]>().exec(),
      this.levels.find(filter).lean<PharmacyStockLevelDocument[]>().exec(),
      this.settings.nearExpiryDays(),
    ]);
    const day = today();
    const nearTo = addDays(day, window);
    const rows = new Map<string, StockRow>();
    const row = (product: string, st: Store): StockRow | null => {
      const key = `${product}|${st}`;
      let r = rows.get(key);
      if (!r) {
        const def = productByKey(product);
        if (!def) return null;
        r = { product, label: def.label, medicine: def.medicine, store: st, usable: 0, reorderLevel: 0, low: false, batches: [], nearExpiry: 0, expired: 0 };
        rows.set(key, r);
      }
      return r;
    };
    for (const b of batches) {
      const r = row(b.product, b.store);
      if (!r) continue;
      const expired = b.expiry < day;
      const near = !expired && b.expiry <= nearTo;
      r.batches.push({ id: String(b._id), batchNo: b.batchNo, expiry: b.expiry, quantity: b.quantity, expired, nearExpiry: near });
      if (expired) r.expired += b.quantity;
      else r.usable += b.quantity;
      if (near) r.nearExpiry += b.quantity;
    }
    for (const l of levels) {
      const r = row(l.product, l.store);
      if (r) r.reorderLevel = l.reorderLevel;
    }
    for (const r of rows.values()) r.low = r.reorderLevel > 0 && r.usable <= r.reorderLevel;
    return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label) || a.store.localeCompare(b.store));
  }

  async movements(q: { product?: string; store?: string; limit?: number } = {}): Promise<MovementView[]> {
    const filter: Record<string, unknown> = {};
    if (q.product) filter.product = q.product;
    if (q.store) {
      if (!isStore(q.store)) throw new BadRequestException('Choose the Main pharmacy or the ER');
      filter.store = q.store;
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(q.limit)) || 100));
    const docs = await this.movementDocs.find(filter).sort({ at: -1, _id: -1 }).limit(limit).lean<PharmacyMovementDocument[]>().exec();
    return docs.map((d) => ({
      id: String(d._id),
      batch: String(d.batch),
      product: d.product,
      label: productByKey(d.product)?.label ?? d.product,
      store: d.store,
      change: d.change,
      kind: d.kind,
      reason: d.reason,
      line: d.line ? String(d.line) : null,
      by: d.by,
      at: new Date(d.at).toISOString(),
    }));
  }

  // ---------- receiving and adjusting ----------

  async receive(actor: Actor, input: { product: string; store: string; batchNo: string; expiry: string; quantity: number }): Promise<{ id: string; usable: number }> {
    const product = typeof input?.product === 'string' ? productByKey(input.product) : undefined;
    if (!product) throw new BadRequestException('Choose a medicine from the list');
    if (!isStore(input.store)) throw new BadRequestException('Choose the Main pharmacy or the ER');
    const batchNo = typeof input.batchNo === 'string' ? input.batchNo.trim() : '';
    if (batchNo.length < 1 || batchNo.length > 40) throw new BadRequestException('Enter the batch number (up to 40 characters)');
    if (!validDay(input.expiry)) throw new BadRequestException('Enter the expiry date as YYYY-MM-DD');
    if (!whole(input.quantity, 1, MAX_QTY)) throw new BadRequestException(`Quantity must be a whole number from 1 to ${MAX_QTY}`);
    if (input.expiry < today()) throw new BadRequestException('This batch has already expired');
    const clash = await this.batches.findOne({ product: product.key, store: input.store, batchNo }).lean().exec();
    if (clash && clash.expiry !== input.expiry) throw new ConflictException(`Batch ${batchNo} is already in stock with another expiry date`);
    let batch: PharmacyBatchDocument | null;
    try {
      batch = await this.batches
        .findOneAndUpdate(
          { product: product.key, store: input.store, batchNo, expiry: input.expiry },
          {
            $inc: { quantity: input.quantity },
            $setOnInsert: { medicine: product.medicine, receivedBy: { id: actor.id, name: actor.name }, receivedAt: clinicNow(), takes: [] },
          },
          { upsert: true, new: true },
        )
        .exec();
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new ConflictException(`Batch ${batchNo} is already in stock with another expiry date`);
      throw e;
    }
    await this.movementDocs.create({
      batch: batch!._id, product: product.key, store: input.store, change: input.quantity, kind: 'received',
      reason: `Received batch ${batchNo}`, by: { id: actor.id, name: actor.name }, at: clinicNow(),
    });
    await this.afterChange(product.key, input.store);
    await this.releaseWaiting(product.key);
    return { id: String(batch!._id), usable: await this.usable(product.key, input.store) };
  }

  /** Changes a batch's quantity. The guarded `$inc` never lets it go below zero, whatever else is running. */
  async adjust(actor: Actor, batchId: string, input: { change: number; reason: AdjustReason }): Promise<{ id: string; quantity: number }> {
    if (!whole(input?.change, -MAX_QTY, MAX_QTY) || input.change === 0) throw new BadRequestException(`Change must be a whole number other than 0, up to ${MAX_QTY}`);
    if (!(ADJUST_REASONS as readonly string[]).includes(input.reason)) throw new BadRequestException('Choose a reason: damaged, expired or count correction');
    const existing = isValidObjectId(batchId) ? await this.batches.findById(batchId).lean<PharmacyBatchDocument>().exec() : null;
    if (!existing) throw new NotFoundException('Batch not found');
    const done = await this.batches
      .findOneAndUpdate({ _id: existing._id, quantity: { $gte: -input.change } }, { $inc: { quantity: input.change } }, { new: true })
      .lean<PharmacyBatchDocument>()
      .exec();
    if (!done) throw new ConflictException(`That would take batch ${existing.batchNo} below zero`);
    await this.movementDocs.create({
      batch: done._id, product: done.product, store: done.store, change: input.change, kind: 'adjusted', reason: input.reason,
      by: { id: actor.id, name: actor.name }, at: clinicNow(),
    });
    await this.afterChange(done.product, done.store);
    return { id: String(done._id), quantity: done.quantity };
  }

  /** Writes off what is left of an expired batch. */
  async removeExpired(actor: Actor, batchId: string): Promise<{ id: string; quantity: number }> {
    const batch = isValidObjectId(batchId) ? await this.batches.findById(batchId).lean<PharmacyBatchDocument>().exec() : null;
    if (!batch) throw new NotFoundException('Batch not found');
    if (batch.expiry >= today()) throw new ConflictException(`Batch ${batch.batchNo} has not expired`);
    if (batch.quantity < 1) throw new ConflictException(`Nothing is left in batch ${batch.batchNo}`);
    return this.adjust(actor, batchId, { change: -batch.quantity, reason: 'expired' });
  }

  async setLevel(actor: Actor, input: { product: string; store: string; reorderLevel: number }): Promise<{ product: string; store: Store; reorderLevel: number }> {
    if (typeof input?.product !== 'string' || !productByKey(input.product)) throw new BadRequestException('Choose a medicine from the list');
    if (!isStore(input.store)) throw new BadRequestException('Choose the Main pharmacy or the ER');
    if (!whole(input.reorderLevel, 0, MAX_QTY)) throw new BadRequestException(`The reorder level must be a whole number from 0 to ${MAX_QTY}`);
    await this.levels.updateOne({ product: input.product, store: input.store }, { $set: { reorderLevel: input.reorderLevel } }, { upsert: true }).exec();
    this.logger.log(`Reorder level of ${input.product} in ${input.store} set to ${input.reorderLevel} by ${actor.name}`);
    await this.afterChange(input.product, input.store);
    return { product: input.product, store: input.store, reorderLevel: input.reorderLevel };
  }

  // ---------- low stock ----------

  /**
   * The low-stock rule. A watched pair (reorder level above 0) is low when its usable quantity is at or below
   * the level. It alerts once: the `lowAlertedAt` claim, then the alert. Back above the level, the claim is
   * released and the alert completed. Returns true when it raised an alert.
   */
  async afterChange(product: string, store: Store): Promise<boolean> {
    const level = await this.levels.findOne({ product, store }).lean<PharmacyStockLevelDocument>().exec();
    if (!level) return false;
    const watched = level.reorderLevel > 0;
    const usable = watched ? await this.usable(product, store) : 0;
    const low = watched && usable <= level.reorderLevel;
    if (low && !level.lowAlertedAt) {
      const claimed = await this.levels.findOneAndUpdate({ _id: level._id, lowAlertedAt: { $exists: false } }, { $set: { lowAlertedAt: new Date() } }, { new: true }).exec();
      if (!claimed) return false;
      await this.raiseAlert(product, store, usable, level.reorderLevel);
      return true;
    }
    if (!low && level.lowAlertedAt) {
      const cleared = await this.levels.findOneAndUpdate({ _id: level._id, lowAlertedAt: { $exists: true } }, { $unset: { lowAlertedAt: '' } }).exec();
      if (cleared) await this.alerts.updateOne({ link: lowAlertLink(product, store) }, { $set: { status: 'Completed' } }).exec();
    }
    return false;
  }

  /** One alert per product and store: a later low reuses the document and makes it Pending again. */
  private async raiseAlert(product: string, store: Store, usable: number, level: number): Promise<void> {
    const def = productByKey(product);
    await this.alerts
      .updateOne(
        { link: lowAlertLink(product, store) },
        {
          $unset: { escalation: '' },
          $set: {
            title: `Low stock: ${def?.label ?? product} (${STORE_LABEL[store]})`,
            subtitle: `${usable} left · reorder level ${level}`,
            type: 'Medication Alert',
            category: 'Medication',
            priority: 'Medium',
            status: 'Pending',
            dueDateTime: displayDateTime(clinicNow()),
          },
        },
        { upsert: true },
      )
      .exec();
  }

  /** `afterChange` for every watched pair, and the alert for a flag that is set with no alert. Returns the alerts raised. */
  async sweepLowStock(): Promise<number> {
    let raised = 0;
    const levels = await this.levels.find({ $or: [{ reorderLevel: { $gt: 0 } }, { lowAlertedAt: { $exists: true } }] }).lean<PharmacyStockLevelDocument[]>().exec();
    for (const l of levels) {
      try {
        if (await this.afterChange(l.product, l.store)) {
          raised++;
          continue;
        }
        const fresh = await this.levels.findById(l._id).lean<PharmacyStockLevelDocument>().exec();
        if (fresh?.lowAlertedAt && fresh.reorderLevel > 0 && !(await this.alerts.exists({ link: lowAlertLink(l.product, l.store) }))) {
          await this.raiseAlert(l.product, l.store, await this.usable(l.product, l.store), fresh.reorderLevel);
          raised++;
        }
      } catch (e) {
        this.logger.error(`Low-stock sweep of ${l.product} in ${l.store} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return raised;
  }

  // ---------- waiting for stock ----------

  /**
   * Approved lines of a product that were waiting for stock go back on the issue clock: `issueFrom` is now,
   * and an ER or Ward line announces `pharmacy.to-issue` (OPD lines have no issue clock). Returns how many it released.
   */
  async releaseWaiting(product: string): Promise<number> {
    const waiting = await this.lines.find({ status: 'approved', waitingForStock: true, product }).lean<PharmacyLineDocument[]>().exec();
    let released = 0;
    for (const l of waiting) {
      try {
        const issueFrom = new Date();
        const done = await this.lines
          .updateOne({ _id: l._id, status: 'approved', waitingForStock: true, version: l.version }, { $set: { waitingForStock: false, issueFrom } })
          .exec();
        if (!done.modifiedCount) continue;
        released++;
        const order = await this.orderDocs.findById(l.order).lean<PharmacyOrderDocument>().exec();
        const events = order && order.setting !== 'OPD' ? [{ type: 'pharmacy.to-issue' as const, lineId: String(l._id), dedupeKey: startKey('pharmacy.to-issue', { _id: l._id, issueFrom }) }] : [];
        await this.orders.publish(String(l.order), events);
      } catch (e) {
        this.logger.error(`Releasing line ${String(l._id)} from waiting for stock failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return released;
  }
}
