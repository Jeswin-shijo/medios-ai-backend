import { createHash } from 'node:crypto';
import mongoose, { Model, Schema, Types } from 'mongoose';
import { displayDate, displayDateTime, displayTime } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { DEFAULT_LADDERS, DEFAULT_TITLES } from '../modules/coordinator/escalations.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { ErVisit, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { LabTestReport, LabTestReportSchema } from '../modules/lab-reports/schemas/lab-report.schema';
import { COLLECT_MINUTES, Priority, TUBE_LABEL, TubeKey, flagValue, groupIntoTubes, targetMinutes, testByKey } from '../modules/lab/lab-catalogue';
import { LAB_CLOCKS } from '../modules/lab/lab-coordinator.registration';
import { escalateAt, orderSummary } from '../modules/lab/lab-orders.service';
import { writeLabReport } from '../modules/lab/lab-report-writer';
import { LabLine, LabLineSchema, LabResultRow } from '../modules/lab/schemas/lab-line.schema';
import { LabLocation, LabLocationSchema } from '../modules/lab/schemas/lab-location.schema';
import { LabRequest, LabRequestSchema } from '../modules/lab/schemas/lab-request.schema';
import { LabSample, LabSampleSchema } from '../modules/lab/schemas/lab-sample.schema';
import { LabSnapshot, LabSnapshotSchema } from '../modules/lab/schemas/lab-snapshot.schema';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { User, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
const HOUR = 60 * MIN;
const SUMMARY_MAX = 140;
const CLOSE_NOTE = 'Opened by the lab agent';
/** The extra demo login the Lab agent's two-person rule needs: the pathologist who validates what the lab technician enters. */
export const LAB_DEMO_ACCOUNTS = [{ email: 'pathologist@medios.ai', name: 'Dr. Meera Nair', department: 'Laboratory', role: 'lab' }];

// ---------------------------------------------------------------------------------------------
// The demo lab day. Times are minutes after the order (`t` is how long ago it was ordered). A stage
// says how far a test has got; its numbers (collect, receive, enter, release) are minutes after the
// order. Requests sit on the cases the ER, Bed and Coordinator seeds made, so every agent agrees.
// ---------------------------------------------------------------------------------------------

type Stage = 'waiting' | 'collected' | 'received' | 'entered' | 'released' | 'cancelled';
type Values = Record<string, number | string>;
type Area = 'ER' | 'Ward' | 'OPD';
const RANK: Record<Stage, number> = { waiting: 0, collected: 1, received: 2, entered: 3, released: 4, cancelled: -1 };

interface LineSpec {
  test: string;
  stage: Stage;
  /** Entered results (a normal set when left out). */
  values?: Values;
  e?: number;
  v?: number;
  /** A critical result, acknowledged this many minutes after the order. */
  ackOff?: number;
  /** A cancelled line: minutes after the order, and why. */
  cancelAt?: number;
  reason?: string;
  /** A released result amended later: new values, minutes after the order, and why. */
  amend?: { values: Values; e: number; v: number; reason: string };
}

interface ReqSpec {
  key: string;
  area: Area;
  /** ER: text in the visit's complaint. Ward: which ward case. OPD: which patient. */
  who: RegExp | number;
  priority: Priority;
  t: number;
  c?: number;
  r?: number;
  e?: number;
  v?: number;
  note?: string;
  lines: LineSpec[];
  /** One tube's sample was rejected `at` minutes after the order; `again` is its recollection. */
  reject?: { tube: TubeKey; reason: string; at: number; again?: { c: number; r?: number } };
}

const NORMAL: Record<string, Values> = {
  cbc: { Haemoglobin: 13.4, WBC: 7.2, Platelets: 260 },
  crp: { CRP: 2.1 },
  rft: { Creatinine: 0.9, Urea: 28 },
  electrolytes: { Sodium: 139, Potassium: 4.2 },
  lft: { Bilirubin: 0.8, ALT: 32, Albumin: 4.1 },
  glucose: { Glucose: 102 },
  hba1c: { HbA1c: 5.2 },
  lipid: { 'Total cholesterol': 182, LDL: 96, HDL: 48, Triglycerides: 130 },
  coag: { PT: 12.1, INR: 1.0 },
  troponin: { 'Troponin I': 0.02 },
  ddimer: { 'D-dimer': 320 },
  abg: { pH: 7.4, 'pCO₂': 40, 'pO₂': 92 },
  thyroid: { TSH: 2.1 },
  'blood-culture': { Result: 'No growth' },
  urine: { Protein: 'Nil', Sugar: 'Nil', 'Pus cells': 2, RBC: 1 },
};

const L = (test: string, stage: Stage, extra: Partial<LineSpec> = {}): LineSpec => ({ test, stage, ...extra });

const ER_SPECS: ReqSpec[] = [
  { key: 'e1', area: 'ER', who: /Pressure in the chest/, priority: 'stat', t: 7, c: 2, r: 4, note: 'Chest pain, rule out a heart attack', lines: [L('cbc', 'received'), L('troponin', 'received')] },
  { key: 'e2', area: 'ER', who: /Crushing chest pain/, priority: 'stat', t: 4, lines: [L('troponin', 'waiting'), L('abg', 'waiting')] },
  {
    key: 'e3', area: 'ER', who: /Road accident/, priority: 'stat', t: 31, c: 2, r: 4,
    lines: [
      L('cbc', 'released', { values: { Haemoglobin: 6.4, WBC: 9.8, Platelets: 210 }, e: 6, v: 7, ackOff: 17 }),
      L('coag', 'entered', { values: { PT: 17.2, INR: 1.5 }, e: 14 }),
      L('electrolytes', 'received'),
    ],
  },
  { key: 'e4', area: 'ER', who: /Face drooping/, priority: 'stat', t: 17, c: 2, r: 3, lines: [L('cbc', 'entered', { values: { Haemoglobin: 13.1, WBC: 8.4, Platelets: 245 }, e: 12 }), L('glucose', 'released', { values: { Glucose: 118 }, e: 6, v: 7 }), L('coag', 'received')] },
  {
    key: 'e5', area: 'ER', who: /Fever for two days/, priority: 'urgent', t: 25, c: 3, r: 8,
    lines: [
      L('cbc', 'entered', { values: { Haemoglobin: 12.8, WBC: 11.9, Platelets: 310 }, e: 20 }),
      L('crp', 'received'),
      // The designed unacknowledged critical: released 5 minutes before now.
      L('electrolytes', 'released', { values: { Sodium: 138, Potassium: 6.6 }, e: 17, v: 20 }),
    ],
  },
  { key: 'e6', area: 'ER', who: /Fever with chills/, priority: 'stat', t: 15, c: 5, r: 7, note: 'Suspected sepsis', lines: [L('cbc', 'entered', { values: { Haemoglobin: 11.2, WBC: 14.8, Platelets: 180 }, e: 10 }), L('crp', 'received'), L('blood-culture', 'received')] },
  { key: 'e7', area: 'ER', who: /Short of breath/, priority: 'urgent', t: 27, c: 2, r: 3, lines: [L('cbc', 'received'), L('abg', 'released', { values: { pH: 7.31, 'pCO₂': 52, 'pO₂': 62 }, e: 6, v: 8 })] },
  { key: 'e8', area: 'ER', who: /upper abdomen/, priority: 'urgent', t: 73, c: 4, r: 15, lines: [L('cbc', 'released', { e: 30, v: 33 }), L('crp', 'received'), L('lft', 'entered', { values: { Bilirubin: 1.4, ALT: 88, Albumin: 3.9 }, e: 45 })] },
  { key: 'e9', area: 'ER', who: /Vomiting since last night/, priority: 'routine', t: 50, c: 10, lines: [L('electrolytes', 'collected'), L('rft', 'collected')] },
  { key: 'e10', area: 'ER', who: /Skin rash/, priority: 'routine', t: 110, c: 10, r: 20, lines: [L('cbc', 'released', { e: 60, v: 65 }), L('crp', 'released', { e: 61, v: 66 })] },
  { key: 'e11', area: 'ER', who: /Sprained ankle/, priority: 'routine', t: 50, lines: [L('crp', 'cancelled', { cancelAt: 10, reason: 'Ordered by mistake' }), L('lft', 'cancelled', { cancelAt: 10, reason: 'Ordered by mistake' })] },
];

const WARD_SPECS: ReqSpec[] = [
  {
    key: 'w1', area: 'Ward', who: 0, priority: 'routine', t: 240, c: 20, r: 45,
    lines: [
      L('cbc', 'released', { e: 90, v: 95 }),
      L('rft', 'released', { values: { Creatinine: 1.9, Urea: 62 }, e: 95, v: 100, amend: { values: { Creatinine: 1.6, Urea: 54 }, e: 140, v: 145, reason: 'Transcription error corrected' } }),
      L('electrolytes', 'released', { e: 96, v: 101 }),
    ],
  },
  { key: 'w2', area: 'Ward', who: 1, priority: 'urgent', t: 120, c: 10, r: 20, lines: [L('coag', 'released', { values: { PT: 46.5, INR: 5.8 }, e: 45, v: 50, ackOff: 65 }), L('electrolytes', 'released', { e: 46, v: 51 })] },
  { key: 'w3', area: 'Ward', who: 2, priority: 'routine', t: 150, c: 30, r: 60, lines: [L('lipid', 'received'), L('hba1c', 'received'), L('thyroid', 'received')] },
  { key: 'w4', area: 'Ward', who: 3, priority: 'routine', t: 130, c: 20, r: 40, lines: [L('lft', 'entered', { values: { Bilirubin: 0.9, ALT: 41, Albumin: 4.0 }, e: 70 }), L('crp', 'entered', { values: { CRP: 12.4 }, e: 71 })] },
  { key: 'w5', area: 'Ward', who: 4, priority: 'urgent', t: 25, lines: [L('ddimer', 'waiting'), L('abg', 'waiting')] },
  {
    key: 'w6', area: 'Ward', who: 5, priority: 'routine', t: 100, c: 10, r: 20,
    reject: { tube: 'urine', reason: 'unlabelled', at: 30 },
    lines: [L('cbc', 'released', { e: 60, v: 65 }), L('urine', 'waiting')],
  },
  { key: 'w7', area: 'Ward', who: 6, priority: 'routine', t: 90, c: 15, r: 35, lines: [L('crp', 'received'), L('lft', 'received'), L('lipid', 'cancelled', { cancelAt: 50, reason: 'No longer needed' })] },
  { key: 'w8', area: 'Ward', who: 7, priority: 'stat', t: 60, c: 3, r: 6, lines: [L('glucose', 'released', { values: { Glucose: 215 }, e: 12, v: 14 }), L('electrolytes', 'released', { values: { Sodium: 131, Potassium: 4.0 }, e: 20, v: 22 })] },
];

const OPD_SPECS: ReqSpec[] = [
  { key: 'p1', area: 'OPD', who: 0, priority: 'routine', t: 100, lines: [L('hba1c', 'waiting'), L('lipid', 'waiting'), L('thyroid', 'waiting')] },
  { key: 'p2', area: 'OPD', who: 1, priority: 'routine', t: 40, c: 10, lines: [L('cbc', 'collected'), L('glucose', 'collected')] },
  { key: 'p3', area: 'OPD', who: 2, priority: 'urgent', t: 60, c: 5, r: 15, lines: [L('urine', 'received'), L('crp', 'received')] },
  { key: 'p4', area: 'OPD', who: 2, priority: 'routine', t: 90, lines: [L('coag', 'cancelled', { cancelAt: 10, reason: 'Duplicate order' })] },
  {
    key: 'p5', area: 'OPD', who: 3, priority: 'routine', t: 180, c: 20, r: 45,
    lines: [L('lft', 'entered', { values: { Bilirubin: 1.6, ALT: 52, Albumin: 3.8 }, e: 100 }), L('rft', 'entered', { values: { Creatinine: 1.4, Urea: 44 }, e: 105 }), L('electrolytes', 'entered', { values: { Sodium: 141, Potassium: 4.6 }, e: 110 })],
  },
  { key: 'p6', area: 'OPD', who: 4, priority: 'routine', t: 120, c: 10, reject: { tube: 'edta', reason: 'clotted', at: 25, again: { c: 50, r: 60 } }, lines: [L('cbc', 'released', { e: 95, v: 100 })] },
  { key: 'p7', area: 'OPD', who: 4, priority: 'routine', t: 20, lines: [L('urine', 'waiting')] },
  { key: 'p8', area: 'OPD', who: 5, priority: 'routine', t: 150, c: 10, r: 25, lines: [L('crp', 'released', { e: 80, v: 85 }), L('ddimer', 'released', { e: 82, v: 87 })] },
  { key: 'p9', area: 'OPD', who: 5, priority: 'routine', t: 35, c: 5, lines: [L('thyroid', 'collected')] },
  { key: 'p10', area: 'OPD', who: 6, priority: 'routine', t: 200, c: 20, r: 50, lines: [L('lipid', 'released', { e: 140, v: 145 }), L('hba1c', 'released', { e: 141, v: 146 })] },
  { key: 'p11', area: 'OPD', who: 6, priority: 'urgent', t: 30, c: 4, r: 10, lines: [L('glucose', 'received')] },
];

const SPECS: ReqSpec[] = [...ER_SPECS, ...WARD_SPECS, ...OPD_SPECS];

/** A small repeatable number generator, so the history is the same on every seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The clinic moment for the real moment `nowMs`: the clinic day, at the real time of day. */
function clinicAt(day: string, nowMs: number): number {
  const d = new Date(nowMs);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m) d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

const CASE_PRIORITY = { stat: 'high', urgent: 'medium', routine: 'low' } as const;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const cut = (s: string) => s.slice(0, SUMMARY_MAX);
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const labelOf = (test: string) => testByKey(test)?.label ?? test;

/** Everything a seeded line is, worked out before anything is written. */
interface LineBuild {
  spec: LineSpec;
  _id: Types.ObjectId;
  tatDueAt: Date;
  /** Real time the line closed (first release, or cancel); undefined while open. */
  closedMs?: number;
  rows?: LabResultRow[];
  firstRows?: LabResultRow[];
  doc: Record<string, any>;
  releasedMs?: number;
}

/**
 * Replaces everything the Lab agent keeps with a demo day: about 30 requests across the ER, the wards and the
 * outpatient side in every state, with their samples, results, reports, cases, clocks, Coordinator messages,
 * critical alerts and a week of hourly snapshots. Run after seedCoordinator and seedEr: the requests sit on
 * their open cases. Staff-visible times use the clinic clock (`clinicDay`); everything else uses the real
 * clock, placed so nothing is after `nowMs` and no running clock is overdue; the designed unacknowledged
 * critical result comes closest, due about ten minutes after `nowMs`. `nowMs` is for tests.
 */
export async function seedLab(clinicDay: string, nowMs: number = Date.now()): Promise<void> {
  const requests = model(LabRequest, LabRequestSchema);
  const lines = model(LabLine, LabLineSchema);
  const samples = model(LabSample, LabSampleSchema);
  const locations = model(LabLocation, LabLocationSchema);
  const snapshots = model(LabSnapshot, LabSnapshotSchema);
  const reports = model(LabTestReport, LabTestReportSchema);
  const cases = model(Case, CaseSchema);
  const messages = model(AgentMessage, AgentMessageSchema);
  const clocks = model(Clock, ClockSchema);
  const escalations = model(Escalation, EscalationSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const timeline = model(TimelineEvent, TimelineEventSchema);
  const counters = model(CoordinatorCounter, CoordinatorCounterSchema);
  const patients = model(Patient, PatientSchema);
  const visits = model(ErVisit, ErVisitSchema);
  const users = model(User, UserSchema);
  const titles = model(DutyTitle, DutyTitleSchema);
  const ladders = model(Ladder, LadderSchema);

  // ---- People ------------------------------------------------------------------------------
  const who = async (email: string, role: string, fallback: string, not?: string): Promise<{ id: string; name: string }> => {
    const u = (await users.findOne({ email }).select('name').lean<any>()) ?? (await users.findOne({ role, ...(not ? { _id: { $ne: not } } : {}) }).sort({ name: 1 }).select('name').lean<any>());
    return u ? { id: String(u._id), name: u.name } : { id: String(new Types.ObjectId()), name: fallback };
  };
  const doctor = await who('doctor@medios.ai', 'doctor', 'Dr. Shajin');
  const nurse = await who('nurse@medios.ai', 'nurse', 'Ward nurse');
  const tech = await who('lab@medios.ai', 'lab', 'Lab technician');
  const pathologist = await who(LAB_DEMO_ACCOUNTS[0].email, 'lab', LAB_DEMO_ACCOUNTS[0].name, tech.id);
  if (pathologist.id === tech.id) throw new Error('Lab seed: the lab technician and the pathologist must be two people (the two-person rule).');

  // ---- Time -------------------------------------------------------------------------------
  const clinicMs = clinicAt(clinicDay, nowMs);
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  // Early in the day there is less room for history: squeeze the ward and outpatient requests into it.
  const room = (nowMs - midnight.getTime() - 2 * MIN) / MIN;
  const squeeze = Math.min(1, Math.max(0.05, room / 240));
  const real = (agoMin: number, plusMs = 0): Date => new Date(Math.min(nowMs, nowMs - agoMin * MIN + plusMs));
  const clinic = (agoMin: number): Date => new Date(clinicMs - agoMin * MIN);

  // ---- The cases the requests sit on (read before anything is wiped) ---------------------------
  const allVisits = await visits.find({ status: { $nin: ['left', 'waiting-bed'] } }).sort({ number: 1 }).lean<any[]>();
  const erCases = new Map<string, any>();
  for (const spec of ER_SPECS) {
    const v = allVisits.find((x) => (spec.who as RegExp).test(x.complaintText ?? '') && ![...erCases.values()].some((used) => String(used.visit._id) === String(x._id)));
    if (!v) throw new Error(`Lab seed: no open ER visit matches ${spec.who}. Run the ER seed first.`);
    const c = await cases.findById(v.case).lean<any>();
    if (!c) throw new Error('Lab seed: an ER visit has no case.');
    erCases.set(spec.key, { visit: v, case: c });
  }
  const wardPool = await cases.find({ kind: 'ipd', state: 'open', openedBy: { $ne: 'er' } }).sort({ number: 1 }).lean<any[]>();
  const wardName = new Map<string, string>();
  for (const c of wardPool) {
    const m = await messages.findOne({ case: c._id, type: 'bed.assigned' }).sort({ createdAt: -1 }).select('payload').lean<any>();
    wardName.set(String(c._id), typeof m?.payload?.ward === 'string' && m.payload.ward ? m.payload.ward : 'General Ward');
  }
  const busy = new Set((await cases.find({ state: 'open', openedBy: { $ne: 'lab' } }).select('patient').lean<any[]>()).map((c) => String(c.patient)));
  const opdPatients = (await patients.find({ detailsPending: { $ne: true } }).sort({ uhid: 1 }).lean<any[]>()).filter((p) => !busy.has(String(p._id))).slice(0, 7);
  const needOpd = Math.max(...OPD_SPECS.map((s) => s.who as number)) + 1;
  if (!wardPool.length) console.log('Lab seed: no open admission case; the ward requests are skipped.');
  if (opdPatients.length < needOpd) console.log(`Lab seed: only ${opdPatients.length} patients have no open case; some outpatient requests share a patient.`);
  const specs = SPECS.filter((s) => s.area !== 'Ward' || wardPool.length).filter((s) => s.area !== 'OPD' || opdPatients.length);

  // ---- Build -------------------------------------------------------------------------------
  const order = [...specs].sort((a, b) => b.t * (b.area === 'ER' ? 1 : squeeze) - a.t * (a.area === 'ER' ? 1 : squeeze));
  const lastCaseNo = (await cases.find({ number: /^CASE-\d{4,}$/, openedBy: { $ne: 'lab' } }).select('number').lean<any[]>()).reduce((max, c) => Math.max(max, Number(String(c.number).slice(5))), 0);
  let caseSerial = lastCaseNo;
  const sampleDay = clinicDay.replace(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/, '$1$2$3');
  let sampleSerial = 0;

  const caseDocs: Record<string, any>[] = [];
  const requestDocs: Record<string, any>[] = [];
  const lineDocs: Record<string, any>[] = [];
  const sampleDocs: Record<string, any>[] = [];
  const locationDocs: Record<string, any>[] = [];
  const clockDocs: Record<string, any>[] = [];
  const messageDocs: Record<string, any>[] = [];
  const alertDocs: Record<string, any>[] = [];
  const milestones: Record<string, unknown>[] = [];
  const touchedCases = new Map<string, number>();
  const newCases = new Map<number, Record<string, any>>();
  const lineUpdatedAt = new Map<string, Date>();

  const push = (caseId: Types.ObjectId, at: Date, m: Record<string, unknown>): Types.ObjectId => {
    const _id = new Types.ObjectId();
    const payload = (m.payload as Record<string, unknown>) ?? {};
    messageDocs.push({
      _id,
      case: caseId,
      to: ['coordinator'],
      payload,
      dueBy: null,
      needsPerson: false,
      opensWork: false,
      hop: 0,
      attempts: 0,
      state: 'delivered',
      // The services' own default when they set none.
      dedupeKey: `${m.type}:${caseId}:${createHash('sha1').update(JSON.stringify(payload)).digest('hex')}`,
      createdAt: at,
      ...m,
    });
    touchedCases.set(String(caseId), Math.max(touchedCases.get(String(caseId)) ?? 0, at.getTime()));
    return _id;
  };
  const addClock = (c: { def: string; case: Types.ObjectId; ref: string; startedBy: Types.ObjectId; startedAt: Date; dueAt: Date; stoppedAt?: Date }): void => {
    if (!c.stoppedAt && c.dueAt.getTime() <= nowMs) throw new Error(`Lab seed: the running ${c.def} clock is already overdue.`);
    // The detail the live clock takes from its start message.
    const start = messageDocs.find((x) => String(x._id) === String(c.startedBy));
    const detail = LAB_CLOCKS.find((d) => d.key === c.def)?.detailFrom?.((start?.payload as Record<string, unknown>) ?? {});
    clockDocs.push({
      _id: new Types.ObjectId(),
      ...c,
      ...(detail ? { detail } : {}),
      state: c.stoppedAt ? 'met' : 'running',
      ...(c.stoppedAt ? { metMinutes: Math.round((c.stoppedAt.getTime() - c.startedAt.getTime()) / MIN) } : {}),
      createdAt: c.startedAt,
      updatedAt: c.stoppedAt ?? c.startedAt,
    });
  };

  let requestSerial = 0;
  for (const spec of order) {
    const sq = spec.area === 'ER' ? 1 : squeeze;
    const at = (off: number): Date => real((spec.t - off) * sq);
    const clinicOff = (off: number): Date => clinic((spec.t - off) * sq);
    const label = `${spec.key}`;
    const check = (off: number | undefined, what: string) => {
      if (off !== undefined && (off < 0 || off > spec.t)) throw new Error(`Lab seed: ${label} ${what} (${off}) is not between the order and now.`);
    };

    // The case and where the patient is.
    let caseId: Types.ObjectId;
    let patient: { _id: Types.ObjectId; uhid: string; name: string };
    let location: { area: Area; ward?: string };
    let visit: any;
    let openedHere = false;
    if (spec.area === 'ER') {
      const pick = erCases.get(spec.key)!;
      visit = pick.visit;
      caseId = pick.case._id;
      patient = { _id: pick.case.patient, uhid: pick.case.patientUhid, name: pick.case.patientName };
      location = { area: 'ER' };
      if ((nowMs - new Date(visit.createdAt).getTime()) / MIN + 0.01 < spec.t) throw new Error(`Lab seed: ${label} was ordered before the patient arrived.`);
    } else if (spec.area === 'Ward') {
      const c = wardPool[(spec.who as number) % wardPool.length];
      caseId = c._id;
      patient = { _id: c.patient, uhid: c.patientUhid, name: c.patientName };
      location = { area: 'Ward', ward: wardName.get(String(c._id)) };
    } else {
      const p = opdPatients[(spec.who as number) % opdPatients.length];
      patient = { _id: p._id, uhid: p.uhid, name: p.name };
      location = { area: 'OPD' };
      const key = Number(spec.who) % opdPatients.length;
      let c = newCases.get(key);
      if (!c) {
        const _id = new Types.ObjectId();
        c = { _id, number: `CASE-${pad(++caseSerial, 4)}`, patient: p._id, patientUhid: p.uhid, patientName: p.name, kind: 'opd', priority: 'low', state: 'open', openedAt: clinicOff(0), agents: ['lab'], refs: { bedRequestIds: [] as string[] }, openedBy: 'lab', createdAt: new Date(at(0).getTime() - 2000), updatedAt: at(0) };
        newCases.set(key, c);
        caseDocs.push(c);
        openedHere = true;
      }
      if (PRIORITY_RANK[CASE_PRIORITY[spec.priority]] < PRIORITY_RANK[c.priority as keyof typeof PRIORITY_RANK]) c.priority = CASE_PRIORITY[spec.priority];
      caseId = c._id;
    }
    if (!locationDocs.some((l) => String(l.case) === String(caseId))) locationDocs.push({ case: caseId, ...location });
    const casePriority = CASE_PRIORITY[spec.priority];
    const priority = spec.priority;

    // The request.
    const requestId = new Types.ObjectId();
    const number = `LR-${pad(++requestSerial, 4)}`;
    const orderReal = at(0);
    const collectBy = new Date(orderReal.getTime() + COLLECT_MINUTES[priority] * MIN);
    const lb: LineBuild[] = spec.lines.map((s) => {
      if (!testByKey(s.test)) throw new Error(`Lab seed: unknown test ${s.test}`);
      const _id = new Types.ObjectId();
      return { spec: s, _id, tatDueAt: new Date(orderReal.getTime() + targetMinutes(s.test, priority) * MIN), doc: {} };
    });
    const lineOf = (test: string) => lb.find((l) => l.spec.test === test)!;
    const enterOff = (l: LineBuild, i: number) => (l.spec.e ?? spec.e ?? 0) + i * 0.01;

    // Results, and what each line's close time is.
    lb.forEach((l, i) => {
      const s = l.spec;
      if (s.stage === 'entered' || s.stage === 'released') {
        const values = s.values ?? NORMAL[s.test];
        const flagged = (vals: Values): LabResultRow[] =>
          testByKey(s.test)!.params.map((p) => ({ param: p.name, value: vals[p.name], unit: p.unit, ...flagValue(s.test, p.name, vals[p.name]) }));
        l.firstRows = flagged(values);
        l.rows = s.amend ? flagged(s.amend.values) : l.firstRows;
        if (s.stage === 'entered' && l.rows.some((r) => r.critical)) throw new Error(`Lab seed: ${label} ${s.test} is critical but not released.`);
        check(s.e, `${s.test} enter`);
      }
      if (s.stage === 'released') {
        check(s.v, `${s.test} release`);
        l.releasedMs = at((s.v ?? 0) + i * 0.01).getTime();
        l.closedMs = l.releasedMs;
      }
      if (s.stage === 'cancelled') {
        check(s.cancelAt, `${s.test} cancel`);
        l.closedMs = at((s.cancelAt ?? 0) + i * 0.01).getTime();
      }
    });
    check(spec.c, 'collect');
    check(spec.r, 'receive');
    if (spec.reject) check(spec.reject.at, 'rejection');

    // Samples: one per tube. A rejected tube also gets its recollection.
    interface SampleBuild { doc: Record<string, any>; tests: string[]; collectedMs?: number; receivedMs?: number; replacement?: boolean }
    const built: SampleBuild[] = [];
    const groups = groupIntoTubes(spec.lines.map((s) => s.test));
    const collectedBy = spec.area === 'OPD' ? tech.name : nurse.name;
    groups.forEach((g, gi) => {
      const mine = g.tests.map(lineOf);
      const active = mine.filter((l) => l.spec.stage !== 'cancelled');
      const sampleId = new Types.ObjectId();
      const rej = spec.reject?.tube === g.tube ? spec.reject : undefined;
      const lineIds = mine.map((l) => l._id);
      const ranks = active.map((l) => RANK[l.spec.stage]);
      const sameClass = ranks.every((r) => r === 0) || ranks.every((r) => r === 1) || ranks.every((r) => r >= 2);
      if (!sameClass) throw new Error(`Lab seed: ${label} has lines on one ${g.tube} sample at different stages.`);
      const number = `S-${sampleDay}-${pad(++sampleSerial, 4)}`;
      const base = { _id: sampleId, number, request: requestId, tube: g.tube, lines: lineIds, collectBy, createdAt: orderReal, updatedAt: orderReal };
      if (!active.length) {
        built.push({ doc: { ...base, status: 'cancelled', updatedAt: new Date(Math.max(...mine.map((l) => l.closedMs ?? 0))) }, tests: g.tests });
        return;
      }
      // The culture bottle is collected at the moment the ER's cultures step was ticked.
      const cultureStep = spec.area === 'ER' && g.tube === 'culture' ? visit.steps?.find((s: any) => s.key === 'cultures') : undefined;
      if (g.tube === 'culture' && spec.area === 'ER' && !cultureStep?.doneAt) throw new Error('Lab seed: the sepsis visit has no cultures step done to match its blood culture.');
      const collectedAt = cultureStep ? new Date(nowMs - (clinicMs - new Date(cultureStep.doneAt).getTime())) : at((spec.c ?? 0) + gi * 0.01);
      const originalTaken = rej ? true : ranks[0] >= 1;
      if (rej) {
        const rejectedAt = at(rej.at + gi * 0.01);
        const recollectBy = new Date(rejectedAt.getTime() + COLLECT_MINUTES[priority] * MIN);
        built.push({
          doc: { ...base, status: 'rejected', collected: { by: collectedBy, at: clinic((spec.t - (spec.c ?? 0) - gi * 0.01) * sq) }, collectedRealAt: collectedAt, rejected: { by: tech.name, reason: rej.reason, note: '', at: clinic((spec.t - rej.at - gi * 0.01) * sq) }, updatedAt: rejectedAt },
          tests: g.tests,
          collectedMs: collectedAt.getTime(),
        });
        const newId = new Types.ObjectId();
        const again = rej.again;
        if (again) check(again.c, 'recollect');
        const againCollected = again ? at(again.c + gi * 0.01) : undefined;
        const againReceived = again?.r !== undefined ? at(again.r + gi * 0.01) : undefined;
        built.push({
          doc: {
            _id: newId, number: `S-${sampleDay}-${pad(++sampleSerial, 4)}`, request: requestId, tube: g.tube, lines: lineIds, replaces: sampleId, collectBy: recollectBy,
            status: againReceived ? 'received' : againCollected ? 'collected' : 'waiting',
            ...(againCollected ? { collected: { by: collectedBy, at: clinic((spec.t - again!.c - gi * 0.01) * sq) }, collectedRealAt: againCollected } : {}),
            ...(againReceived ? { received: { by: tech.name, at: clinic((spec.t - again!.r! - gi * 0.01) * sq) } } : {}),
            createdAt: rejectedAt,
            updatedAt: againReceived ?? againCollected ?? rejectedAt,
          },
          tests: g.tests,
          collectedMs: againCollected?.getTime(),
          receivedMs: againReceived?.getTime(),
          replacement: true,
        });
        (built[built.length - 2] as any).recollectBy = recollectBy;
        (built[built.length - 2] as any).rejectedAt = rejectedAt;
        return;
      }
      const receivedAt = ranks[0] >= 2 ? at((spec.r ?? 0) + gi * 0.01) : undefined;
      built.push({
        doc: {
          ...base,
          status: ranks[0] === 0 ? 'waiting' : receivedAt ? 'received' : 'collected',
          ...(originalTaken ? { collected: { by: collectedBy, at: new Date(clinicMs - (nowMs - collectedAt.getTime())) }, collectedRealAt: collectedAt } : {}),
          ...(receivedAt ? { received: { by: tech.name, at: clinicOff((spec.r ?? 0) + gi * 0.01) } } : {}),
          updatedAt: receivedAt ?? (originalTaken ? collectedAt : orderReal),
        },
        tests: g.tests,
        collectedMs: originalTaken ? collectedAt.getTime() : undefined,
        receivedMs: receivedAt?.getTime(),
      });
    });
    const orderedSamples = built;
    const live = orderedSamples.filter((s) => s.doc.status !== 'cancelled');

    // Which lines are open at a moment: not yet released or cancelled.
    const openAt = (ms: number) => lb.filter((l) => l.closedMs === undefined || l.closedMs > ms);
    const earliestTat = (ls: LineBuild[]) => new Date(Math.min(...ls.map((l) => l.tatDueAt.getTime())));

    // Request-level times.
    const allClosed = lb.every((l) => l.closedMs !== undefined);
    const lastClosed = allClosed ? Math.max(...lb.map((l) => l.closedMs!)) : undefined;
    const allCancelled = lb.every((l) => l.spec.stage === 'cancelled');
    const origTaken = orderedSamples.filter((s) => !s.doc.replaces && s.doc.status !== 'cancelled').map((s) => s.collectedMs);
    const firstDoneMs = allCancelled ? lastClosed! + 1000 : origTaken.length && origTaken.every((x) => x !== undefined) ? Math.max(...(origTaken as number[])) + 1000 : undefined;
    const againMs = orderedSamples.filter((s) => s.replacement && s.collectedMs !== undefined).map((s) => s.collectedMs! + 1000);
    const lastDoneMs = againMs.length ? Math.max(...againMs) : firstDoneMs;
    const waitingNow = live.some((s) => s.doc.status === 'waiting');
    const collectionDone = lastDoneMs !== undefined && !waitingNow;
    const firstReceivedMs = live.some((s) => s.receivedMs !== undefined) ? Math.min(...live.filter((s) => s.receivedMs !== undefined).map((s) => s.receivedMs!)) : undefined;
    /** As the services work it out at `ms`: the turnaround clock escalates at the later of the due and the first receipt plus the target. */
    const escalateFor = (ls: LineBuild[], ms: number, fallback: Date) =>
      ls.length ? escalateAt({ createdAt: orderReal, firstReceivedAt: firstReceivedMs !== undefined && firstReceivedMs <= ms ? new Date(firstReceivedMs) : undefined }, ls) ?? fallback : fallback;
    const doneMs = lastClosed !== undefined ? lastClosed + (allCancelled ? 2000 : 1000) : undefined;
    const cap = (ms: number) => Math.min(nowMs, ms);

    // ---- Messages ------------------------------------------------------------------------------
    if (openedHere) {
      const c = newCases.get(Number(spec.who) % opdPatients.length)!;
      push(c._id, new Date(orderReal.getTime() - 2000), { from: 'coordinator', type: 'case.opened', priority: 'medium', summary: `${c.number} opened for ${patient.uhid}` });
      milestones.push({ uhid: patient.uhid, date: displayDate(clinicOff(0)), time: displayTime(clinicOff(0)), category: 'Outpatient', title: `Case ${c.number} opened`, subtitle: CLOSE_NOTE, status: 'Completed' });
    }
    const msg = (type: string, atMs: number, summary: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      push(caseId, new Date(cap(atMs)), { from: 'lab', type, priority: casePriority, summary: cut(summary), payload, ...extra });

    const announcedAt = new Date(cap(orderReal.getTime() + 1000));
    const orderedMsg = msg('lab.ordered', orderReal.getTime() + 1000, orderSummary(number, spec.lines.map((s) => labelOf(s.test)), priority), {
      requestId: String(requestId),
      requestNumber: number,
      priority,
      tests: spec.lines.map((s) => s.test),
      collectBy,
      tatDueAt: earliestTat(lb),
    });
    const steps: { ms: number; run: () => void }[] = [];
    const defer = (ms: number, run: () => void) => steps.push({ ms, run });

    // Set while the deferred messages run, read afterwards for the clocks.
    const seen = { firstReceive: false, firstReceiveMsg: undefined as Types.ObjectId | undefined, requestDone: undefined as { id: Types.ObjectId; ms: number } | undefined };
    const rejectedMsgs: { id: Types.ObjectId; at: Date; recollectBy: Date }[] = [];
    const collectionDoneMsgs: number[] = [];

    for (const s of orderedSamples) {
      if (s.collectedMs !== undefined) {
        defer(s.collectedMs, () =>
          msg('lab.collected', s.collectedMs! + 500, `${number}: ${s.doc.number} collected (${TUBE_LABEL[s.doc.tube as TubeKey]}: ${s.tests.map(labelOf).join(', ')})`, {
            requestId: String(requestId), sampleId: String(s.doc._id), sampleNumber: s.doc.number, tube: s.doc.tube, tests: s.tests,
          }, { dedupeKey: `lab.collected:${s.doc._id}` }),
        );
      }
      if (s.receivedMs !== undefined) {
        defer(s.receivedMs, () => {
          const first = !seen.firstReceive;
          seen.firstReceive = true;
          const id = msg('lab.received', s.receivedMs! + 500, `${number}: ${s.doc.number} received (${TUBE_LABEL[s.doc.tube as TubeKey]})`, {
            requestId: String(requestId), requestNumber: number, sampleId: String(s.doc._id), firstReceive: first, tests: openAt(s.receivedMs!).map((l) => l.spec.test), tatDueAt: earliestTat(openAt(s.receivedMs!)),
            escalateAt: escalateFor(openAt(s.receivedMs!), s.receivedMs!, earliestTat(openAt(s.receivedMs!))),
          }, { dedupeKey: `lab.received:${s.doc._id}` });
          if (first) seen.firstReceiveMsg = id;
        });
      }
      if (s.doc.status === 'rejected') {
        const replacement = orderedSamples.find((x) => String(x.doc.replaces) === String(s.doc._id))!;
        const rejectedAt = (s as any).rejectedAt as Date;
        defer(rejectedAt.getTime(), () => {
          const id = msg('lab.rejected', rejectedAt.getTime(), `${number}: ${s.doc.number} rejected (${s.doc.rejected.reason}), recollect as ${replacement.doc.number}`, {
            requestId: String(requestId), requestNumber: number, sampleId: String(s.doc._id), newSampleId: String(replacement.doc._id), reason: s.doc.rejected.reason,
            tests: s.tests.filter((t) => lineOf(t).spec.stage !== 'cancelled'), recollectBy: (s as any).recollectBy,
          }, { dedupeKey: `lab.rejected:${s.doc._id}` });
          rejectedMsgs.push({ id, at: rejectedAt, recollectBy: (s as any).recollectBy });
        });
      }
    }
    for (const ms of [firstDoneMs, ...againMs]) {
      if (ms === undefined) continue;
      // After a rejection the flag is open again until the recollection arrives; a done sent before it still happened.
      defer(ms, () => {
        msg('lab.collection-done', ms, `${number}: all samples collected`, { requestId: String(requestId) }, { dedupeKey: `lab.collection-done:${requestId}:${new Types.ObjectId()}` });
        collectionDoneMsgs.push(cap(ms));
      });
    }

    lb.forEach((l, i) => {
      const s = l.spec;
      const def = testByKey(s.test)!;
      if (s.stage === 'cancelled') {
        defer(l.closedMs!, () =>
          msg('lab.cancelled', l.closedMs!, `${number}: ${def.label} cancelled`, {
            requestId: String(requestId), lineId: String(l._id), test: s.test, tatDueAt: openAt(l.closedMs!).length ? earliestTat(openAt(l.closedMs!)) : l.tatDueAt,
            escalateAt: escalateFor(openAt(l.closedMs!), l.closedMs!, l.tatDueAt),
          }),
        );
        return;
      }
      if (s.stage !== 'released') return;
      const criticals = (s.amend ? l.firstRows! : l.rows!).filter((r) => r.critical);
      const flag = criticals.length ? 'critical' : l.firstRows!.some((r) => r.flag !== 'normal') ? 'abnormal' : 'normal';
      defer(l.releasedMs!, () => {
        const open = openAt(l.releasedMs!);
        msg('lab.resulted', l.releasedMs! + 200, `${number}: ${def.label} released${flag === 'normal' ? '' : ` (${flag})`}`, {
          requestId: String(requestId), lineId: String(l._id), test: s.test, flag, version: 1, tatDueAt: open.length ? earliestTat(open) : l.tatDueAt,
          escalateAt: escalateFor(open, l.releasedMs!, l.tatDueAt),
        }, { dedupeKey: `lab.resulted:${l._id}:1` });
        const criticalIds: Types.ObjectId[] = [];
        for (const c of criticals) {
          criticalIds.push(
            msg('lab.critical', l.releasedMs! + 400, `${number}: ${def.label} critical (${c.param})`, {
              requestId: String(requestId), requestNumber: number, lineId: String(l._id), test: s.test, parameter: c.param, value: String(c.value), unit: c.unit, version: 1,
            }, { priority: 'high', dedupeKey: `lab.critical:${l._id}:1:${c.param}` }),
          );
        }
        if (criticals.length) {
          const releasedAt = new Date(l.releasedMs!);
          const ackMs = s.ackOff !== undefined ? at(s.ackOff).getTime() : undefined;
          if (s.ackOff !== undefined) check(s.ackOff, `${s.test} ack`);
          addClock({
            def: 'lab-critical', case: caseId, ref: String(l._id), startedBy: criticalIds[0], startedAt: releasedAt,
            // The unacknowledged critical is due ten minutes after now (its clock gives 15 minutes from the release, five minutes ago).
            dueAt: ackMs === undefined ? new Date(nowMs + 10 * MIN) : new Date(releasedAt.getTime() + 15 * MIN),
            ...(ackMs !== undefined ? { stoppedAt: new Date(ackMs) } : {}),
          });
          if (ackMs !== undefined) {
            msg('lab.critical-acked', ackMs, `${number}: ${def.label} critical acknowledged`, { lineId: String(l._id) }, { priority: 'high', dedupeKey: `lab.critical-acked:${l._id}:1` });
          } else if (Math.abs(nowMs - l.releasedMs! - 5 * MIN) > MIN) {
            throw new Error('Lab seed: the unacknowledged critical was not released five minutes before now.');
          }
          const c = criticals[0];
          alertDocs.push({
            _id: new Types.ObjectId(),
            title: `Critical: ${def.label} ${c.param} ${c.value} ${c.unit}`.trim(),
            subtitle: `For ${doctor.name} · acknowledge within 15 min`,
            patientName: patient.name,
            uhid: patient.uhid,
            type: 'Lab Alert',
            category: 'Critical',
            priority: 'High',
            status: ackMs === undefined ? 'Pending' : 'Completed',
            dueDateTime: displayDateTime(new Date(clinicMs - (nowMs - releasedAt.getTime()) + 15 * MIN)),
            link: `lab-line:${l._id}`,
            createdAt: releasedAt,
            updatedAt: new Date(ackMs ?? releasedAt.getTime()),
          });
        }
      });
      if (s.amend) {
        const a = s.amend;
        check(a.e, `${s.test} amend enter`);
        check(a.v, `${s.test} amend release`);
        const ms = at(a.v + i * 0.01).getTime();
        defer(ms, () => {
          const aflag = l.rows!.some((r) => r.flag !== 'normal') ? 'abnormal' : 'normal';
          msg('lab.resulted', ms + 200, `${number}: ${def.label} released${aflag === 'normal' ? '' : ` (${aflag})`}`, {
            requestId: String(requestId), lineId: String(l._id), test: s.test, flag: aflag, version: 2, tatDueAt: openAt(ms).length ? earliestTat(openAt(ms)) : l.tatDueAt,
            escalateAt: escalateFor(openAt(ms), ms, l.tatDueAt),
          }, { dedupeKey: `lab.resulted:${l._id}:2` });
        });
      }
    });
    if (doneMs !== undefined) {
      defer(doneMs, () => {
        const id = msg('lab.request-done', doneMs, `${number}: all tests finished`, { requestId: String(requestId) }, { dedupeKey: `lab.request-done:${requestId}:${new Types.ObjectId()}` });
        seen.requestDone = { id, ms: cap(doneMs) };
      });
    }
    steps.sort((a, b) => a.ms - b.ms).forEach((t) => t.run());

    // ---- Clocks --------------------------------------------------------------------------------
    const stopMs = (...candidates: (number | undefined)[]) => {
      const ok = candidates.filter((x): x is number => x !== undefined);
      return ok.length ? Math.min(...ok) : undefined;
    };
    const firstDoneAt = collectionDoneMsgs.length ? Math.min(...collectionDoneMsgs) : undefined;
    const collectStop = stopMs(firstDoneAt, seen.requestDone?.ms);
    addClock({ def: 'lab-collect', case: caseId, ref: String(requestId), startedBy: orderedMsg, startedAt: announcedAt, dueAt: collectBy, ...(collectStop !== undefined ? { stoppedAt: new Date(collectStop) } : {}) });
    for (const r of rejectedMsgs) {
      const next = collectionDoneMsgs.filter((ms) => ms > r.at.getTime());
      const stop = stopMs(next.length ? Math.min(...next) : undefined, seen.requestDone?.ms);
      addClock({ def: 'lab-recollect', case: caseId, ref: String(requestId), startedBy: r.id, startedAt: r.at, dueAt: r.recollectBy, ...(stop !== undefined ? { stoppedAt: new Date(stop) } : {}) });
    }
    if (firstReceivedMs !== undefined && seen.firstReceiveMsg) {
      const open = lb.filter((l) => l.closedMs === undefined);
      addClock({
        def: 'lab-tat', case: caseId, ref: String(requestId), startedBy: seen.firstReceiveMsg, startedAt: new Date(cap(firstReceivedMs + 500)),
        dueAt: escalateFor(open, nowMs, new Date(Math.max(...lb.filter((l) => l.spec.stage !== 'cancelled').map((l) => l.tatDueAt.getTime())))),
        ...(seen.requestDone ? { stoppedAt: new Date(seen.requestDone.ms) } : {}),
      });
    }

    // ---- Documents -----------------------------------------------------------------------------
    const lastTouch = Math.max(orderReal.getTime(), ...messageDocs.filter((m) => String(m.case) === String(caseId) && m.payload?.requestId === String(requestId)).map((m) => (m.createdAt as Date).getTime()));
    lb.forEach((l, i) => {
      const s = l.spec;
      const status = s.stage === 'waiting' ? 'ordered' : s.stage === 'entered' ? 'awaiting-validation' : s.stage;
      const base: Record<string, any> = { _id: l._id, request: requestId, test: s.test, status, tatDueAt: l.tatDueAt, results: [], version: 0, history: [], createdAt: orderReal };
      let updated = orderReal.getTime();
      const sampleOf = orderedSamples.filter((x) => x.tests.includes(s.test)).pop();
      if (sampleOf) updated = Math.max(updated, sampleOf.receivedMs ?? sampleOf.collectedMs ?? 0);
      if (s.stage === 'entered' || s.stage === 'released') {
        const enteredAt = at(enterOff(l, i));
        updated = Math.max(updated, enteredAt.getTime());
        Object.assign(base, { results: l.firstRows, enteredBy: { id: tech.id, name: tech.name }, enteredAt: clinic((spec.t - enterOff(l, i)) * sq) });
      }
      if (s.stage === 'released') {
        const releasedClinic = clinic((spec.t - ((s.v ?? 0) + i * 0.01)) * sq);
        const criticals = l.firstRows!.filter((r) => r.critical);
        const entry = { version: 1, results: l.firstRows, enteredBy: { id: tech.id, name: tech.name }, enteredAt: base.enteredAt, validatedBy: { id: pathologist.id, name: pathologist.name }, releasedAt: releasedClinic };
        Object.assign(base, {
          validatedBy: { id: pathologist.id, name: pathologist.name },
          releasedAt: releasedClinic,
          releasedRealAt: new Date(l.releasedMs!),
          lastReleasedRealAt: new Date(l.releasedMs!),
          version: 1,
          history: [entry],
          critical: criticals.length
            ? {
                active: true,
                ...(s.ackOff !== undefined ? { ackBy: doctor.name, ackById: doctor.id, ackAt: clinic((spec.t - s.ackOff) * sq), ackNote: 'Informed the ward; repeat ordered' } : {}),
              }
            : { active: false },
        });
        updated = Math.max(updated, l.releasedMs!, s.ackOff !== undefined ? at(s.ackOff).getTime() : 0);
        if (s.amend) {
          const a = s.amend;
          const amendEntered = clinic((spec.t - a.e) * sq);
          const amendReleased = clinic((spec.t - (a.v + i * 0.01)) * sq);
          const amendMs = at(a.v + i * 0.01).getTime();
          Object.assign(base, {
            results: l.rows,
            enteredBy: { id: tech.id, name: tech.name },
            enteredAt: amendEntered,
            releasedAt: amendReleased,
            lastReleasedRealAt: new Date(amendMs),
            version: 2,
            history: [entry, { version: 2, results: l.rows, enteredBy: { id: tech.id, name: tech.name }, enteredAt: amendEntered, validatedBy: { id: pathologist.id, name: pathologist.name }, releasedAt: amendReleased, amendReason: a.reason }],
          });
          updated = Math.max(updated, amendMs);
        }
      }
      if (s.stage === 'cancelled') {
        Object.assign(base, { cancelled: { by: doctor.name, reason: s.reason ?? '', at: clinic((spec.t - ((s.cancelAt ?? 0) + i * 0.01)) * sq) } });
        updated = Math.max(updated, l.closedMs!);
      }
      base.updatedAt = new Date(Math.min(nowMs, updated));
      l.doc = base;
      lineDocs.push(base);
      lineUpdatedAt.set(String(l._id), base.updatedAt);
    });
    for (const s of orderedSamples) sampleDocs.push(s.doc);

    const touchedMs = Math.min(nowMs, Math.max(lastTouch, doneMs ?? 0));
    requestDocs.push({
      _id: requestId,
      number,
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: patient.name,
      case: caseId,
      orderedBy: { id: doctor.id, name: doctor.name },
      priority,
      note: spec.note ?? '',
      orderedAt: clinicOff(0),
      collectBy,
      announcedAt,
      ...(collectionDone ? { collectionDoneAt: new Date(cap(lastDoneMs!)) } : {}),
      ...(firstReceivedMs !== undefined ? { firstReceivedAt: new Date(cap(firstReceivedMs)) } : {}),
      ...(doneMs !== undefined ? { doneAt: new Date(cap(doneMs)) } : {}),
      createdAt: orderReal,
      updatedAt: new Date(touchedMs),
    });
  }

  // Cases the requests joined keep their other agents; the new outpatient cases were stamped while building.
  for (const c of caseDocs) c.updatedAt = new Date(Math.min(nowMs, Math.max(touchedCases.get(String(c._id)) ?? 0, (c.createdAt as Date).getTime())));
  const joined = [...new Set([...erCases.values()].map((x) => String(x.case._id)).concat(wardPool.map((c) => String(c._id)).filter((id) => requestDocs.some((r) => String(r.case) === id))))];

  // ---- The week of hourly snapshots, built before anything is written ----------------------------
  const today = {
    ordersToday: requestDocs.filter((r) => r.createdAt.getTime() >= midnight.getTime()).length,
    samplesCollected: sampleDocs.filter((s) => s.collectedRealAt && s.collectedRealAt.getTime() >= midnight.getTime()).length,
    inProcessing: lineDocs.filter((l) => l.status === 'received' || l.status === 'awaiting-validation').length,
    resultsCompleted: lineDocs.filter((l) => l.releasedRealAt && l.releasedRealAt.getTime() >= midnight.getTime()).length,
    criticalResults: lineDocs.filter((l) => l.releasedRealAt && l.releasedRealAt.getTime() >= midnight.getTime() && (l.history as any[]).some((h) => h.results.some((r: LabResultRow) => r.critical))).length,
  };
  const r = rng(26092026);
  const busyAt = (h: number) => Math.max(0.08, Math.sin(((h - 6) / 24) * 2 * Math.PI));
  const cum = (h: number) => Array.from({ length: h + 1 }, (_, k) => busyAt(k)).reduce((a, b) => a + b, 0);
  const lastHour = hourOf(new Date(nowMs)).getTime();
  const hnow = new Date(lastHour).getHours();
  const points = Array.from({ length: 168 }, (_, k) => {
    const i = 167 - k;
    const hour = new Date(lastHour - i * HOUR);
    const h = hour.getHours();
    if (i === 0) return { hour, at: new Date(nowMs), ...today };
    const sameDay = hour.getTime() >= midnight.getTime();
    // Totals grow through the day; an earlier day finishes at its own total.
    const share = sameDay ? cum(h) / cum(hnow) : cum(h) / cum(23);
    const scale = (full: number, jitter: number) => Math.max(0, Math.round(full * share * (1 + (r() - 0.5) * jitter)));
    const dayTotal = (base: number) => (sameDay ? base : Math.round(base * (0.85 + r() * 0.35)));
    return {
      hour,
      at: new Date(Math.min(nowMs, hour.getTime() + 59 * MIN)),
      ordersToday: scale(dayTotal(Math.max(today.ordersToday, 30)), 0.1),
      samplesCollected: scale(dayTotal(Math.max(today.samplesCollected, 45)), 0.1),
      inProcessing: Math.max(2, Math.round(4 + 8 * busyAt(h) + (r() - 0.5) * 4)),
      resultsCompleted: scale(dayTotal(Math.max(today.resultsCompleted, 30)), 0.1),
      criticalResults: scale(dayTotal(Math.max(today.criticalResults, 3)), 0.3),
    };
  });

  // ---- Wipe the previous run, then write ---------------------------------------------------------
  const oldCases = await cases.find({ openedBy: 'lab' }).select('number').lean<any[]>();
  const oldCaseIds = oldCases.map((c) => c._id);
  const oldEscalations = await escalations.find({ ladder: { $in: ['lab', 'lab-critical'] } }).select('_id').lean<any[]>();
  await Promise.all([
    requests.deleteMany({}),
    lines.deleteMany({}),
    samples.deleteMany({}),
    locations.deleteMany({}),
    snapshots.deleteMany({}),
    messages.deleteMany({ $or: [{ from: 'lab' }, { case: { $in: oldCaseIds } }] }),
    clocks.deleteMany({ $or: [{ def: /^lab-/ }, { case: { $in: oldCaseIds } }] }),
    escalations.deleteMany({ ladder: { $in: ['lab', 'lab-critical'] } }),
    // Every lab-line alert, whatever its type: an escalation that found none makes its own.
    alerts.deleteMany({ $or: [{ link: { $in: oldEscalations.map((e) => `escalation:${e._id}`) } }, { link: /^lab-line:/ }] }),
    reports.deleteMany({ labLine: { $exists: true } }),
    cases.deleteMany({ openedBy: 'lab' }),
    timeline.deleteMany({ title: { $in: oldCases.map((c) => `Case ${c.number} opened`) } }),
    counters.deleteMany({ key: /^lab-/ }),
  ]);

  // The titles and ladders the lab escalations use, if the Coordinator seed has not made them; and who holds them.
  for (const t of DEFAULT_TITLES) await titles.updateOne({ key: t.key }, { $setOnInsert: { key: t.key, label: t.label, holders: [] } }, { upsert: true });
  for (const l of DEFAULT_LADDERS) await ladders.updateOne({ key: l.key }, { $setOnInsert: { key: l.key, label: l.label, steps: l.steps } }, { upsert: true });
  for (const [email, titleKey] of [['lab@medios.ai', 'lab-in-charge'], ['doctor@medios.ai', 'duty-doctor']] as const) {
    const u = await users.findOne({ email }).select('_id').lean<any>();
    if (!u) {
      console.log(`Lab seed: no user ${email}; the ${titleKey} title keeps its holders.`);
      continue;
    }
    await titles.updateOne({ key: titleKey }, { $set: { holders: [u._id] } });
  }

  messageDocs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // Mongoose keeps createdAt and updatedAt when they are given, so these times stay as set above.
  if (caseDocs.length) await cases.insertMany(caseDocs);
  await requests.insertMany(requestDocs);
  await lines.insertMany(lineDocs);
  await samples.insertMany(sampleDocs);
  await locations.insertMany(locationDocs);
  await messages.insertMany(messageDocs);
  await clocks.insertMany(clockDocs);
  if (alertDocs.length) await alerts.insertMany(alertDocs);
  if (milestones.length) await timeline.insertMany(milestones);
  await counters.updateOne({ key: 'lab-request' }, { $set: { last: requestDocs.length } }, { upsert: true });
  await counters.updateOne({ key: `lab-sample-${sampleDay}` }, { $set: { last: sampleDocs.length } }, { upsert: true });
  await counters.updateOne({ key: 'case' }, { $set: { last: caseSerial } }, { upsert: true });
  // The Lab agent joined these cases: the Coordinator lists it with their agents.
  await cases.updateMany({ _id: { $in: joined.map((id) => new Types.ObjectId(id)) } }, { $addToSet: { agents: 'lab' } }, { timestamps: false });

  // Every released line has its Lab Report, written by the same writer the service uses. The writer stamps the
  // report and the line with the real moment, so the seed puts the release time back.
  for (const l of lineDocs.filter((x) => x.status === 'released')) {
    const line = await lines.findById(l._id);
    const request = await requests.findById(l.request);
    const def = testByKey(l.test)!;
    const reportId = await writeLabReport(reports as any, lines as any, line as any, request as any, def, l.version);
    const releasedAt = new Date(l.lastReleasedRealAt);
    await reports.updateOne(
      { _id: reportId },
      { $set: { date: displayDate(l.releasedAt), time: displayTime(l.releasedAt), createdAt: releasedAt, updatedAt: releasedAt } },
      // createdAt is immutable unless the update says otherwise.
      { timestamps: false, overwriteImmutable: true },
    );
    await lines.updateOne({ _id: l._id }, { $set: { updatedAt: lineUpdatedAt.get(String(l._id)) } }, { timestamps: false });
  }

  await snapshots.insertMany(points);

  const critical = lineDocs.filter((l) => l.critical?.active).length;
  console.log(`✅ ${requestDocs.length} lab requests, ${sampleDocs.length} samples, ${critical} critical, ${points.length} snapshots`);
}
