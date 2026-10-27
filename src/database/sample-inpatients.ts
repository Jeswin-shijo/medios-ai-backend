import { Feature, Need, PatientGender, RoomClass, WardType } from '../modules/beds/bed-types';
import { SnapshotExpected, SnapshotTotals, SnapshotTypeCounts } from '../modules/beds/schemas/bed-snapshot.schema';

// Pure, deterministic generators for the demo seed: made-up inpatients, a week of bed
// counts and a few past bed requests. No database and no clock reads.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Small seeded random generator: the same seed always gives the same numbers. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, list: readonly T[]): T => list[Math.floor(r() * list.length)];

const MALE_NAMES = ['Arun', 'Karthik', 'Suresh', 'Murugan', 'Ramesh', 'Vijay', 'Anand', 'Selvam', 'Prakash', 'Manoj', 'Rajan', 'Sajeev', 'Anil', 'Biju', 'Jayakumar', 'Senthil', 'Dinesh', 'Thomas', 'Joseph', 'Vishnu'];
const FEMALE_NAMES = ['Lakshmi', 'Meena', 'Kavitha', 'Priya', 'Deepa', 'Anitha', 'Revathi', 'Saranya', 'Geetha', 'Sumathi', 'Remya', 'Sreeja', 'Latha', 'Mary', 'Annamma', 'Radha', 'Divya', 'Nithya', 'Shobana', 'Bindu'];
const SURNAMES = ['Kumar', 'Nair', 'Pillai', 'Raj', 'Subramanian', 'Menon', 'Krishnan', 'Thomas', 'Selvaraj', 'Varghese', 'Murugesan', 'Chandran', 'Iyer', 'Devadas', 'Ganesan', 'Joseph', 'Mathew', 'Natarajan'];
const DOCTORS = ['Dr. Shajin', 'Dr. Anitha Kumar', 'Dr. Rajesh Menon', 'Dr. Priya Nair'];

const NOTES: Partial<Record<WardType, string[]>> = {
  icu: ['Post-operative monitoring', 'Respiratory support, weaning'],
  hdu: ['Observation after cardiac event', 'Step-down monitoring'],
  paediatric: ['Fever and dehydration', 'Chest infection'],
  maternity: ['Post-delivery care', 'Antenatal observation'],
  isolation: ['Suspected infectious illness'],
};
const GENERAL_NOTES = ['Fever, under treatment', 'Post-operative care', 'Uncontrolled sugar levels', 'Observation and tests', 'Infection, on IV antibiotics'];

export interface SampleBed {
  label: string;
  wardName?: string;
  wardType: WardType;
  occupantGender: PatientGender;
  nearDepartments: string[];
  features?: readonly Feature[];
}

export interface SampleAdmission {
  /** The bed's label: how the seed finds the bed. */
  label: string;
  wardName: string;
  wardType: WardType;
  features: Feature[];
  name: string;
  uhid: string;
  age: number;
  gender: PatientGender;
  department: string;
  doctor: string;
  roomClass: RoomClass;
  needs: Need[];
  notes: string;
  admittedAt: Date;
  expectedStayDays: number;
}

const AGE_BANDS: Partial<Record<WardType, [number, number]>> = {
  paediatric: [1, 13],
  maternity: [20, 38],
  icu: [45, 80],
  hdu: [45, 80],
};

function needsFor(r: Rng, type: WardType): Need[] {
  switch (type) {
    case 'icu':
      return r() < 0.35 ? ['monitor', 'oxygen', 'ventilator'] : ['monitor', 'oxygen'];
    case 'hdu':
      return ['monitor'];
    case 'isolation':
      return ['isolation', 'oxygen'];
    case 'maternity':
      return ['pregnant'];
    case 'emergency':
      return r() < 0.5 ? ['oxygen'] : [];
    default:
      return r() < 0.15 ? ['oxygen'] : r() < 0.1 ? ['highFallRisk'] : [];
  }
}

/** One made-up inpatient per bed, admitted 0 to 9 days before `demoNow` (the clinic clock). */
export function sampleInpatients(beds: SampleBed[], demoNow: Date): SampleAdmission[] {
  const r = mulberry32(20261026);
  const used = new Set<string>();
  return beds.map((bed) => {
    let uhid: string;
    do uhid = `MHK20269${String(int(r, 0, 9999)).padStart(4, '0')}`;
    while (used.has(uhid));
    used.add(uhid);

    const first = pick(r, bed.occupantGender === 'Female' ? FEMALE_NAMES : MALE_NAMES);
    const [lo, hi] = AGE_BANDS[bed.wardType] ?? [18, 80];
    const stay = int(r, 2, 12);
    // Skewed to recent days, so only a realistic share of stays fall due within a day.
    const admittedAt = new Date(demoNow.getTime() - Math.floor(r() ** 2 * 9 * DAY));
    return {
      label: bed.label,
      wardName: bed.wardName ?? '',
      wardType: bed.wardType,
      features: [...(bed.features ?? [])],
      name: `${first} ${pick(r, SURNAMES)}`,
      uhid,
      age: int(r, lo, hi),
      gender: bed.occupantGender,
      department: bed.nearDepartments[0] ?? 'General Medicine',
      doctor: pick(r, DOCTORS),
      roomClass: bed.wardType === 'isolation' ? 'general' : bed.wardType,
      needs: needsFor(r, bed.wardType),
      notes: pick(r, NOTES[bed.wardType] ?? GENERAL_NOTES),
      admittedAt,
      expectedStayDays: stay,
    };
  });
}

export interface SnapshotCounts {
  totals: SnapshotTotals;
  byType: Partial<Record<WardType, SnapshotTypeCounts>>;
}

export interface SnapshotPoint extends SnapshotCounts {
  /** The real moment, cut to the hour. */
  hour: Date;
  expected: SnapshotExpected;
}

/**
 * Hourly bed counts for `days` days before `realNow` (the hour of `realNow` itself is left
 * out: the app takes that snapshot). Occupancy follows a daily curve (busier by day) with a
 * little noise around the current occupancy, and never goes past what the beds allow.
 */
export function snapshotHistory(realNow: Date, current: SnapshotCounts, days = 7): SnapshotPoint[] {
  const r = mulberry32(7020261);
  const last = Math.floor(realNow.getTime() / HOUR) * HOUR;
  const types = Object.keys(current.byType) as WardType[];
  const points: SnapshotPoint[] = [];
  for (let i = days * 24; i >= 1; i--) {
    const hour = new Date(last - i * HOUR);
    const h = hour.getUTCHours();
    // Busiest mid-morning, quietest at night: about +-5% of the beds, plus a slow drift over the week.
    const curve = Math.sin(((h - 4) / 24) * 2 * Math.PI);
    const delta = (0.05 * curve - 0.02 * (i / 24 / days) + (r() - 0.5) * 0.02) * current.totals.total;

    const byType: SnapshotPoint['byType'] = {};
    const totals: SnapshotTotals = { total: 0, occupied: 0, free: 0, cleaning: 0, blocked: 0, held: 0 };
    for (const type of types) {
      const c = current.byType[type]!;
      const share = c.total / current.totals.total;
      const cleaning = Math.min(c.cleaning, c.total - c.blocked);
      const occupied = Math.max(0, Math.min(c.total - c.blocked - cleaning, Math.round(c.occupied + delta * share)));
      const counts = { total: c.total, occupied, free: c.total - c.blocked - cleaning - occupied, cleaning, blocked: c.blocked };
      byType[type] = counts;
      totals.total += counts.total;
      totals.occupied += counts.occupied;
      totals.free += counts.free;
      totals.cleaning += counts.cleaning;
      totals.blocked += counts.blocked;
    }
    const expected = { discharges: Math.max(0, Math.round(15 + 4 * curve + (r() - 0.5) * 6)), admissions: Math.max(0, Math.round(11 + 2 * curve + (r() - 0.5) * 4)) };
    points.push({ hour, totals, byType, expected });
  }
  return points;
}

export interface PastRequest {
  admission: SampleAdmission;
  by: 'ai' | 'rules';
  priority: 'critical' | 'high' | 'medium' | 'low';
  requestedByName: string;
  requestedAt: Date;
  assignedAt: Date;
  reason: string;
}

const FEATURE_WORDS: Partial<Record<Feature, string>> = {
  oxygen: 'oxygen point',
  monitor: 'a monitor',
  ventilator: 'a ventilator',
  nearNurses: 'close to the nurses',
  singleRoom: 'a single room',
  attendantBed: 'an attendant bed',
};

function reasonFor(a: SampleAdmission, by: 'ai' | 'rules'): string {
  const words = a.features.map((f) => FEATURE_WORDS[f]).filter((w): w is string => !!w).slice(0, 2);
  const has = words.length ? `has ${words.join(' and ')}` : 'is free and cleaned';
  const text = by === 'ai' ? `Best fit: ${a.wardName || 'this ward'} ${has}, near ${a.department}.` : `Top-ranked free bed that ${has}.`;
  return text.slice(0, 140);
}

/** Assigned requests for the most recently admitted sample patients, newest first. */
export function pastRequests(admissions: SampleAdmission[], count = 10): PastRequest[] {
  const r = mulberry32(5120261);
  return [...admissions]
    .sort((x, y) => y.admittedAt.getTime() - x.admittedAt.getTime())
    .slice(0, count)
    .map((admission, i) => {
      const by = i % 3 === 2 ? 'rules' : 'ai';
      const assignedAt = new Date(admission.admittedAt.getTime() - int(r, 2, 10) * MINUTE);
      const critical = admission.wardType === 'icu' || admission.wardType === 'hdu';
      return {
        admission,
        by,
        priority: critical ? 'critical' : pick(r, ['high', 'medium', 'medium', 'low'] as const),
        requestedByName: pick(r, DOCTORS.slice(0, 2)),
        requestedAt: new Date(assignedAt.getTime() - int(r, 5, 45) * MINUTE),
        assignedAt,
        reason: reasonFor(admission, by),
      };
    });
}
