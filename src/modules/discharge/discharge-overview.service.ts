import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { escapeRegex } from '../../common/utils/escape-regex';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import type { StatCardData } from '../beds/bed-overview';
import { CasesService } from '../coordinator/cases.service';
import { LabLine, LabLineDocument, LabLineStatus } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from '../lab/schemas/lab-request.schema';
import { DischargeAiService, DischargeDayCounts, DischargeTextResult } from './discharge-ai';
import {
  CompletionKind,
  DischargeConfig,
  DischargeKind,
  KIND_LABEL,
  LINE_KEYS,
  LINE_LABEL,
  LINE_OWNER,
  LINE_RULE,
  LineKey,
  LineOwner,
  LineRule,
  SUMMARY_SECTIONS,
  SUMMARY_TITLE,
} from './discharge-catalogue';
import { missing } from './discharge-lines.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { NOTE_SECTION, SUMMARY_SECTION_LABEL } from './discharge-summary.service';
import { dayStatus, toRealTime } from './discharge-time';
import {
  DischargeOrder,
  DischargeOrderDocument,
  LIVE_ORDER_STATES,
  LineState,
  OPEN_ORDER_STATES,
  OrderState,
  takeHomeOrderIds,
} from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument, PlanState } from './schemas/discharge-plan.schema';
import { DischargeCounts, DischargeSnapshot, DischargeSnapshotDocument } from './schemas/discharge-snapshot.schema';
import { CourseSource, DischargeSummary, DischargeSummaryDocument } from './schemas/discharge-summary.schema';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const DUPLICATE_KEY = 11000;
/** The longest search text the Queue tab takes. */
const SEARCH_MAX = 100;
/** A Lab test with nothing more to come. */
const LAB_ENDED: readonly LabLineStatus[] = ['released', 'cancelled'];

// ---------- the shown status ----------

/**
 * The plan status the page shows (global constraints, "States"). With no order it is the target day against today:
 * Planned (after tomorrow), Due tomorrow, Due today or Overdue (before today). With an order in progress it is Ordered
 * or Ready to leave, and Left once the stay has ended.
 */
export const SHOWN_STATUSES = ['planned', 'due-tomorrow', 'due-today', 'overdue', 'ordered', 'ready', 'left'] as const;
export type ShownStatus = (typeof SHOWN_STATUSES)[number];

export const SHOWN_STATUS_LABEL: Record<ShownStatus, string> = {
  planned: 'Planned',
  'due-tomorrow': 'Due tomorrow',
  'due-today': 'Due today',
  overdue: 'Overdue',
  ordered: 'Ordered',
  ready: 'Ready to leave',
  left: 'Left',
};

/** The Queue tab's status filter: one shown status, or `due` for Due today, Due tomorrow and Overdue together. */
export type QueueStatusFilter = ShownStatus | 'due';
const DUE: readonly ShownStatus[] = ['due-today', 'due-tomorrow', 'overdue'];
/** The queue's order for plans with no order, after the orders (open windows 0, not yet open 1). */
const NO_ORDER_RANK: Partial<Record<ShownStatus, number>> = { 'due-today': 2, overdue: 3, 'due-tomorrow': 4, planned: 5 };

/** A plan's shown status, from the plan, its order in progress (if any) and the clinic clock. */
export function shownStatus(plan: Pick<DischargePlan, 'state' | 'targetDay'>, order: Pick<DischargeOrder, 'state'> | null, now: Date): ShownStatus {
  if (plan.state === 'completed' || order?.state === 'left') return 'left';
  if (order?.state === 'ready') return 'ready';
  if (order?.state === 'ordered') return 'ordered';
  return dayStatus(plan.targetDay, now);
}

// ---------- the views (the web's types match these; keep the names stable) ----------

/** A card of the Overview: the web's StatCardData, except that Order to leaving's value is null while nobody has left today. */
export type DischargeCard = Omit<StatCardData, 'value'> & { value: number | null };
export type DischargeCardKey = 'dueToday' | 'clearing' | 'ready' | 'orderToLeaving' | 'bedsFreeingToday';

export interface PatientRef {
  id: string;
  name: string;
  uhid: string;
}

/**
 * One row of "Today and tomorrow" and of the Queue tab. Staff screens may show the name. Times are ISO strings:
 * `windowAt` and `plannedLeaveAt` on the clinic clock; `leaveDueAt` real time (for the web's `timeLeft`).
 */
export interface QueueRow {
  planId: string;
  /** The order in progress; absent while there is none. */
  orderId?: string;
  patient: PatientRef;
  /** The admission's doctor, as its text. */
  doctor: string;
  bedLabel: string;
  wardName: string;
  /** The order's kind; absent with no order. */
  kind?: DischargeKind;
  status: ShownStatus;
  /** Required lines done (or not needed), and how many are required: 0 and 0 with no order. */
  done: number;
  required: number;
  /** The label of the first required line not done yet ("Discharge order" with no order); null when Ready. */
  waitingOn: string | null;
  waitingKey: LineKey | null;
  /** That line's short text for the panel, such as "₹2,340 due"; null when it has none. */
  waitingDetail: string | null;
  /** Clinic clock. */
  windowAt?: string;
  /** The window has opened (windowAt is now or earlier): the order-to-leaving clock runs. */
  windowOpen?: boolean;
  /** Clinic clock. */
  plannedLeaveAt?: string;
  /** Real time: the window plus the order-to-leaving target. */
  leaveDueAt?: string;
  /** The target day, YYYY-MM-DD. */
  targetDay: string;
}

export interface DischargeOverview {
  cards: Record<DischargeCardKey, DischargeCard>;
  /** Today and tomorrow, longest waiting first. */
  queue: QueueRow[];
  /** Clinic clock. */
  generatedAt: string;
  /** The order-to-leaving target, in minutes (Settings → Discharge). */
  targetMinutes: number;
}

export interface QueueFilter {
  /** The ward's name, exactly as the rows show it. */
  ward?: string;
  /** The admission's doctor text, exactly as the rows show it. */
  doctor?: string;
  status?: QueueStatusFilter;
  /** Part of the patient's name or UHID, or of the bed label; any letter case. */
  q?: string;
}

/** A checklist line as the panel shows it. Required (R) and shown (S) lines always; an optional (O) one once filled. */
export interface LineView {
  key: LineKey;
  /** For the order's kind: "Documents handed over" for a transfer or against advice. */
  label: string;
  owner: LineOwner;
  rule: Exclude<LineRule, '-'>;
  /** A required line not on the record yet shows as waiting. */
  state: LineState;
  by?: { id: string; name: string };
  /** Clinic clock. */
  at?: string;
  note?: string;
  detail?: string;
}

/** The order for the checklist panel. Times are ISO: clinic clock unless marked real. */
export interface OrderView {
  id: string;
  planId: string;
  kind: DischargeKind;
  state: OrderState;
  /** How the stay ended (R21): the kind, or left-without-discharge. Only an order ended as its own kind is timed. */
  endedAs?: CompletionKind;
  orderedBy: { id: string; name: string };
  orderedAt: string;
  plannedLeaveAt: string;
  windowAt: string;
  windowOpen: boolean;
  /** Real time `discharge.window-opened` went. */
  windowOpenedAt?: string;
  /** Real time: the window plus the order-to-leaving target. */
  leaveDueAt: string;
  /** Real time: the window plus the summary target. */
  summaryDueAt: string;
  startedNow?: { by: { id: string; name: string }; at: string };
  diagnosis: string;
  condition?: string;
  timeOfDeath?: string;
  causeOfDeath?: string;
  receivingHospital?: string;
  transferReason?: string;
  note: string;
  lines: LineView[];
  done: number;
  required: number;
  waitingOn: string | null;
  waitingKey: LineKey | null;
  /** Every Pharmacy take-home order, the first one first. */
  takeHomeOrderIds: string[];
  noTakeHome: boolean;
  followUp?: { followUpId: string; status: 'booked' | 'waitlisted'; appointmentId?: string; date?: string; time?: string };
  noFollowUp: boolean;
  /** The Lab request ids put off as "follow up later". */
  followUpLater: string[];
  gatePass?: { number: string; printedAt: string[]; by: { id: string; name: string } };
  leftAt?: string;
  leftBy?: { id: string; name: string };
  bodyReceiver?: { name: string; relationship: string };
}

/** A section of the summary editor, in print order: the doctor's note comes right after the course paragraph (R39). */
export interface SummaryLayoutItem {
  key: string;
  label: string;
}

/** The summary for the editor and the panel. Times are ISO on the clinic clock, except `updatedAt` (the record's own). */
export interface SummaryView {
  id: string;
  orderId: string;
  kind: DischargeKind;
  /** Discharge summary, transfer letter, against-advice note or death summary. */
  title: string;
  layout: SummaryLayoutItem[];
  /** Section key to text, the doctor's note under `note`. */
  sections: Record<string, string>;
  course: { text: string; source: CourseSource };
  /** The course paragraph is the AI's canned sample: show SAMPLE. */
  sample: boolean;
  /** The sections staff changed by hand. */
  edited: string[];
  draftedAt: string;
  signedBy?: { id: string; name: string };
  signedAt?: string;
  /** Signed before and unlocked for Edit and re-sign. */
  reopened: boolean;
  /** How many signed versions were kept by Edit and re-sign. */
  versionCount: number;
  documentId?: string;
  /** The order was cancelled after signing: kept for history only. */
  archivedAt?: string;
  /** R38: the editor sends this back as `seen` with a save or a sign. */
  updatedAt: string;
}

/** A Lab request on the stay's case, for the Lab line's "Follow up later" choice. */
export interface LabRequestRow {
  id: string;
  /** LR-0001. */
  number: string;
  /** Tests not released or cancelled yet. */
  waiting: number;
  /** A critical result not acknowledged yet: it can never be put off. */
  critical: boolean;
  followUpLater: boolean;
}

export interface PlanView {
  id: string;
  admissionId: string;
  /** The plan's own case, if it has one (the Lab requests fall back to the patient's case, R24). */
  caseId: string | null;
  patient: PatientRef;
  bedLabel: string;
  wardName: string;
  doctor: string;
  targetDay: string;
  /** Clinic clock. */
  targetAt: string;
  targetLog: { from: string; to: string; by: { id: string; name: string }; at: string; note?: string }[];
  state: PlanState;
  status: ShownStatus;
  completedAt?: string;
  completedKind?: CompletionKind;
  leftWithoutDischarge?: { reason: string; lastSeenAt: string; by: { id: string; name: string }; at: string };
}

/** The checklist panel's data: the plan, its order (in progress, or the one the patient left on), the summary and the stay's Lab requests. */
export interface DischargeDetail {
  plan: PlanView;
  order?: OrderView;
  summary?: SummaryView;
  labRequests: LabRequestRow[];
}

/** The patient's one-line discharge status (Patients screen): null with no plan in progress. */
export interface PatientDischargeLine {
  planId: string;
  orderId?: string;
  status: ShownStatus;
  done: number;
  required: number;
  kind?: DischargeKind;
  /** Clinic clock. */
  plannedLeaveAt?: string;
}

/** One row of "Left today". */
export interface LeftRow {
  planId: string;
  /** null for a Left without discharge with no order. */
  orderId: string | null;
  patient: PatientRef;
  bedLabel: string;
  wardName: string;
  doctor: string;
  /** How the stay ended. */
  kind: CompletionKind;
  /** "Home", "Transfer", "Against advice", "Died (Body released)" or "Left without discharge". */
  label: string;
  /** Clinic clock: when the patient left (or was last seen, for a Left without discharge). */
  leftAt: string;
  /** Clinic clock; null with no order. */
  windowAt: string | null;
  /** Order to leaving (windowAt to leftAt), in whole minutes; null when not timed (R21: a Left without discharge). */
  minutes: number | null;
  overTarget: boolean;
  gatePass?: { number: string; printedAt: string[] };
  /** The order's signed summary, for a reprint. */
  summaryId?: string;
}

// ---------- helpers ----------

type Id = Types.ObjectId;
type LeanPlan = DischargePlan & { _id: Id; createdAt?: Date; updatedAt?: Date };
type LeanOrder = DischargeOrder & { _id: Id };
/** A summary record, lean or hydrated. */
type LeanSummary = DischargeSummary & { _id: unknown; createdAt?: Date; updatedAt?: Date };
type LeanSnapshot = { at: Date; counts?: Partial<DischargeCounts> };
type Counts = DischargeCounts;
/** A stay: the plan and its order in progress (or, for one that ended, the order it ended on). */
interface Stay {
  plan: LeanPlan;
  order: LeanOrder | null;
}

const iso = (d: Date | string | number): string => new Date(d).toISOString();
const actor = (a?: { id?: string; name?: string } | null) => ({ id: a?.id ?? '', name: a?.name ?? '' });
const patientOf = (p: LeanPlan): PatientRef => ({ id: String(p.patient), name: p.patientName, uhid: p.patientUhid });

/** "2h", "1h 30m", "45m". */
function hoursAndMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

/** The clinic day of `now`: [from, to). */
function dayOf(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()), to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}

/** Required lines done or not needed, of how many, and the first one still holding Ready. */
function progressOf(order: Pick<DischargeOrder, 'kind' | 'lines'>): { done: number; required: number; waitingKey: LineKey | null } {
  const required = LINE_KEYS.filter((k) => LINE_RULE[order.kind][k] === 'R').length;
  const open = missing(order);
  return { done: required - open.length, required, waitingKey: open[0] ?? null };
}

/** The checklist lines in panel order: R and S lines always (a required one not stored yet as waiting), O lines once stored. */
function lineViews(order: LeanOrder): LineView[] {
  const rule = LINE_RULE[order.kind];
  const stored = new Map((order.lines ?? []).map((l) => [l.key, l]));
  return LINE_KEYS.flatMap((key): LineView[] => {
    const r = rule[key];
    const l = stored.get(key);
    if (r === '-' || (r === 'O' && !l)) return [];
    return [
      {
        key,
        label: LINE_LABEL(key, order.kind),
        owner: LINE_OWNER[key],
        rule: r,
        state: l?.state ?? 'waiting',
        ...(l?.by ? { by: actor(l.by) } : {}),
        ...(l?.at ? { at: iso(l.at) } : {}),
        ...(l?.note ? { note: l.note } : {}),
        ...(l?.detail ? { detail: l.detail } : {}),
      },
    ];
  });
}

/** The kind's sections in print order, with the doctor's note right after the course paragraph. */
function layoutOf(kind: DischargeKind): SummaryLayoutItem[] {
  return SUMMARY_SECTIONS(kind).flatMap((key) => {
    const item = { key, label: SUMMARY_SECTION_LABEL[key] };
    return key === 'course' ? [item, { key: NOTE_SECTION, label: "Doctor's note" }] : [item];
  });
}

/** The summary view (the editor, the panel, and Task 13's `GET orders/:id/summary`). */
export function summaryView(s: LeanSummary): SummaryView {
  return {
    id: String(s._id),
    orderId: String(s.order),
    kind: s.kind,
    title: SUMMARY_TITLE[s.kind],
    layout: layoutOf(s.kind),
    sections: { ...(s.sections ?? {}) },
    course: { text: s.course?.text ?? '', source: s.course?.source },
    sample: s.course?.source === 'ai-sample',
    edited: [...(s.edited ?? [])],
    draftedAt: iso(s.draftedAt ?? s.createdAt ?? 0),
    ...(s.signedBy ? { signedBy: actor(s.signedBy) } : {}),
    ...(s.signedAt ? { signedAt: iso(s.signedAt) } : {}),
    reopened: !s.signedAt && (s.versions?.length ?? 0) > 0,
    versionCount: s.versions?.length ?? 0,
    ...(s.documentId ? { documentId: s.documentId } : {}),
    ...(s.archivedAt ? { archivedAt: iso(s.archivedAt) } : {}),
    updatedAt: iso(s.updatedAt ?? s.createdAt ?? 0),
  };
}

/**
 * The Discharge page's read side (design 7): the five Overview cards with their trend sparks, "Today and tomorrow",
 * the Queue tab, the checklist panel's data, the patient's one-line status, "Left today", the hourly snapshots and the
 * day summary. It never writes another agent's records, and writes only its own snapshots. Plans, orders and "today"
 * are on the clinic clock; the snapshot hours and the sparks are real time (as Revenue's), and so are the due times
 * the clocks run on. R21: only an order that ended as its own kind is timed. The AI sees counts only.
 */
@Injectable()
export class DischargeOverviewService {
  /** The clinic clock (R7); a spec replaces it. Real time is read from it with `toRealTime`. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly settings: DischargeSettingsService,
    /** R24: the patient's case, for a plan and order with none of their own. */
    private readonly cases: CasesService,
    private readonly ai: DischargeAiService,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(DischargeSummary.name) private readonly summaries: Model<DischargeSummaryDocument>,
    @InjectModel(DischargeSnapshot.name) private readonly snapshots: Model<DischargeSnapshotDocument>,
    /** Read only: the stay's Lab requests and tests. */
    @InjectModel(LabRequest.name) private readonly labRequests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly labLines: Model<LabLineDocument>,
  ) {}

  // ---------- the Overview ----------

  /**
   * The five cards and "Today and tomorrow". Due today: plans with an order leaving today (or late), and plans with no
   * order whose target day is today or past ("N with no order yet"). Clearing and Ready: the orders in progress in each
   * state. Order to leaving: today's average from the window to leaving (R21), null while nobody has left. Beds freeing
   * today: orders in progress leaving today (or late), plus every stay that ended today. Each card's spark is the last 24
   * hourly snapshots, and its trend is against the snapshot of this hour yesterday.
   */
  async overview(): Promise<DischargeOverview> {
    const now = this.clock();
    const real = toRealTime(now);
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [{ config, active, counts }, snaps] = await Promise.all([
      this.today(now),
      this.snapshots.find({ at: { $gte: new Date(dayAgoHour) } }).lean<LeanSnapshot[]>().exec(),
    ]);
    const dayAgo = snaps.find((s) => new Date(s.at).getTime() === dayAgoHour);
    const card = (value: number | null, field: keyof Counts, note: string): DischargeCard => ({
      value,
      total: null,
      trendPct: value === null ? null : trendPct(value, dayAgo?.counts?.[field] ?? null),
      spark: hourlySeries(
        snaps.flatMap((s) => {
          const v = s.counts?.[field];
          return typeof v === 'number' ? [{ hour: new Date(s.at), value: v }] : [];
        }),
        SPARK_HOURS,
        real,
      ),
      note,
    });
    return {
      cards: {
        dueToday: card(counts.dueToday, 'dueToday', `${counts.noOrder} with no order yet`),
        clearing: card(counts.clearing, 'clearing', 'order given, lines open'),
        ready: card(counts.ready, 'ready', 'gate pass can print'),
        orderToLeaving: card(counts.avgMinutes, 'avgMinutes', `target ${hoursAndMinutes(config.leaveMinutes)}`),
        bedsFreeingToday: card(counts.bedsFreeing, 'bedsFreeing', 'leaving or left today'),
      },
      queue: this.sortRows(active, now, config).filter((r) => r.status !== 'planned'),
      generatedAt: iso(now),
      targetMinutes: config.leaveMinutes,
    };
  }

  /**
   * The Queue tab: every plan in progress, in the Overview's order with later target days last. Filters by the ward's
   * name, the doctor's text, the shown status (`due` is due today, due tomorrow and overdue) and a search on the
   * patient's name or UHID or the bed label (literal text, any case). 400 for an unknown status.
   */
  async queue(filter: QueueFilter = {}): Promise<QueueRow[]> {
    const f = filter ?? {};
    if (f.status !== undefined && f.status !== 'due' && !(SHOWN_STATUSES as readonly string[]).includes(f.status)) {
      throw new BadRequestException(`status must be one of: due, ${SHOWN_STATUSES.join(', ')}`);
    }
    const where: Record<string, unknown> = {};
    if (typeof f.ward === 'string' && f.ward.trim()) where.wardName = f.ward.trim();
    if (typeof f.doctor === 'string' && f.doctor.trim()) where.doctor = f.doctor.trim();
    const q = typeof f.q === 'string' ? f.q.trim().slice(0, SEARCH_MAX) : '';
    if (q) {
      const re = new RegExp(escapeRegex(q), 'i');
      where.$or = [{ patientName: re }, { patientUhid: re }, { bedLabel: re }];
    }
    const now = this.clock();
    const [config, stays] = await Promise.all([this.settings.get(), this.activeStays(where)]);
    const rows = this.sortRows(stays, now, config);
    if (!f.status) return rows;
    return rows.filter((r) => (f.status === 'due' ? DUE.includes(r.status) : r.status === f.status));
  }

  // ---------- the checklist panel ----------

  /** The checklist panel's data for a plan. 404 for an unknown plan. */
  async detail(planId: string): Promise<DischargeDetail> {
    const plan = isValidObjectId(planId) ? await this.plans.findById(planId).lean<LeanPlan>().exec() : null;
    if (!plan) throw new NotFoundException('Discharge plan not found');
    return this.detailOf(plan);
  }

  /** The same, found by the admission (the bed panel). 404 when the admission has no plan (a sample one, say). */
  async byAdmission(admissionId: string): Promise<DischargeDetail> {
    const plan = isValidObjectId(admissionId)
      ? await this.plans.findOne({ admission: new Types.ObjectId(String(admissionId)) }).lean<LeanPlan>().exec()
      : null;
    if (!plan) throw new NotFoundException('No discharge plan for this admission');
    return this.detailOf(plan);
  }

  /** "Discharge: 5 of 7 done" for the Patients screen. Null when the patient has no plan in progress. */
  async patientLine(patientId: string): Promise<PatientDischargeLine | null> {
    if (!isValidObjectId(patientId)) return null;
    const plan = await this.plans
      .findOne({ patient: new Types.ObjectId(String(patientId)), state: { $ne: 'completed' } })
      .sort({ createdAt: -1, _id: -1 })
      .lean<LeanPlan>()
      .exec();
    if (!plan) return null;
    const order = await this.orders.findOne({ plan: plan._id, state: { $in: OPEN_ORDER_STATES } }).lean<LeanOrder>().exec();
    const status = shownStatus(plan, order, this.clock());
    if (!order) return { planId: String(plan._id), status, done: 0, required: 0 };
    const { done, required } = progressOf(order);
    return { planId: String(plan._id), orderId: String(order._id), status, done, required, kind: order.kind, plannedLeaveAt: iso(order.plannedLeaveAt) };
  }

  // ---------- left today ----------

  /**
   * The stays that ended today (Patient left, Body released, Left without discharge), newest first, with the order to
   * leaving time and the over-target mark. R21: a Left without discharge is listed with its own kind and never timed.
   * One recorded today counts even when the patient was last seen yesterday.
   */
  async leftToday(): Promise<LeftRow[]> {
    const now = this.clock();
    const [config, ended] = await Promise.all([this.settings.get(), this.endedToday(now)]);
    const orderIds = ended.flatMap((s) => (s.order ? [s.order._id] : []));
    const signed = orderIds.length
      ? await this.summaries
          .find({ order: { $in: orderIds }, signedAt: { $ne: null }, archivedAt: null })
          .select('order')
          .lean<{ _id: Id; order: Id }[]>()
          .exec()
      : [];
    return this.leftRows(ended, config, new Map(signed.map((s) => [String(s.order), String(s._id)])));
  }

  // ---------- snapshots and the day summary ----------

  /**
   * Stores this hour's counts for the sparks: one row per real clock hour (`at` is the hour of the given real-time
   * moment, by default now). A second call in the same hour stores nothing. The counts are always now's. True when it
   * stored a row.
   */
  async snapshot(at?: Date): Promise<boolean> {
    const now = this.clock();
    const hour = hourOf(at ?? toRealTime(now));
    if (await this.snapshots.exists({ at: hour }).exec()) return false;
    const { counts } = await this.today(now);
    try {
      await this.snapshots.create({ at: hour, counts });
      return true;
    } catch (e) {
      if ((e as { code?: number })?.code === DUPLICATE_KEY) return false;
      throw e;
    }
  }

  /**
   * "Summarise today": the AI writes it from counts only (due today, with no order, clearing, ready, left today, the
   * average against the target, and the line the longest wait is on), never a name, id, bed or free text. The longest
   * wait is the open order in Ordered whose window opened first, held on its first required line not done.
   */
  async daySummary(): Promise<DischargeTextResult> {
    const now = this.clock();
    const { config, active, counts: c } = await this.today(now);
    let longestWait: DischargeDayCounts['longestWait'] = null;
    let since = Infinity;
    for (const { order } of active) {
      if (order?.state !== 'ordered') continue;
      const opened = new Date(order.windowAt).getTime();
      const line = missing(order)[0];
      if (opened > now.getTime() || !line || opened >= since) continue;
      since = opened;
      longestWait = { line, minutes: Math.max(0, Math.round((now.getTime() - opened) / MIN_MS)) };
    }
    return this.ai.daySummary({
      dueToday: c.dueToday,
      noOrder: c.noOrder,
      clearing: c.clearing,
      ready: c.ready,
      leftToday: c.leftToday,
      avgMinutes: c.avgMinutes,
      targetMinutes: config.leaveMinutes,
      longestWait,
    });
  }

  // ---------- pieces ----------

  /** Settings, the stays in progress, and the counts behind the cards (with the stays that ended today). */
  private async today(now: Date): Promise<{ config: DischargeConfig; active: Stay[]; counts: Counts }> {
    const [config, active, ended] = await Promise.all([this.settings.get(), this.activeStays(), this.endedToday(now)]);
    return { config, active, counts: this.countsOf(active, this.leftRows(ended, config, new Map()), now) };
  }

  /** Plans in progress (not completed), with their order in progress. A plan whose order has left is not in progress. */
  private async activeStays(where: Record<string, unknown> = {}): Promise<Stay[]> {
    const plans = await this.plans.find({ ...where, state: { $ne: 'completed' } }).lean<LeanPlan[]>().exec();
    if (!plans.length) return [];
    const live = await this.orders
      .find({ plan: { $in: plans.map((p) => p._id) }, state: { $in: LIVE_ORDER_STATES } })
      .lean<LeanOrder[]>()
      .exec();
    const byPlan = new Map(live.map((o) => [String(o.plan), o]));
    return plans.flatMap((plan): Stay[] => {
      const order = byPlan.get(String(plan._id)) ?? null;
      // The patient has left and only the plan's own step is behind (the one-minute pass finishes it).
      if (order?.state === 'left') return [];
      return [{ plan, order }];
    });
  }

  /**
   * The stays that ended today: plans completed today, or a Left without discharge recorded today, and any order that
   * left today (should its plan's own step be behind). Each with the order it ended on, if any.
   */
  private async endedToday(now: Date): Promise<Stay[]> {
    const { from, to } = dayOf(now);
    const today = { $gte: from, $lt: to };
    const [completed, leftOrders] = await Promise.all([
      this.plans
        .find({ state: 'completed', $or: [{ completedAt: today }, { 'leftWithoutDischarge.at': today }] })
        .select('_id')
        .lean<{ _id: Id }[]>()
        .exec(),
      this.orders.find({ state: 'left', leftAt: today }).select('plan').lean<{ plan: Id }[]>().exec(),
    ]);
    const ids = [...new Set([...completed.map((p) => String(p._id)), ...leftOrders.map((o) => String(o.plan))])].map((i) => new Types.ObjectId(i));
    if (!ids.length) return [];
    const [plans, orders] = await Promise.all([
      this.plans.find({ _id: { $in: ids } }).lean<LeanPlan[]>().exec(),
      this.orders.find({ plan: { $in: ids }, state: 'left' }).lean<LeanOrder[]>().exec(),
    ]);
    const byPlan = new Map(orders.map((o) => [String(o.plan), o]));
    return plans.map((plan) => ({ plan, order: byPlan.get(String(plan._id)) ?? null }));
  }

  /** The Left today rows, newest first. `summaries` maps an order id to its signed summary's id. */
  private leftRows(ended: Stay[], config: DischargeConfig, summaries: Map<string, string>): LeftRow[] {
    const rows = ended.map(({ plan, order }): LeftRow => {
      const kind: CompletionKind = plan.completedKind ?? order?.endedAs ?? order?.kind ?? 'left-without-discharge';
      const leftAt = order?.leftAt ?? plan.completedAt ?? plan.leftWithoutDischarge?.lastSeenAt ?? plan.updatedAt;
      // R21: only an order that ended as its own kind is a discharge to time.
      const timed = !!order && !!order.leftAt && order.endedAs === order.kind;
      const minutes = timed ? Math.max(0, Math.round((new Date(order.leftAt!).getTime() - new Date(order.windowAt).getTime()) / MIN_MS)) : null;
      const summaryId = order ? summaries.get(String(order._id)) : undefined;
      return {
        planId: String(plan._id),
        orderId: order ? String(order._id) : null,
        patient: patientOf(plan),
        bedLabel: plan.bedLabel,
        wardName: plan.wardName,
        doctor: plan.doctor ?? '',
        kind,
        label: kind === 'died' ? `${KIND_LABEL.died} (Body released)` : KIND_LABEL[kind],
        leftAt: iso(leftAt ?? 0),
        windowAt: order ? iso(order.windowAt) : null,
        minutes,
        overTarget: minutes !== null && minutes > config.leaveMinutes,
        ...(order?.gatePass?.number ? { gatePass: { number: order.gatePass.number, printedAt: (order.gatePass.printedAt ?? []).map(iso) } } : {}),
        ...(summaryId ? { summaryId } : {}),
      };
    });
    return rows.sort((a, b) => b.leftAt.localeCompare(a.leftAt) || a.planId.localeCompare(b.planId));
  }

  /** The counts behind the cards, the snapshots and the day summary. */
  private countsOf(active: Stay[], left: LeftRow[], now: Date): Counts {
    const today = isoDate(now);
    const { to } = dayOf(now);
    const leavingToday = (o: LeanOrder) => new Date(o.plannedLeaveAt).getTime() < to.getTime();
    let dueToday = 0;
    let noOrder = 0;
    let clearing = 0;
    let ready = 0;
    let leaving = 0;
    for (const { plan, order } of active) {
      if (order) {
        if (order.state === 'ordered') clearing += 1;
        if (order.state === 'ready') ready += 1;
        if (leavingToday(order)) {
          dueToday += 1;
          leaving += 1;
        }
      } else if (plan.targetDay <= today) {
        dueToday += 1;
        noOrder += 1;
      }
    }
    const timed = left.flatMap((r) => (r.minutes === null ? [] : [r.minutes]));
    return {
      dueToday,
      noOrder,
      clearing,
      ready,
      leftToday: left.length,
      avgMinutes: timed.length ? Math.round(timed.reduce((t, m) => t + m, 0) / timed.length) : null,
      bedsFreeing: leaving + left.length,
    };
  }

  /**
   * Rows longest waiting first: open windows by when they opened, then orders whose window has not opened (by when it
   * will), then due today with no order, then overdue, then due tomorrow, then later target days (each by target time).
   */
  private sortRows(stays: Stay[], now: Date, config: DischargeConfig): QueueRow[] {
    const keyed = stays.map((s) => {
      const row = this.row(s, now, config);
      if (s.order) {
        const windowMs = new Date(s.order.windowAt).getTime();
        return { row, rank: windowMs <= now.getTime() ? 0 : 1, time: windowMs };
      }
      return { row, rank: NO_ORDER_RANK[row.status] ?? NO_ORDER_RANK.planned, time: new Date(s.plan.targetAt).getTime() };
    });
    keyed.sort((a, b) => a.rank - b.rank || a.time - b.time || a.row.planId.localeCompare(b.row.planId));
    return keyed.map((k) => k.row);
  }

  private row({ plan, order }: Stay, now: Date, config: DischargeConfig): QueueRow {
    const base = {
      planId: String(plan._id),
      patient: patientOf(plan),
      doctor: plan.doctor ?? '',
      bedLabel: plan.bedLabel,
      wardName: plan.wardName,
      status: shownStatus(plan, order, now),
      targetDay: plan.targetDay,
    };
    if (!order) {
      return { ...base, done: 0, required: 0, waitingOn: LINE_LABEL('order', 'home'), waitingKey: 'order', waitingDetail: null };
    }
    const { done, required, waitingKey } = progressOf(order);
    const windowAt = new Date(order.windowAt);
    return {
      ...base,
      orderId: String(order._id),
      kind: order.kind,
      done,
      required,
      waitingOn: waitingKey ? LINE_LABEL(waitingKey, order.kind) : null,
      waitingKey,
      waitingDetail: (waitingKey && order.lines.find((l) => l.key === waitingKey)?.detail) || null,
      windowAt: iso(windowAt),
      windowOpen: windowAt.getTime() <= now.getTime(),
      plannedLeaveAt: iso(order.plannedLeaveAt),
      leaveDueAt: iso(new Date(toRealTime(windowAt).getTime() + config.leaveMinutes * MIN_MS)),
    };
  }

  private async detailOf(plan: LeanPlan): Promise<DischargeDetail> {
    const now = this.clock();
    const [config, order] = await Promise.all([
      this.settings.get(),
      // At most one live order per plan (the unique index): in progress, or the one the patient left on.
      this.orders.findOne({ plan: plan._id, state: { $in: LIVE_ORDER_STATES } }).lean<LeanOrder>().exec(),
    ]);
    const [summary, labRequests] = await Promise.all([
      order ? this.summaries.findOne({ order: order._id }).lean<LeanSummary>().exec() : Promise.resolve(null),
      this.labRequestsOf(plan, order),
    ]);
    return {
      plan: this.planView(plan, order, now),
      ...(order ? { order: this.orderView(order, now, config) } : {}),
      ...(summary ? { summary: summaryView(summary) } : {}),
      labRequests,
    };
  }

  private planView(p: LeanPlan, order: LeanOrder | null, now: Date): PlanView {
    const lwd = p.leftWithoutDischarge;
    return {
      id: String(p._id),
      admissionId: String(p.admission),
      caseId: p.case ? String(p.case) : null,
      patient: patientOf(p),
      bedLabel: p.bedLabel,
      wardName: p.wardName,
      doctor: p.doctor ?? '',
      targetDay: p.targetDay,
      targetAt: iso(p.targetAt),
      targetLog: (p.targetLog ?? []).map((t) => ({ from: t.from, to: t.to, by: actor(t.by), at: iso(t.at), ...(t.note ? { note: t.note } : {}) })),
      state: p.state,
      status: shownStatus(p, order, now),
      ...(p.completedAt ? { completedAt: iso(p.completedAt) } : {}),
      ...(p.completedKind ? { completedKind: p.completedKind } : {}),
      ...(lwd ? { leftWithoutDischarge: { reason: lwd.reason, lastSeenAt: iso(lwd.lastSeenAt), by: actor(lwd.by), at: iso(lwd.at) } } : {}),
    };
  }

  private orderView(o: LeanOrder, now: Date, config: DischargeConfig): OrderView {
    const windowAt = new Date(o.windowAt);
    const realWindow = toRealTime(windowAt).getTime();
    const { done, required, waitingKey } = progressOf(o);
    const f = o.followUp;
    return {
      id: String(o._id),
      planId: String(o.plan),
      kind: o.kind,
      state: o.state,
      ...(o.endedAs ? { endedAs: o.endedAs } : {}),
      orderedBy: actor(o.orderedBy),
      orderedAt: iso(o.orderedAt),
      plannedLeaveAt: iso(o.plannedLeaveAt),
      windowAt: iso(windowAt),
      windowOpen: windowAt.getTime() <= now.getTime(),
      ...(o.windowOpenedAt ? { windowOpenedAt: iso(o.windowOpenedAt) } : {}),
      leaveDueAt: iso(new Date(realWindow + config.leaveMinutes * MIN_MS)),
      summaryDueAt: iso(new Date(realWindow + config.summaryMinutes * MIN_MS)),
      ...(o.startedNow ? { startedNow: { by: actor(o.startedNow.by), at: iso(o.startedNow.at) } } : {}),
      diagnosis: o.diagnosis,
      ...(o.condition ? { condition: o.condition } : {}),
      ...(o.timeOfDeath ? { timeOfDeath: iso(o.timeOfDeath) } : {}),
      ...(o.causeOfDeath ? { causeOfDeath: o.causeOfDeath } : {}),
      ...(o.receivingHospital ? { receivingHospital: o.receivingHospital } : {}),
      ...(o.transferReason ? { transferReason: o.transferReason } : {}),
      note: o.note ?? '',
      lines: lineViews(o),
      done,
      required,
      waitingOn: waitingKey ? LINE_LABEL(waitingKey, o.kind) : null,
      waitingKey,
      takeHomeOrderIds: takeHomeOrderIds(o),
      noTakeHome: !!o.noTakeHome,
      ...(f
        ? {
            followUp: {
              followUpId: f.followUpId,
              status: f.status,
              ...(f.appointmentId ? { appointmentId: f.appointmentId } : {}),
              ...(f.date ? { date: f.date } : {}),
              ...(f.time ? { time: f.time } : {}),
            },
          }
        : {}),
      noFollowUp: !!o.noFollowUp,
      followUpLater: (o.followUpLater ?? []).map(String),
      ...(o.gatePass?.number ? { gatePass: { number: o.gatePass.number, printedAt: (o.gatePass.printedAt ?? []).map(iso), by: actor(o.gatePass.by) } } : {}),
      ...(o.leftAt ? { leftAt: iso(o.leftAt) } : {}),
      ...(o.leftBy ? { leftBy: actor(o.leftBy) } : {}),
      ...(o.bodyReceiver ? { bodyReceiver: { name: o.bodyReceiver.name, relationship: o.bodyReceiver.relationship } } : {}),
    };
  }

  /**
   * The Lab requests of the stay's case (R24: the order's case, else the plan's, else the patient's open or newest
   * case: the same case the Lab line reads), oldest first, with how many tests still wait, whether a critical result
   * waits for its acknowledgement, and whether the doctor put the request off as "follow up later".
   */
  private async labRequestsOf(plan: LeanPlan, order: LeanOrder | null): Promise<LabRequestRow[]> {
    const own = order?.case ?? plan.case;
    const caseId = own ? String(own) : ((await this.cases.forPatient(String(plan.patient)))?._id ?? null);
    if (!caseId || !isValidObjectId(String(caseId))) return [];
    const requests = await this.labRequests
      .find({ case: new Types.ObjectId(String(caseId)) })
      .sort({ orderedAt: 1, number: 1 })
      .select('number')
      .lean<{ _id: Id; number: string }[]>()
      .exec();
    if (!requests.length) return [];
    const tests = await this.labLines
      .find({ request: { $in: requests.map((r) => r._id) } })
      .select('request status critical')
      .lean<{ request: Id; status: LabLineStatus; critical?: { active?: boolean; ackAt?: Date } }[]>()
      .exec();
    const later = new Set((order?.followUpLater ?? []).map(String));
    return requests.map((r) => {
      const mine = tests.filter((t) => String(t.request) === String(r._id));
      return {
        id: String(r._id),
        number: r.number,
        waiting: mine.filter((t) => !LAB_ENDED.includes(t.status)).length,
        critical: mine.some((t) => !!t.critical?.active && !t.critical.ackAt),
        followUpLater: later.has(String(r._id)),
      };
    });
  }
}
