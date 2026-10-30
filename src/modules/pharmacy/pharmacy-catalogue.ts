/**
 * Pharmacy Agent: the medicine list. Pure data and helpers, no database.
 * Values come verbatim from the Pharmacy Agent global constraints (spec 5.2).
 */

export type Priority = 'stat' | 'urgent' | 'routine';
export type Frequency = 'STAT' | 'OD' | 'BD' | 'TDS' | 'QID' | 'HS' | 'SOS';
export const DOSES_PER_DAY: Record<Frequency, number> = {
  STAT: 1,
  OD: 1,
  BD: 2,
  TDS: 3,
  QID: 4,
  HS: 1,
  SOS: 4,
};

export type Route = 'oral' | 'sublingual' | 'iv' | 'im' | 'sc' | 'inhaled';
export const ROUTE_LABEL: Record<Route, string> = {
  oral: 'Oral',
  sublingual: 'Sublingual',
  iv: 'IV',
  im: 'IM',
  sc: 'Subcutaneous',
  inhaled: 'Nebulised',
};

export type Form =
  | 'tab'
  | 'cap'
  | 'sl-tab'
  | 'syringe'
  | 'vial'
  | 'mdv'
  | 'ampoule'
  | 'bag'
  | 'bottle'
  | 'nebule'
  | 'sachet';
export const FORM_INFO: Record<
  Form,
  { label: string; issueUnit: string; routes: Route[] }
> = {
  tab: { label: 'tab', issueUnit: 'tablet', routes: ['oral'] },
  cap: { label: 'cap', issueUnit: 'capsule', routes: ['oral'] },
  'sl-tab': { label: 'SL tab', issueUnit: 'tablet', routes: ['sublingual'] },
  syringe: { label: 'syringe', issueUnit: 'syringe', routes: ['sc'] },
  vial: { label: 'inj', issueUnit: 'vial', routes: ['iv'] },
  mdv: { label: 'multi-dose vial', issueUnit: 'vial', routes: ['iv', 'sc'] },
  ampoule: { label: 'ampoule', issueUnit: 'ampoule', routes: ['iv', 'im'] },
  bag: { label: 'IV bag', issueUnit: 'bag', routes: ['iv'] },
  bottle: { label: 'IV bottle', issueUnit: 'bottle', routes: ['iv'] },
  nebule: { label: 'nebule', issueUnit: 'nebule', routes: ['inhaled'] },
  sachet: { label: 'oral sachet', issueUnit: 'sachet', routes: ['oral'] },
};

export type DoseUnit = 'mg' | 'g' | 'mL' | 'IU' | 'mmol';
export type Store = 'main' | 'er';
export const STORE_LABEL: Record<Store, string> = {
  main: 'Main pharmacy',
  er: 'ER',
};

export type ClassKey = string;
export type AllergyGroup = 'penicillin' | 'sulfa' | 'nsaid' | 'aspirin';
export const ALLERGY_ALIASES: Record<AllergyGroup, string[]> = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'augmentin', 'piperacillin'],
  sulfa: ['sulfa', 'sulpha', 'sulfonamide', 'cotrimoxazole', 'septran'],
  nsaid: ['NSAID', 'ibuprofen', 'diclofenac'],
  aspirin: ['aspirin'],
};

export interface ProductDef {
  key: string;
  medicine: string;
  form: Form;
  strength: number;
  unit: DoseUnit;
  issueUnit: string;
  routes: Route[];
  contentPerVial?: number;
  label: string;
}

export interface KidneyRule {
  from: number;
  below: number;
  severity: 'red' | 'amber';
  words: string;
}

export interface MedicineDef {
  key: string;
  name: string;
  unit: DoseUnit;
  classKey: ClassKey;
  classLabel: string;
  allergyGroup?: AllergyGroup;
  maxSingle?: number;
  maxDaily?: number;
  perKg?: { perKg: number; underKg?: number };
  kidney: KidneyRule[];
  aliases: string[];
  products: ProductDef[];
}

const MDV_CONTENT: Record<string, number> = {
  heparin: 25000,
  'insulin-regular': 1000,
};

const ROUTE_OVERRIDES: Record<string, Route[]> = {
  'insulin-regular:mdv': ['sc', 'iv'],
  'ceftriaxone:vial': ['iv', 'im'],
  'hydrocortisone:vial': ['iv', 'im'],
  'morphine:ampoule': ['iv', 'im', 'sc'],
  'adrenaline:ampoule': ['im', 'iv'],
  'potassium-chloride:ampoule': ['iv'],
};

const K = (
  from: number,
  below: number,
  severity: 'red' | 'amber',
  words: string,
): KidneyRule => ({ from, below, severity, words });

const KIDNEY: Record<string, KidneyRule[]> = {
  enoxaparin: [K(0, 30, 'red', 'reduce to once daily')],
  rosuvastatin: [K(0, 30, 'amber', 'max 10 mg')],
  ramipril: [K(0, 30, 'amber', 'start low and check potassium')],
  spironolactone: [K(0, 30, 'red', 'avoid: high potassium risk')],
  metformin: [K(0, 30, 'red', 'avoid'), K(30, 45, 'amber', 'max 1000 mg a day')],
  glimepiride: [K(0, 30, 'amber', 'low blood sugar risk; start low')],
  'amoxicillin-clavulanate': [K(0, 30, 'amber', 'reduce the dose')],
  'piperacillin-tazobactam': [K(0, 40, 'amber', 'reduce the dose')],
  meropenem: [K(0, 50, 'amber', 'reduce the dose')],
  ciprofloxacin: [K(0, 30, 'amber', 'reduce the dose')],
  cotrimoxazole: [K(0, 30, 'amber', 'reduce the dose')],
  vancomycin: [K(0, 50, 'amber', 'dose by blood levels')],
  diclofenac: [
    K(0, 30, 'red', 'avoid'),
    K(30, 60, 'amber', 'use with care; check kidney function'),
  ],
  ibuprofen: [
    K(0, 30, 'red', 'avoid'),
    K(30, 60, 'amber', 'use with care; check kidney function'),
  ],
  tramadol: [K(0, 30, 'amber', 'longer gap between doses')],
  morphine: [K(0, 30, 'amber', 'reduce the dose')],
  levetiracetam: [K(0, 50, 'amber', 'reduce the dose')],
};

type Spec = {
  key: string;
  name: string;
  unit: DoseUnit;
  products: Array<[Form, number[]]>;
  classKey: ClassKey;
  classLabel: string;
  allergy?: AllergyGroup;
  s?: number;
  d?: number;
  perKg?: { perKg: number; underKg?: number };
  aliases?: string[];
};

const SPECS: Spec[] = [
  { key: 'aspirin', name: 'Aspirin', unit: 'mg', products: [['tab', [75, 150, 300]]], classKey: 'antiplatelet-salicylate', classLabel: 'Antiplatelet (salicylate)', allergy: 'aspirin', s: 600, d: 4000 },
  { key: 'clopidogrel', name: 'Clopidogrel', unit: 'mg', products: [['tab', [75]]], classKey: 'antiplatelet-p2y12', classLabel: 'Antiplatelet (P2Y12)', s: 600, d: 600 },
  { key: 'ticagrelor', name: 'Ticagrelor', unit: 'mg', products: [['tab', [90]]], classKey: 'antiplatelet-p2y12', classLabel: 'Antiplatelet (P2Y12)', s: 180, d: 360 },
  { key: 'enoxaparin', name: 'Enoxaparin', unit: 'mg', products: [['syringe', [40, 60, 80]]], classKey: 'anticoagulant-heparin', classLabel: 'Anticoagulant (heparin)', s: 150, perKg: { perKg: 1.1 } },
  { key: 'heparin', name: 'Heparin', unit: 'IU', products: [['mdv', [25000]]], classKey: 'anticoagulant-heparin', classLabel: 'Anticoagulant (heparin)', s: 10000, d: 40000, aliases: ['unfractionated heparin'] },
  { key: 'warfarin', name: 'Warfarin', unit: 'mg', products: [['tab', [1, 2, 5]]], classKey: 'anticoagulant-vka', classLabel: 'Anticoagulant (vitamin K antagonist)', s: 10 },
  { key: 'atorvastatin', name: 'Atorvastatin', unit: 'mg', products: [['tab', [10, 20, 40, 80]]], classKey: 'statin', classLabel: 'Statin', d: 80 },
  { key: 'rosuvastatin', name: 'Rosuvastatin', unit: 'mg', products: [['tab', [5, 10, 20, 40]]], classKey: 'statin', classLabel: 'Statin', d: 40 },
  { key: 'isosorbide-dinitrate', name: 'Isosorbide dinitrate', unit: 'mg', products: [['sl-tab', [5]]], classKey: 'nitrate', classLabel: 'Nitrate', s: 10, aliases: ['isdn'] },
  { key: 'metoprolol', name: 'Metoprolol', unit: 'mg', products: [['tab', [25, 50]]], classKey: 'beta-blocker', classLabel: 'Beta blocker', d: 400 },
  { key: 'ramipril', name: 'Ramipril', unit: 'mg', products: [['cap', [2.5, 5, 10]]], classKey: 'ace-inhibitor', classLabel: 'ACE inhibitor (RAAS)', d: 10 },
  { key: 'telmisartan', name: 'Telmisartan', unit: 'mg', products: [['tab', [40, 80]]], classKey: 'arb', classLabel: 'ARB (RAAS)', d: 80 },
  { key: 'amlodipine', name: 'Amlodipine', unit: 'mg', products: [['tab', [5, 10]]], classKey: 'ccb', classLabel: 'Calcium channel blocker', d: 10 },
  { key: 'furosemide', name: 'Furosemide', unit: 'mg', products: [['tab', [40]], ['ampoule', [20]]], classKey: 'loop-diuretic', classLabel: 'Loop diuretic', d: 600, aliases: ['frusemide'] },
  { key: 'spironolactone', name: 'Spironolactone', unit: 'mg', products: [['tab', [25, 50]]], classKey: 'k-sparing-diuretic', classLabel: 'Potassium-sparing diuretic', d: 100 },
  { key: 'metformin', name: 'Metformin', unit: 'mg', products: [['tab', [500, 1000]]], classKey: 'biguanide', classLabel: 'Biguanide', d: 2550 },
  { key: 'glimepiride', name: 'Glimepiride', unit: 'mg', products: [['tab', [1, 2]]], classKey: 'sulfonylurea', classLabel: 'Sulfonylurea', d: 8 },
  { key: 'insulin-regular', name: 'Insulin regular', unit: 'IU', products: [['mdv', [1000]]], classKey: 'insulin', classLabel: 'Insulin', s: 50, aliases: ['regular insulin', 'human insulin'] },
  { key: 'amoxicillin', name: 'Amoxicillin', unit: 'mg', products: [['cap', [500]]], classKey: 'penicillin', classLabel: 'Penicillin', allergy: 'penicillin', d: 3000, aliases: ['amoxycillin'] },
  { key: 'amoxicillin-clavulanate', name: 'Amoxicillin-clavulanate', unit: 'mg', products: [['tab', [625]]], classKey: 'penicillin', classLabel: 'Penicillin', allergy: 'penicillin', d: 1875, aliases: ['co-amoxiclav', 'augmentin'] },
  { key: 'piperacillin-tazobactam', name: 'Piperacillin-tazobactam', unit: 'g', products: [['vial', [4.5]]], classKey: 'penicillin', classLabel: 'Penicillin', allergy: 'penicillin', d: 18, aliases: ['pip-taz'] },
  { key: 'ceftriaxone', name: 'Ceftriaxone', unit: 'g', products: [['vial', [1]]], classKey: 'cephalosporin', classLabel: 'Cephalosporin', d: 4 },
  { key: 'meropenem', name: 'Meropenem', unit: 'g', products: [['vial', [1]]], classKey: 'carbapenem', classLabel: 'Carbapenem', d: 6 },
  { key: 'azithromycin', name: 'Azithromycin', unit: 'mg', products: [['tab', [500]]], classKey: 'macrolide', classLabel: 'Macrolide', d: 500 },
  { key: 'ciprofloxacin', name: 'Ciprofloxacin', unit: 'mg', products: [['tab', [500]]], classKey: 'fluoroquinolone', classLabel: 'Fluoroquinolone', d: 1500 },
  { key: 'metronidazole', name: 'Metronidazole', unit: 'mg', products: [['tab', [400]], ['bag', [500]]], classKey: 'nitroimidazole', classLabel: 'Nitroimidazole', d: 2000 },
  { key: 'cotrimoxazole', name: 'Cotrimoxazole', unit: 'mg', products: [['tab', [960]]], classKey: 'sulfonamide', classLabel: 'Sulfonamide (sulfa)', allergy: 'sulfa', d: 1920, aliases: ['co-trimoxazole', 'septran'] },
  { key: 'vancomycin', name: 'Vancomycin', unit: 'mg', products: [['vial', [500, 1000]]], classKey: 'glycopeptide', classLabel: 'Glycopeptide', s: 2000, perKg: { perKg: 20 } },
  { key: 'paracetamol', name: 'Paracetamol', unit: 'mg', products: [['tab', [500, 650]], ['bottle', [1000]]], classKey: 'analgesic', classLabel: 'Analgesic', s: 1000, d: 4000, perKg: { perKg: 15, underKg: 50 }, aliases: ['acetaminophen'] },
  { key: 'diclofenac', name: 'Diclofenac', unit: 'mg', products: [['tab', [50]], ['ampoule', [75]]], classKey: 'nsaid', classLabel: 'NSAID', allergy: 'nsaid', d: 150 },
  { key: 'ibuprofen', name: 'Ibuprofen', unit: 'mg', products: [['tab', [400]]], classKey: 'nsaid', classLabel: 'NSAID', allergy: 'nsaid', d: 2400 },
  { key: 'tramadol', name: 'Tramadol', unit: 'mg', products: [['cap', [50]], ['ampoule', [50]]], classKey: 'opioid', classLabel: 'Opioid', d: 400 },
  { key: 'morphine', name: 'Morphine', unit: 'mg', products: [['ampoule', [10]]], classKey: 'opioid', classLabel: 'Opioid', s: 10 },
  { key: 'pantoprazole', name: 'Pantoprazole', unit: 'mg', products: [['tab', [40]], ['vial', [40]]], classKey: 'ppi', classLabel: 'PPI', d: 80 },
  { key: 'omeprazole', name: 'Omeprazole', unit: 'mg', products: [['cap', [20]]], classKey: 'ppi', classLabel: 'PPI', d: 40 },
  { key: 'ondansetron', name: 'Ondansetron', unit: 'mg', products: [['tab', [4]], ['ampoule', [4]]], classKey: 'antiemetic', classLabel: 'Antiemetic', s: 8, d: 24 },
  { key: 'salbutamol', name: 'Salbutamol', unit: 'mg', products: [['nebule', [2.5]]], classKey: 'bronchodilator', classLabel: 'Bronchodilator', s: 5, aliases: ['albuterol'] },
  { key: 'hydrocortisone', name: 'Hydrocortisone', unit: 'mg', products: [['vial', [100]]], classKey: 'steroid', classLabel: 'Steroid', d: 400 },
  { key: 'adrenaline', name: 'Adrenaline', unit: 'mg', products: [['ampoule', [1]]], classKey: 'emergency', classLabel: 'Emergency', s: 1, aliases: ['epinephrine'] },
  { key: 'levetiracetam', name: 'Levetiracetam', unit: 'mg', products: [['tab', [500]], ['vial', [500]]], classKey: 'antiepileptic', classLabel: 'Antiepileptic', d: 3000 },
  { key: 'cetirizine', name: 'Cetirizine', unit: 'mg', products: [['tab', [10]]], classKey: 'antihistamine', classLabel: 'Antihistamine', d: 10 },
  { key: 'potassium-chloride', name: 'Potassium chloride', unit: 'mmol', products: [['sachet', [20]], ['ampoule', [20]]], classKey: 'potassium', classLabel: 'Potassium supplement', s: 40, aliases: ['kcl'] },
  { key: 'normal-saline', name: 'Normal saline 0.9%', unit: 'mL', products: [['bag', [500]]], classKey: 'iv-fluid', classLabel: 'IV fluid', aliases: ['ns', 'sodium chloride 0.9%'] },
  { key: 'ringer-lactate', name: 'Ringer lactate', unit: 'mL', products: [['bag', [500]]], classKey: 'iv-fluid', classLabel: 'IV fluid', aliases: ['rl', "ringer's lactate"] },
];

function buildProducts(s: Spec): ProductDef[] {
  const out: ProductDef[] = [];
  for (const [form, strengths] of s.products) {
    const info = FORM_INFO[form];
    for (const strength of strengths) {
      out.push({
        key: `${s.key}-${form}-${strength}`,
        medicine: s.key,
        form,
        strength,
        unit: s.unit,
        issueUnit: info.issueUnit,
        routes: ROUTE_OVERRIDES[`${s.key}:${form}`] ?? info.routes,
        ...(form === 'mdv' ? { contentPerVial: MDV_CONTENT[s.key] } : {}),
        label: `${s.name} ${info.label} ${strength} ${s.unit}`,
      });
    }
  }
  return out;
}

export const MEDICINES: MedicineDef[] = SPECS.map((s) => ({
  key: s.key,
  name: s.name,
  unit: s.unit,
  classKey: s.classKey,
  classLabel: s.classLabel,
  ...(s.allergy ? { allergyGroup: s.allergy } : {}),
  ...(s.s !== undefined ? { maxSingle: s.s } : {}),
  ...(s.d !== undefined ? { maxDaily: s.d } : {}),
  ...(s.perKg ? { perKg: s.perKg } : {}),
  kidney: KIDNEY[s.key] ?? [],
  aliases: s.aliases ?? [],
  products: buildProducts(s),
}));

const BY_KEY = new Map(MEDICINES.map((m) => [m.key, m]));
const PRODUCT_BY_KEY = new Map(
  MEDICINES.flatMap((m) => m.products).map((p) => [p.key, p]),
);

export function medicineByKey(key: string): MedicineDef | undefined {
  return BY_KEY.get(key);
}
export function productByKey(key: string): ProductDef | undefined {
  return PRODUCT_BY_KEY.get(key);
}

/** The other medicines (keys) of the same class. */
export function sameKind(medicine: string): string[] {
  const m = BY_KEY.get(medicine);
  if (!m) return [];
  return MEDICINES.filter(
    (x) => x.classKey === m.classKey && x.key !== m.key,
  ).map((x) => x.key);
}

/** Quantity to issue in the product's issue unit; null when the duration is unknown. */
export function quantityFor(
  product: ProductDef,
  dose: number,
  frequency: Frequency,
  durationDays: number | null,
): number | null {
  const perDay = frequency === 'STAT' ? 1 : DOSES_PER_DAY[frequency];
  const days = frequency === 'STAT' ? 1 : durationDays;
  if (days === null || days === undefined) return null;
  const ceil = (x: number) => Math.ceil(x - 1e-9);
  if (product.contentPerVial) {
    return Math.max(1, ceil((dose * perDay * days) / product.contentPerVial));
  }
  return ceil(dose / product.strength) * perDay * days;
}

const FORM_WORD =
  /^(tab|tablet|cap|capsule|inj|injection|syp|syrup|neb|iv)\.?\s+/;
const STRENGTH_TOKEN = /(^|\s)\d+(?:\.\d+)?\s*(?:mg|g|ml|iu|mmol|mcg|%)?(?=\s|$)/g;

function normalise(text: string): string {
  let t = text.toLowerCase().trim();
  t = t.replace(FORM_WORD, '');
  t = t.replace(/-/g, ' ');
  t = t.replace(STRENGTH_TOKEN, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

const NAME_INDEX = new Map<string, MedicineDef>();
for (const m of MEDICINES) {
  for (const n of [m.name, m.key, ...m.aliases]) {
    const k = normalise(n);
    if (k && !NAME_INDEX.has(k)) NAME_INDEX.set(k, m);
  }
}

/** Exact match of a typed medicine name, after normalising. */
export function matchMedicine(text: string): MedicineDef | null {
  const k = normalise(text);
  return k ? (NAME_INDEX.get(k) ?? null) : null;
}

export function parseDose(
  text: string,
): { value: number; unit: DoseUnit } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mg|g|ml|iu|units?|mmol)\s*$/i.exec(text);
  if (!m) return null;
  const u = m[2].toLowerCase();
  const unit: DoseUnit =
    u === 'ml' ? 'mL' : u === 'iu' || u.startsWith('unit') ? 'IU' : (u as DoseUnit);
  return { value: Number(m[1]), unit };
}

export function parseDurationDays(text: string): number | null {
  const m = /^\s*(\d+)\s*(days?|day\(s\)|weeks?|week\(s\))\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase().startsWith('w') ? 7 : 1);
  return n >= 1 && n <= 365 ? n : null;
}

const ROUTE_WORDS: Record<string, Route> = {
  oral: 'oral',
  po: 'oral',
  sublingual: 'sublingual',
  sl: 'sublingual',
  iv: 'iv',
  intravenous: 'iv',
  im: 'im',
  intramuscular: 'im',
  sc: 'sc',
  subcutaneous: 'sc',
  inhaled: 'inhaled',
  nebulised: 'inhaled',
  nebulized: 'inhaled',
  inhalation: 'inhaled',
};

function routeFromText(text?: string): Route | null {
  if (!text) return null;
  return ROUTE_WORDS[text.trim().toLowerCase()] ?? null;
}

export function routeFor(product: ProductDef, routeText?: string): Route {
  const r = routeFromText(routeText);
  return r && product.routes.includes(r) ? r : product.routes[0];
}

export function pickProduct(
  med: MedicineDef,
  dose: number | null,
  routeText?: string,
): ProductDef {
  const r = routeFromText(routeText);
  const byRoute = r ? med.products.filter((p) => p.routes.includes(r)) : [];
  const pool = byRoute.length ? byRoute : med.products;
  if (dose === null) return pool[0];
  const exact = pool.find((p) => p.strength === dose);
  if (exact) return exact;
  const divides = pool
    .filter((p) => Math.abs(dose / p.strength - Math.round(dose / p.strength)) < 1e-9)
    .sort((a, b) => b.strength - a.strength);
  return divides[0] ?? pool[0];
}
