// Pure ER rules: triage suggestion, pathways and clock targets.
// No Nest, no database. Fixed rules decide; the AI never does.

export type TriageColour = 'red' | 'orange' | 'yellow' | 'green';
export type BedPriority = 'critical' | 'high' | 'medium' | 'low';

export const COLOUR_RANK: Record<TriageColour, number> = { red: 0, orange: 1, yellow: 2, green: 3 };

/** Minutes from arrival to a doctor, by colour. Fixed in code. */
export const DOCTOR_TARGET_MIN: Record<TriageColour, number> = { red: 10, orange: 30, yellow: 120, green: 240 };

export const BED_PRIORITY: Record<TriageColour, BedPriority> = {
  red: 'critical',
  orange: 'high',
  yellow: 'medium',
  green: 'low',
};

export type ComplaintKey =
  | 'chest-pain'
  | 'chest-pain-severe'
  | 'breathing'
  | 'stroke-signs'
  | 'unresponsive'
  | 'seizure'
  | 'major-trauma'
  | 'head-injury'
  | 'abdominal-pain'
  | 'fever'
  | 'vomiting-dehydration'
  | 'fracture'
  | 'pregnancy-bleeding-pain'
  | 'other';

export const COMPLAINTS: { key: ComplaintKey; label: string }[] = [
  { key: 'chest-pain', label: 'Chest pain' },
  { key: 'chest-pain-severe', label: 'Chest pain with sweating or breathlessness' },
  { key: 'breathing', label: 'Breathing difficulty' },
  { key: 'stroke-signs', label: 'Stroke signs (face, arm, speech)' },
  { key: 'unresponsive', label: 'Unresponsive' },
  { key: 'seizure', label: 'Seizure now' },
  { key: 'major-trauma', label: 'Major trauma' },
  { key: 'head-injury', label: 'Head injury' },
  { key: 'abdominal-pain', label: 'Abdominal pain' },
  { key: 'fever', label: 'Fever' },
  { key: 'vomiting-dehydration', label: 'Vomiting with dehydration' },
  { key: 'fracture', label: 'Fracture without deformity' },
  { key: 'pregnancy-bleeding-pain', label: 'Pregnancy with bleeding or pain' },
  { key: 'other', label: 'Other' },
];

const COMPLAINT_COLOUR: Partial<Record<ComplaintKey, TriageColour>> = {
  unresponsive: 'red',
  seizure: 'red',
  'major-trauma': 'red',
  'chest-pain-severe': 'red',
  'chest-pain': 'orange',
  'stroke-signs': 'orange',
  breathing: 'orange',
  'pregnancy-bleeding-pain': 'orange',
  fever: 'yellow',
  'vomiting-dehydration': 'yellow',
  fracture: 'yellow',
};

export type TriageVitals = {
  spo2?: number;
  bpSystolic?: number;
  heartRate?: number;
  respiratoryRate?: number;
  temperature?: number;
};

const has = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

type Hit = { colour: TriageColour; reason: string };

function vitalHits(v: TriageVitals): Hit[] {
  const hits: Hit[] = [];
  if (has(v.spo2)) {
    const t = `SpO₂ ${v.spo2}%`;
    if (v.spo2 < 90) hits.push({ colour: 'red', reason: `${t} (under 90%)` });
    else if (v.spo2 < 94) hits.push({ colour: 'orange', reason: `${t} (under 94%)` });
    else if (v.spo2 < 96) hits.push({ colour: 'yellow', reason: `${t} (under 96%)` });
  }
  if (has(v.bpSystolic)) {
    const t = `Systolic BP ${v.bpSystolic}`;
    if (v.bpSystolic < 90) hits.push({ colour: 'red', reason: `${t} (under 90)` });
    else if (v.bpSystolic <= 100) hits.push({ colour: 'yellow', reason: `${t} (100 or under)` });
    else if (v.bpSystolic > 200) hits.push({ colour: 'orange', reason: `${t} (over 200)` });
    else if (v.bpSystolic > 160) hits.push({ colour: 'yellow', reason: `${t} (over 160)` });
  }
  if (has(v.heartRate)) {
    const t = `Heart rate ${v.heartRate}`;
    if (v.heartRate > 130) hits.push({ colour: 'red', reason: `${t} (over 130)` });
    else if (v.heartRate < 40) hits.push({ colour: 'red', reason: `${t} (under 40)` });
    else if (v.heartRate > 100) hits.push({ colour: 'yellow', reason: `${t} (over 100)` });
    else if (v.heartRate <= 50) hits.push({ colour: 'yellow', reason: `${t} (50 or under)` });
  }
  if (has(v.respiratoryRate)) {
    const t = `Respiratory rate ${v.respiratoryRate}`;
    if (v.respiratoryRate > 30) hits.push({ colour: 'red', reason: `${t} (over 30)` });
    else if (v.respiratoryRate < 8) hits.push({ colour: 'red', reason: `${t} (under 8)` });
    else if (v.respiratoryRate > 20) hits.push({ colour: 'yellow', reason: `${t} (over 20)` });
  }
  if (has(v.temperature)) {
    if (hasSepsisSigns(v)) {
      hits.push({
        colour: 'orange',
        reason: `Temperature ${v.temperature} °C with heart rate ${v.heartRate} (sepsis signs)`,
      });
    } else if (v.temperature >= 38) {
      hits.push({ colour: 'yellow', reason: `Temperature ${v.temperature} °C (38 or over)` });
    }
  }
  return hits;
}

function hasSepsisSigns(v: TriageVitals): boolean {
  return has(v.temperature) && has(v.heartRate) && v.temperature >= 39 && v.heartRate > 110;
}

export function suggestTriage(input: {
  complaint: ComplaintKey;
  vitals: TriageVitals;
  painScore?: number;
}): { colour: TriageColour; reasons: string[] } {
  const hits: Hit[] = [];
  const complaintColour = COMPLAINT_COLOUR[input.complaint];
  if (complaintColour) {
    const label = COMPLAINTS.find((c) => c.key === input.complaint)?.label ?? input.complaint;
    hits.push({ colour: complaintColour, reason: `Complaint: ${label.toLowerCase()}` });
  }
  hits.push(...vitalHits(input.vitals));
  const pain = input.painScore;
  if (has(pain)) {
    if (pain >= 7) hits.push({ colour: 'orange', reason: `Pain ${pain}/10` });
    else if (pain >= 4) hits.push({ colour: 'yellow', reason: `Pain ${pain}/10` });
  }
  // Array.sort is stable: rule order is kept inside one colour.
  hits.sort((a, b) => COLOUR_RANK[a.colour] - COLOUR_RANK[b.colour]);
  const reasons = hits.map((h) => h.reason);
  const colour: TriageColour = hits[0]?.colour ?? 'green';
  if (!hits.length) reasons.push('No red flags');
  const v = input.vitals;
  if (![v.spo2, v.bpSystolic, v.heartRate, v.respiratoryRate, v.temperature].some(has)) {
    reasons.push('Vitals not recorded');
  }
  return { colour, reasons };
}

export type StepKey = 'ecg' | 'doctor' | 'ct' | 'last-known-well' | 'cultures' | 'antibiotics';
export type PathwayKey = 'chest-pain' | 'stroke' | 'sepsis';

export const PATHWAYS: Record<
  PathwayKey,
  { label: string; steps: { key: StepKey; label: string; defaultMin: number }[] }
> = {
  'chest-pain': {
    label: 'Chest pain',
    steps: [
      { key: 'ecg', label: 'ECG done', defaultMin: 10 },
      { key: 'doctor', label: 'Seen by a doctor', defaultMin: 15 },
    ],
  },
  stroke: {
    label: 'Stroke signs',
    steps: [
      { key: 'doctor', label: 'Seen by a doctor', defaultMin: 10 },
      { key: 'ct', label: 'CT scan done', defaultMin: 25 },
      { key: 'last-known-well', label: 'Last known well recorded', defaultMin: 10 },
    ],
  },
  sepsis: {
    label: 'Sepsis signs',
    steps: [
      { key: 'doctor', label: 'Seen by a doctor', defaultMin: 15 },
      { key: 'cultures', label: 'Blood cultures taken', defaultMin: 45 },
      { key: 'antibiotics', label: 'Antibiotics given', defaultMin: 60 },
    ],
  },
};

const PATHWAY_ORDER: PathwayKey[] = ['chest-pain', 'stroke', 'sepsis'];

export function pathwaysFor(complaint: ComplaintKey, vitals: TriageVitals): PathwayKey[] {
  const found = new Set<PathwayKey>();
  if (complaint === 'chest-pain' || complaint === 'chest-pain-severe') found.add('chest-pain');
  if (complaint === 'stroke-signs') found.add('stroke');
  if (hasSepsisSigns(vitals)) found.add('sepsis');
  return PATHWAY_ORDER.filter((p) => found.has(p));
}

/** Every `<pathway>.<step>` target in minutes; valid overrides (integer 1-240, known key) replace defaults. */
export function pathwayTargets(overrides?: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of PATHWAY_ORDER) {
    for (const s of PATHWAYS[p].steps) out[`${p}.${s.key}`] = s.defaultMin;
  }
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 240) out[key] = value;
    }
  }
  return out;
}

/** The smaller of the colour's target and any running pathway's doctor step. */
export function doctorDueMinutes(
  colour: TriageColour,
  pathways: PathwayKey[],
  targets: Record<string, number>,
): number {
  let min = DOCTOR_TARGET_MIN[colour];
  for (const p of pathways) {
    const fallback = PATHWAYS[p].steps.find((s) => s.key === 'doctor')?.defaultMin;
    const t = targets[`${p}.doctor`] ?? fallback;
    if (typeof t === 'number' && t < min) min = t;
  }
  return min;
}
