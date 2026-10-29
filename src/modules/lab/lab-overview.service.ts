import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import type { StatCardData } from '../beds/bed-overview';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { LAB_TESTS, targetMinutes, testByKey } from './lab-catalogue';
import { labOnTimePct } from './lab-coordinator.registration';
import { LabSettingsService } from './lab-settings.service';
import { LabLine, LabLineDocument } from './schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';
import { LabSample, LabSampleDocument } from './schemas/lab-sample.schema';
import { LabSnapshot, LabSnapshotDocument } from './schemas/lab-snapshot.schema';

export type { StatCardData } from '../beds/bed-overview';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;

export type LabCardKey = 'ordersToday' | 'samplesCollected' | 'inProcessing' | 'resultsCompleted' | 'criticalResults';
export type LabSeriesRange = '24h' | '7d';
const CARD_KEYS: LabCardKey[] = ['ordersToday', 'samplesCollected', 'inProcessing', 'resultsCompleted', 'criticalResults'];

export interface LabTatRow {
  test: string;
  label: string;
  count: number;
  avgMin: number | null;
  targetMin: number;
  onTime: boolean | null;
}

export interface LabCriticalRow {
  lineId: string;
  requestNumber: string;
  test: string;
  label: string;
  parameter: string;
  value: string;
  unit: string;
  orderedBy: string;
  releasedAt: string | null;
  ackBy: string | null;
  ackAt: string | null;
  /** True when the line has been amended (version above 1). */
  amended: boolean;
  /** From the running critical clock; null once acknowledged. */
  dueAt: string | null;
}

export interface LabOverview {
  at: string;
  cards: Record<LabCardKey, StatCardData>;
  tatByTest: LabTatRow[];
  performance: {
    avgTatMin: number | null;
    onTimePct: number | null;
    collectionOnTimePct: number | null;
    rejectionRate: number | null;
    ordersByHour: number[];
  };
  critical: LabCriticalRow[];
}

export type LabSeriesPoint = { at: string } & Record<LabCardKey, number | null>;

type Counts = Record<LabCardKey, number>;

const mean = (values: number[]): number | null => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
const pct = (part: number, whole: number): number | null => (whole ? Math.round((part / whole) * 100) : null);
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

/** The Lab page's cards, tables and charts. Today means since real local midnight; every on-time figure compares real times. */
@Injectable()
export class LabOverviewService {
  constructor(
    @InjectModel(LabSnapshot.name) private readonly snapshots: Model<LabSnapshotDocument>,
    @InjectModel(LabRequest.name) private readonly requests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly lines: Model<LabLineDocument>,
    @InjectModel(LabSample.name) private readonly samples: Model<LabSampleDocument>,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
    private readonly labSettings: LabSettingsService,
  ) {}

  /** Stores this hour's numbers (real clock), replacing any earlier snapshot of the same hour. */
  async snapshot(): Promise<void> {
    const at = new Date();
    const { counts } = await this.current();
    await this.snapshots.updateOne({ hour: hourOf(at) }, { $set: { at, ...counts } }, { upsert: true }).exec();
  }

  async overview(): Promise<LabOverview> {
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [{ counts, tatByTest, performance, critical }, snaps] = await Promise.all([
      this.current(),
      this.snapshots.find({ hour: { $gte: new Date(dayAgoHour) } }).lean().exec(),
    ]);
    const dayAgo = snaps.find((s) => s.hour.getTime() === dayAgoHour);
    const card = (field: LabCardKey, note: string): StatCardData => ({
      value: counts[field],
      total: null,
      trendPct: trendPct(counts[field], dayAgo?.[field] ?? null),
      spark: hourlySeries(snaps.map((s) => ({ hour: s.hour, value: s[field] })), SPARK_HOURS, real),
      note,
    });
    return {
      at: clinicNow().toISOString(),
      cards: {
        ordersToday: card('ordersToday', 'requests ordered today'),
        samplesCollected: card('samplesCollected', 'samples collected today'),
        inProcessing: card('inProcessing', 'received or awaiting validation'),
        resultsCompleted: card('resultsCompleted', 'results released today'),
        criticalResults: card('criticalResults', 'critical results released today'),
      },
      tatByTest,
      performance,
      critical,
    };
  }

  /**
   * Criticals that need attention: every released critical nobody has acknowledged (from any day, its
   * clock may still be escalating), then those acknowledged today. Unacknowledged first, oldest first;
   * then acknowledged, newest first. The ack time is on the clinic clock, so "today" is clinic midnight
   * (the same as real midnight in production).
   */
  async criticalList(): Promise<LabCriticalRow[]> {
    const midnight = clinicNow();
    midnight.setHours(0, 0, 0, 0);
    const lines = await this.lines
      .find({
        status: 'released',
        'critical.active': true,
        $or: [{ 'critical.ackAt': { $exists: false } }, { 'critical.ackAt': { $gte: midnight } }],
      })
      .select('request test releasedAt releasedRealAt lastReleasedRealAt results history critical version')
      .lean<any[]>()
      .exec();
    if (!lines.length) return [];
    const [parents, running] = await Promise.all([
      this.requests.find({ _id: { $in: [...new Set(lines.map((l) => String(l.request)))] } }).select('number orderedBy').lean<any[]>().exec(),
      this.clocks
        .find({ def: 'lab-critical', state: 'running', ref: { $in: lines.map((l) => String(l._id)) } })
        .select('ref dueAt')
        .lean<{ ref: string; dueAt: Date }[]>()
        .exec(),
    ]);
    const parent = new Map(parents.map((r) => [String(r._id), r]));
    const dueOf = new Map(running.map((c) => [c.ref, c.dueAt]));
    const at = (l: any) => new Date(l.lastReleasedRealAt ?? l.releasedRealAt ?? 0).getTime();
    const ackAt = (l: any) => new Date(l.critical?.ackAt ?? 0).getTime();
    lines.sort((a, b) => {
      const ua = !a.critical?.ackAt;
      const ub = !b.critical?.ackAt;
      if (ua !== ub) return ua ? -1 : 1;
      return ua ? at(a) - at(b) : ackAt(b) - ackAt(a);
    });
    return lines.map((l) => {
      // An amendment to normal keeps the earlier critical open: show the value that was critical.
      const c =
        (l.results ?? []).find((r: any) => r.critical) ??
        [...(l.history ?? [])].reverse().flatMap((h: any) => h.results ?? []).find((r: any) => r.critical);
      return {
        lineId: String(l._id),
        requestNumber: parent.get(String(l.request))?.number ?? '',
        test: l.test,
        label: testByKey(l.test)?.label ?? l.test,
        parameter: c?.param ?? '',
        value: c ? String(c.value) : '',
        unit: c?.unit ?? '',
        orderedBy: parent.get(String(l.request))?.orderedBy?.name ?? '',
        releasedAt: iso(l.releasedAt),
        ackBy: l.critical?.ackBy ?? null,
        ackAt: iso(l.critical?.ackAt),
        amended: (l.version ?? 0) > 1,
        dueAt: iso(dueOf.get(String(l._id))),
      };
    });
  }

  async series(range: LabSeriesRange): Promise<{ range: LabSeriesRange; points: LabSeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const last = hourOf(new Date()).getTime();
    const snaps = await this.snapshots.find({ hour: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): LabSeriesPoint => {
      const hour = last - (hours - 1 - i) * HOUR_MS;
      const s = byHour.get(hour);
      const point = { at: new Date(hour).toISOString() } as LabSeriesPoint;
      for (const k of CARD_KEYS) point[k] = s?.[k] ?? null;
      return point;
    });
    return { range, points };
  }

  /** Everything the cards, tables and the snapshot share. */
  private async current(): Promise<{ counts: Counts; tatByTest: LabTatRow[]; performance: LabOverview['performance']; critical: LabCriticalRow[] }> {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const { targets } = await this.labSettings.overrides();
    const [requestsToday, collectedToday, inProcessing, releasedToday] = await Promise.all([
      this.requests.find({ createdAt: { $gte: midnight } }).select('createdAt').lean<{ createdAt: Date }[]>().exec(),
      this.samples.find({ collectedRealAt: { $gte: midnight } }).select('collectBy collectedRealAt status').lean<{ collectBy: Date; collectedRealAt: Date; status: string }[]>().exec(),
      this.lines.countDocuments({ status: { $in: ['received', 'awaiting-validation'] } }).exec(),
      this.lines
        .find({ releasedRealAt: { $gte: midnight } })
        .select('request test tatDueAt releasedAt releasedRealAt results critical')
        .lean<any[]>()
        .exec(),
    ]);
    const parents = await this.requests
      .find({ _id: { $in: [...new Set(releasedToday.map((l) => String(l.request)))] } })
      .select('number orderedBy scheduledFor createdAt')
      .lean<any[]>()
      .exec();
    const parent = new Map(parents.map((r) => [String(r._id), r]));
    const turnaround = (l: any): number => {
      const r = parent.get(String(l.request));
      const start = new Date(r?.scheduledFor ?? r?.createdAt ?? l.releasedRealAt).getTime();
      return (new Date(l.releasedRealAt).getTime() - start) / MIN_MS;
    };
    const onTime = (l: any) => new Date(l.releasedRealAt).getTime() <= new Date(l.tatDueAt).getTime();

    const tatByTest: LabTatRow[] = LAB_TESTS.map((t) => {
      const mine = releasedToday.filter((l) => l.test === t.key);
      return {
        test: t.key,
        label: t.label,
        count: mine.length,
        avgMin: mean(mine.map(turnaround)),
        targetMin: targetMinutes(t.key, 'routine', targets),
        onTime: mine.length ? mine.every(onTime) : null,
      };
    }).filter((r) => r.count > 0);

    const criticalLines = releasedToday.filter((l) => (l.results ?? []).some((r: any) => r.critical));
    const critical = await this.criticalList();

    const ordersByHour = Array.from({ length: 24 }, () => 0);
    for (const r of requestsToday) ordersByHour[new Date(r.createdAt).getHours()]++;
    const rejected = collectedToday.filter((s) => s.status === 'rejected').length;

    return {
      counts: {
        ordersToday: requestsToday.length,
        samplesCollected: collectedToday.length,
        inProcessing,
        resultsCompleted: releasedToday.length,
        criticalResults: criticalLines.length,
      },
      tatByTest,
      performance: {
        avgTatMin: mean(releasedToday.map(turnaround)),
        onTimePct: pct(releasedToday.filter(onTime).length, releasedToday.length),
        collectionOnTimePct: pct(collectedToday.filter((s) => new Date(s.collectedRealAt).getTime() <= new Date(s.collectBy).getTime()).length, collectedToday.length),
        rejectionRate: pct(rejected, collectedToday.length),
        ordersByHour,
      },
      critical,
    };
  }
}
