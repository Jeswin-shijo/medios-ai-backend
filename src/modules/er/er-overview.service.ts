import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import type { StatCardData } from '../beds/bed-overview';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { erOnTimePct } from './er-coordinator.registration';
import { COLOUR_RANK, DOCTOR_TARGET_MIN, TriageColour } from './er-rules';
import { ErSnapshot, ErSnapshotDocument } from './schemas/er-snapshot.schema';
import { ErVisit, ErVisitDocument } from './schemas/er-visit.schema';

export type { StatCardData } from '../beds/bed-overview';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const COLOURS = Object.keys(COLOUR_RANK) as TriageColour[];

export type ErCardKey = 'patientsInEr' | 'critical' | 'avgTriageMin' | 'onTimePct';
export type ErSeriesRange = '24h' | '7d';

export interface ErOverview {
  at: string;
  cards: Record<ErCardKey, StatCardData>;
  colours: { colour: TriageColour; count: number; targetMin: number; avgWaitMin: number | null }[];
  performance: { avgTriageMin: number | null; onTimePct: number | null; avgStayMin: number | null; arrivalsByHour: number[] };
}

export interface ErSeriesPoint {
  at: string;
  patientsInEr: number | null;
  critical: number | null;
  avgTriageMin: number | null;
  onTimePct: number | null;
}

type Counts = Record<ErCardKey, number | null>;

const mean = (values: number[]): number | null => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
const minutesBetween = (from: Date, to: Date): number => (new Date(to).getTime() - new Date(from).getTime()) / MIN_MS;

/** The ER page's cards, colour table and charts. Today means since real local midnight. */
@Injectable()
export class ErOverviewService {
  constructor(
    @InjectModel(ErSnapshot.name) private readonly snapshots: Model<ErSnapshotDocument>,
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
  ) {}

  /** Stores this hour's numbers (real clock), replacing any earlier snapshot of the same hour. */
  async snapshot(): Promise<void> {
    const at = new Date();
    const { counts } = await this.current();
    await this.snapshots.updateOne({ hour: hourOf(at) }, { $set: { at, ...counts } }, { upsert: true }).exec();
  }

  async overview(): Promise<ErOverview> {
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [{ counts, colours, performance }, snaps] = await Promise.all([
      this.current(),
      this.snapshots.find({ hour: { $gte: new Date(dayAgoHour) } }).lean().exec(),
    ]);
    const dayAgo = snaps.find((s) => s.hour.getTime() === dayAgoHour);
    // A card with no data yet shows 0 and says so in its note.
    const card = (field: ErCardKey, note: string): StatCardData => {
      const value = counts[field];
      return {
        value: value ?? 0,
        total: null,
        trendPct: value === null ? null : trendPct(value, dayAgo?.[field] ?? null),
        spark: hourlySeries(snaps.filter((s) => s[field] !== null && s[field] !== undefined).map((s) => ({ hour: s.hour, value: s[field] as number })), SPARK_HOURS, real),
        note: value === null ? `${note}: none yet today` : note,
      };
    };
    return {
      at: clinicNow().toISOString(),
      cards: {
        patientsInEr: card('patientsInEr', 'in the ER now'),
        critical: card('critical', 'red, in the ER now'),
        avgTriageMin: card('avgTriageMin', 'minutes, arrival to triage'),
        onTimePct: card('onTimePct', 'doctor reviews on time today'),
      },
      colours,
      performance,
    };
  }

  async series(range: ErSeriesRange): Promise<{ range: ErSeriesRange; points: ErSeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const last = hourOf(new Date()).getTime();
    const snaps = await this.snapshots.find({ hour: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): ErSeriesPoint => {
      const hour = last - (hours - 1 - i) * HOUR_MS;
      const s = byHour.get(hour);
      return {
        at: new Date(hour).toISOString(),
        patientsInEr: s?.patientsInEr ?? null,
        critical: s?.critical ?? null,
        avgTriageMin: s?.avgTriageMin ?? null,
        onTimePct: s?.onTimePct ?? null,
      };
    });
    return { range, points };
  }

  /** Everything the cards, the table and the snapshot share. */
  private async current(): Promise<{ counts: Counts; colours: ErOverview['colours']; performance: ErOverview['performance'] }> {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const [open, today, onTimePct] = await Promise.all([
      this.visits.find({ status: { $ne: 'left' } }).select('triage.colour').lean<{ triage?: { colour: string } }[]>().exec(),
      this.visits
        .find({ createdAt: { $gte: midnight } })
        .select('arrivedAt triage.at triage.colour doctorSeenAt leftAt status')
        .lean<any[]>()
        .exec(),
      erOnTimePct(this.clocks, midnight),
    ]);
    // `triage.at` is the first triage: a re-triage only adds to the history.
    const avgTriageMin = mean(today.filter((v) => v.triage?.at).map((v) => minutesBetween(v.arrivedAt, v.triage.at)));
    const colours = COLOURS.map((colour) => ({
      colour,
      count: open.filter((v) => v.triage?.colour === colour).length,
      targetMin: DOCTOR_TARGET_MIN[colour],
      avgWaitMin: mean(today.filter((v) => v.triage?.colour === colour && v.doctorSeenAt).map((v) => minutesBetween(v.arrivedAt, v.doctorSeenAt))),
    }));
    const arrivalsByHour = Array.from({ length: 24 }, () => 0);
    for (const v of today) arrivalsByHour[new Date(v.arrivedAt).getHours()]++;
    return {
      counts: {
        patientsInEr: open.length,
        critical: open.filter((v) => v.triage?.colour === 'red').length,
        avgTriageMin,
        onTimePct,
      },
      colours,
      performance: {
        avgTriageMin,
        onTimePct,
        avgStayMin: mean(today.filter((v) => v.status === 'left' && v.leftAt).map((v) => minutesBetween(v.arrivedAt, v.leftAt))),
        arrivalsByHour,
      },
    };
  }
}
