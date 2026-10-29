// Lab test catalogue and flag rules. Pure: no Nest, no database, no imports.
export type Priority = 'stat' | 'urgent' | 'routine';
export type TubeKey = 'edta' | 'serum' | 'fluoride' | 'citrate' | 'abg-syringe' | 'culture' | 'urine';

export const TUBE_ORDER: TubeKey[] = ['edta', 'serum', 'fluoride', 'citrate', 'abg-syringe', 'culture', 'urine'];

export const TUBE_LABEL: Record<TubeKey, string> = {
  edta: 'EDTA (lavender)',
  serum: 'Serum (gold)',
  fluoride: 'Fluoride (grey)',
  citrate: 'Citrate (blue)',
  'abg-syringe': 'Heparin syringe',
  culture: 'Culture bottles',
  urine: 'Urine container',
};

export interface LabParameterDef {
  name: string;
  unit: string;
  low?: number;
  high?: number;
  text?: true;
}

export interface LabTestDef {
  key: string;
  label: string;
  tube: TubeKey;
  category: string;
  params: LabParameterDef[];
  tat: { stat: number; routine: number };
}

export const LAB_TESTS: LabTestDef[] = [
  {
    key: 'cbc', label: 'Complete blood count', tube: 'edta', category: 'Hematology',
    params: [
      { name: 'Haemoglobin', unit: 'g/dL', low: 12, high: 16 },
      { name: 'WBC', unit: '×10³/µL', low: 4, high: 11 },
      { name: 'Platelets', unit: '×10³/µL', low: 150, high: 450 },
    ],
    tat: { stat: 30, routine: 120 },
  },
  {
    key: 'crp', label: 'CRP', tube: 'serum', category: 'Biochemistry',
    params: [{ name: 'CRP', unit: 'mg/L', low: 0, high: 5 }],
    tat: { stat: 60, routine: 240 },
  },
  {
    key: 'rft', label: 'Kidney function', tube: 'serum', category: 'Biochemistry',
    params: [
      { name: 'Creatinine', unit: 'mg/dL', low: 0.6, high: 1.2 },
      { name: 'Urea', unit: 'mg/dL', low: 15, high: 40 },
    ],
    tat: { stat: 60, routine: 240 },
  },
  {
    key: 'electrolytes', label: 'Electrolytes', tube: 'serum', category: 'Biochemistry',
    params: [
      { name: 'Sodium', unit: 'mmol/L', low: 135, high: 145 },
      { name: 'Potassium', unit: 'mmol/L', low: 3.5, high: 5.1 },
    ],
    tat: { stat: 45, routine: 240 },
  },
  {
    key: 'lft', label: 'Liver function', tube: 'serum', category: 'Biochemistry',
    params: [
      { name: 'Bilirubin', unit: 'mg/dL', low: 0.2, high: 1.2 },
      { name: 'ALT', unit: 'U/L', low: 7, high: 56 },
      { name: 'Albumin', unit: 'g/dL', low: 3.5, high: 5 },
    ],
    tat: { stat: 120, routine: 360 },
  },
  {
    key: 'glucose', label: 'Blood sugar (random)', tube: 'fluoride', category: 'Biochemistry',
    params: [{ name: 'Glucose', unit: 'mg/dL', low: 70, high: 140 }],
    tat: { stat: 30, routine: 120 },
  },
  {
    key: 'hba1c', label: 'HbA1c', tube: 'edta', category: 'Biochemistry',
    params: [{ name: 'HbA1c', unit: '%', low: 4, high: 5.6 }],
    tat: { stat: 240, routine: 720 },
  },
  {
    key: 'lipid', label: 'Lipid profile', tube: 'serum', category: 'Biochemistry',
    params: [
      { name: 'Total cholesterol', unit: 'mg/dL', low: 0, high: 200 },
      { name: 'LDL', unit: 'mg/dL', low: 0, high: 100 },
      { name: 'HDL', unit: 'mg/dL', low: 40, high: 100 },
      { name: 'Triglycerides', unit: 'mg/dL', low: 0, high: 150 },
    ],
    tat: { stat: 240, routine: 720 },
  },
  {
    key: 'coag', label: 'Clotting (PT/INR)', tube: 'citrate', category: 'Blood',
    params: [
      { name: 'PT', unit: 's', low: 11, high: 13.5 },
      { name: 'INR', unit: '–', low: 0.8, high: 1.2 },
    ],
    tat: { stat: 45, routine: 240 },
  },
  {
    key: 'troponin', label: 'Troponin I', tube: 'serum', category: 'Biochemistry',
    params: [{ name: 'Troponin I', unit: 'ng/mL', low: 0, high: 0.04 }],
    tat: { stat: 60, routine: 120 },
  },
  {
    key: 'ddimer', label: 'D-dimer', tube: 'citrate', category: 'Blood',
    params: [{ name: 'D-dimer', unit: 'ng/mL FEU', low: 0, high: 500 }],
    tat: { stat: 60, routine: 240 },
  },
  {
    key: 'abg', label: 'Blood gas (ABG)', tube: 'abg-syringe', category: 'Blood',
    params: [
      { name: 'pH', unit: '–', low: 7.35, high: 7.45 },
      { name: 'pCO₂', unit: 'mmHg', low: 35, high: 45 },
      { name: 'pO₂', unit: 'mmHg', low: 80, high: 100 },
    ],
    tat: { stat: 15, routine: 30 },
  },
  {
    key: 'thyroid', label: 'Thyroid profile', tube: 'serum', category: 'Biochemistry',
    params: [{ name: 'TSH', unit: 'mIU/L', low: 0.4, high: 4 }],
    tat: { stat: 180, routine: 720 },
  },
  {
    key: 'blood-culture', label: 'Blood culture', tube: 'culture', category: 'Others',
    params: [{ name: 'Result', unit: '', text: true }],
    tat: { stat: 1440, routine: 2880 },
  },
  {
    key: 'urine', label: 'Urine routine', tube: 'urine', category: 'Urine',
    params: [
      { name: 'Protein', unit: '', text: true },
      { name: 'Sugar', unit: '', text: true },
      { name: 'Pus cells', unit: '/hpf', low: 0, high: 5 },
      { name: 'RBC', unit: '/hpf', low: 0, high: 2 },
    ],
    tat: { stat: 60, routine: 240 },
  },
];

/** The reference range as text, e.g. "3.5–5.1" or "≥ 40". */
export function rangeText(test: string, p: LabParameterDef): string {
  if (p.text) return test === 'blood-culture' ? 'No growth' : 'Negative';
  if (p.low !== undefined && p.high !== undefined) return `${p.low}–${p.high}`;
  return p.low !== undefined ? `≥ ${p.low}` : p.high !== undefined ? `≤ ${p.high}` : '';
}

export function testByKey(key: string): LabTestDef | undefined {
  return LAB_TESTS.find((t) => t.key === key);
}

export const COLLECT_MINUTES: Record<Priority, number> = { stat: 15, urgent: 60, routine: 240 };

export type CriticalLimit = { low?: number; high?: number; anyAbnormalText?: true };

export const CRITICAL_LIMITS: Record<string, CriticalLimit> = {
  'electrolytes.Potassium': { low: 2.8, high: 6.2 },
  'electrolytes.Sodium': { low: 120, high: 160 },
  'glucose.Glucose': { low: 50, high: 400 },
  'cbc.Haemoglobin': { low: 7 },
  'cbc.Platelets': { low: 20 },
  'cbc.WBC': { low: 2, high: 30 },
  'coag.INR': { high: 5 },
  'troponin.Troponin I': { high: 0.04 },
  'abg.pH': { low: 7.2, high: 7.6 },
  'abg.pO₂': { low: 50 },
  'abg.pCO₂': { high: 70 },
  'blood-culture.Result': { anyAbnormalText: true },
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function effectiveLimits(
  overrides?: Record<string, { low?: number | null; high?: number | null }>,
): Record<string, CriticalLimit> {
  const out: Record<string, CriticalLimit> = {};
  for (const [k, v] of Object.entries(CRITICAL_LIMITS)) out[k] = { ...v };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const [k, o] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(CRITICAL_LIMITS, k) || !o || typeof o !== 'object') continue;
    for (const side of ['low', 'high'] as const) {
      const v = o[side];
      if (v === null) delete out[k][side];
      else if (isNum(v)) out[k][side] = v;
    }
  }
  return out;
}

const validMinutes = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 4320;

export function targetMinutes(
  test: string,
  priority: Priority,
  overrides?: Record<string, { stat?: number; routine?: number }>,
): number {
  const def = testByKey(test);
  if (!def) throw new Error(`Unknown lab test: ${test}`);
  const o = overrides && Object.prototype.hasOwnProperty.call(overrides, test) ? overrides[test] : undefined;
  const stat = validMinutes(o?.stat) ? o.stat : def.tat.stat;
  const routine = validMinutes(o?.routine) ? o.routine : def.tat.routine;
  if (priority === 'stat') return stat;
  if (priority === 'urgent') return stat * 2;
  return routine;
}

const NORMAL_TEXT = ['nil', 'negative', 'no growth'];

export function flagValue(
  test: string,
  param: string,
  value: number | string,
  limits: Record<string, CriticalLimit> = CRITICAL_LIMITS,
): { flag: 'normal' | 'low' | 'high' | 'abnormal'; critical: boolean } {
  const def = testByKey(test);
  if (!def) throw new Error(`Unknown lab test: ${test}`);
  const p = def.params.find((x) => x.name === param);
  if (!p) throw new Error(`Unknown parameter ${param} for test ${test}`);
  const limit = limits[`${test}.${param}`];
  if (p.text) {
    if (typeof value !== 'string') throw new Error(`${test} ${param} needs a text value`);
    const flag = NORMAL_TEXT.includes(value.trim().toLowerCase()) ? 'normal' : 'abnormal';
    return { flag, critical: flag === 'abnormal' && limit?.anyAbnormalText === true };
  }
  if (!isNum(value)) throw new Error(`${test} ${param} needs a number value`);
  let flag: 'normal' | 'low' | 'high' = 'normal';
  if (p.low !== undefined && value < p.low) flag = 'low';
  else if (p.high !== undefined && value > p.high) flag = 'high';
  const critical =
    !!limit &&
    ((limit.low !== undefined && value < limit.low) || (limit.high !== undefined && value > limit.high));
  return { flag, critical };
}

export function groupIntoTubes(tests: string[]): { tube: TubeKey; tests: string[] }[] {
  for (const t of tests) if (!testByKey(t)) throw new Error(`Unknown lab test: ${t}`);
  const wanted = new Set(tests);
  const out: { tube: TubeKey; tests: string[] }[] = [];
  for (const def of LAB_TESTS) {
    if (!wanted.has(def.key)) continue;
    let group = out.find((g) => g.tube === def.tube);
    if (!group) out.push((group = { tube: def.tube, tests: [] }));
    group.tests.push(def.key);
  }
  return out;
}
