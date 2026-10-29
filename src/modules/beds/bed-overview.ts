import type { BedBoard } from './beds.service';
import { WardType } from './bed-types';
import { hourlySeries, hourOf, trendPct } from '../../common/utils/series';

export { hourlySeries, hourOf, trendPct };

export type BoardTotals = BedBoard['totals'];

// Pure maths for the Bed Agent overview. No database, no clock of its own: the callers
// pass `now`. Snapshot hours are the real clock; admission times are the clinic clock.

/** A unit is "full" at this share of its beds. */
export const UNIT_FULL_PCT = 85;
/** A bed is "late" being cleaned after this many minutes. */
export const CLEANING_LATE_MIN = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const AVG_DAYS = 7;

export type CardKey =
  | 'total'
  | 'occupied'
  | 'available'
  | 'cleaning'
  | 'blocked'
  | 'cleaningBlocked'
  | 'expectedDischarges'
  | 'expectedAdmissions';

export interface StatCardData {
  value: number;
  /** The bed total, for "x of y"; null for cards that are not a share of the beds. */
  total: number | null;
  /** Change against 24 hours ago, in percent; null without a snapshot from then. */
  trendPct: number | null;
  /** The last 24 hourly points, oldest first; null where there is no snapshot. */
  spark: (number | null)[];
  note: string;
}

export interface TypeRow {
  type: WardType;
  label: string;
  total: number;
  occupied: number;
  free: number;
  cleaning: number;
  blocked: number;
  percentFull: number;
}

export interface DischargeItem {
  admissionId: string;
  patientName: string;
  wardName: string;
  bedLabel: string;
  /** ISO, clinic clock. */
  dueAt: string;
  overdue: boolean;
  sample: boolean;
}

export interface Movement {
  id: string;
  kind: 'admission' | 'transfer' | 'discharge';
  /** ISO, clinic clock. */
  at: string;
  patientName: string;
  from: string;
  to: string;
  sample: boolean;
}

export interface AgentSuggestion {
  id: string;
  tone: 'warn' | 'info' | 'ok';
  title: string;
  detail: string;
  action: { label: string; target: 'requests' | 'discharge' | 'cleaning' | 'utilization' | 'bed-map' };
}

export interface BedOverview {
  /** ISO, clinic clock. */
  at: string;
  totals: BoardTotals;
  cards: Record<CardKey, StatCardData>;
  byType: TypeRow[];
  dischargePlan: DischargeItem[];
  movements: Movement[];
  suggestions: AgentSuggestion[];
  openRequests: number;
  avgAdmissionsPerDay: number;
}

/** An admission with its bed names already looked up. */
export interface OverviewAdmission {
  id: string;
  patientName: string;
  sample: boolean;
  department: string;
  /** The ward of the bed the patient is in (or left from, once discharged). */
  wardName: string;
  bedLabel: string;
  expectedStayDays: number;
  status: 'active' | 'discharged';
  admittedAt: Date;
  dischargedAt?: Date;
  transfers: { fromLabel: string; toLabel: string; at: Date }[];
}

export interface SuggestionInput {
  byType: TypeRow[];
  /** Beds due to free up today, overdue ones included. */
  dischargesToday: number;
  /** Beds in cleaning for more than CLEANING_LATE_MIN. */
  lateCleaning: number;
  /** Requests that are waiting for a bed or need staff. */
  requestsNeedingAttention: number;
  freeVentilatorBeds: number;
}

export const dueAt = (admittedAt: Date, expectedStayDays: number): Date =>
  new Date(admittedAt.getTime() + expectedStayDays * DAY_MS);

/** Active stays due before `now` + 24 hours, overdue ones included, soonest first. */
export function dischargePlan(admissions: OverviewAdmission[], now: Date): DischargeItem[] {
  const horizon = now.getTime() + DAY_MS;
  return admissions
    .filter((a) => a.status === 'active')
    .map((a) => ({ a, due: dueAt(a.admittedAt, a.expectedStayDays) }))
    .filter(({ due }) => due.getTime() < horizon)
    .sort((x, y) => x.due.getTime() - y.due.getTime())
    .map(({ a, due }) => ({
      admissionId: a.id,
      patientName: a.patientName,
      wardName: a.wardName,
      bedLabel: a.bedLabel,
      dueAt: due.toISOString(),
      overdue: due.getTime() < now.getTime(),
      sample: a.sample,
    }));
}

/** Plan items due before the end of `now`'s day (overdue included). */
export function dischargesToday(plan: DischargeItem[], now: Date): number {
  const endOfDay = new Date(now);
  endOfDay.setHours(24, 0, 0, 0);
  return plan.filter((p) => new Date(p.dueAt).getTime() < endOfDay.getTime()).length;
}

/** Open requests plus the average admissions per day over the 7 days before `now`, rounded up. */
export function expectedAdmissions(openRequests: number, admittedAts: Date[], now: Date): { value: number; avgPerDay: number } {
  const from = now.getTime() - AVG_DAYS * DAY_MS;
  const recent = admittedAts.filter((d) => d.getTime() >= from && d.getTime() <= now.getTime()).length;
  const avgPerDay = Math.ceil(recent / AVG_DAYS);
  return { value: openRequests + avgPerDay, avgPerDay };
}

/** Admissions, transfers and discharges, newest first. */
export function movements(admissions: OverviewAdmission[], limit = 10): Movement[] {
  const out: Movement[] = [];
  for (const a of admissions) {
    const base = { patientName: a.patientName, sample: a.sample };
    // The bed the stay started in: the first transfer's origin, else the current bed.
    out.push({ ...base, id: `${a.id}:admit`, kind: 'admission', at: a.admittedAt.toISOString(), from: a.department, to: a.transfers[0]?.fromLabel ?? a.bedLabel });
    a.transfers.forEach((t, i) =>
      out.push({ ...base, id: `${a.id}:transfer:${i}`, kind: 'transfer', at: t.at.toISOString(), from: t.fromLabel, to: t.toLabel }),
    );
    if (a.dischargedAt) out.push({ ...base, id: `${a.id}:discharge`, kind: 'discharge', at: a.dischargedAt.toISOString(), from: a.bedLabel, to: '—' });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const LAST_FREE: { type: WardType; name: string }[] = [
  { type: 'icu', name: 'ICU' },
  { type: 'hdu', name: 'HDU' },
  { type: 'isolation', name: 'isolation' },
];

export function agentSuggestions(input: SuggestionInput): AgentSuggestion[] {
  const out: AgentSuggestion[] = [];
  for (const r of input.byType) {
    if (r.total > 0 && r.percentFull >= UNIT_FULL_PCT) {
      out.push({
        id: `full-${r.type}`,
        tone: 'warn',
        title: `${r.label} is ${r.percentFull}% full`,
        detail: `${r.free} of ${r.total} ${r.label} beds are free.`,
        action: { label: 'See utilization', target: 'utilization' },
      });
    }
  }
  if (input.dischargesToday > 0) {
    const n = input.dischargesToday;
    out.push({
      id: 'discharges-today',
      tone: 'info',
      title: `Prepare ${n} ${plural(n, 'bed', 'beds')} for today's discharges`,
      detail: 'These stays reach their expected end today.',
      action: { label: 'Open discharge plan', target: 'discharge' },
    });
  }
  if (input.lateCleaning > 0) {
    const n = input.lateCleaning;
    out.push({
      id: 'cleaning-late',
      tone: 'warn',
      title: `${n} ${plural(n, 'bed', 'beds')} waiting over ${CLEANING_LATE_MIN} min for cleaning`,
      detail: 'Cleaned beds can be given to waiting patients.',
      action: { label: 'See cleaning', target: 'cleaning' },
    });
  }
  if (input.requestsNeedingAttention > 0) {
    const n = input.requestsNeedingAttention;
    out.push({
      id: 'requests-attention',
      tone: 'warn',
      title: `${n} bed ${plural(n, 'request is waiting or needs', 'requests are waiting or need')} attention`,
      detail: 'No bed could be found by the Bed Agent, or staff must decide.',
      action: { label: 'Open requests', target: 'requests' },
    });
  }
  for (const { type, name } of LAST_FREE) {
    if (input.byType.find((r) => r.type === type)?.free === 1) {
      out.push({
        id: `last-${type}`,
        tone: 'warn',
        title: `Last free ${name} bed`,
        detail: `Only one ${name} bed is left.`,
        action: { label: 'Open bed map', target: 'bed-map' },
      });
    }
  }
  if (input.freeVentilatorBeds === 1) {
    out.push({
      id: 'last-ventilator',
      tone: 'warn',
      title: 'Last free ventilator bed',
      detail: 'Only one bed with a ventilator is left.',
      action: { label: 'Open bed map', target: 'bed-map' },
    });
  }
  if (!out.length) {
    out.push({
      id: 'all-normal',
      tone: 'ok',
      title: 'All units are within normal levels',
      detail: 'No unit is near full and nothing is waiting.',
      action: { label: 'Open bed map', target: 'bed-map' },
    });
  }
  return out;
}
