import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import type { StatCardData } from '../beds/bed-overview';
import { procedureByKey } from '../scheduling/scheduling-catalogue';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { BillExplainInput, RevenueAiService, RevenueSummaryInput, RevenueTextResult } from './revenue-ai';
import { ACTIVE_BILL_STATES, Bill, BillDocument } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument } from './schemas/charge-line.schema';
import { Payment, PaymentDocument, PAYMENT_MODES, PaymentMode } from './schemas/payment.schema';
import { Refund, RefundDocument } from './schemas/refund.schema';
import { RevenueSnapshot, RevenueSnapshotDocument } from './schemas/revenue-snapshot.schema';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RECENT = 20;
const NEEDS_ACTION_MAX = 100;
const BILL_TASK = /^revenue-bill:([a-f\d]{24}):(deposit|topup|final)$/;
const REFUND_TASK = /^revenue-refund:([a-f\d]{24})$/;
const TASK_LINKS = '^revenue-(bill:[a-f0-9]{24}:(deposit|topup|final)|refund:[a-f0-9]{24})$';

export type RevenueCardKey = 'collectedToday' | 'openBills' | 'depositsDue' | 'finalWaiting' | 'refundsDue';
export type RevenueSeriesRange = '24h' | '7d';
/** The cards of the Overview. Money cards carry `display`, the amount as ₹ with Indian grouping. */
export type RevenueCard = StatCardData & { display?: string };
export type RevenueNeed = 'deposit' | 'topup' | 'final' | 'refund';
export type RevenueSeriesPoint = { at: string } & Record<RevenueCardKey, number | null>;
type Counts = Record<RevenueCardKey, number>;
const CARD_KEYS: RevenueCardKey[] = ['collectedToday', 'openBills', 'depositsDue', 'finalWaiting', 'refundsDue'];
/** The snapshot field behind each card. */
const FIELD: Record<RevenueCardKey, 'collected' | 'openBills' | 'depositsDue' | 'finalWaiting' | 'refundsDue'> = {
  collectedToday: 'collected',
  openBills: 'openBills',
  depositsDue: 'depositsDue',
  finalWaiting: 'finalWaiting',
  refundsDue: 'refundsDue',
};

export interface NeedsActionRow {
  billId: string;
  number: string;
  patientName: string;
  patientUhid: string;
  kind: string;
  need: RevenueNeed;
  title: string;
  /** ISO time the task was raised. */
  since: string;
  balance: number;
  /** The refund's amount; null for the other tasks. */
  amount: number | null;
}

export interface NeedsPriceRow {
  billId: string;
  billNumber: string;
  lineId: string;
  code: string;
  name: string;
  qty: number;
  chargedAt: string;
}

export interface RecentPaymentRow {
  receiptNumber: string;
  billId: string;
  billNumber: string;
  patientName: string;
  patientUhid: string;
  amount: number;
  mode: string;
  kind: string;
  at: string;
  cancelled: boolean;
}

export interface RevenueOverview {
  at: string;
  day: string;
  cards: Record<RevenueCardKey, RevenueCard>;
  needsAction: NeedsActionRow[];
  /** `kiosk`: taken at the reception kiosk (the real method is in each payment's reference). */
  byMode: { cash: number; upi: number; card: number; kiosk: number };
  needsPrice: NeedsPriceRow[];
  recent: RecentPaymentRow[];
}

/** The clinic day's [from, to) window: the one boundary the overview, the payments list and the Dashboard share (R34, R35). */
export function clinicDayWindow(date: string): { from: Date; to: Date } {
  const from = parseIsoDay(date);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

const OPEN_BILL = { $or: [{ state: 'open' }, { state: 'final', 'totals.balance': { $ne: 0 } }] };
const bump = (o: Record<string, number>, key: string, by = 1) => {
  o[key] = (o[key] ?? 0) + by;
};

/** The Revenue page's cards, needs-action list, collections by mode and recent payments. "Today" is the clinic day (R34). */
@Injectable()
export class RevenueOverviewService {
  constructor(
    @InjectModel(RevenueSnapshot.name) private readonly snapshots: Model<RevenueSnapshotDocument>,
    @InjectModel(Bill.name) private readonly bills: Model<BillDocument>,
    @InjectModel(ChargeLine.name) private readonly lines: Model<ChargeLineDocument>,
    @InjectModel(Payment.name) private readonly payments: Model<PaymentDocument>,
    @InjectModel(Refund.name) private readonly refunds: Model<RefundDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly ai: RevenueAiService,
  ) {}

  /** Stores this hour's numbers (real clock), replacing any earlier snapshot of the same hour. Task 13 runs it hourly. */
  async snapshot(): Promise<void> {
    const at = hourOf(new Date());
    const c = await this.counts(isoDate(clinicNow()));
    await this.snapshots
      .updateOne({ at }, { $set: { collected: c.collectedToday, openBills: c.openBills, depositsDue: c.depositsDue, finalWaiting: c.finalWaiting, refundsDue: c.refundsDue } }, { upsert: true })
      .exec();
  }

  async overview(day?: string): Promise<RevenueOverview> {
    const date = this.dayOf(day);
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [counts, byMode, snaps, needsAction, needsPrice, recent] = await Promise.all([
      this.counts(date),
      this.modeTotals(date),
      this.snapshots.find({ at: { $gte: new Date(dayAgoHour) } }).lean().exec(),
      this.needsAction(),
      this.needsPriceLines(),
      this.recentPayments(),
    ]);
    const dayAgo = snaps.find((s) => s.at.getTime() === dayAgoHour);
    const card = (key: RevenueCardKey, note: string, money = false): RevenueCard => {
      const field = FIELD[key];
      return {
        value: counts[key],
        total: null,
        trendPct: trendPct(counts[key], dayAgo?.[field] ?? null),
        spark: hourlySeries(snaps.map((s) => ({ hour: s.at, value: s[field] })), SPARK_HOURS, real),
        note,
        ...(money ? { display: formatRupees(counts[key]) } : {}),
      };
    };
    return {
      at: clinicNow().toISOString(),
      day: date,
      cards: {
        collectedToday: card('collectedToday', 'collected today, all payment modes', true),
        openBills: card('openBills', 'bills open or with money still due'),
        depositsDue: card('depositsDue', 'advance deposits to collect'),
        finalWaiting: card('finalWaiting', 'final bills to prepare'),
        refundsDue: card('refundsDue', 'approved refunds to pay'),
      },
      needsAction,
      byMode,
      needsPrice,
      recent,
    };
  }

  async series(range: RevenueSeriesRange): Promise<{ range: RevenueSeriesRange; points: RevenueSeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const last = hourOf(new Date()).getTime();
    const snaps = await this.snapshots.find({ at: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.at.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): RevenueSeriesPoint => {
      const t = last - (hours - 1 - i) * HOUR_MS;
      const s = byHour.get(t);
      const point = { at: new Date(t).toISOString() } as RevenueSeriesPoint;
      for (const k of CARD_KEYS) point[k] = s ? s[FIELD[k]] : null;
      return point;
    });
    return { range, points };
  }

  /** "Explain this bill": the AI sees category totals, counts, procedure labels and amounts only (see BillExplainInput). */
  async explain(billId: string): Promise<RevenueTextResult> {
    return this.ai.explain(await this.explainInput(billId));
  }

  /** "Summarise today": the AI sees totals and counts only (see RevenueSummaryInput). */
  async summarise(): Promise<RevenueTextResult> {
    return this.ai.summarise(await this.summaryInput(isoDate(clinicNow())));
  }

  // ---------- pieces ----------

  private dayOf(day?: string): string {
    if (day === undefined) return isoDate(clinicNow());
    if (!ISO_DAY.test(day) || isoDate(parseIsoDay(day)) !== day) throw new BadRequestException('day must be a date as YYYY-MM-DD');
    return day;
  }

  private window(date: string): { from: Date; to: Date } {
    return clinicDayWindow(date);
  }

  /** Payments stamped on the clinic day that were not cancelled. Refunds paid are not subtracted (R34). */
  private dayPayments(date: string) {
    const { from, to } = this.window(date);
    return this.payments.find({ at: { $gte: from, $lt: to }, cancelled: { $exists: false } }).select('amount mode').lean<{ amount: number; mode: string }[]>().exec();
  }

  private async modeTotals(date: string): Promise<RevenueOverview['byMode']> {
    const out = { cash: 0, upi: 0, card: 0, kiosk: 0 };
    for (const p of await this.dayPayments(date)) if ((PAYMENT_MODES as readonly string[]).includes(p.mode)) out[p.mode as PaymentMode] += p.amount;
    return out;
  }

  private openTasks(suffix: 'deposit' | 'final') {
    return this.alerts.countDocuments({ link: { $regex: `^revenue-bill:[a-f0-9]{24}:${suffix}$` }, status: { $ne: 'Completed' } }).exec();
  }

  private async counts(date: string): Promise<Counts> {
    const [payments, openBills, depositsDue, finalWaiting, refundsDue] = await Promise.all([
      this.dayPayments(date),
      this.bills.countDocuments({ ...OPEN_BILL }).exec(),
      this.openTasks('deposit'),
      this.openTasks('final'),
      this.refunds.countDocuments({ state: 'approved' }).exec(),
    ]);
    return { collectedToday: payments.reduce((t, p) => t + p.amount, 0), openBills, depositsDue, finalWaiting, refundsDue };
  }

  /** Bills with a deposit, top-up, final or refund task still open, oldest task first. */
  private async needsAction(): Promise<NeedsActionRow[]> {
    const tasks = await this.alerts
      .find({ link: { $regex: TASK_LINKS }, status: { $ne: 'Completed' } })
      .sort({ createdAt: 1 })
      .limit(NEEDS_ACTION_MAX)
      .lean<{ link: string; title: string; createdAt?: Date }[]>()
      .exec();
    const refundIds: string[] = [];
    for (const t of tasks) {
      const r = REFUND_TASK.exec(t.link);
      if (r) refundIds.push(r[1]);
    }
    const refunds = refundIds.length ? await this.refunds.find({ _id: { $in: refundIds } }).select('bill amount').lean<{ _id: unknown; bill: unknown; amount: number }[]>().exec() : [];
    const refundById = new Map(refunds.map((r) => [String(r._id), r]));
    const refs = tasks.map((t) => {
      const b = BILL_TASK.exec(t.link);
      if (b) return { task: t, billId: b[1], need: b[2] as RevenueNeed, amount: null as number | null };
      const r = refundById.get(REFUND_TASK.exec(t.link)?.[1] ?? '');
      return r ? { task: t, billId: String(r.bill), need: 'refund' as RevenueNeed, amount: r.amount } : null;
    });
    const billIds = [...new Set(refs.flatMap((r) => (r ? [r.billId] : [])))];
    const bills = billIds.length ? await this.bills.find({ _id: { $in: billIds } }).lean().exec() : [];
    const billById = new Map(bills.map((b) => [String(b._id), b]));
    return refs.flatMap((r): NeedsActionRow[] => {
      const b = r && billById.get(r.billId);
      if (!r || !b) return [];
      return [{ billId: String(b._id), number: b.number, patientName: b.patientName, patientUhid: b.patientUhid, kind: b.kind, need: r.need, title: r.task.title, since: new Date(r.task.createdAt ?? Date.now()).toISOString(), balance: b.totals?.balance ?? 0, amount: r.amount }];
    });
  }

  /** Lines saved without a price, on bills that can still change. */
  private async needsPriceLines(): Promise<NeedsPriceRow[]> {
    const lines = await this.lines.find({ needsPrice: true, reversed: { $ne: true } }).sort({ chargedAt: 1 }).lean().exec();
    if (!lines.length) return [];
    const bills = await this.bills.find({ _id: { $in: [...new Set(lines.map((l) => String(l.bill)))] }, state: { $in: ACTIVE_BILL_STATES } }).select('number').lean<{ _id: unknown; number: string }[]>().exec();
    const number = new Map(bills.map((b) => [String(b._id), b.number]));
    return lines.flatMap((l): NeedsPriceRow[] => {
      const billNumber = number.get(String(l.bill));
      return billNumber ? [{ billId: String(l.bill), billNumber, lineId: String(l._id), code: l.code, name: l.name, qty: l.qty, chargedAt: new Date(l.chargedAt).toISOString() }] : [];
    });
  }

  private async recentPayments(): Promise<RecentPaymentRow[]> {
    const rows = await this.payments.find({}).sort({ at: -1 }).limit(RECENT).lean().exec();
    const bills = rows.length ? await this.bills.find({ _id: { $in: [...new Set(rows.map((p) => String(p.bill)))] } }).select('number patientName patientUhid').lean<{ _id: unknown; number: string; patientName: string; patientUhid: string }[]>().exec() : [];
    const byId = new Map(bills.map((b) => [String(b._id), b]));
    return rows.map((p) => {
      const b = byId.get(String(p.bill));
      return { receiptNumber: p.receiptNumber, billId: String(p.bill), billNumber: b?.number ?? '', patientName: b?.patientName ?? '', patientUhid: b?.patientUhid ?? '', amount: p.amount, mode: p.mode, kind: p.kind, at: new Date(p.at).toISOString(), cancelled: !!p.cancelled };
    });
  }

  /** Category totals, counts, catalogue procedure labels and amounts. Never a number, name or typed text. */
  private async explainInput(billId: string): Promise<BillExplainInput> {
    const bill = isValidObjectId(billId) ? await this.bills.findById(billId).lean().exec() : null;
    if (!bill) throw new NotFoundException('Bill not found');
    const [lines, payments] = await Promise.all([this.lines.find({ bill: bill._id }).lean().exec(), this.payments.find({ bill: bill._id, cancelled: { $exists: false } }).lean().exec()]);
    const categoryTotals: Record<string, number> = {};
    const lineCountsByCategory: Record<string, number> = {};
    const procedures = new Map<string, number>();
    let needsPriceLines = 0;
    for (const l of lines) {
      bump(categoryTotals, l.category, l.amount);
      if (l.amount > 0 && !l.reversed) bump(lineCountsByCategory, l.category);
      if (l.needsPrice && !l.reversed) needsPriceLines++;
      const label = l.code.startsWith('proc:') ? procedureByKey(l.code.slice(5))?.name : undefined;
      if (label && !l.reversed) procedures.set(label, (procedures.get(label) ?? 0) + l.amount);
    }
    const paymentsByMode: Record<string, number> = {};
    for (const p of payments) bump(paymentsByMode, p.mode, p.amount);
    const t = bill.totals;
    return {
      categoryTotals,
      lineCountsByCategory,
      procedures: [...procedures].map(([label, amount]) => ({ label, amount })),
      totals: { charges: t?.charges ?? 0, discounts: t?.discounts ?? 0, payments: t?.payments ?? 0, refunds: t?.refunds ?? 0, balance: t?.balance ?? 0 },
      paymentsByMode,
      billState: bill.state,
      billKind: bill.kind,
      needsPriceLines,
    };
  }

  private async summaryInput(date: string): Promise<RevenueSummaryInput> {
    const [counts, byMode, open, needsPriceLines] = await Promise.all([
      this.counts(date),
      this.modeTotals(date),
      this.bills.find({ ...OPEN_BILL }).select('kind totals.balance').lean<{ kind: string; totals?: { balance?: number } }[]>().exec(),
      this.needsPriceLines(),
    ]);
    const openBillsByKind: Record<string, number> = {};
    let outstandingBalance = 0;
    for (const b of open) {
      bump(openBillsByKind, b.kind);
      outstandingBalance += Math.max(0, b.totals?.balance ?? 0);
    }
    return { ...counts, byMode, openBillsByKind, outstandingBalance, needsPriceLines: needsPriceLines.length };
  }
}
