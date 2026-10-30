import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import type { StatCardData } from '../beds/bed-overview';
import type { Priority } from './pharmacy-catalogue';
import { OPEN_QUERY_FILTER } from './pharmacy-coordinator.registration';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyStockService, StockRow } from './pharmacy-stock.service';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';
import { PharmacySnapshot, PharmacySnapshotDocument } from './schemas/pharmacy-snapshot.schema';

export type { StatCardData } from '../beds/bed-overview';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const PRIORITIES: Priority[] = ['stat', 'urgent', 'routine'];

export type PharmacyCardKey = 'ordersToday' | 'toCheck' | 'openQueries' | 'issuedToday' | 'lowStock';
export type PharmacySeriesRange = '24h' | '7d';
const CARD_KEYS: PharmacyCardKey[] = ['ordersToday', 'toCheck', 'openQueries', 'issuedToday', 'lowStock'];

export interface PharmacyCheckTimeRow {
  priority: Priority;
  count: number;
  avgMin: number | null;
  targetMin: number;
  onTimePct: number | null;
}

export interface BatchAlertRow {
  product: string;
  label: string;
  store: string;
  batchNo: string;
  expiry: string;
  quantity: number;
}

export interface PharmacyOverview {
  at: string;
  cards: Record<PharmacyCardKey, StatCardData>;
  checkTime: PharmacyCheckTimeRow[];
  stockAlerts: { low: StockRow[]; nearExpiry: BatchAlertRow[]; expired: BatchAlertRow[] };
  performance: {
    avgCheckMin: number | null;
    checkOnTimePct: number | null;
    queriesOnTimePct: number | null;
    ordersByHour: number[];
  };
}

export type PharmacySeriesPoint = { at: string } & Record<PharmacyCardKey, number | null>;
type Counts = Record<PharmacyCardKey, number>;

const mean = (values: number[]): number | null => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
const pct = (part: number, whole: number): number | null => (whole ? Math.round((part / whole) * 100) : null);

/** The Pharmacy page's cards, tables and charts. Today means since real local midnight; every figure comes from timestamps on the orders and lines. */
@Injectable()
export class PharmacyOverviewService {
  constructor(
    @InjectModel(PharmacySnapshot.name) private readonly snapshots: Model<PharmacySnapshotDocument>,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    private readonly settings: PharmacySettingsService,
    private readonly stock: PharmacyStockService,
  ) {}

  /** Stores this hour's numbers (real clock), replacing any earlier snapshot of the same hour. */
  async snapshot(): Promise<void> {
    const at = new Date();
    const { counts } = await this.current();
    await this.snapshots.updateOne({ hour: hourOf(at) }, { $set: { at, ...counts } }, { upsert: true }).exec();
  }

  async overview(): Promise<PharmacyOverview> {
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [{ counts, checkTime, stockAlerts, performance }, snaps] = await Promise.all([
      this.current(),
      this.snapshots.find({ hour: { $gte: new Date(dayAgoHour) } }).lean().exec(),
    ]);
    const dayAgo = snaps.find((s) => s.hour.getTime() === dayAgoHour);
    const card = (field: PharmacyCardKey, note: string): StatCardData => ({
      value: counts[field],
      total: null,
      trendPct: trendPct(counts[field], dayAgo?.[field] ?? null),
      spark: hourlySeries(snaps.map((s) => ({ hour: s.hour, value: s[field] })), SPARK_HOURS, real),
      note,
    });
    return {
      at: clinicNow().toISOString(),
      cards: {
        ordersToday: card('ordersToday', 'medicine orders today'),
        toCheck: card('toCheck', 'lines waiting for a pharmacist'),
        openQueries: card('openQueries', 'questions waiting for a doctor'),
        issuedToday: card('issuedToday', 'lines issued today'),
        lowStock: card('lowStock', 'products at or below reorder level'),
      },
      checkTime,
      stockAlerts,
      performance,
    };
  }

  async series(range: PharmacySeriesRange): Promise<{ range: PharmacySeriesRange; points: PharmacySeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const last = hourOf(new Date()).getTime();
    const snaps = await this.snapshots.find({ hour: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): PharmacySeriesPoint => {
      const hour = last - (hours - 1 - i) * HOUR_MS;
      const s = byHour.get(hour);
      const point = { at: new Date(hour).toISOString() } as PharmacySeriesPoint;
      for (const k of CARD_KEYS) point[k] = s?.[k] ?? null;
      return point;
    });
    return { range, points };
  }

  /** Everything the cards, tables and the snapshot share. */
  private async current(): Promise<{ counts: Counts; checkTime: PharmacyCheckTimeRow[]; stockAlerts: PharmacyOverview['stockAlerts']; performance: PharmacyOverview['performance'] }> {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const [ordersToday, toCheck, openQueries, issuedToday, checkedToday, answeredToday, rows, targets] = await Promise.all([
      this.orderDocs.find({ createdAt: { $gte: midnight } }).select('createdAt').lean<{ createdAt: Date }[]>().exec(),
      this.lines.countDocuments({ status: 'to-check' }).exec(),
      this.lines.countDocuments(OPEN_QUERY_FILTER as never).exec(),
      this.lines.countDocuments({ 'issued.realAt': { $gte: midnight } }).exec(),
      this.lines
        .find({ checkedAt: { $gte: midnight }, enteredCheckAt: { $exists: true } })
        .select('order enteredCheckAt checkedAt')
        .lean<{ order: unknown; enteredCheckAt: Date; checkedAt: Date }[]>()
        .exec(),
      this.lines.find({ 'query.answer.realAt': { $gte: midnight } }).select('query.dueAt query.answer.realAt').lean<{ query: { dueAt: Date; answer: { realAt: Date } } }[]>().exec(),
      this.stock.stock(),
      this.settings.targets(),
    ]);

    const parents = await this.orderDocs
      .find({ _id: { $in: [...new Set(checkedToday.map((l) => String(l.order)))] } })
      .select('priority')
      .lean<{ _id: unknown; priority: Priority }[]>()
      .exec();
    const priorityOf = new Map(parents.map((o) => [String(o._id), o.priority]));
    const minutes = (l: { enteredCheckAt: Date; checkedAt: Date }) => (new Date(l.checkedAt).getTime() - new Date(l.enteredCheckAt).getTime()) / MIN_MS;
    // A line sent back to To check is not a finished check until it is checked again.
    const timed = checkedToday
      .filter((l) => new Date(l.checkedAt).getTime() >= new Date(l.enteredCheckAt).getTime() && priorityOf.has(String(l.order)))
      .map((l) => ({ priority: priorityOf.get(String(l.order))!, min: minutes(l) }));

    const checkTime: PharmacyCheckTimeRow[] = PRIORITIES.map((priority) => {
      const mine = timed.filter((t) => t.priority === priority);
      const targetMin = targets.check[priority];
      return { priority, count: mine.length, avgMin: mean(mine.map((t) => t.min)), targetMin, onTimePct: pct(mine.filter((t) => t.min <= targetMin).length, mine.length) };
    });

    const low = rows.filter((r) => r.low);
    const batchRows = (pick: 'expired' | 'nearExpiry'): BatchAlertRow[] =>
      rows
        .flatMap((r) => r.batches.filter((b) => b[pick]).map((b) => ({ product: r.product, label: r.label, store: r.store, batchNo: b.batchNo, expiry: b.expiry, quantity: b.quantity })))
        .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.label.localeCompare(b.label));

    const ordersByHour = Array.from({ length: 24 }, () => 0);
    for (const o of ordersToday) ordersByHour[new Date(o.createdAt).getHours()]++;

    return {
      counts: { ordersToday: ordersToday.length, toCheck, openQueries, issuedToday, lowStock: low.length },
      checkTime,
      stockAlerts: { low, nearExpiry: batchRows('nearExpiry'), expired: batchRows('expired') },
      performance: {
        avgCheckMin: mean(timed.map((t) => t.min)),
        checkOnTimePct: pct(timed.filter((t) => t.min <= targets.check[t.priority]).length, timed.length),
        queriesOnTimePct: pct(answeredToday.filter((l) => new Date(l.query.answer.realAt).getTime() <= new Date(l.query.dueAt).getTime()).length, answeredToday.length),
        ordersByHour,
      },
    };
  }
}
