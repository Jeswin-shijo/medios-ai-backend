import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { DischargePlan, DischargePlanDocument } from '../discharge/schemas/discharge-plan.schema';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import {
  BedOverview,
  CLEANING_LATE_MIN,
  CardKey,
  OverviewAdmission,
  StatCardData,
  TypeRow,
  agentSuggestions,
  dischargePlan,
  dischargesToday,
  expectedAdmissions,
  hourOf,
  hourlySeries,
  movements,
  trendPct,
} from './bed-overview';
import { WardType } from './bed-types';
import { BedRequestsService } from './bed-requests.service';
import { BedBoard, BedsService } from './beds.service';
import { CLASS_LABEL } from './rules';
import { Admission, AdmissionDocument } from './schemas/admission.schema';
import { BedSnapshot, BedSnapshotDocument, SnapshotExpected, SnapshotTypeCounts } from './schemas/bed-snapshot.schema';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const MOVEMENT_LIMIT = 10;
/** Snapshots are the agent's own: it acts as no signed-in user. */
const SYSTEM_ACTOR: Actor = { id: 'bed-agent', name: 'Bed Agent', role: UserRole.ADMIN };

export type SeriesRange = '24h' | '7d';
export interface SeriesPoint {
  hour: string;
  occupied: number | null;
  free: number | null;
  cleaning: number | null;
  blocked: number | null;
}

type AdmissionRecord = Admission & { _id: any };

/** Counts per ward type, from the board. Held beds count in the total only. */
function countByType(board: BedBoard): Map<WardType, SnapshotTypeCounts> {
  const typeOfWard = new Map(board.wards.map((w) => [w.id, w.type]));
  const out = new Map<WardType, SnapshotTypeCounts>();
  for (const bed of board.beds) {
    const type = typeOfWard.get(bed.wardId);
    if (!type) continue;
    const c = out.get(type) ?? { total: 0, occupied: 0, free: 0, cleaning: 0, blocked: 0 };
    c.total++;
    if (bed.state === 'occupied' || bed.state === 'free' || bed.state === 'cleaning' || bed.state === 'blocked') c[bed.state]++;
    out.set(type, c);
  }
  return out;
}

@Injectable()
export class BedOverviewService {
  constructor(
    @InjectModel(BedSnapshot.name) private readonly snapshots: Model<BedSnapshotDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    private readonly beds: BedsService,
    private readonly requests: BedRequestsService,
    /** Read only: the Discharge Agent writes plans. */
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
  ) {}

  /** Stores this hour's counts (real clock), replacing any earlier snapshot of the same hour. */
  async snapshot(): Promise<void> {
    const at = new Date();
    const [board, outlook] = await Promise.all([this.beds.board(SYSTEM_ACTOR), this.outlook()]);
    await this.snapshots
      .updateOne(
        { hour: hourOf(at) },
        {
          $set: {
            at,
            totals: {
              total: board.totals.total,
              occupied: board.totals.occupied,
              free: board.totals.free,
              cleaning: board.totals.cleaning,
              blocked: board.totals.blocked,
              held: board.totals.held,
            },
            byType: Object.fromEntries(countByType(board)),
            expected: { discharges: outlook.plan.length, admissions: outlook.admit.value },
          },
        },
        { upsert: true },
      )
      .exec();
  }

  async overview(actor: Actor): Promise<BedOverview> {
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [board, outlook, needingAttention, snaps] = await Promise.all([
      this.beds.board(actor),
      this.outlook(),
      this.requests.countNeedingAttention(),
      this.snapshots.find({ hour: { $gte: new Date(dayAgoHour) } }).lean().exec(),
    ]);
    const { clinic, stays, plan, admit, openRequests } = outlook;

    const counts = countByType(board);
    const byType: TypeRow[] = [];
    for (const type of new Set(board.wards.map((w) => w.type))) {
      const c = counts.get(type);
      if (!c) continue;
      byType.push({ type, label: CLASS_LABEL[type], ...c, percentFull: c.total ? Math.round((c.occupied / c.total) * 100) : 0 });
    }

    const late = board.beds.filter(
      (b) => b.state === 'cleaning' && clinic.getTime() - new Date(b.since).getTime() > CLEANING_LATE_MIN * 60_000,
    ).length;
    const freeVentilatorBeds = board.beds.filter((b) => b.state === 'free' && b.features.includes('ventilator')).length;

    const t = board.totals;
    const pct = (n: number) => `${t.total ? Math.round((n / t.total) * 100) : 0}% of beds`;
    const history = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const dayAgo = history.get(dayAgoHour);
    const card = (
      value: number,
      total: number | null,
      note: string,
      pick: (s: { totals: BedSnapshotDocument['totals']; expected?: SnapshotExpected }) => number | undefined,
    ): StatCardData => {
      const before = dayAgo ? pick(dayAgo) : undefined;
      const points = snaps.flatMap((s) => {
        const value = pick(s);
        return value === undefined ? [] : [{ hour: s.hour, value }];
      });
      return { value, total, trendPct: trendPct(value, before ?? null), spark: hourlySeries(points, SPARK_HOURS, real), note };
    };
    const cards: Record<CardKey, StatCardData> = {
      total: card(t.total, null, pct(t.total), (s) => s.totals.total),
      occupied: card(t.occupied, t.total, `${t.percentFull}% occupancy`, (s) => s.totals.occupied),
      available: card(t.free, t.total, 'Ready for allocation', (s) => s.totals.free),
      cleaning: card(t.cleaning, t.total, pct(t.cleaning), (s) => s.totals.cleaning),
      blocked: card(t.blocked, t.total, pct(t.blocked), (s) => s.totals.blocked),
      cleaningBlocked: card(t.cleaning + t.blocked, t.total, 'Under cleaning or maintenance', (s) => s.totals.cleaning + s.totals.blocked),
      expectedDischarges: card(plan.length, null, 'Next 24 hours', (s) => s.expected?.discharges),
      expectedAdmissions: card(admit.value, null, `${openRequests} open + ${admit.avgPerDay}/day average`, (s) => s.expected?.admissions),
    };

    return {
      at: clinic.toISOString(),
      totals: t,
      cards,
      byType,
      dischargePlan: plan,
      movements: movements(stays, MOVEMENT_LIMIT),
      suggestions: agentSuggestions({
        byType,
        dischargesToday: dischargesToday(plan, clinic),
        lateCleaning: late,
        requestsNeedingAttention: needingAttention,
        freeVentilatorBeds,
      }),
      openRequests,
      avgAdmissionsPerDay: admit.avgPerDay,
    };
  }

  async series(range: SeriesRange): Promise<{ range: SeriesRange; points: SeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const now = new Date();
    const last = hourOf(now).getTime();
    const snaps = await this.snapshots.find({ hour: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): SeriesPoint => {
      const hour = last - (hours - 1 - i) * HOUR_MS;
      const t = byHour.get(hour)?.totals;
      return {
        hour: new Date(hour).toISOString(),
        occupied: t?.occupied ?? null,
        free: t?.free ?? null,
        cleaning: t?.cleaning ?? null,
        blocked: t?.blocked ?? null,
      };
    });
    return { range, points };
  }

  /** The target (clinic clock) of every discharge plan still open, by admission id. */
  private async targets(): Promise<Map<string, Date>> {
    const plans = await this.plans
      .find({ state: { $ne: 'completed' } })
      .select('admission targetAt')
      .lean<Array<{ admission: unknown; targetAt: Date }>>()
      .exec();
    return new Map(plans.map((p) => [String(p.admission), p.targetAt]));
  }

  /** Active stays, and any stay admitted, moved or discharged in the last 7 days (clinic clock). */
  private stays(): Promise<AdmissionRecord[]> {
    const since = new Date(clinicNow().getTime() - 7 * DAY_MS);
    return this.admissions
      .find({ $or: [{ status: 'active' }, { admittedAt: { $gte: since } }, { dischargedAt: { $gte: since } }, { 'transfers.at': { $gte: since } }] })
      .lean<AdmissionRecord[]>()
      .exec();
  }

  /**
   * What the overview and the snapshot both need: recent stays with their bed names, the
   * discharge plan and the expected admissions. One place, so the two always agree.
   */
  private async outlook() {
    const [records, openRequests, inventory, targets, orders] = await Promise.all([
      this.stays(),
      this.requests.countOpen(),
      this.beds.inventory(),
      this.targets(),
      this.beds.openDischargeOrders(),
    ]);
    const clinic = clinicNow();
    const labels = new Map(inventory.beds.map((b) => [b.id, b.label]));
    const wardNames = new Map(inventory.wards.map((w) => [w.id, w.name]));
    const wardOfBed = new Map(inventory.beds.map((b) => [b.id, wardNames.get(b.wardId) ?? '']));
    const stays = records.map((a): OverviewAdmission => {
      // A real stay is due when its open order plans the leaving, else at its plan's target. Samples keep admission + stay.
      const id = String(a._id);
      const order = a.sample ? undefined : orders.get(id);
      const due = a.sample ? undefined : (order?.plannedLeaveAt ?? targets.get(id));
      return {
        id,
        patientName: a.patientName,
        sample: !!a.sample,
        department: a.department,
        wardName: wardOfBed.get(String(a.bed)) ?? '',
        bedLabel: labels.get(String(a.bed)) ?? '—',
        expectedStayDays: a.expectedStayDays,
        status: a.status,
        admittedAt: a.admittedAt,
        dischargedAt: a.dischargedAt,
        transfers: a.transfers.map((t) => ({
          fromLabel: labels.get(String(t.fromBed)) ?? '—',
          toLabel: labels.get(String(t.toBed)) ?? '—',
          at: t.at,
        })),
        ...(due ? { dischargeDue: due } : {}),
        ordered: !!order,
      };
    });
    return {
      clinic,
      stays,
      openRequests,
      plan: dischargePlan(stays, clinic),
      admit: expectedAdmissions(openRequests, stays.map((a) => a.admittedAt), clinic),
    };
  }
}
