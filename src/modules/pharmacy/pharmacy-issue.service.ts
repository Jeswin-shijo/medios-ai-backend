import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { STORE_LABEL, Store, productByKey, sameKind } from './pharmacy-catalogue';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { PharmacyLineView, PharmacyOrdersService } from './pharmacy-orders.service';
import { Flag, needsDoctor, needsReason, needsReview } from './pharmacy-rules';
import { PharmacyStockService, STORES, isStore, today } from './pharmacy-stock.service';
import { PharmacyBatch, PharmacyBatchDocument } from './schemas/pharmacy-batch.schema';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyMovement, PharmacyMovementDocument } from './schemas/pharmacy-movement.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

const lineBusy = 'This line just changed. Reload and try again.';
/** A claim older than this (real time) is a crashed issue, not one in progress. */
const STALE_CLAIM_MS = 30_000;
const MAX_ISSUE_QTY = 10_000;

export interface IssueOptions {
  /** The line's quantity in its issue unit; null when unknown (the pharmacist enters it). */
  quantity: number | null;
  defaultStore: Store;
  stores: { store: Store; usable: number; batches: { id: string; batchNo: string; expiry: string; quantity: number }[] }[];
}

interface Take {
  batch: PharmacyBatchDocument;
  qty: number;
}

/** Issuing approved lines from stock, oldest expiry first, and the Out of stock query. */
@Injectable()
export class PharmacyIssueService {
  private readonly logger = new Logger(PharmacyIssueService.name);

  constructor(
    @InjectModel(PharmacyBatch.name) private readonly batches: Model<PharmacyBatchDocument>,
    @InjectModel(PharmacyMovement.name) private readonly movementDocs: Model<PharmacyMovementDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    private readonly stock: PharmacyStockService,
    private readonly orders: PharmacyOrdersService,
    private readonly checks: PharmacyChecksService,
  ) {}

  private async load(lineId: string): Promise<PharmacyLineDocument> {
    const line = isValidObjectId(lineId) ? await this.lines.findById(lineId).lean<PharmacyLineDocument>().exec() : null;
    if (!line) throw new NotFoundException('Medicine line not found');
    return line;
  }

  private async defaultStoreOf(line: PharmacyLineDocument): Promise<Store> {
    const order = await this.orderDocs.findById(line.order).lean<PharmacyOrderDocument>().exec();
    return order?.setting === 'ER' ? 'er' : 'main';
  }

  /** Unexpired batches holding stock, oldest expiry first. */
  private usableBatches(product: string, store: Store) {
    return this.batches
      .find({ product, store, expiry: { $gte: today() }, quantity: { $gt: 0 } })
      .sort({ expiry: 1, batchNo: 1, _id: 1 })
      .lean<PharmacyBatchDocument[]>()
      .exec();
  }

  // ---------- options ----------

  /** What the issue form offers: the line's quantity, the default store, and each store's usable batches. */
  async options(lineId: string): Promise<IssueOptions> {
    const line = await this.load(lineId);
    const stores: IssueOptions['stores'] = [];
    for (const store of STORES) {
      const batches = line.product ? await this.usableBatches(line.product, store) : [];
      stores.push({
        store,
        usable: batches.reduce((n, b) => n + b.quantity, 0),
        batches: batches.map((b) => ({ id: String(b._id), batchNo: b.batchNo, expiry: b.expiry, quantity: b.quantity })),
      });
    }
    return { quantity: line.quantity, defaultStore: await this.defaultStoreOf(line), stores };
  }

  /** The route's name for the same thing (a 409 for not enough stock carries no other-store detail). */
  issueOptions(lineId: string): Promise<IssueOptions> {
    return this.options(lineId);
  }

  // ---------- issuing ----------

  async issue(actor: Actor, lineId: string, input: { store?: string; batchNo?: string; quantity?: number } = {}): Promise<PharmacyLineView> {
    const first = await this.load(lineId);
    // Y48: an allergy recorded after ordering or approval is seen now, before the barrier reads the flags.
    if (first.status === 'approved') await this.orders.recheckPatient(String(first.patient), 'order', { kinds: ['allergy'] });
    const line = await this.load(lineId);
    // The recheck itself just held the line in an allergy query: say so.
    if (first.status === 'approved' && line.status === 'query' && line.query?.kind === 'allergy') throw new ConflictException('A new allergy was found: the doctor has been asked');
    if (line.status !== 'approved') throw new ConflictException('This line is not approved for issue');
    if (line.issuing) throw new ConflictException('This line is being issued');

    // The last barrier before a medicine leaves the pharmacy: an open allergy gate is never passed.
    const flags = (line.flags ?? []) as Flag[];
    if (needsDoctor(flags, line.version).length) {
      await this.checks.holdAtOnce([line]);
      throw new ConflictException('A doctor must confirm this allergy before it is issued. A query has been opened.');
    }
    // Y28 backstop: a flag that arrived after the approval (an unreviewed amber allergy, or a red flag nobody confirmed) sends the line back.
    if (needsReview(flags, line.version).length || needsReason(flags, line.version).length) {
      const back = await this.checks.sendBackToCheck(lineId);
      throw new ConflictException(back ? 'A flag arrived after this line was approved. It is back in To check.' : lineBusy);
    }

    const store: Store = input?.store === undefined ? await this.defaultStoreOf(line) : (input.store as Store);
    if (!isStore(store)) throw new BadRequestException('Choose the Main pharmacy or the ER');
    let quantity = line.quantity;
    if (quantity === null) {
      const typed = input?.quantity;
      if (!(typeof typed === 'number' && Number.isInteger(typed) && typed >= 1 && typed <= MAX_ISSUE_QTY)) {
        throw new BadRequestException(`Enter the quantity to issue, a whole number from 1 to ${MAX_ISSUE_QTY}`);
      }
      quantity = typed;
    }
    const batchNo = typeof input?.batchNo === 'string' ? input.batchNo.trim() : '';
    const product = line.product ? productByKey(line.product) : undefined;
    if (line.product && !product) throw new ConflictException('This medicine is not in the medicine list');

    // 1. Claim the line. It must still be approved at this version, with the flags just read.
    const by = { id: actor.id, name: actor.name };
    const issuing = { by, store, realAt: new Date() };
    const claimed = await this.lines.updateOne({ _id: line._id, status: 'approved', version: line.version, issuing: { $exists: false }, flags: line.flags }, { $set: { issuing } }).exec();
    if (!claimed.modifiedCount) throw new ConflictException(lineBusy);

    const done: Take[] = [];
    try {
      // 2 and 3. Plan the takes, then take each atomically.
      if (product) {
        const plan = await this.plan(product.key, product.label, store, quantity, batchNo);
        for (const t of plan) {
          const took = await this.batches
            .findOneAndUpdate(
              { _id: t.batch._id, quantity: { $gte: t.qty }, expiry: { $gte: today() }, 'takes.line': { $ne: line._id } },
              { $inc: { quantity: -t.qty }, $push: { takes: { line: line._id, qty: t.qty, realAt: new Date() } } },
              { new: true },
            )
            .lean<PharmacyBatchDocument>()
            .exec();
          if (!took) throw await this.notEnough(product.key, product.label, store);
          done.push({ batch: took, qty: t.qty });
        }
      }
      // 4. Flip the line, guarded on the claim and on the flags that were read.
      const at = clinicNow();
      const flipped = await this.lines
        .updateOne(
          { _id: line._id, status: 'approved', version: line.version, 'issuing.realAt': issuing.realAt, flags: line.flags },
          {
            $set: {
              status: 'issued',
              waitingForStock: false,
              issued: {
                by, at, realAt: new Date(), store, quantity,
                batches: done.map((t) => ({ batch: String(t.batch._id), batchNo: t.batch.batchNo, expiry: t.batch.expiry, qty: t.qty })),
              },
            },
            $unset: { issuing: '' },
          },
        )
        .exec();
      if (!flipped.modifiedCount) throw new ConflictException(lineBusy);
    } catch (e) {
      await this.undoTakes(String(line._id), done);
      await this.lines.updateOne({ _id: line._id, 'issuing.realAt': issuing.realAt }, { $unset: { issuing: '' } }).exec().catch(() => undefined);
      throw e;
    }

    // 5 and 6. The line is issued: what follows is repeatable, and repairTakes finishes it after a failure.
    try {
      await this.settle(String(line._id), done.map((t) => ({ batch: String(t.batch._id), product: t.batch.product, store: t.batch.store, qty: t.qty })), by, clinicNow());
      await this.announceIssued(lineId);
      if (product) await this.stock.afterChange(product.key, store);
    } catch (e) {
      this.logger.error(`Finishing the issue of line ${lineId} failed (repair will retry): ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.orders.line(lineId);
  }

  /** The batches to take from: the scanned batch, or the store's batches oldest expiry first. */
  private async plan(product: string, label: string, store: Store, quantity: number, batchNo: string): Promise<Take[]> {
    if (batchNo) {
      const scanned = await this.batches.findOne({ product, store, batchNo }).lean<PharmacyBatchDocument>().exec();
      if (!scanned) throw new ConflictException(`Batch ${batchNo} is not in the ${STORE_LABEL[store]} stock of ${label}`);
      if (scanned.expiry < today()) throw new ConflictException(`Batch ${batchNo} expired on ${scanned.expiry}`);
      if (scanned.quantity < quantity) throw new ConflictException(`Batch ${batchNo} holds only ${scanned.quantity} (${quantity} needed)`);
      return [{ batch: scanned, qty: quantity }];
    }
    const plan: Take[] = [];
    let need = quantity;
    for (const b of await this.usableBatches(product, store)) {
      if (need <= 0) break;
      const qty = Math.min(b.quantity, need);
      plan.push({ batch: b, qty });
      need -= qty;
    }
    if (need > 0) throw await this.notEnough(product, label, store);
    return plan;
  }

  private async notEnough(product: string, label: string, store: Store): Promise<ConflictException> {
    return new ConflictException(`Not enough ${label} in ${STORE_LABEL[store]} (${await this.stock.usable(product, store)} left)`);
  }

  /** Puts back what this line took (each guarded on the take still being there, so it never happens twice). */
  private async undoTakes(lineId: string, done: Take[]): Promise<void> {
    for (const t of done) await this.putBack(String(t.batch._id), lineId, t.qty).catch((e) => this.logger.error(`Putting back a take failed: ${String(e)}`));
  }

  private async putBack(batchId: string, lineId: string, qty: number): Promise<boolean> {
    const line = new Types.ObjectId(lineId);
    const r = await this.batches.updateOne({ _id: batchId, takes: { $elemMatch: { line, qty } } }, { $inc: { quantity: qty }, $pull: { takes: { line } } }).exec();
    return r.modifiedCount > 0;
  }

  /** The movement of each take (written once per batch and line), then the take is pulled. */
  private async settle(lineId: string, takes: { batch: string; product: string; store: Store; qty: number }[], by: { id: string; name: string }, at: Date): Promise<void> {
    const line = new Types.ObjectId(lineId);
    for (const t of takes) {
      await this.movementDocs
        .updateOne(
          { batch: t.batch, line, kind: 'issued' },
          { $setOnInsert: { product: t.product, store: t.store, change: -t.qty, reason: 'issued', by, at } },
          { upsert: true },
        )
        .exec()
        // A racing writer already logged it.
        .catch((e) => {
          if ((e as { code?: number }).code !== 11000) throw e;
        });
      await this.batches.updateOne({ _id: t.batch }, { $pull: { takes: { line } } }).exec();
    }
  }

  /** Sends pharmacy.issued once (its dedupe key holds the line) and records that it went out. */
  async announceIssued(lineId: string): Promise<boolean> {
    const line = await this.load(lineId);
    if (line.status !== 'issued' || !line.issued || line.issued.announcedAt) return false;
    await this.orders.publish(String(line.order), [{ type: 'pharmacy.issued', lineId, dedupeKey: `pharmacy.issued:${lineId}` }]);
    await this.lines.updateOne({ _id: line._id, 'issued.announcedAt': { $exists: false } }, { $set: { 'issued.announcedAt': new Date() } }).exec();
    return true;
  }

  // ---------- out of stock ----------

  /** Opens a stock query to the doctor, listing same-kind medicines that are in stock. Only when no store covers the line. */
  async outOfStock(actor: Actor, lineId: string): Promise<PharmacyLineView> {
    const line = await this.load(lineId);
    if (line.status !== 'approved') throw new ConflictException('This line is not approved for issue');
    if (line.issuing) throw new ConflictException('This line is being issued');
    const product = line.product ? productByKey(line.product) : undefined;
    if (!product || !line.medicine) throw new ConflictException('An unlisted medicine has no stock to run out of');
    const need = line.quantity ?? 1;
    for (const store of STORES) {
      if ((await this.stock.usable(product.key, store)) >= need) throw new ConflictException(`There is stock in ${STORE_LABEL[store]}`);
    }
    const kinds = sameKind(line.medicine);
    const inStock = kinds.length
      ? await this.batches.distinct('medicine', { medicine: { $in: kinds }, expiry: { $gte: today() }, quantity: { $gt: 0 } }).exec()
      : [];
    const suggestions = kinds.filter((k) => inStock.includes(k));
    const opened = await this.checks.openQuery(lineId, {
      kind: 'stock',
      question: `Out of stock in both stores: ${product.label}. Choose another medicine, wait for stock, or cancel.`,
      by: { id: actor.id, name: actor.name },
      suggestions,
    });
    if (!opened) throw new ConflictException(lineBusy);
    return this.orders.line(lineId);
  }

  // ---------- repair ----------

  /**
   * Finishes what a crash left. A line still approved whose claim is older than 30 s has its takes put back and
   * its claim removed (the claim goes first, so a slow issue can never flip behind it). Takes of a line that is
   * neither issued nor claimed are put back. Takes of an issued line get their movement, then are pulled.
   * `undone` counts lines put right, `logged` counts movements written.
   */
  async repairTakes(): Promise<{ undone: number; logged: number }> {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
    const undone = new Set<string>();
    let logged = 0;

    const stuck = await this.lines.find({ status: 'approved', 'issuing.realAt': { $lt: cutoff } }).lean<PharmacyLineDocument[]>().exec();
    for (const l of stuck) {
      const fenced = await this.lines.updateOne({ _id: l._id, status: 'approved', 'issuing.realAt': l.issuing!.realAt }, { $unset: { issuing: '' } }).exec();
      if (!fenced.modifiedCount) continue;
      undone.add(String(l._id));
      for (const b of await this.batches.find({ 'takes.line': l._id }).lean<PharmacyBatchDocument[]>().exec()) {
        for (const t of b.takes.filter((x) => String(x.line) === String(l._id))) await this.putBack(String(b._id), String(l._id), t.qty);
      }
    }

    const withTakes = await this.batches.find({ 'takes.0': { $exists: true } }).lean<PharmacyBatchDocument[]>().exec();
    for (const b of withTakes) {
      for (const t of b.takes) {
        try {
          if (new Date(t.realAt) >= cutoff) continue; // a request in flight owns it
          const line = await this.lines.findById(t.line).lean<PharmacyLineDocument>().exec();
          if (line?.status === 'issued' && line.issued) {
            // Only a take the line really issued is logged; a leftover from a failed put-back goes back to stock.
            if (line.issued.batches?.some((x) => x.batch === String(b._id) && x.qty === t.qty)) {
              await this.settle(String(line._id), [{ batch: String(b._id), product: b.product, store: b.store, qty: t.qty }], line.issued.by, line.issued.at);
              logged++;
            } else if (await this.putBack(String(b._id), String(t.line), t.qty)) undone.add(String(t.line));
          } else if (!(line?.status === 'approved' && line.issuing)) {
            // Neither issued nor being issued: nothing will ever flip it, so the stock goes back.
            if (await this.putBack(String(b._id), String(t.line), t.qty)) undone.add(String(t.line));
          }
        } catch (e) {
          this.logger.error(`Repairing a take of batch ${String(b._id)} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return { undone: undone.size, logged };
  }
}
