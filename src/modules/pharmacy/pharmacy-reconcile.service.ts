import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { DUPLICATE_WINDOW_MS } from '../coordinator/messages.service';
import { AgentMessage, MessageDocument } from '../coordinator/schemas/agent-message.schema';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { Prescription, PrescriptionDocument } from '../prescriptions/schemas/prescription.schema';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { PharmacyIssueService } from './pharmacy-issue.service';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { PharmacyPrescriptionsService } from './pharmacy-prescriptions.service';
import { Flag, needsDoctor, needsReason } from './pharmacy-rules';
import { PharmacyStockService } from './pharmacy-stock.service';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

/** Rows touched more recently than this belong to the request in flight. */
const GRACE_MS = 30_000;
/** Most repairs one branch makes in one pass. */
const BATCH = 50;
/** Most rows one branch looks at in one pass; the window moves on every pass, so no row is starved. */
const WINDOW = 500;
const DAY_MS = 86_400_000;
const REPLACEMENT_DAYS = 7;
/** A repair resend with the key of a message sent this recently would be dropped as a duplicate: wait for the next pass. */
const RESEND_AFTER_MS = DUPLICATE_WINDOW_MS + 5_000;

export interface ReconcileResult {
  ordered: number;
  rounds: number;
  done: number;
  queries: number;
  answers: number;
  issued: number;
  takes: number;
  /** Y20b: stored replacements that were missing and were added. */
  replacements: number;
  /** Y21b and Y27: red-flag lines that had no query and now have one. */
  holds: number;
  /** Waiting lines whose stock arrived. */
  released: number;
  /** Prescriptions whose latest revision was not in Pharmacy and was synced. */
  prescriptions: number;
}

type Row = { _id: Types.ObjectId };
const ref = /^(.+):([ciq])(\d+)$/;

/**
 * The safety net the scheduler runs every 60 seconds. It repairs what a crash or a failed message left
 * half-done: a lost message, a round without its clock, a clock whose round has closed, a query without
 * its clock or alert, an answer that never stopped its clock, a lost replacement, a red flag nobody asked
 * about, stock takes and an issued line nobody heard about. Every branch is bounded, leaves rows touched
 * in the last 30 seconds alone, and has its own try/catch per item, so one broken row never stops the pass.
 */
@Injectable()
export class PharmacyReconcileService {
  private readonly logger = new Logger(PharmacyReconcileService.name);
  private readonly cursors = new Map<string, string>();

  constructor(
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
    @InjectModel(AgentMessage.name) private readonly messageDocs: Model<MessageDocument>,
    private readonly orders: PharmacyOrdersService,
    private readonly checks: PharmacyChecksService,
    private readonly issue: PharmacyIssueService,
    private readonly stock: PharmacyStockService,
    @InjectModel(Prescription.name) private readonly rxs: Model<PrescriptionDocument>,
    private readonly prescriptions: PharmacyPrescriptionsService,
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    const out: ReconcileResult = { ordered: 0, rounds: 0, done: 0, queries: 0, answers: 0, issued: 0, takes: 0, replacements: 0, holds: 0, released: 0, prescriptions: 0 };
    const guard = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        this.logger.error(`Reconcile: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await guard('the orders branch', async () => void (out.ordered = await this.announceOrders()));
    await guard('the rounds branch', async () => void (out.rounds = await this.repairRounds()));
    await guard('the closed rounds branch', async () => void (out.done = await this.repairDone()));
    await guard('the queries branch', async () => void (out.queries = await this.repairQueries()));
    await guard('the answers branch', async () => void (out.answers = await this.repairAnswers()));
    await guard('the replacements branch', async () => void (out.replacements = await this.repairReplacements()));
    // Takes first: a line stuck mid-issue has its claim cleared before any hold could leave the claim behind.
    await guard('the stock takes branch', async () => {
      const t = await this.issue.repairTakes();
      out.takes = t.undone + t.logged;
    });
    await guard('the waiting lines branch', async () => void (out.released = await this.stock.releaseWaitingWithStock()));
    await guard('the allergy holds branch', async () => void (out.holds += await this.holdOpenAllergies()));
    await guard('the issued red flags branch', async () => void (out.holds += await this.askIssuedFlags()));
    await guard('the prescriptions branch', async () => void (out.prescriptions = await this.syncPrescriptions()));
    await guard('the issued branch', async () => void (out.issued = await this.announceIssued()));
    return out;
  }

  // ---------- helpers ----------

  private recent(d?: Date | null): boolean {
    return !!d && Date.now() - new Date(d).getTime() < GRACE_MS;
  }

  /** Whether a message with this key went out recently enough that a resend would be dropped as a duplicate. */
  private async tooSoon(filter: Record<string, unknown>): Promise<boolean> {
    return !!(await this.messageDocs.exists({ ...filter, createdAt: { $gte: new Date(Date.now() - RESEND_AFTER_MS) } }).exec());
  }

  /**
   * Looks at up to WINDOW rows of a branch, resuming where the last pass stopped (and wrapping), and repairs
   * at most BATCH of them. A failing row is logged and counted as not repaired.
   */
  private async scan<T extends Row>(key: string, model: Model<any>, filter: Record<string, unknown>, what: (row: T) => string, repair: (row: T) => Promise<boolean>): Promise<number> {
    const cursor = this.cursors.get(key);
    const read = (extra: Record<string, unknown>, limit: number) => model.find({ ...filter, ...extra }).sort({ _id: 1 }).limit(limit).lean<T[]>().exec();
    let rows: T[] = cursor ? await read({ _id: { $gt: new Types.ObjectId(cursor) } }, WINDOW) : [];
    if (rows.length < WINDOW) rows = rows.concat(await read(cursor ? { _id: { $lte: new Types.ObjectId(cursor) } } : {}, WINDOW - rows.length));
    let fixed = 0;
    let last: T | undefined;
    for (const row of rows) {
      if (fixed >= BATCH) break;
      last = row;
      try {
        if (await repair(row)) fixed++;
      } catch (e) {
        this.logger.error(`Reconcile: ${what(row)} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (last) this.cursors.set(key, String(last._id));
    return fixed;
  }

  private line(id: unknown): Promise<PharmacyLineDocument | null> {
    return isValidObjectId(id) ? this.lines.findById(id).lean<PharmacyLineDocument>().exec() : Promise.resolve(null);
  }

  // ---------- (a) pharmacy.ordered ----------

  private announceOrders(): Promise<number> {
    return this.scan<PharmacyOrderDocument & Row>(
      'ordered',
      this.orderDocs,
      { announcedAt: { $exists: false }, createdAt: { $lt: new Date(Date.now() - GRACE_MS) } },
      (o) => `announcing order ${o.number}`,
      async (o) => {
        // Y35: an order with no lines (a prescription sync that has not added them yet) is not announced.
        if (!(await this.lines.exists({ order: o._id }).exec())) return false;
        const doc = await this.orderDocs.findById(o._id).exec();
        return doc ? this.orders.announceOrdered(doc) : false;
      },
    );
  }

  // ---------- (b) rounds, their clocks and their done messages ----------

  private async repairRounds(): Promise<number> {
    const waiting = (await this.lines.distinct('order', { status: { $in: ['to-check', 'approved'] } }).exec()) as Types.ObjectId[];
    return this.scan<PharmacyOrderDocument & Row>(
      'rounds',
      this.orderDocs,
      { $or: [{ checkOpen: true }, { issueOpen: true }, { _id: { $in: waiting } }] },
      (o) => `the rounds of order ${o.number}`,
      async (o) => {
        if (this.recent(o.updatedAt)) return false;
        const newest = await this.lines.findOne({ order: o._id }).sort({ updatedAt: -1 }).select('updatedAt').lean<{ updatedAt?: Date }>().exec();
        if (this.recent(newest?.updatedAt)) return false;
        const id = String(o._id);
        const { closed } = await this.orders.syncRounds(id);
        let changed = closed.check !== undefined || closed.issue !== undefined;
        for (const [clock, round] of [['check', closed.check], ['issue', closed.issue]] as const) {
          if (round === undefined) continue;
          if (await this.tooSoon({ dedupeKey: `pharmacy.${clock}-done:${id}:${round}` })) continue;
          await this.orders.sendDone(id, clock, round);
        }
        // The round exists; its clock starts from the start message. No clock in any state: the start never arrived.
        const fresh = await this.orderDocs.findById(o._id).lean<PharmacyOrderDocument>().exec();
        if (!fresh) return changed;
        if (!changed && (fresh.checkRound !== o.checkRound || fresh.issueRound !== o.issueRound || fresh.checkOpen !== o.checkOpen || fresh.issueOpen !== o.issueOpen)) changed = true;
        for (const clock of ['check', 'issue'] as const) {
          if (!fresh[`${clock}Open`] || (clock === 'issue' && fresh.setting === 'OPD')) continue;
          const letter = clock === 'check' ? 'c' : 'i';
          const have = await this.clocks.exists({ def: `pharmacy-${clock}`, ref: `${id}:${letter}${fresh[`${clock}Round`]}` }).exec();
          if (have) continue;
          if (await this.tooSoon({ type: clock === 'check' ? 'pharmacy.to-check' : 'pharmacy.to-issue', 'payload.orderId': id })) continue;
          if (await this.orders.resendStart(id, clock)) changed = true;
        }
        return changed;
      },
    );
  }

  /** A running (or expired and never marked met) clock whose round is closed (the done message never arrived, or never went out): done for that round only. */
  private repairDone(): Promise<number> {
    return this.scan<ClockDocument & Row>(
      'done',
      this.clocks,
      { def: { $in: ['pharmacy-check', 'pharmacy-issue'] }, $or: [{ state: 'running' }, { state: 'expired', stoppedAt: { $exists: false } }] },
      (c) => `the closed round of clock ${String(c._id)}`,
      async (c) => {
        const m = ref.exec(c.ref ?? '');
        if (!m || (m[2] !== 'c' && m[2] !== 'i')) return false;
        const order = await this.orderDocs.findById(m[1]).lean<PharmacyOrderDocument>().exec();
        if (!order || this.recent(order.updatedAt)) return false;
        const clock = m[2] === 'c' ? 'check' : 'issue';
        const n = Number(m[3]);
        const current = order[`${clock}Round`];
        const closed = n < current || (n === current && !order[`${clock}Open`]);
        if (!closed) return false;
        if (await this.tooSoon({ dedupeKey: `pharmacy.${clock}-done:${m[1]}:${n}` })) return false;
        await this.orders.sendDone(m[1], clock, n);
        return true;
      },
    );
  }

  // ---------- (c) an open query with no clock or alert ----------

  private repairQueries(): Promise<number> {
    return this.scan<PharmacyLineDocument & Row>(
      'queries',
      this.lines,
      { 'query.seq': { $exists: true }, 'query.answer': { $exists: false }, status: { $in: ['query', 'issued'] } },
      (l) => `the query of line ${String(l._id)}`,
      async (l) => {
        if (this.recent(l.updatedAt) || !l.query) return false;
        const id = String(l._id);
        const seq = l.query.seq;
        if (await this.clocks.exists({ def: 'pharmacy-query', ref: `${id}:q${seq}` }).exec()) return false;
        const key = `pharmacy.query:${id}:${seq}`;
        if (await this.tooSoon({ dedupeKey: key })) return false;
        // Read again: an answer that landed after the first read must not reopen anything.
        const now = await this.line(l._id);
        if (!now?.query || now.query.answer || now.query.seq !== seq) return false;
        await this.checks.raiseQueryAlert(id);
        await this.orders.publish(String(now.order), [{ type: 'pharmacy.query', lineId: id, extra: { querySeq: seq, kind: now.query.kind, queryDueAt: now.query.dueAt }, dedupeKey: key }]);
        return true;
      },
    );
  }

  // ---------- (d) an answer that never stopped its clock ----------

  /**
   * Query clocks still running (or expired and never marked met) for a query that has been answered: the
   * answer is resent for that query's own number, so it can never reach a newer query's clock, and only
   * that query's alert is completed.
   */
  private repairAnswers(): Promise<number> {
    return this.scan<ClockDocument & Row>(
      'answers',
      this.clocks,
      { def: 'pharmacy-query', $or: [{ state: 'running' }, { state: 'expired', stoppedAt: { $exists: false } }] },
      (c) => `the answer for clock ${String(c._id)}`,
      async (c) => {
        const m = ref.exec(c.ref ?? '');
        if (!m || m[2] !== 'q') return false;
        const seq = Number(m[3]);
        const line = await this.line(m[1]);
        if (!line?.query || this.recent(line.updatedAt)) return false;
        let outcome: string;
        if (line.query.seq === seq && line.query.answer) {
          if (Date.now() - new Date(line.query.answer.realAt).getTime() > DAY_MS) return false;
          outcome = line.query.answer.outcome;
        } else if (line.query.seq > seq) {
          // A later query can only open after this one was answered; the line keeps just the latest answer.
          outcome = 'answered';
        } else {
          return false;
        }
        const key = `pharmacy.query-answered:${m[1]}:${seq}`;
        if (await this.tooSoon({ dedupeKey: key })) return false;
        // Y31: the alert first, as answer() does: if it fails, the clock still runs and the next pass comes back.
        await this.checks.completeQueryAlert(m[1], seq);
        await this.orders.publish(String(line.order), [{ type: 'pharmacy.query-answered', lineId: m[1], extra: { querySeq: seq, outcome }, dedupeKey: key }]);
        return true;
      },
    );
  }

  // ---------- Y20b: a stored replacement that is missing ----------

  private repairReplacements(): Promise<number> {
    return this.scan<PharmacyLineDocument & Row>(
      'replacements',
      this.lines,
      { 'query.answer.replacement': { $exists: true }, 'query.answer.realAt': { $gte: new Date(Date.now() - REPLACEMENT_DAYS * DAY_MS) } },
      (l) => `the replacement of line ${String(l._id)}`,
      async (l) => {
        const r = l.query?.answer?.replacement;
        if (!r || this.recent(l.updatedAt)) return false;
        if (await this.lines.exists({ _id: r.id }).exec()) return false;
        return !!(await this.checks.ensureReplacement(String(l._id)));
      },
    );
  }

  // ---------- Y21b and Y27: a red flag nobody has asked about ----------

  private static readonly NO_OPEN_QUERY = [{ query: { $exists: false } }, { 'query.answer': { $exists: true } }];
  private static readonly UNCONFIRMED_RED = { $elemMatch: { severity: 'red', confirmed: { $exists: false } } };

  /** An approved or to-check line with an unconfirmed red allergy flag and no open query is held for a doctor. */
  private holdOpenAllergies(): Promise<number> {
    return this.scan<PharmacyLineDocument & Row>(
      'allergy-holds',
      this.lines,
      { status: { $in: ['to-check', 'approved'] }, flags: { $elemMatch: { severity: 'red', kind: 'allergy', confirmed: { $exists: false } } }, $or: PharmacyReconcileService.NO_OPEN_QUERY },
      (l) => `holding line ${String(l._id)}`,
      async (l) => {
        if (this.recent(l.updatedAt) || !needsDoctor((l.flags ?? []) as Flag[], l.version).length) return false;
        await this.checks.holdAtOnce([l]);
        const now = await this.line(l._id);
        return !!now?.query && !now.query.answer;
      },
    );
  }

  /** An issued line (the last 24 h) with an unconfirmed red flag and no open query gets a query for that flag (Y24; an allergy is held as at ordering). */
  private askIssuedFlags(): Promise<number> {
    return this.scan<PharmacyLineDocument & Row>(
      'issued-flags',
      this.lines,
      { status: 'issued', 'issued.realAt': { $gte: new Date(Date.now() - DAY_MS) }, flags: PharmacyReconcileService.UNCONFIRMED_RED, $or: PharmacyReconcileService.NO_OPEN_QUERY },
      (l) => `asking about line ${String(l._id)}`,
      async (l) => {
        if (this.recent(l.updatedAt)) return false;
        const flags = (l.flags ?? []) as Flag[];
        const allergy = needsDoctor(flags, l.version)[0];
        const other = needsReason(flags, l.version)[0];
        if (!allergy && !other) return false;
        if (allergy) await this.checks.holdAtOnce([l]);
        else await this.checks.askAboutFlag(String(l._id), other);
        const now = await this.line(l._id);
        return !!now?.query && !now.query.answer;
      },
    );
  }

  // ---------- (f) pharmacy.issued ----------

  private announceIssued(): Promise<number> {
    return this.scan<PharmacyLineDocument & Row>(
      'issued',
      this.lines,
      { status: 'issued', 'issued.announcedAt': { $exists: false }, 'issued.realAt': { $lt: new Date(Date.now() - GRACE_MS) } },
      (l) => `announcing line ${String(l._id)}`,
      (l) => this.issue.announceIssued(String(l._id)),
    );
  }

  // ---------- (g) a saved prescription Pharmacy has not caught up with ----------

  /**
   * A prescription still marked pending (its latest revision not yet handled by Pharmacy), untouched for 30 s,
   * is synced. Sync clears the mark, so the branch's candidates shrink as it repairs. Revision 0 (saved before
   * Pharmacy existed) is never marked.
   */
  private syncPrescriptions(): Promise<number> {
    return this.scan<PrescriptionDocument & Row>(
      'prescriptions',
      this.rxs,
      { pharmacyPending: true, updatedAt: { $lt: new Date(Date.now() - GRACE_MS) } },
      (r) => `syncing prescription ${String(r._id)}`,
      async (r) => {
        return (await this.prescriptions.sync(String(r._id))) === 'synced';
      },
    );
  }
}
