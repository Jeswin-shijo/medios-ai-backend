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
import { flagValue, rangeText, testByKey } from '../modules/lab/lab-catalogue';
import { templateSummary } from '../modules/lab/lab-ai';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import {
  Frequency,
  MEDICINES,
  MedicineDef,
  ProductDef,
  STORE_LABEL,
  Store,
  medicineByKey,
  pickProduct,
  productByKey,
  quantityFor,
  routeFor,
} from '../modules/pharmacy/pharmacy-catalogue';
import { PHARMACY_CLOCKS } from '../modules/pharmacy/pharmacy-coordinator.registration';
import { PharmacyPatientsService, PatientFactsView } from '../modules/pharmacy/pharmacy-patients.service';
import { PHARMACY_AGENT } from '../modules/pharmacy/pharmacy-queries.service';
import { CASE_PRIORITY, LineMessageType, lineSummary, medicineLabel, orderSummary } from '../modules/pharmacy/pharmacy-rounds';
import { CheckLine, Flag, checkLine, egfr } from '../modules/pharmacy/pharmacy-rules';
import { DEFAULT_TARGETS } from '../modules/pharmacy/pharmacy-settings.service';
import { prescriptionLine } from '../modules/pharmacy/pharmacy-prescriptions.service';
import { PharmacyBatch, PharmacyBatchSchema } from '../modules/pharmacy/schemas/pharmacy-batch.schema';
import { PharmacyLine, PharmacyLineSchema, QueryKind } from '../modules/pharmacy/schemas/pharmacy-line.schema';
import { PharmacyLocation, PharmacyLocationSchema } from '../modules/pharmacy/schemas/pharmacy-location.schema';
import { PharmacyMovement, PharmacyMovementSchema } from '../modules/pharmacy/schemas/pharmacy-movement.schema';
import { PharmacyOrder, PharmacyOrderSchema } from '../modules/pharmacy/schemas/pharmacy-order.schema';
import { PharmacySnapshot, PharmacySnapshotSchema } from '../modules/pharmacy/schemas/pharmacy-snapshot.schema';
import { PharmacyStockLevel, PharmacyStockLevelSchema } from '../modules/pharmacy/schemas/pharmacy-stock-level.schema';
import { Prescription, PrescriptionSchema } from '../modules/prescriptions/schemas/prescription.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { User, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SUMMARY_MAX = 140;
/** Marks the made-up Patient records of this seed (never a demo patient). */
const PHARMACY_MARK = 'Seed: pharmacy demo';
const CLOSE_NOTE = 'Opened by the pharmacy agent';
/** Marks the prescriptions this seed makes, so a rerun clears them and nothing else. */
export const PHARMACY_DEMO_RX = 'Pharmacy demo';
const ALLERGY_REASON = 'Reaction was mild; the doctor confirmed it';
const REVIEW_REASON = 'Checked and acceptable';

type Pri = 'stat' | 'urgent' | 'routine';
type Area = 'ER' | 'Ward' | 'OPD';
type LState = 'check' | 'approved' | 'issued' | 'query' | 'rejected' | 'cancelled' | 'stopped';

// ---------------------------------------------------------------------------------------------
// The demo pharmacy day. `t` is how long ago an order was made (minutes); every other number is
// minutes after the order. Orders sit on the cases the ER, Bed, Coordinator and Lab seeds made.
// ---------------------------------------------------------------------------------------------

interface QSpec {
  kind: QueryKind;
  by: 'agent' | 'pharm';
  /** Minutes after the order. */
  at: number;
  /** The pharmacist's own words (the agent's questions are worked out). */
  question?: string;
  ans?: { outcome: 'keep' | 'stop'; at: number; reason: string };
}

interface LS {
  med: string;
  dose: number;
  route?: string;
  freq: Frequency;
  days?: number;
  state: LState;
  /** Approved, rejected or cancelled this long after the order. */
  a?: number;
  /** Issued this long after the order. */
  i?: number;
  store?: Store;
  q?: QSpec;
  reason?: string;
  /** The Pharmacy Agent held this line for an allergy a doctor has not confirmed. */
  holdAllergy?: boolean;
}

interface RxItem {
  medicine: string;
  dose: string;
  frequency: string;
  duration: string;
  indication: string;
  state: 'approved' | 'check';
  a?: number;
}

interface OS {
  key: string;
  area: Area;
  /** ER: text in the visit's complaint. Ward: 'pen' for the penicillin patient, else the n-th other ward case. OPD: the n-th counter patient. */
  who: RegExp | 'pen' | 'k1' | 'k2' | number;
  pri: Pri;
  t: number;
  note?: string;
  lines?: LS[];
  /** A prescription order: `fixture` is the existing one; its items are listed in the prescription's order. */
  rx?: { fixture?: boolean; items: RxItem[] };
  /** The eGFR this order's patient has: the seed stores a released Kidney function report whose creatinine gives it. */
  egfr?: number;
}

const L = (med: string, dose: number, freq: Frequency, state: LState, extra: Partial<LS> = {}): LS => ({ med, dose, freq, state, ...extra });

const ER_ORDERS: OS[] = [
  {
    key: 'e1', area: 'ER', who: /Pressure in the chest/, pri: 'stat', t: 8, note: 'Chest pain, rule out a heart attack',
    lines: [
      L('aspirin', 300, 'STAT', 'issued', { a: 1, i: 3 }),
      L('clopidogrel', 300, 'STAT', 'issued', { a: 1.2, i: 3.4 }),
      L('atorvastatin', 80, 'OD', 'approved', { days: 1, a: 1.6 }),
      L('isosorbide-dinitrate', 5, 'STAT', 'issued', { route: 'sublingual', a: 1.4, i: 4 }),
      L('enoxaparin', 60, 'BD', 'check', { route: 'sc', days: 5 }),
    ],
  },
  // An approved ticagrelor line: the ER store has none, the Main pharmacy has some.
  { key: 'e2', area: 'ER', who: /Crushing chest pain/, pri: 'stat', t: 4, lines: [L('aspirin', 300, 'STAT', 'issued', { a: 1, i: 2.5 }), L('ticagrelor', 180, 'STAT', 'approved', { a: 1.4 })] },
  {
    key: 'e3', area: 'ER', who: /Road accident/, pri: 'urgent', t: 28,
    lines: [
      L('morphine', 10, 'STAT', 'issued', { route: 'iv', a: 2, i: 4 }),
      L('ceftriaxone', 1, 'STAT', 'issued', { route: 'iv', a: 3, i: 8 }),
      L('normal-saline', 500, 'STAT', 'issued', { route: 'iv', a: 2.5, i: 6 }),
      L('paracetamol', 1000, 'STAT', 'approved', { route: 'iv', a: 20 }),
    ],
  },
  { key: 'e4', area: 'ER', who: /Short of breath/, pri: 'urgent', t: 22, lines: [L('salbutamol', 5, 'STAT', 'issued', { route: 'inhaled', a: 1.5, i: 3.5 }), L('hydrocortisone', 100, 'STAT', 'check', { route: 'iv' })] },
  {
    key: 'e5', area: 'ER', who: /Breathless, needs oxygen/, pri: 'urgent', t: 95,
    lines: [
      L('furosemide', 40, 'STAT', 'issued', { route: 'iv', a: 5, i: 12 }),
      L('diclofenac', 75, 'STAT', 'rejected', { route: 'im', a: 6, reason: 'An NSAID is not suitable: breathless with a suspected weak heart' }),
    ],
  },
  {
    key: 'e6', area: 'ER', who: /Fever with chills/, pri: 'stat', t: 34, note: 'Suspected sepsis',
    lines: [
      L('ceftriaxone', 2, 'STAT', 'issued', { route: 'iv', a: 2, i: 5 }),
      L('normal-saline', 500, 'STAT', 'issued', { route: 'iv', a: 2.2, i: 7 }),
      L('paracetamol', 1000, 'STAT', 'issued', { route: 'iv', a: 3, i: 9 }),
    ],
  },
  { key: 'e7', area: 'ER', who: /upper abdomen/, pri: 'urgent', t: 70, lines: [L('pantoprazole', 40, 'STAT', 'issued', { route: 'iv', a: 5, i: 15 }), L('ondansetron', 4, 'STAT', 'approved', { route: 'iv', a: 30 })] },
  { key: 'e8', area: 'ER', who: /Sprained ankle/, pri: 'routine', t: 100, lines: [L('paracetamol', 500, 'TDS', 'issued', { days: 3, a: 10, i: 40, store: 'er' })] },
];

const WARD_ORDERS: OS[] = [
  {
    key: 'w1', area: 'Ward', who: 'pen', pri: 'urgent', t: 12,
    lines: [
      L('amoxicillin-clavulanate', 625, 'TDS', 'query', { days: 5, holdAllergy: true, q: { kind: 'allergy', by: 'agent', at: 2 } }),
      L('paracetamol', 650, 'TDS', 'approved', { days: 3, a: 3 }),
    ],
  },
  {
    key: 'w2', area: 'Ward', who: 'k1', pri: 'routine', t: 200, egfr: 26,
    lines: [
      L('enoxaparin', 40, 'OD', 'issued', { route: 'sc', days: 5, a: 10, i: 30, q: { kind: 'kidney', by: 'agent', at: 60, ans: { outcome: 'keep', at: 75, reason: 'Already once daily; renal dose reviewed with the ward doctor' } } }),
      L('ramipril', 5, 'OD', 'issued', { days: 30, a: 11, i: 31 }),
      L('amlodipine', 5, 'OD', 'issued', { days: 30, a: 12, i: 32 }),
    ],
  },
  { key: 'w3', area: 'Ward', who: 1, pri: 'urgent', t: 40, lines: [L('ceftriaxone', 1, 'OD', 'approved', { route: 'iv', days: 5, a: 10 }), L('pantoprazole', 40, 'OD', 'check', { days: 5 })] },
  { key: 'w4', area: 'Ward', who: 2, pri: 'routine', t: 150, lines: [L('metformin', 500, 'BD', 'approved', { days: 30, a: 20 }), L('glimepiride', 1, 'OD', 'check', { days: 30 })] },
  { key: 'w5', area: 'Ward', who: 3, pri: 'routine', t: 70, lines: [L('paracetamol', 650, 'TDS', 'issued', { days: 3, a: 10, i: 25 }), L('ondansetron', 4, 'BD', 'approved', { days: 2, a: 12 })] },
  {
    key: 'w6', area: 'Ward', who: 4, pri: 'stat', t: 9,
    lines: [
      L('insulin-regular', 10, 'STAT', 'approved', { route: 'sc', a: 2 }),
      L('potassium-chloride', 40, 'STAT', 'query', { route: 'iv', q: { kind: 'dose', by: 'pharm', at: 3, question: 'Please confirm the potassium dose and the rate of the drip.' } }),
    ],
  },
  {
    key: 'w7', area: 'Ward', who: 5, pri: 'urgent', t: 26,
    lines: [
      L('warfarin', 5, 'OD', 'check', { days: 30 }),
      L('metronidazole', 400, 'TDS', 'query', { days: 5, q: { kind: 'clash', by: 'pharm', at: 7, question: 'Metronidazole raises the INR sharply with warfarin. Is this intended?' } }),
    ],
  },
  {
    key: 'w8', area: 'Ward', who: 'k2', pri: 'routine', t: 100, egfr: 27,
    lines: [
      L('metformin', 500, 'BD', 'stopped', { days: 30, a: 10, i: 25, q: { kind: 'kidney', by: 'agent', at: 55, ans: { outcome: 'stop', at: 70, reason: 'eGFR 27: metformin stopped, insulin to be reviewed' } } }),
      L('amlodipine', 5, 'OD', 'issued', { days: 30, a: 11, i: 26 }),
    ],
  },
];

const OPD_ORDERS: OS[] = [
  {
    key: 'x1', area: 'OPD', who: -1, pri: 'routine', t: 75,
    rx: {
      fixture: true,
      items: [
        { medicine: '', dose: '', frequency: '', duration: '', indication: '', state: 'approved', a: 15 },
        { medicine: '', dose: '', frequency: '', duration: '', indication: '', state: 'check' },
        { medicine: '', dose: '', frequency: '', duration: '', indication: '', state: 'approved', a: 16 },
        { medicine: '', dose: '', frequency: '', duration: '', indication: '', state: 'approved', a: 17 },
        { medicine: '', dose: '', frequency: '', duration: '', indication: '', state: 'check' },
      ],
    },
  },
  {
    key: 'x2', area: 'OPD', who: 3, pri: 'routine', t: 40,
    rx: {
      items: [
        { medicine: 'Tab Paracetamol 650 mg', dose: '650 mg', frequency: 'TDS', duration: '3 days', indication: 'Fever', state: 'approved', a: 10 },
        { medicine: 'Tab Cetirizine 10 mg', dose: '10 mg', frequency: 'HS', duration: '5 days', indication: 'Allergic rhinitis', state: 'approved', a: 11 },
      ],
    },
  },
  {
    key: 'x3', area: 'OPD', who: 0, pri: 'routine', t: 95,
    rx: {
      items: [
        { medicine: 'Cap Amoxicillin 500 mg', dose: '500 mg', frequency: 'TDS', duration: '5 days', indication: 'Throat infection', state: 'approved', a: 12 },
        { medicine: 'Syp Ambroxol', dose: '15 ml', frequency: 'TDS', duration: '5 days', indication: 'Cough', state: 'approved', a: 18 },
      ],
    },
  },
  {
    key: 'x4', area: 'OPD', who: 1, pri: 'routine', t: 25,
    rx: {
      items: [
        { medicine: 'Tab Atorvastatin 20 mg', dose: '20 mg', frequency: 'OD', duration: 'Continue', indication: 'Cholesterol', state: 'approved', a: 6 },
        { medicine: 'Tab Telmisartan 40 mg', dose: '40 mg', frequency: 'OD', duration: 'Continue', indication: 'Hypertension', state: 'approved', a: 7 },
      ],
    },
  },
  {
    key: 'x5', area: 'OPD', who: 2, pri: 'routine', t: 130,
    rx: {
      items: [
        { medicine: 'Cap Omeprazole 20 mg', dose: '20 mg', frequency: 'OD', duration: '14 days', indication: 'Acidity', state: 'approved', a: 20 },
        { medicine: 'Tab Clopidogrel 75 mg', dose: '75 mg', frequency: 'OD', duration: '30 days', indication: 'After a stent', state: 'approved', a: 21 },
      ],
    },
  },
  { key: 'o6', area: 'OPD', who: 2, pri: 'routine', t: 50, lines: [L('cetirizine', 10, 'OD', 'check', { days: 5 }), L('paracetamol', 500, 'TDS', 'approved', { days: 3, a: 10 })] },
  { key: 'o7', area: 'OPD', who: 1, pri: 'urgent', t: 110, lines: [L('azithromycin', 500, 'OD', 'issued', { days: 3, a: 5, i: 35 }), L('amoxicillin', 500, 'TDS', 'approved', { days: 5, a: 8 })] },
  { key: 'o8', area: 'OPD', who: 0, pri: 'routine', t: 160, lines: [L('ibuprofen', 400, 'TDS', 'issued', { days: 3, a: 12, i: 60 }), L('pantoprazole', 40, 'OD', 'issued', { days: 3, a: 14, i: 61 })] },
  { key: 'o9', area: 'OPD', who: 2, pri: 'routine', t: 30, lines: [L('metronidazole', 400, 'TDS', 'cancelled', { days: 5, a: 5, reason: 'Ordered for the wrong patient' }), L('amlodipine', 5, 'OD', 'check', { days: 30 })] },
];

const SPECS: OS[] = [...ER_ORDERS, ...WARD_ORDERS, ...OPD_ORDERS];

// ---------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------

const ER_FORMS = new Set(['sl-tab', 'syringe', 'vial', 'mdv', 'ampoule', 'bag', 'bottle', 'nebule']);
const ER_EXTRA = new Set(['aspirin-tab-75', 'aspirin-tab-300', 'clopidogrel-tab-75', 'ticagrelor-tab-90', 'atorvastatin-tab-40', 'atorvastatin-tab-80', 'metoprolol-tab-25', 'paracetamol-tab-500']);
const erStocked = (p: ProductDef): boolean => ER_FORMS.has(p.form) || ER_EXTRA.has(p.key);

const BASE_MAIN: Record<string, number> = { tab: 500, cap: 400, 'sl-tab': 200, syringe: 150, vial: 120, mdv: 30, ampoule: 100, bag: 150, bottle: 100, nebule: 200, sachet: 150 };
const BASE_ER: Record<string, number> = { tab: 80, cap: 80, 'sl-tab': 60, syringe: 60, vial: 50, mdv: 12, ampoule: 50, bag: 60, bottle: 40, nebule: 80, sachet: 40 };
/** The three low pairs (above 0), with what is left and the reorder level. */
const LOW: Record<string, { left: number; level: number }> = {
  'pantoprazole-tab-40|main': { left: 38, level: 50 },
  'amoxicillin-clavulanate-tab-625|main': { left: 30, level: 60 },
  'salbutamol-nebule-2.5|er': { left: 12, level: 30 },
};
const OUT = { product: 'ticagrelor-tab-90', store: 'er' as Store, level: 10 };
const NEAR_EXPIRY = [
  { product: 'cetirizine-tab-10', store: 'main' as Store, days: 38, qty: 60 },
  { product: 'ringer-lactate-bag-500', store: 'main' as Store, days: 74, qty: 24 },
];
const EXPIRED = [{ product: 'ondansetron-ampoule-4', store: 'main' as Store, days: -9, qty: 18 }];

interface BatchBuild {
  _id: Types.ObjectId;
  product: ProductDef;
  store: Store;
  batchNo: string;
  expiry: string;
  /** What is left at the end of the seed. */
  final: number;
  taken: number;
  receivedAt: Date;
  /** The oldest usable batch of its pair, which every issue takes from. */
  first?: boolean;
}

const isoOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------------------------

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

const cut = (s: string) => s.slice(0, SUMMARY_MAX);
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

const asCheckLine = (l: { medicine: string | null; dose: number | null; frequency: string; doseText?: string }): CheckLine => ({
  medicine: l.medicine,
  dose: l.dose,
  frequency: l.frequency as Frequency,
  doseReadable: l.dose === null && !!l.doseText ? false : undefined,
});

interface LB {
  spec: LS;
  _id: Types.ObjectId;
  order: OB;
  idx: number;
  medicine: string | null;
  product: string | null;
  freeName?: string;
  dose: number | null;
  doseText?: string;
  unit: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number | null;
  prescriptionItem?: string;
  /** Real milliseconds. */
  enteredMs: number;
  state: LState;
  status: string;
  approvedMs?: number;
  issueFromMs?: number;
  checkedMs?: number;
  issuedMs?: number;
  rejectedMs?: number;
  cancelledMs?: number;
  stoppedMs?: number;
  querySeq: number;
  query?: Record<string, any>;
  issued?: Record<string, any>;
  flags: Flag[];
  approvedReason?: string;
  lastMs: number;
}

interface OB {
  spec: OS;
  _id: Types.ObjectId;
  number: string;
  caseId: Types.ObjectId;
  patient: { _id: Types.ObjectId; uhid: string; name: string };
  setting: Area;
  ward?: string;
  sq: number;
  t0: number;
  lines: LB[];
  source: 'order' | 'prescription';
  prescription?: { _id: Types.ObjectId };
}

interface StockPlan {
  batchBuilds: BatchBuild[];
  pairs: Map<string, BatchBuild[]>;
  levelRows: { product: string; store: Store; reorderLevel: number }[];
  movementDocs: Record<string, any>[];
  takeStock: (l: LB, store: Store, ms: number) => { batch: string; batchNo: string; expiry: string; qty: number }[];
}

/** The pharmacy stock: two batches per stocked pair, the three low pairs, ER ticagrelor at 0, and the near-expiry and expired batches. Issues take from the oldest usable batch. */
function planStock(clinicMs: number, clinicOf: (ms: number) => Date, pharmacistBy: { id: string; name: string }): StockPlan {
  const allProducts = MEDICINES.flatMap((m) => m.products);
  const batchBuilds: BatchBuild[] = [];
  const pairs = new Map<string, BatchBuild[]>();
  let batchSerial = 0;
  const rr = rng(30102026);
  const addBatch = (product: ProductDef, store: Store, days: number, final: number, first = false): BatchBuild => {
    const b: BatchBuild = {
      _id: new Types.ObjectId(),
      product,
      store,
      batchNo: `${product.medicine.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase()}-${1000 + ++batchSerial}`,
      expiry: isoOf(clinicMs + days * DAY),
      final,
      taken: 0,
      receivedAt: new Date(clinicMs - (14 + Math.floor(rr() * 40)) * DAY),
      ...(first ? { first: true } : {}),
    };
    batchBuilds.push(b);
    const k = `${product.key}|${store}`;
    pairs.set(k, [...(pairs.get(k) ?? []), b]);
    return b;
  };
  const levelRows: { product: string; store: Store; reorderLevel: number }[] = [];
  for (const p of allProducts) {
    for (const store of ['main', 'er'] as Store[]) {
      if (store === 'er' && !erStocked(p)) continue;
      if (store === 'er' && p.key === OUT.product) {
        levelRows.push({ product: p.key, store, reorderLevel: OUT.level });
        continue;
      }
      const low = LOW[`${p.key}|${store}`];
      const base = (store === 'main' ? BASE_MAIN : BASE_ER)[p.form];
      const total = low ? low.left : base;
      const older = Math.max(1, Math.round(total * 0.4));
      const newer = total - older;
      const d0 = 150 + Math.floor(rr() * 90);
      addBatch(p, store, d0, older, true);
      if (newer > 0) addBatch(p, store, d0 + 180, newer);
      levelRows.push({ product: p.key, store, reorderLevel: low ? low.level : Math.max(2, Math.floor(total * 0.2)) });
    }
  }
  for (const x of NEAR_EXPIRY) addBatch(productByKey(x.product)!, x.store, x.days, x.qty);
  for (const x of EXPIRED) addBatch(productByKey(x.product)!, x.store, x.days, x.qty);

  const movementDocs: Record<string, any>[] = [];
  const takeStock = (l: LB, store: Store, ms: number): { batch: string; batchNo: string; expiry: string; qty: number }[] => {
    const qty = l.quantity ?? 0;
    const pair = pairs.get(`${l.product}|${store}`)?.find((b) => b.first);
    if (!pair) throw new Error(`Pharmacy seed: ${l.order.number} issues ${l.product} from ${store}, which stocks none.`);
    pair.taken += qty;
    movementDocs.push({
      _id: new Types.ObjectId(), batch: pair._id, product: pair.product.key, store, change: -qty, kind: 'issued', reason: 'issued', line: l._id,
      by: pharmacistBy, at: clinicOf(ms), createdAt: new Date(ms), updatedAt: new Date(ms),
    });
    return [{ batch: String(pair._id), batchNo: pair.batchNo, expiry: pair.expiry, qty }];
  };
  return { batchBuilds, pairs, levelRows, movementDocs, takeStock };
}

/** The batch, reorder-level, movement and low-stock alert documents of a stock plan, once every issue has taken its quantity. */
function stockDocuments(stock: StockPlan, nowMs: number, clinicMs: number, clinicOf: (ms: number) => Date, pharmacistBy: { id: string; name: string }) {
  const { batchBuilds, pairs, levelRows, movementDocs } = stock;
  const alertDocs: Record<string, any>[] = [];
  const batchDocs = batchBuilds.map((b) => ({
    _id: b._id, product: b.product.key, medicine: b.product.medicine, store: b.store, batchNo: b.batchNo, expiry: b.expiry, quantity: b.final, receivedBy: pharmacistBy,
    receivedAt: b.receivedAt, takes: [], createdAt: b.receivedAt, updatedAt: b.receivedAt,
  }));
  for (const b of batchBuilds) {
    if (b.taken > 0 && !b.first) throw new Error('Pharmacy seed: an issue reached a batch that is not the oldest usable one.');
    movementDocs.push({
      _id: new Types.ObjectId(), batch: b._id, product: b.product.key, store: b.store, change: b.final + b.taken, kind: 'received', reason: `Received batch ${b.batchNo}`, by: pharmacistBy,
      at: b.receivedAt, createdAt: b.receivedAt, updatedAt: b.receivedAt,
    });
  }
  for (const x of [...NEAR_EXPIRY, ...EXPIRED]) if ((pairs.get(`${x.product}|${x.store}`) ?? []).some((b) => b.taken > 0 && !b.first)) throw new Error('Pharmacy seed: an issue reached a special batch.');
  const lowKeys = [...Object.keys(LOW), `${OUT.product}|${OUT.store}`];
  const lowAt = lowKeys.map((_, i) => new Date(nowMs - (95 + i * 47) * MIN));
  const levelDocs = levelRows.map((r) => {
    const k = `${r.product}|${r.store}`;
    const i = lowKeys.indexOf(k);
    return { ...r, ...(i >= 0 ? { lowAlertedAt: lowAt[i] } : {}), createdAt: new Date(clinicMs - 30 * DAY), updatedAt: i >= 0 ? lowAt[i] : new Date(clinicMs - 30 * DAY) };
  });
  lowKeys.forEach((k, i) => {
    const [product, store] = k.split('|') as [string, Store];
    const left = k === `${OUT.product}|${OUT.store}` ? 0 : LOW[k].left;
    const level = levelRows.find((r) => r.product === product && r.store === store)!.reorderLevel;
    alertDocs.push({
      _id: new Types.ObjectId(), title: `Low stock: ${productByKey(product)!.label} (${STORE_LABEL[store]})`, subtitle: `${left} left · reorder level ${level}`, lowAlertedAt: lowAt[i],
      type: 'Medication Alert', category: 'Medication', priority: 'Medium', status: 'Pending', dueDateTime: displayDateTime(clinicOf(lowAt[i].getTime())),
      link: `pharmacy-stock:${product}:${store}`, patientName: '', uhid: '', createdAt: lowAt[i], updatedAt: lowAt[i],
    });
  });
  return { batchDocs, levelDocs, lowKeys, lowAlerts: alertDocs };
}

/** The Pharmacy agent's five card values at every hour of the last week, ending with the real counts now. */
function buildSnapshots(orderDocs: Record<string, any>[], lineDocs: Record<string, any>[], lowStock: number, nowMs: number, midnight: Date): Record<string, any>[] {
  const openQuery = (l: Record<string, any>) => ['to-check', 'query', 'approved', 'issued'].includes(l.status) && l.query && !l.query.answer;
  const today = {
    ordersToday: orderDocs.filter((o) => o.createdAt.getTime() >= midnight.getTime()).length,
    toCheck: lineDocs.filter((l) => l.status === 'to-check').length,
    openQueries: lineDocs.filter(openQuery).length,
    issuedToday: lineDocs.filter((l) => l.issued && l.issued.realAt.getTime() >= midnight.getTime()).length,
    lowStock,
  };
  const r = rng(26092026);
  const busyAt = (h: number) => Math.max(0.08, Math.sin(((h - 6) / 24) * 2 * Math.PI));
  const cum = (h: number) => Array.from({ length: h + 1 }, (_, k) => busyAt(k)).reduce((a, b) => a + b, 0);
  const lastHour = hourOf(new Date(nowMs)).getTime();
  const hnow = new Date(lastHour).getHours();
  return Array.from({ length: 168 }, (_, k) => {
    const i = 167 - k;
    const hour = new Date(lastHour - i * HOUR);
    const h = hour.getHours();
    if (i === 0) return { hour, at: new Date(nowMs), ...today };
    const sameDay = hour.getTime() >= midnight.getTime();
    const share = sameDay ? cum(h) / cum(hnow) : cum(h) / cum(23);
    const scale = (full: number, jitter: number) => Math.max(0, Math.round(full * share * (1 + (r() - 0.5) * jitter)));
    const dayTotal = (base: number) => (sameDay ? base : Math.round(base * (0.85 + r() * 0.35)));
    return {
      hour,
      at: new Date(Math.min(nowMs, hour.getTime() + 59 * MIN)),
      ordersToday: scale(dayTotal(Math.max(today.ordersToday, 25)), 0.1),
      toCheck: Math.max(1, Math.round(3 + 6 * busyAt(h) + (r() - 0.5) * 3)),
      openQueries: Math.max(0, Math.round(1 + 3 * busyAt(h) + (r() - 0.5) * 2)),
      issuedToday: scale(dayTotal(Math.max(today.issuedToday, 25)), 0.1),
      lowStock: Math.max(2, 3 + Math.round((r() - 0.3) * 2)),
    };
  });
}

interface SimContext {
  nowMs: number;
  targets: typeof DEFAULT_TARGETS;
  doctor: { id: string; name: string };
  pharmacistBy: { id: string; name: string };
  clinicOf: (ms: number) => Date;
  takeStock: StockPlan['takeStock'];
  messageDocs: Record<string, any>[];
  touchedCases: Map<string, number>;
  clockDocs: Record<string, any>[];
  alertDocs: Record<string, any>[];
  lineDocs: Record<string, any>[];
  orderDocs: Record<string, any>[];
}

const earliest = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null);

/**
 * One order's day, in time order: what each line did, the check and issue rounds that follow, the messages and
 * clocks the Coordinator would hold, the query and rejection alerts, and the line and order documents.
 */
function simulateOrder(ob: OB, ctx: SimContext): void {
  const { nowMs, targets, doctor, pharmacistBy, clinicOf, takeStock, messageDocs, touchedCases, clockDocs, alertDocs, lineDocs, orderDocs } = ctx;
  const spec = ob.spec;
  const sq = ob.sq;
  const pri = spec.pri;
  const orderId = ob._id;
  const created = ob.t0;
  const at = (off: number): number => Math.min(nowMs - MIN, ob.t0 + off * sq * MIN);
  const announcedMs = created + 1000;

  const round = { check: { n: 0, open: false, due: null as number | null }, issue: { n: 0, open: false, due: null as number | null } };
  const running = new Map<string, Record<string, any>>();
  const push = (type: string, ms: number, summary: string, payload: Record<string, unknown>, dedupeKey: string): Types.ObjectId => {
    const _id = new Types.ObjectId();
    messageDocs.push({
      _id, case: ob.caseId, from: 'pharmacy', to: ['coordinator'], type, priority: CASE_PRIORITY[pri], summary: cut(summary), payload,
      dueBy: null, needsPerson: false, opensWork: false, hop: 0, attempts: 0, state: 'delivered', dedupeKey, createdAt: new Date(ms),
    });
    touchedCases.set(String(ob.caseId), Math.max(touchedCases.get(String(ob.caseId)) ?? 0, ms));
    return _id;
  };
  const startClock = (def: string, ref: string, msgId: Types.ObjectId, ms: number, dueMs: number, payload: Record<string, unknown>) => {
    const detail = PHARMACY_CLOCKS.find((c) => c.key === def)?.detailFrom?.(payload);
    const c = { _id: new Types.ObjectId(), def, case: ob.caseId, ref, startedBy: msgId, startedAt: new Date(ms), dueAt: new Date(dueMs), state: 'running', ...(detail ? { detail } : {}), createdAt: new Date(ms), updatedAt: new Date(ms) };
    running.set(ref, c);
    clockDocs.push(c);
  };
  const stopClock = (ref: string, ms: number) => {
    const c = running.get(ref);
    if (!c) return;
    c.state = 'met';
    c.stoppedAt = new Date(ms);
    c.metMinutes = Math.round((ms - c.startedAt.getTime()) / MIN);
    c.updatedAt = new Date(ms);
    running.delete(ref);
  };

  /** Opens, moves or closes the order's rounds to match what waits now; returns what a message carries and the rounds this call closed. */
  const sync = (): { state: Record<string, unknown>; closed: { check?: number; issue?: number } } => {
    const closed: { check?: number; issue?: number } = {};
    const dueC = earliest(ob.lines.filter((l) => l.status === 'to-check').map((l) => l.enteredMs + targets.check[pri] * MIN));
    const dueI = ob.setting === 'OPD' ? null : earliest(ob.lines.filter((l) => l.status === 'approved').map((l) => (l.issueFromMs ?? created) + targets.issue[pri] * MIN));
    for (const [k, due] of [['check', dueC], ['issue', dueI]] as const) {
      const r = round[k];
      if (due !== null && !r.open) Object.assign(r, { n: r.n + 1, open: true, due });
      else if (due !== null) r.due = due;
      else if (r.open) {
        r.open = false;
        closed[k] = r.n;
      }
    }
    return {
      state: {
        checkRound: round.check.n, checkDueAt: new Date(round.check.due ?? created), issueRound: round.issue.n, issueDueAt: new Date(round.issue.due ?? created),
      },
      closed,
    };
  };
  const refOf = (k: 'check' | 'issue', n: number) => `${orderId}:${k === 'check' ? 'c' : 'i'}${n}`;

  interface Ev { type: LineMessageType; line: LB; extra?: Record<string, unknown>; dedupeKey: string }
  /** One publish: the rounds are synced first, then every event carries the state, then each closed round says so. */
  const publish = (ms: number, events: Ev[]): void => {
    const { state, closed } = sync();
    let k = 0;
    const next = () => ms + 100 * k++;
    for (const ev of events) {
      const l = ev.line;
      const when = next();
      const payload: Record<string, unknown> = {
        orderId: String(orderId), orderNumber: ob.number, lineId: String(l._id), medicine: l.medicine ?? 'unlisted', priority: pri, setting: ob.setting, version: 1, ...state,
      };
      const q = l.query;
      if (ev.type === 'pharmacy.query') Object.assign(payload, { querySeq: q!.seq, kind: q!.kind, queryDueAt: q!.dueAt });
      if (ev.type === 'pharmacy.query-answered') Object.assign(payload, { querySeq: q!.seq, outcome: q!.answer.outcome });
      if (ev.type === 'pharmacy.issued') Object.assign(payload, { store: l.issued!.store, quantity: l.issued!.quantity });
      if (ev.type === 'pharmacy.cancelled' || ev.type === 'pharmacy.stopped') Object.assign(payload, { querySeq: l.querySeq });
      Object.assign(payload, ev.extra ?? {});
      const id = push(ev.type, when, lineSummary(ob.number, { medicine: l.medicine, dose: l.dose, unit: l.unit }, ev.type, pri), payload, ev.dedupeKey);
      l.lastMs = Math.max(l.lastMs, when);
      // What the Coordinator's clocks do with it.
      const cRef = refOf('check', round.check.n);
      const iRef = refOf('issue', round.issue.n);
      for (const [ref, due] of [[cRef, state.checkDueAt], [iRef, state.issueDueAt]] as const) {
        if (ref === iRef && ob.setting === 'OPD') continue;
        const c = running.get(ref);
        if (c) {
          c.dueAt = due;
          c.updatedAt = new Date(when);
        }
      }
      if (ev.type === 'pharmacy.to-check' && !running.has(cRef)) startClock('pharmacy-check', cRef, id, when, (state.checkDueAt as Date).getTime(), payload);
      if (ev.type === 'pharmacy.to-issue' && ob.setting !== 'OPD' && !running.has(iRef)) startClock('pharmacy-issue', iRef, id, when, (state.issueDueAt as Date).getTime(), payload);
      if (ev.type === 'pharmacy.query') startClock('pharmacy-query', `${l._id}:q${q!.seq}`, id, when, new Date(q!.dueAt).getTime(), payload);
      if (['pharmacy.query-answered', 'pharmacy.cancelled', 'pharmacy.stopped'].includes(ev.type)) stopClock(`${l._id}:q${l.querySeq}`, when);
    }
    for (const [kind, n] of [['check', closed.check], ['issue', closed.issue]] as const) {
      if (n === undefined) continue;
      const when = next();
      const type = kind === 'check' ? 'pharmacy.check-done' : 'pharmacy.issue-done';
      push(type, when, `${ob.number}: ${kind === 'check' ? 'all medicines checked' : 'all medicines issued'} (${pri.toUpperCase()})`, { orderId: String(orderId), orderNumber: ob.number, [kind === 'check' ? 'checkRound' : 'issueRound']: n }, `${type}:${orderId}:${n}`);
      stopClock(refOf(kind, n), when);
    }
  };

  // The order: pharmacy.ordered, then every line waits to be checked.
  push('pharmacy.ordered', announcedMs, orderSummary(ob.number, ob.lines.map((l) => medicineLabel(l.medicine)), pri), {
    orderId: String(orderId), orderNumber: ob.number, priority: pri, setting: ob.setting, source: ob.source, medicines: ob.lines.map((l) => l.medicine ?? 'unlisted'),
  }, `pharmacy.ordered:${orderId}`);
  for (const l of ob.lines) l.status = 'to-check';
  publish(created + 1500, ob.lines.map((l) => ({ type: 'pharmacy.to-check' as const, line: l, dedupeKey: `pharmacy.to-check:${l._id}:${l.enteredMs}` })));

  // Then what each line did, in time order.
  interface Op { off: number; line: LB; kind: 'approve' | 'pquery' | 'aquery' | 'reject' | 'cancel' | 'issue' | 'answer' }
  const ops: Op[] = [];
  for (const l of ob.lines) {
    const s = l.spec;
    if (['approved', 'issued', 'stopped'].includes(l.state)) ops.push({ off: s.a!, line: l, kind: 'approve' });
    if (l.state === 'rejected') ops.push({ off: s.a!, line: l, kind: 'reject' });
    if (l.state === 'cancelled') ops.push({ off: s.a!, line: l, kind: 'cancel' });
    if (['issued', 'stopped'].includes(l.state)) ops.push({ off: s.i!, line: l, kind: 'issue' });
    if (s.q) {
      ops.push({ off: s.q.at, line: l, kind: s.q.by === 'pharm' ? 'pquery' : 'aquery' });
      if (s.q.ans) ops.push({ off: s.q.ans.at, line: l, kind: 'answer' });
    }
    if (['approved', 'issued', 'stopped', 'rejected', 'cancelled'].includes(l.state) && s.a === undefined) throw new Error(`Pharmacy seed: ${ob.number} ${s.med} has no action time.`);
  }
  ops.sort((a, b) => a.off - b.off || a.line.idx - b.line.idx);
  for (const op of ops) {
    const l = op.line;
    const ms = at(op.off);
    const s = l.spec;
    if (op.kind === 'approve') {
      l.status = 'approved';
      l.approvedMs = ms;
      l.checkedMs = ms;
      l.issueFromMs = ms;
      const ev: Ev[] = [{ type: 'pharmacy.approved', line: l, dedupeKey: `pharmacy.approved:${l._id}:1:${ms}` }];
      if (ob.setting !== 'OPD') ev.push({ type: 'pharmacy.to-issue', line: l, dedupeKey: `pharmacy.to-issue:${l._id}:${ms}` });
      publish(ms, ev);
    } else if (op.kind === 'reject') {
      l.status = 'rejected';
      l.rejectedMs = ms;
      l.checkedMs = ms;
      publish(ms, [{ type: 'pharmacy.rejected', line: l, dedupeKey: `pharmacy.rejected:${l._id}` }]);
    } else if (op.kind === 'cancel') {
      l.status = 'cancelled';
      l.cancelledMs = ms;
      publish(ms, [{ type: 'pharmacy.cancelled', line: l, extra: { querySeq: l.querySeq }, dedupeKey: `pharmacy.cancelled:${l._id}` }]);
    } else if (op.kind === 'issue') {
      l.status = 'issued';
      l.issuedMs = ms;
      const store: Store = s.store ?? (ob.setting === 'ER' ? 'er' : 'main');
      const batchesOut = takeStock(l, store, ms);
      l.issued = { by: pharmacistBy, at: clinicOf(ms), realAt: new Date(ms), store, quantity: l.quantity, batches: batchesOut, announcedAt: new Date(ms + 300) };
      publish(ms, [{ type: 'pharmacy.issued', line: l, dedupeKey: `pharmacy.issued:${l._id}` }]);
    } else if (op.kind === 'pquery' || op.kind === 'aquery') {
      const q = s.q!;
      const red = l.flags.filter((f) => f.severity === 'red' && !f.confirmed);
      const kidneyRed = red.filter((f) => f.kind === 'kidney');
      let question = q.question ?? '';
      let redKeys = red.map((f) => f.key);
      if (q.by === 'agent') {
        if (q.kind === 'allergy') {
          const flag = red.find((f) => f.kind === 'allergy');
          question = `${flag!.text}. Please confirm with a reason, change the dose, or cancel.`;
          redKeys = red.filter((f) => f.kind === 'allergy').map((f) => f.key);
        } else {
          const egfr = /eGFR (\d+)/.exec(kidneyRed[0]?.text ?? '')?.[1];
          question = `Dose may need lowering for kidney function${egfr ? ` (eGFR ${egfr})` : ''}. Please review.`;
          redKeys = kidneyRed.map((f) => f.key);
        }
      }
      const openedAt = new Date(ms);
      const dueAt = new Date(ms + targets.query[pri] * MIN);
      l.querySeq = 1;
      l.query = {
        seq: 1, kind: q.kind, question, by: q.by === 'agent' ? PHARMACY_AGENT : pharmacistBy, at: clinicOf(ms), openedRealAt: openedAt, dueAt, suggestions: [], redKeys,
      };
      if (!['issued'].includes(l.status)) {
        l.status = 'query';
        if (q.by === 'pharm') l.checkedMs = ms;
      }
      publish(ms, [{ type: 'pharmacy.query', line: l, extra: { querySeq: 1, kind: q.kind, queryDueAt: dueAt }, dedupeKey: `pharmacy.query:${l._id}:1` }]);
    } else {
      const a = s.q!.ans!;
      const keep = a.outcome === 'keep';
      const reason = a.reason;
      l.query!.answer = { outcome: a.outcome, by: doctor, reason, at: clinicOf(ms), realAt: new Date(ms) };
      if (keep) {
        const asked = (f: Flag) => (l.query!.redKeys as string[]).includes(f.key);
        l.flags = l.flags.map((f) => (f.severity === 'red' && !f.confirmed && asked(f) ? { ...f, confirmed: { by: doctor.name, reason, at: clinicOf(ms) } } : f));
      }
      const events: Ev[] = [{ type: 'pharmacy.query-answered', line: l, extra: { querySeq: 1, outcome: a.outcome }, dedupeKey: `pharmacy.query-answered:${l._id}:1` }];
      if (!keep) {
        l.status = 'stopped';
        l.stoppedMs = ms;
        events.push({ type: 'pharmacy.stopped', line: l, extra: { querySeq: 1 }, dedupeKey: `pharmacy.stopped:${l._id}` });
      }
      publish(ms, events);
    }
  }

  // The query and rejection alerts.
  for (const l of ob.lines) {
    const name = `${medicineLabel(l.medicine)}${l.dose === null ? '' : ` ${l.dose} ${l.unit}`}`;
    if (l.query) {
      const minutes = Math.max(1, Math.round((new Date(l.query.dueAt).getTime() - new Date(l.query.openedRealAt).getTime()) / MIN));
      const openMs = new Date(l.query.openedRealAt).getTime();
      const answered = l.query.answer ? new Date(l.query.answer.realAt).getTime() : undefined;
      alertDocs.push({
        _id: new Types.ObjectId(), title: `Pharmacy query: ${name} (${l.query.kind})`, subtitle: `For ${doctor.name} · ${ob.number} · answer within ${minutes} min`, querySeq: 1,
        patientName: ob.patient.name, uhid: ob.patient.uhid, type: 'Medication Alert', category: 'Medication', priority: 'High', status: answered ? 'Completed' : 'Pending',
        dueDateTime: displayDateTime(new Date(clinicOf(openMs).getTime() + minutes * MIN)), link: `pharmacy-line:${l._id}`, createdAt: new Date(openMs), updatedAt: new Date(answered ?? openMs),
      });
    }
    if (l.state === 'rejected') {
      alertDocs.push({
        _id: new Types.ObjectId(), title: `Rejected: ${name}`, subtitle: `For ${doctor.name} · ${ob.number} · ${l.spec.reason}`, patientName: ob.patient.name, uhid: ob.patient.uhid,
        type: 'Medication Alert', category: 'Medication', priority: 'Medium', status: 'Pending', link: `pharmacy-rejected:${l._id}`, createdAt: new Date(l.rejectedMs!), updatedAt: new Date(l.rejectedMs!),
      });
    }
  }

  // The line documents.
  for (const l of ob.lines) {
    const s = l.spec;
    const doc: Record<string, any> = {
      _id: l._id, order: orderId, patient: ob.patient._id, medicine: l.medicine, product: l.product, ...(l.freeName ? { freeName: l.freeName } : {}), dose: l.dose,
      ...(l.doseText ? { doseText: l.doseText } : {}), unit: l.unit, route: l.route, frequency: l.frequency, durationDays: l.durationDays, quantity: l.quantity, note: '', version: 1,
      status: l.status, enteredCheckAt: new Date(l.enteredMs), waitingForStock: false, ...(l.prescriptionItem ? { prescriptionItem: l.prescriptionItem, prescriptionRev: 1 } : {}),
      flags: l.flags, querySeq: l.querySeq, history: [], createdAt: new Date(created), updatedAt: new Date(Math.min(nowMs, l.lastMs)),
    };
    if (l.checkedMs !== undefined) doc.checkedAt = new Date(l.checkedMs);
    if (l.issueFromMs !== undefined) doc.issueFrom = new Date(l.issueFromMs);
    if (l.query) doc.query = l.query;
    if (l.approvedMs !== undefined) doc.approved = { by: pharmacistBy, at: clinicOf(l.approvedMs), version: 1, ...(l.approvedReason ? { reason: l.approvedReason } : {}) };
    if (l.rejectedMs !== undefined) doc.rejected = { by: pharmacistBy, reason: s.reason, at: clinicOf(l.rejectedMs) };
    if (l.issued) doc.issued = l.issued;
    if (l.cancelledMs !== undefined) doc.cancelled = { by: doctor, reason: s.reason, at: clinicOf(l.cancelledMs) };
    if (l.stoppedMs !== undefined) doc.stopped = { by: doctor, reason: s.q!.ans!.reason, at: clinicOf(l.stoppedMs) };
    lineDocs.push(doc);
  }

  const touched = Math.min(nowMs, Math.max(announcedMs, ...ob.lines.map((l) => l.lastMs)));
  orderDocs.push({
    _id: orderId, number: ob.number, patient: ob.patient._id, patientUhid: ob.patient.uhid, patientName: ob.patient.name, case: ob.caseId, setting: ob.setting,
    ...(ob.ward ? { ward: ob.ward } : {}), orderedBy: doctor, priority: pri, note: spec.note ?? '', source: ob.source,
    ...(ob.prescription ? { prescription: ob.prescription._id, prescriptionRev: 1 } : { prescriptionRev: 0 }), orderedAt: clinicOf(created), announcedAt: new Date(announcedMs),
    checkRound: round.check.n, checkOpen: round.check.open, ...(round.check.n ? { checkDueAt: new Date(round.check.due!) } : {}),
    issueRound: round.issue.n, issueOpen: round.issue.open, ...(round.issue.n ? { issueDueAt: new Date(round.issue.due!) } : {}),
    createdAt: new Date(created), updatedAt: new Date(touched),
  });
}

/**
 * Replaces everything the Pharmacy agent keeps with a demo day: pharmacy stock, 25 medicine orders in every
 * state across the ER, the wards and the outpatient counter, with their checks, queries, issues, Coordinator
 * messages, clocks and alerts, and a week of hourly snapshots. Run after seedLab: the orders sit on the cases
 * the ER, Bed, Coordinator and Lab seeds made. Staff-visible times use the clinic clock (`clinicDay`);
 * everything else uses the real clock, placed so nothing is after `nowMs` and no running clock is overdue.
 * `nowMs` is for tests.
 */
export async function seedPharmacy(clinicDay: string, nowMs: number = Date.now()): Promise<void> {
  const orders = model(PharmacyOrder, PharmacyOrderSchema);
  const lines = model(PharmacyLine, PharmacyLineSchema);
  const locations = model(PharmacyLocation, PharmacyLocationSchema);
  const batches = model(PharmacyBatch, PharmacyBatchSchema);
  const movements = model(PharmacyMovement, PharmacyMovementSchema);
  const snapshots = model(PharmacySnapshot, PharmacySnapshotSchema);
  const levels = model(PharmacyStockLevel, PharmacyStockLevelSchema);
  const prescriptions = model(Prescription, PrescriptionSchema);
  const cases = model(Case, CaseSchema);
  const messages = model(AgentMessage, AgentMessageSchema);
  const clocks = model(Clock, ClockSchema);
  const escalations = model(Escalation, EscalationSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const timeline = model(TimelineEvent, TimelineEventSchema);
  const counters = model(CoordinatorCounter, CoordinatorCounterSchema);
  const patients = model(Patient, PatientSchema);
  const reports = model(LabTestReport, LabTestReportSchema);
  const visits = model(ErVisit, ErVisitSchema);
  const users = model(User, UserSchema);
  const titles = model(DutyTitle, DutyTitleSchema);
  const ladders = model(Ladder, LadderSchema);
  const facts = new PharmacyPatientsService(patients as never, reports as never);

  // ---- People ------------------------------------------------------------------------------
  const who = async (email: string, role: string, fallback: string): Promise<{ id: string; name: string }> => {
    const u = (await users.findOne({ email }).select('name').lean<any>()) ?? (await users.findOne({ role }).sort({ name: 1 }).select('name').lean<any>());
    return u ? { id: String(u._id), name: u.name } : { id: String(new Types.ObjectId()), name: fallback };
  };
  const doctor = await who('doctor@medios.ai', 'doctor', 'Dr. Shajin');
  const pharmacist = await who('pharmacy@medios.ai', 'pharmacist', 'Pharmacist');

  // ---- Time -------------------------------------------------------------------------------
  const clinicMs = clinicAt(clinicDay, nowMs);
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  // Early in the day there is less room for history: squeeze the ward and outpatient orders into it.
  const room = (nowMs - midnight.getTime() - 2 * MIN) / MIN;
  const squeeze = Math.min(1, Math.max(0.05, room / 240));
  const clinicOf = (ms: number): Date => new Date(clinicMs - (nowMs - ms));
  const targets = DEFAULT_TARGETS;

  // ---- The cases the orders sit on (read before anything is wiped) -----------------------------
  const allVisits = await visits.find({ status: { $ne: 'left' } }).sort({ number: 1 }).lean<any[]>();
  const used = new Set<string>();
  const erPick = new Map<string, { visit: any; case: any }>();
  for (const spec of SPECS.filter((s) => s.area === 'ER')) {
    const v = allVisits.find((x) => (spec.who as RegExp).test(x.complaintText ?? '') && !used.has(String(x._id)));
    if (!v) throw new Error(`Pharmacy seed: no open ER visit matches ${spec.who}. Run the ER seed first.`);
    const c = await cases.findById(v.case).lean<any>();
    if (!c) throw new Error('Pharmacy seed: an ER visit has no case.');
    used.add(String(v._id));
    erPick.set(spec.key, { visit: v, case: c });
  }
  const chestMan = await patients.findById(erPick.get('e1')!.case.patient).lean<any>();
  if (!chestMan || chestMan.gender !== 'Male' || chestMan.age !== 62 || chestMan.vitals?.weightKg !== 64) {
    throw new Error('Pharmacy seed: the chest-pain patient must be a man of 62 and 64 kg. Run the ER seed first.');
  }

  const wardPool = await cases.find({ kind: 'ipd', state: 'open', openedBy: { $ne: 'er' } }).sort({ number: 1 }).lean<any[]>();
  const wardName = new Map<string, string>();
  for (const c of wardPool) {
    const m = await messages.findOne({ case: c._id, type: 'bed.assigned' }).sort({ createdAt: -1 }).select('payload').lean<any>();
    wardName.set(String(c._id), typeof m?.payload?.ward === 'string' && m.payload.ward ? m.payload.ward : 'General Ward');
  }
  // The demo's own earlier run: its made-up patient records and kidney reports go first, so a rerun starts from the same world.
  await reports.deleteMany({ labLine: /^pharmacy-demo:/ });
  await patients.deleteMany({ address: PHARMACY_MARK });
  // The penicillin patient: the first admitted patient who has a Patient record (a made-up sample inpatient has none).
  const hasRecord = async (cs: any[]) => new Set((await patients.find({ _id: { $in: cs.map((c) => c.patient) } }).select('_id').lean<any[]>()).map((p) => String(p._id)));
  const records = await hasRecord(wardPool);
  const penCase = wardPool.find((c) => records.has(String(c.patient)));
  // The two kidney patients (eGFR 26 and 27) need a record, for the age and sex their eGFR comes from: admitted patients who have one first,
  // else a made-up record for a sample inpatient (marked, and cleared on a rerun).
  const spare = wardPool.filter((c) => c !== penCase);
  const kidneyCases = [...spare.filter((c) => records.has(String(c.patient))), ...spare.filter((c) => !records.has(String(c.patient)))].slice(0, 2);
  const otherWard = spare.filter((c) => !kidneyCases.includes(c));
  if (!wardPool.length) console.log('Pharmacy seed: no open admission case; the ward orders are skipped.');
  else if (!penCase) console.log('Pharmacy seed: no admitted patient has a Patient record; the penicillin allergy is not recorded.');
  const kidneyCase = (who: 'k1' | 'k2') => kidneyCases[who === 'k1' ? 0 : 1];
  const MADE_UP = { k1: { age: 68, gender: 'Male' }, k2: { age: 64, gender: 'Female' } } as const;
  for (const who of ['k1', 'k2'] as const) {
    const c = kidneyCase(who);
    if (c && !records.has(String(c.patient))) {
      await patients.create({
        _id: c.patient, uhid: c.patientUhid, name: c.patientName, ...MADE_UP[who], phone: who === 'k1' ? '9000009301' : '9000009302', address: PHARMACY_MARK, doctor: doctor.name, department: 'General Medicine',
        createdAt: new Date(nowMs), updatedAt: new Date(nowMs),
      });
      console.log(`Pharmacy seed: ${c.patientUhid} had no Patient record; a made-up one was added for the kidney story.`);
    }
  }

  const openCases = await cases.find({ state: 'open', openedBy: { $ne: 'pharmacy' } }).lean<any[]>();
  const openOf = new Map(openCases.map((c) => [String(c.patient), c]));
  const clinical = new Set(openCases.filter((c) => c.kind === 'er' || c.kind === 'ipd').map((c) => String(c.patient)));
  // The existing demo prescription, and the patient it belongs to.
  const fixtureRx = await prescriptions.findOne({ type: { $ne: PHARMACY_DEMO_RX } }).sort({ createdAt: 1 }).lean<any>();
  const fixturePatient = fixtureRx ? await patients.findOne({ uhid: fixtureRx.uhid }).lean<any>() : null;
  const fixtureActive = fixtureRx ? fixtureRx.items.filter((i: any) => i.status === 'Active') : [];
  // Counter patients: no open ER or ward case, adults first, never the fixture prescription's patient.
  const counter = (await patients.find({ detailsPending: { $ne: true } }).sort({ uhid: 1 }).lean<any[]>())
    .filter((p) => !clinical.has(String(p._id)) && String(p._id) !== String(fixturePatient?._id))
    .sort((a, b) => Number((a.age ?? 0) < 18) - Number((b.age ?? 0) < 18));
  const needCounter = 4;
  if (!counter.length) console.log('Pharmacy seed: no patient is free of an ER or ward case; the outpatient orders are skipped.');
  else if (counter.length < needCounter) console.log(`Pharmacy seed: only ${counter.length} patients are free of an ER or ward case; some outpatient orders share a patient.`);

  // The allergy the penicillin ward patient has recorded (before any check runs, so every flag sees it).
  if (penCase) await patients.updateOne({ _id: penCase.patient }, { $addToSet: { allergies: 'Penicillin' } });

  const specs = SPECS.filter((s) => s.area === 'ER' || (s.area === 'Ward' && wardPool.length && (s.who !== 'pen' || penCase) && ((s.who !== 'k1' && s.who !== 'k2') || kidneyCase(s.who))) || (s.area === 'OPD' && (s.rx?.fixture ? fixturePatient : counter.length)));

  // ---- Build the orders: patient, case, lines ---------------------------------------------------
  const lastCaseNo = (await cases.find({ number: /^CASE-\d{4,}$/, openedBy: { $ne: 'pharmacy' } }).select('number').lean<any[]>()).reduce((max, c) => Math.max(max, Number(String(c.number).slice(5))), 0);
  let caseSerial = lastCaseNo;
  const caseDocs: Record<string, any>[] = [];
  const newCases = new Map<string, Record<string, any>>();
  const joined = new Set<string>();
  const locationDocs: Record<string, any>[] = [];
  const messageDocs: Record<string, any>[] = [];
  const milestones: Record<string, unknown>[] = [];
  const touchedCases = new Map<string, number>();
  const rxDocs: Record<string, any>[] = [];

  const sorted = [...specs].sort((a, b) => b.t * (b.area === 'ER' ? 1 : squeeze) - a.t * (a.area === 'ER' ? 1 : squeeze));
  const builds: OB[] = [];
  let orderSerial = 0;
  for (const spec of sorted) {
    const sq = spec.area === 'ER' ? 1 : squeeze;
    const t0 = nowMs - spec.t * sq * MIN;
    const id = new Types.ObjectId();
    let caseId: Types.ObjectId;
    let patient: { _id: Types.ObjectId; uhid: string; name: string };
    let setting: Area = spec.area;
    let ward: string | undefined;
    let locationOf: { area: Area; ward?: string };
    if (spec.area === 'ER') {
      const pick = erPick.get(spec.key)!;
      if ((nowMs - new Date(pick.visit.createdAt).getTime()) / MIN + 0.01 < spec.t) throw new Error(`Pharmacy seed: ${spec.key} was ordered before the patient arrived.`);
      caseId = pick.case._id;
      patient = { _id: pick.case.patient, uhid: pick.case.patientUhid, name: pick.case.patientName };
      locationOf = { area: 'ER' };
    } else if (spec.area === 'Ward') {
      const c = spec.who === 'pen' ? penCase : spec.who === 'k1' || spec.who === 'k2' ? kidneyCase(spec.who) : otherWard.length ? otherWard[(spec.who as number) % otherWard.length] : penCase;
      caseId = c._id;
      patient = { _id: c.patient, uhid: c.patientUhid, name: c.patientName };
      ward = wardName.get(String(c._id));
      locationOf = { area: 'Ward', ward };
    } else {
      const p = spec.rx?.fixture ? fixturePatient : counter[(spec.who as number) % counter.length];
      patient = { _id: p._id, uhid: p.uhid, name: p.name };
      const existing = openOf.get(String(p._id)) ?? newCases.get(String(p._id));
      if (existing) {
        caseId = existing._id;
        locationOf = { area: existing.kind === 'er' ? 'ER' : existing.kind === 'ipd' ? 'Ward' : 'OPD' };
        if (existing.kind === 'ipd') ward = wardName.get(String(existing._id));
      } else {
        const c = {
          _id: new Types.ObjectId(),
          number: `CASE-${pad(++caseSerial, 4)}`,
          patient: p._id, patientUhid: p.uhid, patientName: p.name,
          kind: 'opd', priority: 'low', state: 'open', openedAt: clinicOf(t0), agents: ['pharmacy'],
          refs: { bedRequestIds: [] as string[] }, openedBy: 'pharmacy',
          createdAt: new Date(t0 - 2000), updatedAt: new Date(t0),
        };
        newCases.set(String(p._id), c);
        caseDocs.push(c);
        caseId = c._id;
        locationOf = { area: 'OPD' };
        messageDocs.push({
          _id: new Types.ObjectId(), case: c._id, from: 'coordinator', to: ['coordinator'], type: 'case.opened', priority: 'medium',
          summary: `${c.number} opened for ${p.uhid}`, payload: {}, dueBy: null, needsPerson: false, opensWork: false, hop: 0, attempts: 0, state: 'delivered',
          dedupeKey: `case.opened:${c._id}`, createdAt: new Date(t0 - 2000),
        });
        milestones.push({ uhid: p.uhid, date: displayDate(clinicOf(t0)), time: displayTime(clinicOf(t0)), category: 'Outpatient', title: `Case ${c.number} opened`, subtitle: CLOSE_NOTE, status: 'Completed' });
      }
      setting = 'OPD';
    }
    // A prescription order is always OPD; other orders take their patient's place.
    if (spec.area !== 'OPD') setting = spec.area;
    if (!locationDocs.some((l) => String(l.case) === String(caseId))) locationDocs.push({ case: caseId, ...locationOf });
    const newCase = [...newCases.values()].find((c) => String(c._id) === String(caseId));
    if (newCase) {
      const casePri = CASE_PRIORITY[spec.pri];
      if (PRIORITY_RANK[casePri] < PRIORITY_RANK[newCase.priority as keyof typeof PRIORITY_RANK]) newCase.priority = casePri;
    } else joined.add(String(caseId));

    const ob: OB = {
      spec, _id: id, number: '', caseId, patient, setting, ...(setting === 'Ward' && ward ? { ward } : {}), sq, t0,
      lines: [], source: spec.rx ? 'prescription' : 'order',
    };

    // Lines.
    const check = (off: number | undefined, what: string) => {
      if (off !== undefined && (off < 0 || off > spec.t)) throw new Error(`Pharmacy seed: ${spec.key} ${what} (${off}) is not between the order and now.`);
    };
    const enteredMs = (i: number) => t0 + 200 + i * 10;
    if (spec.rx) {
      let items: any[];
      if (spec.rx.fixture) {
        items = fixtureActive;
        if (items.length !== spec.rx.items.length) throw new Error('Pharmacy seed: the demo prescription no longer has five active items.');
        ob.prescription = { _id: fixtureRx._id };
      } else {
        const rxId = new Types.ObjectId();
        items = spec.rx.items.map((i) => ({
          _id: new Types.ObjectId(), medicine: i.medicine, brand: '', dose: i.dose, frequency: i.frequency, duration: i.duration, route: 'Oral',
          indication: i.indication, status: 'Active', startDate: displayDate(clinicOf(t0)),
        }));
        rxDocs.push({
          _id: rxId, uhid: patient.uhid, date: displayDate(clinicOf(t0)), doctor: doctor.name, type: PHARMACY_DEMO_RX, items, additionalInstructions: '',
          pharmacyRev: 1, pharmacyBy: { id: doctor.id, name: doctor.name }, createdAt: new Date(t0 - 5000), updatedAt: new Date(t0 - 5000),
        });
        ob.prescription = { _id: rxId };
      }
      items.forEach((item, i) => {
        const r = spec.rx!.items[i];
        check(r.a, `item ${i} approval`);
        const s = prescriptionLine(item, 1);
        const state: LState = r.state === 'approved' ? 'approved' : 'check';
        ob.lines.push({
          spec: { med: s.medicine ?? '', dose: s.dose ?? 0, freq: s.frequency as Frequency, state, a: r.a },
          _id: new Types.ObjectId(), order: ob, idx: i, medicine: s.medicine, product: s.product, ...(s.freeName ? { freeName: s.freeName } : {}),
          dose: s.dose, ...(s.doseText ? { doseText: s.doseText } : {}), unit: s.unit, route: s.route, frequency: s.frequency, durationDays: s.durationDays,
          quantity: s.quantity, prescriptionItem: s.prescriptionItem, enteredMs: enteredMs(i), state, status: 'to-check', querySeq: 0, flags: [], lastMs: t0,
        });
      });
    } else {
      spec.lines!.forEach((s, i) => {
        check(s.a, `${s.med} action`);
        check(s.i, `${s.med} issue`);
        check(s.q?.at, `${s.med} query`);
        check(s.q?.ans?.at, `${s.med} answer`);
        const med = medicineByKey(s.med) as MedicineDef | undefined;
        if (!med) throw new Error(`Pharmacy seed: unknown medicine ${s.med}`);
        const product = pickProduct(med, s.dose, s.route);
        if (!productByKey(product.key)) throw new Error(`Pharmacy seed: unknown product ${product.key}`);
        const days = s.freq === 'STAT' ? null : (s.days ?? null);
        ob.lines.push({
          spec: s, _id: new Types.ObjectId(), order: ob, idx: i, medicine: med.key, product: product.key, dose: s.dose, unit: med.unit,
          route: routeFor(product, s.route), frequency: s.freq, durationDays: days, quantity: quantityFor(product, s.dose, s.freq, days),
          enteredMs: enteredMs(i), state: s.state, status: 'to-check', querySeq: 0, flags: [], lastMs: t0,
        });
      });
    }
    builds.push(ob);
  }
  builds.sort((a, b) => a.t0 - b.t0);
  builds.forEach((b) => (b.number = `MO-${pad(++orderSerial, 4)}`));

  // ---- A released Kidney function report for each patient with a set eGFR, written as the Lab release writes it -------
  // The creatinine is solved from the pharmacy's own eGFR rule (age and sex from the record), so a live recheck reproduces the flags.
  const rft = testByKey('rft')!;
  for (const b of builds.filter((x) => x.spec.egfr !== undefined)) {
    const p = await patients.findById(b.patient._id).lean<any>();
    const sex = p?.gender === 'Male' ? 'M' : p?.gender === 'Female' ? 'F' : p?.gender === 'Other' ? 'Other' : null;
    let creatinine: number | undefined;
    for (let c = 50; c <= 1000 && creatinine === undefined; c++) if (egfr({ creatinine: c / 100, age: p?.age ?? null, sex }) === b.spec.egfr) creatinine = c / 100;
    if (creatinine === undefined) throw new Error(`Pharmacy seed: no creatinine gives eGFR ${b.spec.egfr} for ${b.patient.uhid}.`);
    const values: Record<string, number> = { Creatinine: creatinine, Urea: Math.round(40 + creatinine * 12) };
    const rows = rft.params.map((q) => ({ param: q.name, value: values[q.name], unit: q.unit, ...flagValue('rft', q.name, values[q.name]) }));
    // Released a few minutes before the kidney question about its line.
    const query = b.spec.lines!.find((l) => l.q?.kind === 'kidney')!.q!;
    const at = new Date(Math.min(nowMs - 2 * MIN, b.t0 + (query.at - 5) * b.sq * MIN));
    const when = clinicOf(at.getTime());
    await reports.collection.insertOne({
      uhid: b.patient.uhid, testName: rft.label, category: rft.category, date: displayDate(when), time: displayTime(when),
      status: rows.some((r) => r.flag !== 'normal') ? 'Abnormal' : 'Completed',
      groups: [{
        category: rft.label,
        parameters: rows.map((r) => ({
          name: r.param, result: r.value, referenceRange: rangeText('rft', rft.params.find((q) => q.name === r.param)!), unit: r.unit,
          status: { normal: 'Normal', low: 'Low', high: 'High', abnormal: 'Abnormal' }[r.flag], critical: r.critical,
        })),
      }],
      labLine: `pharmacy-demo:${b.patient._id}`, amended: false,
      aiSummary: { sample: false, ...templateSummary(rows.map((r, i) => ({ name: r.param, value: r.value, unit: r.unit, referenceRange: rangeText('rft', rft.params[i]), flag: r.flag, critical: r.critical }))) },
      createdAt: at, updatedAt: at,
    });
  }

  // ---- Flags: the fixed rules over every patient's active lines, as a live recheck would leave them -----
  const byPatient = new Map<string, LB[]>();
  for (const b of builds) for (const l of b.lines) byPatient.set(String(b.patient._id), [...(byPatient.get(String(b.patient._id)) ?? []), l]);
  // What the checks compare against: lines still to check, in a query or approved, and lines issued in the last 24 hours (all of today's).
  const isActive = (l: LB) => ['check', 'query', 'approved', 'issued'].includes(l.state);
  for (const [patientId, list] of byPatient) {
    const f: PatientFactsView = await facts.facts(patientId);
    for (const l of list) {
      const others = list.filter((o) => o !== l && isActive(o)).map(asCheckLine);
      const drafts = checkLine(asCheckLine(l), f, others);
      const approvedAt = l.spec.a !== undefined && ['approved', 'issued', 'stopped'].includes(l.state) ? l.order.t0 + l.spec.a * l.order.sq * MIN : undefined;
      l.flags = drafts.map((d) => {
        const flag: Flag = { ...d, version: 1 };
        if (d.severity === 'red' && d.kind === 'allergy') {
          if (!l.spec.holdAllergy) flag.confirmed = { by: doctor.name, reason: ALLERGY_REASON, at: clinicOf(l.order.t0 + 1000) };
        } else if (d.severity === 'red' && approvedAt !== undefined && l.state !== 'stopped' && !(l.spec.q?.kind === 'kidney' && d.kind === 'kidney')) {
          flag.confirmed = { by: pharmacist.name, reason: REVIEW_REASON, at: clinicOf(approvedAt) };
          l.approvedReason = REVIEW_REASON;
        } else if (d.severity === 'amber' && d.kind === 'allergy' && approvedAt !== undefined) {
          flag.reviewed = { by: pharmacist.name, at: clinicOf(approvedAt) };
        }
        return flag;
      });
      if (l.spec.holdAllergy && !l.flags.some((x) => x.kind === 'allergy' && x.severity === 'red' && !x.confirmed)) {
        throw new Error('Pharmacy seed: the penicillin line has no unconfirmed red allergy flag.');
      }
    }
  }

  // ---- Stock plan -----------------------------------------------------------------------------
  const pharmacistBy = { id: pharmacist.id, name: pharmacist.name };
  const stock = planStock(clinicMs, clinicOf, pharmacistBy);
  const takeStock = stock.takeStock;
  const movementDocs = stock.movementDocs;

  // ---- Simulate each order's day: messages, rounds, clocks, alerts, documents ----------------------
  const clockDocs: Record<string, any>[] = [];
  const alertDocs: Record<string, any>[] = [];
  const lineDocs: Record<string, any>[] = [];
  const orderDocs: Record<string, any>[] = [];

  const out = { messageDocs, touchedCases, clockDocs, alertDocs, lineDocs, orderDocs };
  for (const ob of builds) simulateOrder(ob, { nowMs, targets, doctor, pharmacistBy, clinicOf, takeStock, ...out });
  for (const c of clockDocs) {
    if (c.state === 'running' && c.dueAt.getTime() <= nowMs) throw new Error(`Pharmacy seed: the running ${c.def} clock ${c.detail ?? ''} is already overdue.`);
  }

  // ---- Stock documents ---------------------------------------------------------------------------
  const { batchDocs, levelDocs, lowKeys, lowAlerts } = stockDocuments(stock, nowMs, clinicMs, clinicOf, pharmacistBy);
  alertDocs.push(...lowAlerts);

  // ---- The week of hourly snapshots ----------------------------------------------------------------
  const points = buildSnapshots(orderDocs, lineDocs, lowKeys.length, nowMs, midnight);

  // ---- Wipe the previous run, then write -----------------------------------------------------------
  const oldCases = await cases.find({ openedBy: 'pharmacy' }).select('number').lean<any[]>();
  const oldCaseIds = oldCases.map((c) => c._id);
  const oldEscalations = await escalations.find({ ladder: { $in: ['pharmacy', 'pharmacy-query'] } }).select('_id').lean<any[]>();
  await Promise.all([
    orders.deleteMany({}),
    lines.deleteMany({}),
    locations.deleteMany({}),
    batches.deleteMany({}),
    movements.deleteMany({}),
    snapshots.deleteMany({}),
    levels.deleteMany({}),
    messages.deleteMany({ $or: [{ from: 'pharmacy' }, { case: { $in: oldCaseIds } }] }),
    clocks.deleteMany({ $or: [{ def: /^pharmacy-/ }, { case: { $in: oldCaseIds } }] }),
    escalations.deleteMany({ ladder: { $in: ['pharmacy', 'pharmacy-query'] } }),
    // Every pharmacy alert, whatever its type: an escalation that found none makes its own.
    alerts.deleteMany({ $or: [{ link: { $in: oldEscalations.map((e) => `escalation:${e._id}`) } }, { link: /^pharmacy-/ }] }),
    prescriptions.deleteMany({ type: PHARMACY_DEMO_RX }),
    cases.deleteMany({ openedBy: 'pharmacy' }),
    timeline.deleteMany({ title: { $in: oldCases.map((c) => `Case ${c.number} opened`) } }),
    counters.deleteMany({ key: 'pharmacy-order' }),
  ]);

  // The titles and ladders the pharmacy escalations use, if the Coordinator seed has not made them; and who holds them.
  for (const t of DEFAULT_TITLES) await titles.updateOne({ key: t.key }, { $setOnInsert: { key: t.key, label: t.label, holders: [] } }, { upsert: true });
  for (const l of DEFAULT_LADDERS) await ladders.updateOne({ key: l.key }, { $setOnInsert: { key: l.key, label: l.label, steps: l.steps } }, { upsert: true });
  const duty = await users.findOne({ email: 'pharmacy@medios.ai' }).select('_id').lean<any>();
  if (duty) await titles.updateOne({ key: 'pharmacist-on-duty' }, { $set: { holders: [duty._id] } });
  else console.log('Pharmacy seed: no user pharmacy@medios.ai; the pharmacist-on-duty title keeps its holders.');

  messageDocs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const c of caseDocs) c.updatedAt = new Date(Math.min(nowMs, Math.max(touchedCases.get(String(c._id)) ?? 0, (c.createdAt as Date).getTime())));
  // Mongoose keeps createdAt and updatedAt when they are given, so these times stay as set above.
  if (caseDocs.length) await cases.insertMany(caseDocs);
  if (rxDocs.length) await prescriptions.insertMany(rxDocs);
  await orders.insertMany(orderDocs);
  await lines.insertMany(lineDocs);
  await locations.insertMany(locationDocs);
  await batches.insertMany(batchDocs);
  await movements.insertMany(movementDocs);
  await levels.insertMany(levelDocs);
  await messages.insertMany(messageDocs);
  await clocks.insertMany(clockDocs);
  await alerts.insertMany(alertDocs);
  if (milestones.length) await timeline.insertMany(milestones);
  await snapshots.insertMany(points);
  await counters.updateOne({ key: 'pharmacy-order' }, { $set: { last: orderDocs.length } }, { upsert: true });
  await counters.updateOne({ key: 'case' }, { $max: { last: caseSerial } }, { upsert: true });
  // The Pharmacy agent joined these cases: the Coordinator lists it with their agents.
  await cases.updateMany({ _id: { $in: [...joined].map((id) => new Types.ObjectId(id)) } }, { $addToSet: { agents: 'pharmacy' } }, { timestamps: false });
  // The existing demo prescription is in Pharmacy now, at revision 1 with nothing pending, so the reconcile pass has nothing to send.
  if (fixtureRx && orderDocs.some((o) => String(o.prescription) === String(fixtureRx._id))) {
    await prescriptions.updateOne({ _id: fixtureRx._id }, { $set: { pharmacyRev: 1, pharmacyBy: { id: doctor.id, name: doctor.name } }, $unset: { pharmacyPending: '' } }, { timestamps: false });
  }

  console.log(`✅ ${orderDocs.length} pharmacy orders, ${lineDocs.length} lines, ${batchDocs.length} batches, ${lowKeys.length} low, ${points.length} snapshots`);
}
