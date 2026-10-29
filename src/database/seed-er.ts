import { createHash } from 'node:crypto';
import mongoose, { Model, Schema, Types } from 'mongoose';
import { displayDate, displayTime } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { BedRequest, BedRequestSchema } from '../modules/beds/schemas/bed-request.schema';
import { DEFAULT_LADDERS, DEFAULT_TITLES, NO_HOLDERS } from '../modules/coordinator/escalations.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { erOnTimePct } from '../modules/er/er-coordinator.registration';
import { DEFAULT_BAYS } from '../modules/er/er-bays.service';
import {
  BED_PRIORITY,
  COMPLAINTS,
  ComplaintKey,
  PATHWAYS,
  PathwayKey,
  StepKey,
  TriageColour,
  TriageVitals,
  doctorDueMinutes,
  pathwayTargets,
  pathwaysFor,
  suggestTriage,
} from '../modules/er/er-rules';
import { ErBay, ErBaySchema } from '../modules/er/schemas/er-bay.schema';
import { ErExpected, ErExpectedSchema } from '../modules/er/schemas/er-expected.schema';
import { ErSnapshot, ErSnapshotSchema } from '../modules/er/schemas/er-snapshot.schema';
import { ErDispositionKind, ErMode, ErVisit, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { User, UserRole, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
const HOUR = 60 * MIN;
const CLOSE_REASON = 'ER visit finished';
/** Marks the patients this seed made up, so a rerun removes exactly those. */
const MARKER = 'ER demo patient';
const BED_REQUESTER = 'ER Seed';
/** The department of every patient the seed gives an ER visit. */
const ER_DEPARTMENT = 'General Medicine';
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
type Priority = keyof typeof PRIORITY_RANK;

// ---------------------------------------------------------------------------------------------
// The demo ER day. Times are minutes: `ago` is how long before now the patient arrived, and every
// other number is minutes after arrival. Left visits are the history; open visits are the board.
// ---------------------------------------------------------------------------------------------

const NORMAL: TriageVitals & { bpDiastolic: number } = { spo2: 98, bpSystolic: 122, bpDiastolic: 80, heartRate: 82, respiratoryRate: 16, temperature: 36.8 };

interface Spec {
  key: string;
  ago: number;
  mode: ErMode;
  complaint: ComplaintKey;
  text: string;
  vitals?: TriageVitals & { bpDiastolic?: number };
  pain?: number;
  /** Minutes to triage; none means still waiting for triage. */
  triage?: number;
  /** A later colour change. The first colour is the rules' suggestion. */
  retriage?: { min: number; colour: TriageColour; reason: string };
  /** Non-doctor pathway steps that are done, by minutes after arrival. */
  steps?: Partial<Record<StepKey, number>>;
  /** Minutes until a doctor saw the patient. */
  seen?: number;
  /** The doctor's decision. Everything but `admit` sends the patient out of the ER. */
  disposition?: { kind: ErDispositionKind; min: number };
  bay?: string;
  /** The same patient as an earlier spec (they came back later the same day). */
  reuse?: string;
  /** An unknown person, registered as a placeholder patient. */
  placeholder?: { gender: 'Male' | 'Female'; age: number };
}

const OPEN_SPECS: Spec[] = [
  { key: 'o1', ago: 150, mode: 'walk-in', complaint: 'other', text: 'Sprained ankle after a fall', vitals: NORMAL, pain: 2, triage: 6 },
  { key: 'o2', ago: 85, mode: 'walk-in', complaint: 'abdominal-pain', text: 'Pain in the upper abdomen since morning', vitals: NORMAL, pain: 5, triage: 7, bay: 'Stretcher 1' },
  { key: 'o3', ago: 70, mode: 'walk-in', complaint: 'vomiting-dehydration', text: 'Vomiting since last night, very thirsty', vitals: { ...NORMAL, heartRate: 104 }, triage: 5 },
  // The designed overdue review: orange, 30 minutes to a doctor, now 35 minutes in.
  { key: 'o4', ago: 35, mode: 'walk-in', complaint: 'breathing', text: 'Short of breath since the evening', vitals: { ...NORMAL, spo2: 92, respiratoryRate: 22 }, triage: 4 },
  // Chest pain pathway running, ECG done.
  { key: 'o5', ago: 12, mode: 'walk-in', complaint: 'chest-pain', text: 'Pressure in the chest for an hour', vitals: { ...NORMAL, bpSystolic: 148, bpDiastolic: 92, heartRate: 96 }, pain: 6, triage: 4, steps: { ecg: 8 }, bay: 'Bay 3' },
  // Red chest pain, ECG still to do.
  { key: 'o6', ago: 6, mode: 'ambulance', complaint: 'chest-pain-severe', text: 'Crushing chest pain with sweating', vitals: { spo2: 95, bpSystolic: 96, bpDiastolic: 60, heartRate: 112, respiratoryRate: 22 }, pain: 8, triage: 2, bay: 'Bay 1' },
  { key: 'o7', ago: 3, mode: 'walk-in', complaint: 'head-injury', text: 'Fell from a bike, small cut on the head' },
  { key: 'o8', ago: 5, mode: 'ambulance', complaint: 'unresponsive', text: 'Found unresponsive near the bus stand, brought by ambulance', placeholder: { gender: 'Male', age: 45 } },
  { key: 'o9', ago: 8, mode: 'walk-in', complaint: 'fracture', text: 'Wrist injury after a fall' },
  { key: 'o10', ago: 40, mode: 'ambulance', complaint: 'major-trauma', text: 'Road accident, bleeding from the leg', vitals: { spo2: 93, bpSystolic: 88, bpDiastolic: 54, heartRate: 128, respiratoryRate: 26 }, triage: 2, seen: 8, bay: 'Bay 2' },
  { key: 'o11', ago: 21, mode: 'ambulance', complaint: 'stroke-signs', text: 'Face drooping and slurred speech', vitals: { ...NORMAL, bpSystolic: 168, bpDiastolic: 98 }, triage: 3, steps: { 'last-known-well': 5 }, seen: 9, bay: 'Bay 4' },
  { key: 'o12', ago: 95, mode: 'walk-in', complaint: 'fever', text: 'Fever for two days with body ache', vitals: { ...NORMAL, temperature: 38.4, heartRate: 98 }, triage: 6, seen: 60, bay: 'Stretcher 2' },
  { key: 'o13', ago: 40, mode: 'referred', complaint: 'fever', text: 'Fever with chills, referred from a clinic', vitals: { spo2: 95, bpSystolic: 104, bpDiastolic: 66, heartRate: 118, respiratoryRate: 24, temperature: 39.4 }, triage: 4, steps: { cultures: 30 }, seen: 12, bay: 'Bay 5' },
  { key: 'o14', ago: 130, mode: 'walk-in', complaint: 'other', text: 'Skin rash for two days', vitals: NORMAL, pain: 1, triage: 8, seen: 100, bay: 'Stretcher 3' },
  // Admitted: waiting for a ward bed.
  { key: 'o15', ago: 110, mode: 'walk-in', complaint: 'breathing', text: 'Breathless, needs oxygen', vitals: { ...NORMAL, spo2: 90, respiratoryRate: 24 }, triage: 4, seen: 18, disposition: { kind: 'admit', min: 80 }, bay: 'Bay 6' },
];

const LEFT_SPECS: Spec[] = [
  { key: 'l1', ago: 330, mode: 'walk-in', complaint: 'fracture', text: 'Finger injury in a door', vitals: NORMAL, pain: 5, triage: 6, seen: 50, disposition: { kind: 'home', min: 95 }, reuse: 'o2' },
  { key: 'l2', ago: 300, mode: 'walk-in', complaint: 'other', text: 'Mild headache since morning', vitals: NORMAL, pain: 3, triage: 5, seen: 70, disposition: { kind: 'home', min: 100 }, reuse: 'o3' },
  // The one review that ran late.
  { key: 'l3', ago: 270, mode: 'walk-in', complaint: 'fever', text: 'Fever and sore throat', vitals: { ...NORMAL, temperature: 38.1 }, triage: 7, seen: 130, disposition: { kind: 'home', min: 180 } },
  { key: 'l4', ago: 245, mode: 'walk-in', complaint: 'chest-pain', text: 'Chest tightness after climbing stairs', vitals: { ...NORMAL, heartRate: 90 }, pain: 5, triage: 4, steps: { ecg: 9 }, seen: 13, disposition: { kind: 'home', min: 150 } },
  { key: 'l5', ago: 215, mode: 'walk-in', complaint: 'other', text: 'Insect bite, swelling on the arm', vitals: NORMAL, pain: 2, triage: 8, seen: 90, disposition: { kind: 'home', min: 120 } },
  { key: 'l6', ago: 190, mode: 'ambulance', complaint: 'seizure', text: 'Seizure at home, now drowsy', vitals: { ...NORMAL, heartRate: 108 }, triage: 2, seen: 7, disposition: { kind: 'transfer', min: 70 } },
  { key: 'l7', ago: 170, mode: 'walk-in', complaint: 'vomiting-dehydration', text: 'Vomiting all day', vitals: { ...NORMAL, heartRate: 104 }, triage: 5, retriage: { min: 15, colour: 'orange', reason: 'Persistent vomiting and drowsy' }, seen: 28, disposition: { kind: 'home', min: 120 } },
  { key: 'l8', ago: 150, mode: 'walk-in', complaint: 'other', text: 'Back pain', vitals: NORMAL, pain: 2, triage: 6, disposition: { kind: 'left-against-advice', min: 75 } },
  { key: 'l9', ago: 125, mode: 'walk-in', complaint: 'abdominal-pain', text: 'Stomach cramps after a meal', vitals: NORMAL, pain: 5, triage: 6, seen: 60, disposition: { kind: 'home', min: 100 } },
  { key: 'l10', ago: 105, mode: 'walk-in', complaint: 'other', text: 'Cough for a week', vitals: NORMAL, pain: 1, triage: 6, seen: 40, disposition: { kind: 'home', min: 65 } },
];

/** Made-up people for the patients the demo data has too few of. */
const EXTRA_PEOPLE: { name: string; age: number; gender: 'Male' | 'Female' }[] = [
  { name: 'Karthik Subramanian', age: 41, gender: 'Male' },
  { name: 'Lakshmi Devi', age: 63, gender: 'Female' },
  { name: 'Mohan Raj', age: 52, gender: 'Male' },
  { name: 'Selvi Murugan', age: 36, gender: 'Female' },
  { name: 'Joseph Antony', age: 57, gender: 'Male' },
  { name: 'Fathima Beevi', age: 48, gender: 'Female' },
  { name: 'Ramesh Pillai', age: 69, gender: 'Male' },
  { name: 'Anitha Kumari', age: 27, gender: 'Female' },
  { name: 'Vijay Anand', age: 33, gender: 'Male' },
  { name: 'Revathi Sundaram', age: 44, gender: 'Female' },
  { name: 'Arul Dass', age: 59, gender: 'Male' },
  { name: 'Mary Stella', age: 71, gender: 'Female' },
  { name: 'Prakash Nair', age: 38, gender: 'Male' },
  { name: 'Shanthi Ramesh', age: 54, gender: 'Female' },
  { name: 'Dinesh Kumar', age: 24, gender: 'Male' },
  { name: 'Geetha Priya', age: 31, gender: 'Female' },
  { name: 'Baskaran Iyer', age: 66, gender: 'Male' },
  { name: 'Nirmala Jose', age: 49, gender: 'Female' },
  { name: 'Ganesan Pillai', age: 62, gender: 'Male' },
  { name: 'Hema Latha', age: 39, gender: 'Female' },
  { name: 'Suresh Babu', age: 46, gender: 'Male' },
  { name: 'Jaya Rani', age: 55, gender: 'Female' },
  { name: 'Thomas Varghese', age: 73, gender: 'Male' },
  { name: 'Pushpa Mani', age: 34, gender: 'Female' },
];

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

const stepLabel = (key: StepKey): string => {
  for (const p of Object.values(PATHWAYS)) {
    const s = p.steps.find((x) => x.key === key);
    if (s) return s.label;
  }
  return key;
};
const complaintLabel = (key: string): string => COMPLAINTS.find((c) => c.key === key)?.label ?? key;
const mean = (values: number[]): number | null => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/**
 * Replaces everything the ER agent keeps with a demo day: bays, about 25 visits (15 in the ER, the rest
 * gone home or elsewhere) with the cases, clocks and Coordinator messages the live services would have
 * written, one overdue doctor review with its escalation, one patient waiting for a bed, one placeholder
 * patient, one expected arrival and a week of hourly snapshots. Run after seedCoordinator (which wipes
 * cases, clocks and messages) and seedBeds. Staff-visible times use the clinic clock (`clinicDay`);
 * everything else uses the real clock, placed so nothing is after `nowMs` and no running clock is overdue
 * except the designed one, which ran out five minutes before `nowMs`. `nowMs` is for tests.
 */
export async function seedEr(clinicDay: string, nowMs: number = Date.now()): Promise<void> {
  const visits = model(ErVisit, ErVisitSchema);
  const expected = model(ErExpected, ErExpectedSchema);
  const bays = model(ErBay, ErBaySchema);
  const snapshots = model(ErSnapshot, ErSnapshotSchema);
  const cases = model(Case, CaseSchema);
  const messages = model(AgentMessage, AgentMessageSchema);
  const clocks = model(Clock, ClockSchema);
  const escalations = model(Escalation, EscalationSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const timeline = model(TimelineEvent, TimelineEventSchema);
  const requests = model(BedRequest, BedRequestSchema);
  const patients = model(Patient, PatientSchema);
  const counters = model(CoordinatorCounter, CoordinatorCounterSchema);
  const users = model(User, UserSchema);
  const titles = model(DutyTitle, DutyTitleSchema);
  const ladders = model(Ladder, LadderSchema);

  // Everything that can throw is checked before anything is wiped.
  const person = async (email: string, role: UserRole, fallback: string): Promise<string> =>
    (await users.findOne({ email }).lean<any>())?.name ?? (await users.findOne({ role }).sort({ name: 1 }).lean<any>())?.name ?? fallback;
  const nurse = await person('nurse@medios.ai', UserRole.NURSE, 'ER nurse');
  const doctor = await person('doctor@medios.ai', UserRole.DOCTOR, 'Dr. Shajin');
  const admins = (await users.find({ role: UserRole.ADMIN, isActive: { $ne: false } }).sort({ name: 1 }).select('name').lean<any[]>()).map((u) => u.name as string);

  // The previous run's data, and nothing else, goes.
  const oldCases = await cases.find({ openedBy: 'er' }).select('number').lean<any[]>();
  const oldCaseIds = oldCases.map((c) => c._id);
  const oldEscalations = await escalations.find({ ladder: 'er' }).select('_id').lean<any[]>();
  const wipeTimeline = oldCases.flatMap((c) => [`Case ${c.number} opened`, `Case ${c.number} closed`]);
  await Promise.all([
    visits.deleteMany({}),
    expected.deleteMany({}),
    bays.deleteMany({}),
    snapshots.deleteMany({}),
    messages.deleteMany({ $or: [{ from: 'er' }, { case: { $in: oldCaseIds } }] }),
    clocks.deleteMany({ $or: [{ def: /^er-/ }, { case: { $in: oldCaseIds } }] }),
    escalations.deleteMany({ ladder: 'er' }),
    alerts.deleteMany({ link: { $in: oldEscalations.map((e) => `escalation:${e._id}`) } }),
    cases.deleteMany({ openedBy: 'er' }),
    timeline.deleteMany({ title: { $in: wipeTimeline } }),
    requests.deleteMany({ requestedBy: BED_REQUESTER }),
    patients.deleteMany({ $or: [{ address: MARKER }, { detailsPending: true, name: /^Unknown / }] }),
    counters.deleteMany({ key: 'er' }),
  ]);
  const lastCase = (await cases.find({ number: /^CASE-\d{4,}$/ }).select('number').lean<any[]>()).reduce((max, c) => Math.max(max, Number(String(c.number).slice(5))), 0);
  await counters.updateOne({ key: 'case' }, { $set: { last: lastCase } }, { upsert: true });

  // The titles and ladders this seed's escalation uses, if the Coordinator seed has not made them.
  for (const t of DEFAULT_TITLES) await titles.updateOne({ key: t.key }, { $setOnInsert: { key: t.key, label: t.label, holders: [] } }, { upsert: true });
  // The demo nurse and doctor hold the ER duty titles, so the Staff on duty card and the ladder have people.
  for (const [email, titleKey] of [['nurse@medios.ai', 'er-nurse-in-charge'], ['doctor@medios.ai', 'er-consultant']] as const) {
    const u = await users.findOne({ email }).select('_id').lean<any>();
    if (!u) {
      console.log(`ER seed: no user ${email}; the ${titleKey} title keeps its holders.`);
      continue;
    }
    await titles.updateOne({ key: titleKey }, { $set: { holders: [u._id] } });
  }
  for (const l of DEFAULT_LADDERS) await ladders.updateOne({ key: l.key }, { $setOnInsert: { key: l.key, label: l.label, steps: l.steps } }, { upsert: true });

  // ---- Time -------------------------------------------------------------------------------
  const clinicMs = clinicAt(clinicDay, nowMs);
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  /** The real moment `ago` minutes before now (never after it). */
  const real = (ago: number, plusMs = 0): Date => new Date(Math.min(nowMs, nowMs - ago * MIN + plusMs));
  const clinic = (ago: number): Date => new Date(clinicMs - ago * MIN);
  // Early in the day there is less room for history: squeeze the left visits' day into it.
  const room = (nowMs - midnight.getTime() - 2 * MIN) / MIN;
  const squeeze = Math.min(1, Math.max(0.05, room / 335));
  const specs: Spec[] = [
    ...OPEN_SPECS,
    ...LEFT_SPECS.map((s) => ({
      ...s,
      ago: s.ago * squeeze,
      triage: s.triage !== undefined ? s.triage * squeeze : undefined,
      steps: s.steps ? (Object.fromEntries(Object.entries(s.steps).map(([k, v]) => [k, (v as number) * squeeze])) as Spec['steps']) : undefined,
      seen: s.seen !== undefined ? s.seen * squeeze : undefined,
      retriage: s.retriage ? { ...s.retriage, min: s.retriage.min * squeeze } : undefined,
      disposition: s.disposition ? { ...s.disposition, min: s.disposition.min * squeeze } : undefined,
    })),
  ];

  // ER numbers go by arrival, oldest first.
  const order = [...specs].sort((a, b) => b.ago - a.ago);
  const numberOf = new Map(order.map((s, i) => [s.key, `ER-${String(i + 1).padStart(4, '0')}`]));

  // ---- Patients ---------------------------------------------------------------------------
  const admitted = new Set((await model(Admission, AdmissionSchema).find({ status: 'active' }).select('patient').lean<any[]>()).map((a) => String(a.patient)));
  const busy = new Set([
    ...(await cases.find({ state: 'open' }).select('patient').lean<any[]>()).map((c) => String(c.patient)),
    ...(await requests.find({ open: true }).select('patient').lean<any[]>()).map((r) => String(r.patient)),
  ]);
  // General Medicine patients only: the admit form starts from the patient's department, and an
  // Obstetrics or Paediatrics one would not fit an adult ER admission.
  const demoFree = (await patients.find().sort({ uhid: 1 }).lean<any[]>())
    .filter((p) => !admitted.has(String(p._id)) && !busy.has(String(p._id)) && !p.detailsPending && (p.department ?? ER_DEPARTMENT) === ER_DEPARTMENT)
    .slice(0, 6);

  const needPerson = specs.filter((s) => !s.reuse && !s.placeholder);
  const extrasNeeded = Math.max(0, needPerson.length - demoFree.length);
  if (extrasNeeded > EXTRA_PEOPLE.length) throw new Error('ER seed: not enough made-up people for the visits.');
  const prefix = `MHK${new Date(nowMs).getFullYear()}`;
  const lastUhid = await patients.findOne({ uhid: { $regex: `^${prefix}\\d{5}$` } }).sort({ uhid: -1 }).select('uhid').lean<any>();
  let serial = lastUhid ? Number(String(lastUhid.uhid).slice(prefix.length)) : 0;
  const nextUhid = () => `${prefix}${String(++serial).padStart(5, '0')}`;
  const stamp = { createdAt: new Date(nowMs), updatedAt: new Date(nowMs) };
  const made = await patients.insertMany([
    ...EXTRA_PEOPLE.slice(0, extrasNeeded).map((p, i) => ({ uhid: nextUhid(), name: p.name, age: p.age, gender: p.gender, phone: `90000092${String(i).padStart(2, '0')}`, address: MARKER, doctor: 'Dr. Shajin', department: ER_DEPARTMENT, ...stamp })),
    ...OPEN_SPECS.concat(LEFT_SPECS)
      .filter((s) => s.placeholder)
      .map((s) => ({
        uhid: nextUhid(),
        name: `Unknown ${s.placeholder!.gender === 'Male' ? 'male' : 'female'}, ${numberOf.get(s.key)}`,
        age: s.placeholder!.age,
        gender: s.placeholder!.gender,
        phone: '',
        detailsPending: true,
        department: ER_DEPARTMENT,
        ...stamp,
      })),
  ]);
  const extras = made.filter((p) => p.address === MARKER);
  const placeholders = made.filter((p) => p.detailsPending);
  const pool = [...demoFree, ...extras];
  // The patient waiting for a bed is a man: the demo's one free bed is in the women's ward, so the live Bed Agent leaves the request waiting.
  const waitingAt = needPerson.findIndex((s) => s.disposition?.kind === 'admit');
  const man = pool.findIndex((p, i) => i >= waitingAt && p.gender === 'Male');
  if (waitingAt >= 0 && man > waitingAt) [pool[waitingAt], pool[man]] = [pool[man], pool[waitingAt]];
  else if (waitingAt >= 0 && man < 0) {
    const earlier = pool.findIndex((p, i) => i < waitingAt && p.gender === 'Male');
    if (earlier >= 0) [pool[waitingAt], pool[earlier]] = [pool[earlier], pool[waitingAt]];
  }
  const patientOf = new Map<string, any>();
  needPerson.forEach((s, i) => patientOf.set(s.key, pool[i]));
  specs.filter((s) => s.placeholder).forEach((s, i) => patientOf.set(s.key, placeholders[i]));
  for (const s of specs.filter((x) => x.reuse)) patientOf.set(s.key, patientOf.get(s.reuse!));

  // ---- Case numbers and ids ---------------------------------------------------------------
  const first = (await counters.findOne({ key: 'case' }).lean<any>())?.last ?? 0;
  const caseNumber = new Map(order.map((s, i) => [s.key, `CASE-${String(first + i + 1).padStart(4, '0')}`]));
  const ids = new Map(specs.map((s) => [s.key, { visit: new Types.ObjectId(), case: new Types.ObjectId() }]));

  const bayRows = DEFAULT_BAYS.map((b, order) => ({ _id: new Types.ObjectId(), ...b, order, outOfUse: false, createdAt: new Date(nowMs), updatedAt: new Date(nowMs) }) as Record<string, any>);
  const targets = pathwayTargets();

  // ---- Visits, cases, clocks and messages -------------------------------------------------
  const visitDocs: Record<string, any>[] = [];
  const caseDocs: Record<string, any>[] = [];
  const clockDocs: Record<string, any>[] = [];
  const messageDocs: Record<string, any>[] = [];
  const milestones: Record<string, unknown>[] = [];

  const push = (caseId: Types.ObjectId | null, at: Date, m: Record<string, unknown>): Types.ObjectId => {
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
    return _id;
  };
  const milestone = (uhid: string, at: Date, title: string, subtitle: string) =>
    milestones.push({ uhid, date: displayDate(at), time: displayTime(at), category: 'Emergency', title, subtitle, status: 'Completed' });

  type Clockish = { def: string; case: Types.ObjectId; startedBy: Types.ObjectId; startedAt: Date; dueAt: Date; stoppedAt?: Date; state?: string; escalation?: Types.ObjectId };
  const addClock = (c: Clockish): Types.ObjectId => {
    const _id = new Types.ObjectId();
    const state = c.state ?? (c.stoppedAt ? 'met' : 'running');
    clockDocs.push({
      _id,
      ...c,
      state,
      ...(c.stoppedAt ? { metMinutes: Math.round((c.stoppedAt.getTime() - c.startedAt.getTime()) / MIN) } : {}),
      createdAt: c.startedAt,
      updatedAt: c.stoppedAt ?? c.startedAt,
    });
    return _id;
  };

  let overdue: { caseId: Types.ObjectId; clock: Types.ObjectId; triaged: Types.ObjectId; dueAt: Date; number: string } | undefined;
  let bedWait: { spec: Spec; visit: Record<string, any> } | undefined;
  const lastTouch = new Map<string, number>();

  for (const spec of order) {
    const { visit: visitId, case: caseId } = ids.get(spec.key)!;
    const patient = patientOf.get(spec.key);
    const number = numberOf.get(spec.key)!;
    const caseNo = caseNumber.get(spec.key)!;
    const A = spec.ago;
    const after = (min: number, plusMs = 0) => real(A - min, plusMs);
    const clinicAfter = (min: number) => clinic(A - min);
    const label = complaintLabel(spec.complaint);
    const vitals = spec.vitals ?? {};

    // Arrival and the case that opens with it.
    const arrivedReal = after(0);
    const createdAt = arrivedReal;
    let touched = arrivedReal.getTime();
    const note = (d: Date) => (touched = Math.max(touched, d.getTime()));
    const isLeft = !!spec.disposition && spec.disposition.kind !== 'admit';
    const waitingBed = spec.disposition?.kind === 'admit';

    // Triage, as the service works it out.
    const suggestion = spec.triage !== undefined ? suggestTriage({ complaint: spec.complaint, vitals, painScore: spec.pain }) : undefined;
    const firstColour = suggestion?.colour;
    const colour = spec.retriage?.colour ?? firstColour;
    const started: PathwayKey[] = spec.triage !== undefined ? pathwaysFor(spec.complaint, vitals) : [];
    const doctorDueAt = (c: TriageColour, running: PathwayKey[]) => new Date(createdAt.getTime() + doctorDueMinutes(c, running, targets) * MIN);
    const colourPriority = colour ? BED_PRIORITY[colour] : 'medium';
    const casePriority: Priority = colourPriority && PRIORITY_RANK[colourPriority] < PRIORITY_RANK.medium ? colourPriority : 'medium';
    const priorityNow = waitingBed ? ('high' as Priority) : casePriority;

    const steps: { key: StepKey; doneAt?: Date; byName?: string }[] = [];
    for (const p of started) for (const s of PATHWAYS[p].steps) if (!steps.some((x) => x.key === s.key)) steps.push({ key: s.key });
    for (const [key, min] of Object.entries(spec.steps ?? {})) {
      const st = steps.find((x) => x.key === key);
      if (st) Object.assign(st, { doneAt: clinicAfter(min as number), byName: nurse });
    }
    if (spec.seen !== undefined) {
      const st = steps.find((x) => x.key === 'doctor');
      if (st) Object.assign(st, { doneAt: clinicAfter(spec.seen), byName: doctor });
    }

    push(caseId, after(0, -2000), { from: 'coordinator', type: 'case.opened', priority: 'medium', summary: `${caseNo} opened for ${patient.uhid}` });
    milestone(patient.uhid, clinicAfter(0), `Case ${caseNo} opened`, 'Opened by the er agent');
    const arrived = push(caseId, after(0, 1000), {
      from: 'er',
      type: 'er.arrived',
      priority: 'medium',
      summary: `${number} arrived: ${label} (${spec.mode})`,
      payload: { visitId: String(visitId), visitNumber: number, complaint: label },
    });
    const announcedAt = after(0, 1000);
    note(announcedAt);

    let triagedMsg: Types.ObjectId | undefined;
    let triageAt: Date | undefined;
    if (spec.triage !== undefined && colour && firstColour) {
      triageAt = after(spec.triage, 1000);
      note(triageAt);
      triagedMsg = push(caseId, triageAt, {
        from: 'er',
        type: 'er.triaged',
        priority: BED_PRIORITY[firstColour],
        summary: `${number} triaged ${firstColour}: ${label}`,
        payload: { visitId: String(visitId), colour: firstColour, doctorDueAt: doctorDueAt(firstColour, started) },
      });
      addClock({ def: 'er-triage', case: caseId, startedBy: arrived, startedAt: announcedAt, dueAt: new Date(createdAt.getTime() + 10 * MIN), stoppedAt: triageAt });
    } else {
      addClock({ def: 'er-triage', case: caseId, startedBy: arrived, startedAt: announcedAt, dueAt: new Date(createdAt.getTime() + 10 * MIN) });
    }

    const pathwayMsgs = new Map<PathwayKey, { id: Types.ObjectId; at: Date }>();
    started.forEach((p, idx) => {
      const at = after(spec.triage!, 3000);
      const stepDue = Object.fromEntries(PATHWAYS[p].steps.filter((s) => s.key !== 'doctor').map((s) => [s.key, new Date(createdAt.getTime() + s.defaultMin * MIN)]));
      const id = push(caseId, at, {
        from: 'er',
        type: 'er.pathway-started',
        priority: BED_PRIORITY[firstColour!],
        summary: `${number} ${firstColour}: ${PATHWAYS[p].label} pathway started`,
        payload: { visitId: String(visitId), pathway: p, stepDue, doctorDueAt: doctorDueAt(firstColour!, started) },
        dedupeKey: `er.pathway-started:${visitId}:${idx}`,
      });
      pathwayMsgs.set(p, { id, at });
      note(at);
    });

    if (spec.retriage && firstColour) {
      const at = after(spec.retriage.min, 1000);
      note(at);
      push(caseId, at, {
        from: 'er',
        type: 'er.retriaged',
        priority: BED_PRIORITY[spec.retriage.colour],
        summary: `${number} re-triaged ${firstColour} to ${spec.retriage.colour}: ${label}`,
        payload: { visitId: String(visitId), colour: spec.retriage.colour, doctorDueAt: doctorDueAt(spec.retriage.colour, started) },
        dedupeKey: `er.retriaged:${visitId}:2`,
      });
    }

    for (const [key, min] of Object.entries(spec.steps ?? {}) as [StepKey, number][]) {
      const at = after(min, 1000);
      note(at);
      push(caseId, at, {
        from: 'er',
        type: 'er.step-done',
        priority: BED_PRIORITY[colour!],
        summary: `${number} ${colour}: ${stepLabel(key)}`,
        payload: { visitId: String(visitId), step: key },
      });
    }
    // One clock per non-doctor step: stopped when the step was done, running while it is not.
    for (const p of started) {
      const msg = pathwayMsgs.get(p)!;
      for (const s of PATHWAYS[p].steps.filter((x) => x.key !== 'doctor')) {
        const doneMin = (spec.steps as Record<string, number> | undefined)?.[s.key];
        addClock({
          def: `er-step-${s.key}`,
          case: caseId,
          startedBy: msg.id,
          startedAt: msg.at,
          dueAt: new Date(createdAt.getTime() + s.defaultMin * MIN),
          ...(doneMin !== undefined ? { stoppedAt: after(doneMin, 1000) } : {}),
        });
      }
    }

    let seenAt: Date | undefined;
    if (spec.seen !== undefined) {
      seenAt = after(spec.seen, 1000);
      note(seenAt);
      push(caseId, seenAt, { from: 'er', type: 'er.doctor-seen', priority: BED_PRIORITY[colour!], summary: `${number} ${colour}: seen by a doctor`, payload: { visitId: String(visitId) } });
    }

    let dispositionAt: Date | undefined;
    if (spec.disposition) {
      dispositionAt = after(spec.disposition.min, 1000);
      note(dispositionAt);
      push(caseId, dispositionAt, {
        from: 'er',
        type: 'er.disposition',
        priority: colour ? BED_PRIORITY[colour] : 'medium',
        summary: `${number}: decision is ${spec.disposition.kind}`,
        payload: { visitId: String(visitId), kind: spec.disposition.kind },
        dedupeKey: `er.disposition:${visitId}:${spec.disposition.kind}`,
      });
    }
    let leftReal: Date | undefined;
    if (isLeft) {
      leftReal = after(spec.disposition!.min, 2000);
      note(leftReal);
      push(caseId, leftReal, {
        from: 'er',
        type: 'er.left',
        priority: 'medium',
        summary: `${number} left the ER (${spec.disposition!.kind})`,
        payload: { visitId: String(visitId), reason: spec.disposition!.kind },
        dedupeKey: `er.left:${visitId}`,
      });
    }

    // The doctor review clock: it starts at triage and moves with the colour and pathways.
    if (triagedMsg && triageAt && colour) {
      const dueAt = doctorDueAt(colour, started);
      const stoppedAt = seenAt ?? leftReal;
      const clockId = addClock({ def: 'er-doctor', case: caseId, startedBy: triagedMsg, startedAt: triageAt, dueAt, ...(stoppedAt ? { stoppedAt } : {}) });
      if (!stoppedAt && dueAt.getTime() <= nowMs) overdue = { caseId, clock: clockId, triaged: triagedMsg, dueAt, number };
    }

    // The case: closed when the patient went home; open while they are in the ER or waiting for a bed.
    let closedAtClinic: Date | undefined;
    if (isLeft) {
      closedAtClinic = clinicAfter(spec.disposition!.min);
      push(caseId, after(spec.disposition!.min, 3000), { from: 'coordinator', type: 'case.closed', priority: casePriority, summary: `${caseNo} closed: ${CLOSE_REASON}` });
      note(after(spec.disposition!.min, 3000));
      milestone(patient.uhid, closedAtClinic, `Case ${caseNo} closed`, CLOSE_REASON);
    }
    caseDocs.push({
      _id: caseId,
      number: caseNo,
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: patient.name,
      kind: waitingBed ? 'ipd' : 'er',
      priority: priorityNow,
      state: isLeft ? 'closed' : 'open',
      openedAt: clinicAfter(0),
      ...(isLeft ? { closedAt: closedAtClinic, closedReason: CLOSE_REASON } : {}),
      agents: waitingBed ? ['er', 'bed'] : ['er'],
      refs: { bedRequestIds: [] as string[] },
      openedBy: 'er',
      createdAt: after(0, -2000),
      updatedAt: new Date(touched),
    });

    const triage = spec.triage !== undefined && suggestion && firstColour && colour
      ? {
          suggested: suggestion.colour,
          reasons: suggestion.reasons,
          colour,
          byName: nurse,
          at: clinicAfter(spec.triage),
          history: [
            { colour: firstColour, byName: nurse, at: clinicAfter(spec.triage), kind: 'triage' },
            ...(spec.retriage ? [{ colour: spec.retriage.colour, byName: nurse, at: clinicAfter(spec.retriage.min), reason: spec.retriage.reason, kind: 'retriage' }] : []),
          ],
        }
      : undefined;
    const bay = spec.bay ? bayRows.find((b) => b.name === spec.bay) : undefined;
    if (bay) bay.visit = visitId;
    const status = isLeft ? 'left' : waitingBed ? 'waiting-bed' : !triage ? 'waiting-triage' : seenAt ? 'in-treatment' : 'waiting-doctor';
    const visit: Record<string, any> = {
      _id: visitId,
      number,
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: patient.name,
      mode: spec.mode,
      complaint: spec.complaint,
      complaintText: spec.text,
      arrivedAt: clinicAfter(0),
      ...(triage ? { triage } : {}),
      ...(Object.keys(vitals).length ? { vitals } : {}),
      ...(spec.pain !== undefined ? { painScore: spec.pain } : {}),
      ...(bay ? { bay: bay._id, bayName: bay.name } : {}),
      status,
      pathways: started.map((key) => ({ key, startedBy: 'rules' })),
      steps,
      ...(seenAt ? { doctorSeenAt: clinicAfter(spec.seen!), doctorSeenByName: doctor } : {}),
      ...(spec.disposition ? { disposition: { kind: spec.disposition.kind, byName: doctor, at: clinicAfter(spec.disposition.min), notes: '' } } : {}),
      ...(isLeft ? { leftAt: clinicAfter(spec.disposition!.min), leftReason: spec.disposition!.kind, leftAnnouncedAt: leftReal } : {}),
      announcedAt,
      ...(triageAt ? { triageAnnouncedAt: triageAt } : {}),
      case: caseId,
      createdAt,
      updatedAt: new Date(touched),
    };
    visitDocs.push(visit);
    lastTouch.set(spec.key, touched);
    if (waitingBed) bedWait = { spec, visit };
  }

  // ---- The patient waiting for a bed: a Bed Agent request on the same case ---------------------
  const wb = bedWait!;
  const wbCase = caseDocs.find((c) => String(c._id) === String(wb.visit.case))!;
  const wbPatient = patientOf.get(wb.spec.key);
  const requestedAgo = wb.spec.ago - wb.spec.disposition!.min - 1;
  const [request] = await requests.insertMany([
    {
      type: 'admission',
      patient: wbPatient._id,
      patientName: wbPatient.name,
      patientUhid: wbPatient.uhid,
      patientAge: wbPatient.age,
      patientGender: wbPatient.gender,
      stepDown: false,
      roomClass: 'icu',
      needs: ['oxygen', 'monitor', 'ventilator'],
      notes: 'Breathless, SpO2 90 on arrival. Needs oxygen and a ventilator bed.',
      department: 'General Medicine',
      doctor,
      expectedStayDays: 3,
      priority: 'high',
      priorityRank: PRIORITY_RANK.high,
      state: 'waiting',
      stateReason: 'No free bed has what this patient needs yet.',
      open: true,
      attempts: 0,
      requestedBy: BED_REQUESTER,
      requestedByName: doctor,
      requestedAt: clinic(requestedAgo),
      stateSince: clinic(requestedAgo - 1),
    },
  ]);
  wbCase.refs.bedRequestIds.push(String(request._id));
  const wbCaseId = wbCase._id as Types.ObjectId;
  push(wbCaseId, real(requestedAgo), {
    from: 'bed',
    type: 'bed.request',
    priority: 'high',
    summary: `${wbPatient.uhid}: admission bed requested (high)`,
    payload: { requestId: String(request._id), requestType: 'admission', priority: 'high' },
    opensWork: true,
  });
  const waitingMsg = push(wbCaseId, real(requestedAgo - 1), {
    from: 'bed',
    type: 'bed.waiting',
    priority: 'high',
    summary: `${wbPatient.uhid} is waiting for a bed`,
    payload: { requestId: String(request._id) },
  });
  addClock({ def: 'bed-wait', case: wbCaseId, startedBy: waitingMsg, startedAt: real(requestedAgo - 1), dueAt: new Date(real(requestedAgo - 1).getTime() + 60 * MIN) });
  wbCase.updatedAt = real(requestedAgo - 1);

  // ---- The designed overdue review: expired clock, escalation, alert ---------------------------
  const od = overdue;
  if (!od) throw new Error('ER seed: the overdue review was not built.');
  const escalationId = new Types.ObjectId();
  const alertId = new Types.ObjectId();
  const expiredAt = new Date(nowMs - 5 * MIN);
  if (Math.abs(od.dueAt.getTime() - expiredAt.getTime()) > MIN) throw new Error('ER seed: the overdue review is not five minutes late.');
  const clock = clockDocs.find((c) => String(c._id) === String(od.clock))!;
  Object.assign(clock, { state: 'expired', dueAt: expiredAt, escalation: escalationId, updatedAt: expiredAt });
  const nurseTitle = DEFAULT_TITLES.find((t) => t.key === 'er-nurse-in-charge')!;
  const holders = ((await titles.findOne({ key: nurseTitle.key }).lean<any>())?.holders ?? []) as unknown[];
  const holderNames = holders.length ? (await users.find({ _id: { $in: holders }, isActive: { $ne: false } }).sort({ name: 1 }).select('name').lean<any[]>()).map((u) => u.name as string) : admins;
  const reason = 'Doctor review overdue';
  const text = `Escalated to ${nurseTitle.label}: ${reason}`;
  push(od.caseId, expiredAt, {
    from: 'coordinator',
    type: 'clock.expired',
    priority: 'high',
    summary: reason,
    payload: { clockKey: 'er-doctor' },
    causedBy: od.triaged,
    dedupeKey: `clock.expired:${od.clock}`,
  });
  push(od.caseId, new Date(expiredAt.getTime() + 1000), {
    from: 'coordinator',
    type: 'escalation.raised',
    priority: 'high',
    summary: text.slice(0, 140),
    payload: { reason },
    dedupeKey: `escalation.raised:${escalationId}`,
  });
  await alerts.create({
    _id: alertId,
    title: text,
    subtitle: holders.length ? `On duty: ${holderNames.join(', ')}` : NO_HOLDERS,
    type: 'System',
    category: 'Critical',
    priority: 'High',
    status: 'Pending',
    link: `escalation:${escalationId}`,
    escalation: { id: String(escalationId), ladder: 'er', step: 0, titleKey: nurseTitle.key, titleLabel: nurseTitle.label, holderNames },
  });
  await escalations.create({
    _id: escalationId,
    case: od.caseId,
    ladder: 'er',
    step: 0,
    reason,
    source: { kind: 'clock', id: String(od.clock) },
    state: 'open',
    alert: alertId,
    raisedAt: expiredAt,
    stepAt: expiredAt,
    createdAt: expiredAt,
    updatedAt: expiredAt,
  });
  const odCase = caseDocs.find((c) => String(c._id) === String(od.caseId))!;
  odCase.updatedAt = new Date(expiredAt.getTime() + 1000);
  const odVisit = visitDocs.find((v) => String(v.case) === String(od.caseId))!;
  odVisit.updatedAt = new Date(Math.max(odVisit.updatedAt.getTime(), expiredAt.getTime() + 1000));

  // ---- The expected arrival ----------------------------------------------------------------
  const [expectedCard] = await expected.insertMany([
    { complaint: 'Chest pain with sweating', ageSex: '58 M', mode: 'ambulance', etaMinutes: 6, expectedAt: new Date(clinicMs + 6 * MIN), state: 'waiting', byName: nurse, createdAt: real(0), updatedAt: real(0) },
  ]);
  push(null, real(0), {
    from: 'er',
    type: 'er.expected',
    priority: 'medium',
    summary: 'Expected in about 6 min (ambulance)',
    payload: { expectedId: String(expectedCard._id) },
  });

  // ---- Write everything --------------------------------------------------------------------
  messageDocs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  // Mongoose keeps createdAt and updatedAt when they are given, so these times stay as set above.
  await visits.insertMany(visitDocs);
  await bays.insertMany(bayRows);
  await cases.insertMany(caseDocs);
  await clocks.insertMany(clockDocs);
  await messages.insertMany(messageDocs);
  await timeline.insertMany(milestones);
  await counters.updateOne({ key: 'er' }, { $set: { last: specs.length } }, { upsert: true });
  await counters.updateOne({ key: 'case' }, { $set: { last: first + specs.length } }, { upsert: true });

  // ---- A week of hourly snapshots, ending with the current hour ---------------------------------
  const today = visitDocs.filter((v) => v.createdAt.getTime() >= midnight.getTime());
  const open = visitDocs.filter((v) => v.status !== 'left');
  const avgTriageNow = mean(today.filter((v) => v.triage).map((v) => (v.triage.at.getTime() - v.arrivedAt.getTime()) / MIN));
  const onTimeNow = await erOnTimePct(clocks as any, visits as any, midnight);
  const r = rng(26092026);
  const last = hourOf(new Date(nowMs)).getTime();
  const points = Array.from({ length: 168 }, (_, k) => {
    const i = 167 - k;
    const hour = new Date(last - i * HOUR);
    const h = hour.getHours();
    const current = i === 0;
    // Busier from late morning to evening, quiet overnight.
    const busy = Math.max(0, Math.sin(((h - 7) / 24) * 2 * Math.PI));
    const patientsInEr = current ? open.length : Math.max(2, Math.round(5 + 11 * busy + (r() - 0.5) * 4));
    const critical = current ? open.filter((v) => v.triage?.colour === 'red').length : Math.min(patientsInEr, Math.max(0, Math.round(0.5 + 2 * busy + (r() - 0.5) * 2)));
    const avgTriageMin = current ? avgTriageNow : Math.round((4 + 4 * busy + (r() - 0.5) * 3) * 10) / 10;
    const onTimePct = current ? onTimeNow : Math.round(90 - 16 * busy + (r() - 0.5) * 8);
    return { hour, at: new Date(Math.min(nowMs, hour.getTime() + 59 * MIN)), patientsInEr, critical, avgTriageMin: avgTriageMin === null ? null : Math.round(avgTriageMin), onTimePct };
  });
  await snapshots.insertMany(points);

  console.log(`✅ ${visitDocs.length} ER visits, ${open.length} in the ER, 1 expected, ${points.length} snapshots`);
}
