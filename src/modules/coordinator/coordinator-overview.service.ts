import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import type { StatCardData } from '../beds/bed-overview';
import { AgentStatusService, AgentStatusView } from './agent-status.service';
import { ApprovalsService } from './approvals.service';
import { ClocksService } from './clocks.service';
import { MessagesService } from './messages.service';
import { Case, CaseDocument } from './schemas/case.schema';
import { CoordinatorSnapshot, CoordinatorSnapshotDocument } from './schemas/coordinator-snapshot.schema';
import { Escalation, EscalationDocument } from './schemas/escalation.schema';

export type { StatCardData } from '../beds/bed-overview';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const AGENT_COUNT = 9;

export type CoordinatorCardKey = 'activeWorkflows' | 'agentsCoordinated' | 'tasksRouted' | 'escalations';
export type SnapshotField = 'activeWorkflows' | 'agentsOnline' | 'tasksToday' | 'escalations';
export type SeriesRange = '24h' | '7d';

export interface CoordinatorOverview {
  at: string;
  cards: Record<CoordinatorCardKey, StatCardData>;
  agents: AgentStatusView[];
  openApprovals: number;
  runningClocks: number;
}

export interface CoordinatorSeriesPoint {
  at: string;
  activeWorkflows: number | null;
  agentsOnline: number | null;
  tasksToday: number | null;
  escalations: number | null;
}

type Counts = Record<SnapshotField, number>;

@Injectable()
export class CoordinatorOverviewService {
  constructor(
    @InjectModel(CoordinatorSnapshot.name) private readonly snapshots: Model<CoordinatorSnapshotDocument>,
    @InjectModel(Case.name) private readonly cases: Model<CaseDocument>,
    @InjectModel(Escalation.name) private readonly escalationModel: Model<EscalationDocument>,
    private readonly statuses: AgentStatusService,
    private readonly messages: MessagesService,
    private readonly approvals: ApprovalsService,
    private readonly clocks: ClocksService,
  ) {}

  /** Stores this hour's counts (real clock), replacing any earlier snapshot of the same hour. */
  async snapshot(): Promise<void> {
    const at = new Date();
    const { counts } = await this.current();
    await this.snapshots.updateOne({ hour: hourOf(at) }, { $set: { at, ...counts } }, { upsert: true }).exec();
  }

  async overview(): Promise<CoordinatorOverview> {
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [{ counts, openApprovals }, runningClocks, snaps] = await Promise.all([
      this.current(),
      this.clocks.countRunning(),
      this.snapshots.find({ hour: { $gte: new Date(dayAgoHour) } }).lean().exec(),
    ]);
    const dayAgo = snaps.find((s) => s.hour.getTime() === dayAgoHour);
    const card = (field: SnapshotField, total: number | null, note: string): StatCardData => {
      const value = counts[field];
      return {
        value,
        total,
        trendPct: trendPct(value, dayAgo?.[field] ?? null),
        spark: hourlySeries(snaps.map((s) => ({ hour: s.hour, value: s[field] })), SPARK_HOURS, real),
        note,
      };
    };
    return {
      at: clinicNow().toISOString(),
      cards: {
        activeWorkflows: card('activeWorkflows', null, 'open cases'),
        agentsCoordinated: card('agentsOnline', AGENT_COUNT, 'online'),
        tasksRouted: card('tasksToday', null, 'messages today'),
        escalations: card('escalations', null, 'approvals and escalations open'),
      },
      agents: this.statuses.list(real),
      openApprovals,
      runningClocks,
    };
  }

  async series(range: SeriesRange): Promise<{ range: SeriesRange; points: CoordinatorSeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const last = hourOf(new Date()).getTime();
    const snaps = await this.snapshots.find({ hour: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): CoordinatorSeriesPoint => {
      const hour = last - (hours - 1 - i) * HOUR_MS;
      const s = byHour.get(hour);
      return {
        at: new Date(hour).toISOString(),
        activeWorkflows: s?.activeWorkflows ?? null,
        agentsOnline: s?.agentsOnline ?? null,
        tasksToday: s?.tasksToday ?? null,
        escalations: s?.escalations ?? null,
      };
    });
    return { range, points };
  }

  /** The four live counts the cards and the snapshot share. */
  private async current(): Promise<{ counts: Counts; openApprovals: number }> {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const [activeWorkflows, tasksToday, openApprovals, openEscalations] = await Promise.all([
      this.cases.countDocuments({ state: 'open' }).exec(),
      this.messages.countSince(midnight),
      this.approvals.countOpen(),
      this.escalationModel.countDocuments({ state: 'open' }).exec(),
    ]);
    const agentsOnline = this.statuses.list().filter((a) => a.built && a.online).length;
    return { counts: { activeWorkflows, agentsOnline, tasksToday, escalations: openApprovals + openEscalations }, openApprovals };
  }
}
