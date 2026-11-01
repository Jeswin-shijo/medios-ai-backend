/**
 * Pharmacy Agent: the fixed check rules. Pure code, no database.
 * Rules flag; people decide. Nothing here changes a dose or approves a line.
 */
import {
  ALLERGY_ALIASES,
  AllergyGroup,
  DOSES_PER_DAY,
  Frequency,
  MedicineDef,
  matchMedicine,
  medicineByKey,
} from './pharmacy-catalogue';

export type FlagKind =
  | 'allergy'
  | 'clash'
  | 'double'
  | 'dose'
  | 'kidney'
  | 'age'
  | 'list'
  | 'procedure';
export type Severity = 'red' | 'amber';

export interface FlagDraft {
  key: string;
  kind: FlagKind;
  severity: Severity;
  text: string;
}

export interface Flag extends FlagDraft {
  version: number;
  confirmed?: { by: string; reason: string; at: Date };
  reviewed?: { by: string; at: Date };
}

export interface CheckLine {
  /** Medicine key; null means unlisted. */
  medicine: string | null;
  dose: number | null;
  frequency: Frequency;
  doseReadable?: boolean;
}

/**
 * known: a recent eGFR is in `egfr`.
 * unknown: no recent kidney result.
 * not-calculated: cannot be calculated (a child, or unknown age or sex): no kidney flag.
 */
export type KidneyStatus = 'known' | 'unknown' | 'not-calculated';

export type Sex = 'M' | 'F' | 'Other' | null;

export interface PatientFacts {
  age: number | null;
  sex: Sex;
  weightKg: number | null;
  allergies: string[];
  egfr: number | null;
  kidneyStatus: KidneyStatus;
  /** The earliest open contrast procedure near now (Scheduling's message), if any. `at` is a clinic-clock Date. */
  contrast?: { at: Date; number: string };
}

const d = (key: string, kind: FlagKind, severity: Severity, text: string): FlagDraft => ({
  key,
  kind,
  severity,
  text,
});

// ---------- 1. Allergy ----------

const IGNORED_ENTRY = /^\s*(no|nil|none|nkda|not)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A term matches when no letter sits directly before or after it (a plural "s" is allowed). */
function entryHas(entry: string, term: string): boolean {
  return new RegExp(`(?<![a-z])${escapeRe(term)}s?(?![a-z])`, 'i').test(entry);
}

function entryHasAny(entry: string, terms: string[]): boolean {
  return terms.some((t) => entryHas(entry, t));
}

const GROUP_WORDS: Record<AllergyGroup, { title: string; noun: string }> = {
  penicillin: { title: 'Penicillin', noun: 'a penicillin' },
  sulfa: { title: 'Sulfa', noun: 'a sulfonamide' },
  nsaid: { title: 'NSAID', noun: 'an NSAID' },
  aspirin: { title: 'Aspirin', noun: 'aspirin' },
};

function allergyFlags(med: MedicineDef, allergies: string[]): FlagDraft[] {
  const entries = allergies.filter((e) => e && !IGNORED_ENTRY.test(e));
  if (!entries.length) return [];
  const lower = med.name.toLowerCase();
  const nameTerms = [med.name, med.key, ...med.aliases];
  for (const e of entries) {
    if (entryHasAny(e, nameTerms)) {
      return [d(`allergy.${med.key}`, 'allergy', 'red', `Allergy recorded to ${lower}`)];
    }
    if (med.allergyGroup && entryHasAny(e, ALLERGY_ALIASES[med.allergyGroup])) {
      const w = GROUP_WORDS[med.allergyGroup];
      return [
        d(
          `allergy.${med.key}`,
          'allergy',
          'red',
          `${w.title} allergy recorded: ${lower} is ${w.noun}`,
        ),
      ];
    }
  }
  for (const e of entries) {
    if (
      entryHasAny(e, ALLERGY_ALIASES.penicillin) &&
      (med.classKey === 'cephalosporin' || med.classKey === 'carbapenem')
    ) {
      return [
        d(
          'allergy.cross-penicillin',
          'allergy',
          'amber',
          `Penicillin allergy recorded: cross-reaction with ${lower} is uncommon; check what the reaction was`,
        ),
      ];
    }
    if (entryHasAny(e, ALLERGY_ALIASES.nsaid) && med.key === 'aspirin') {
      return [
        d(
          'allergy.cross-nsaid',
          'allergy',
          'amber',
          `NSAID allergy recorded: ${lower} may cross-react; check what the reaction was`,
        ),
      ];
    }
    if (entryHasAny(e, ALLERGY_ALIASES.aspirin) && med.classKey === 'nsaid') {
      return [
        d(
          'allergy.cross-aspirin',
          'allergy',
          'amber',
          `Aspirin allergy recorded: ${lower} may cross-react; check what the reaction was`,
        ),
      ];
    }
  }
  return [];
}

// ---------- 2. Clashes and 3. Doubles ----------

const isAnticoag = (m: MedicineDef) => m.classKey.startsWith('anticoagulant');
const isAntiplatelet = (m: MedicineDef) => m.classKey.startsWith('antiplatelet');
const isNsaid = (m: MedicineDef) => m.classKey === 'nsaid';
const isRaas = (m: MedicineDef) =>
  m.classKey === 'ace-inhibitor' || m.classKey === 'arb';
const keyIn =
  (...keys: string[]) =>
  (m: MedicineDef) =>
    keys.includes(m.key);

interface ClashRow {
  left: (m: MedicineDef) => boolean;
  right: (m: MedicineDef) => boolean;
  severity: Severity;
  words: string;
}

const CLASH_ROWS: ClashRow[] = [
  { left: isNsaid, right: isAnticoag, severity: 'red', words: 'Major bleeding risk' },
  { left: keyIn('warfarin'), right: keyIn('metronidazole', 'cotrimoxazole'), severity: 'red', words: 'Raises INR sharply' },
  { left: keyIn('spironolactone'), right: keyIn('potassium-chloride'), severity: 'red', words: 'High potassium risk' },
  { left: isNsaid, right: isAntiplatelet, severity: 'amber', words: 'Bleeding risk; consider paracetamol' },
  { left: isAnticoag, right: isAntiplatelet, severity: 'amber', words: 'Bleeding risk; usual in heart-attack care; monitor' },
  { left: keyIn('warfarin'), right: keyIn('ciprofloxacin', 'azithromycin'), severity: 'amber', words: 'May raise INR; check INR' },
  { left: keyIn('clopidogrel'), right: keyIn('omeprazole'), severity: 'amber', words: 'Omeprazole weakens clopidogrel; pantoprazole is preferred' },
  { left: isRaas, right: keyIn('spironolactone', 'potassium-chloride'), severity: 'amber', words: 'High potassium risk; check potassium' },
  { left: keyIn('ondansetron'), right: keyIn('azithromycin', 'ciprofloxacin'), severity: 'amber', words: 'QT prolongation risk' },
];

/** First matching row; the text puts the table's left side first. Key is relative to `other`. */
function clashFlag(a: MedicineDef, other: MedicineDef): FlagDraft | null {
  for (const row of CLASH_ROWS) {
    let l: MedicineDef | null = null;
    let r: MedicineDef | null = null;
    if (row.left(a) && row.right(other)) [l, r] = [a, other];
    else if (row.left(other) && row.right(a)) [l, r] = [other, a];
    if (l && r) {
      return d(
        `clash.${other.key}`,
        'clash',
        row.severity,
        `${row.words} (${l.key} with ${r.key})`,
      );
    }
  }
  return null;
}

function doubleFlag(a: MedicineDef, other: MedicineDef): FlagDraft | null {
  const key = `double.${other.key}`;
  if (a.key === other.key) {
    return d(key, 'double', 'red', `Same medicine twice (${a.key})`);
  }
  const text = (words: string, first: MedicineDef, second: MedicineDef) =>
    `${words} (${first.key} with ${second.key})`;
  if (a.classKey === other.classKey) {
    const red: Record<string, string> = {
      'anticoagulant-heparin': 'Two heparins',
      'antiplatelet-p2y12': 'Two P2Y12 antiplatelets',
      opioid: 'Two opioids',
      nsaid: 'Two NSAIDs',
    };
    const amber: Record<string, string> = {
      statin: 'Two statins',
      ppi: 'Two PPIs',
    };
    if (red[a.classKey]) return d(key, 'double', 'red', text(red[a.classKey], a, other));
    if (amber[a.classKey]) return d(key, 'double', 'amber', text(amber[a.classKey], a, other));
  }
  const ace = a.classKey === 'ace-inhibitor' ? a : other.classKey === 'ace-inhibitor' ? other : null;
  const arb = a.classKey === 'arb' ? a : other.classKey === 'arb' ? other : null;
  if (ace && arb) return d(key, 'double', 'red', text('ACE inhibitor with ARB', ace, arb));
  const war = a.key === 'warfarin' ? a : other.key === 'warfarin' ? other : null;
  const hep = a.classKey === 'anticoagulant-heparin' ? a : other.classKey === 'anticoagulant-heparin' ? other : null;
  if (war && hep) return d(key, 'double', 'amber', text('Bridging: confirm intended', war, hep));
  return null;
}

function pairFlags(a: MedicineDef, b: MedicineDef): FlagDraft[] {
  const same = a.key === b.key;
  const clash = same ? null : clashFlag(a, b);
  const dbl = doubleFlag(a, b);
  return [clash, dbl].filter((f): f is FlagDraft => f !== null);
}

// ---------- 4. Dose ----------

const round1 = (n: number) => Math.round(n * 10) / 10;

function doseFlags(med: MedicineDef, line: CheckLine, patient: PatientFacts): FlagDraft[] {
  if (line.dose === null || line.doseReadable === false) return [];
  const out: FlagDraft[] = [];
  const dose = line.dose;
  const u = med.unit;
  if (med.maxSingle !== undefined && dose > med.maxSingle) {
    out.push(d('dose.single', 'dose', 'red', `Single dose ${dose} ${u} is above the ${med.maxSingle} ${u} maximum`));
  }
  const total = dose * DOSES_PER_DAY[line.frequency];
  if (med.maxDaily !== undefined && total > med.maxDaily) {
    out.push(d('dose.daily', 'dose', 'red', `Daily total ${total} ${u} is above the ${med.maxDaily} ${u} maximum`));
  }
  if (med.perKg) {
    const w = patient.weightKg;
    if (w === null || w === undefined || w <= 0) {
      // A rule that applies only under a weight (paracetamol) has nothing to flag with no weight.
      if (med.perKg.underKg === undefined) {
        out.push(d('dose.no-weight', 'dose', 'amber', 'Weight not recorded'));
      }
    } else if (med.perKg.underKg === undefined || w < med.perKg.underKg) {
      const limit = med.perKg.perKg * w;
      if (dose > limit + 1e-9) {
        out.push(
          d(
            'dose.per-kg',
            'dose',
            'amber',
            `${dose} ${u} is above ${med.perKg.perKg} ${u}/kg for ${w} kg (${round1(limit)} ${u})`,
          ),
        );
      }
    }
  }
  return out;
}

// ---------- 5. Kidney ----------

export function egfr(i: {
  creatinine: number;
  age: number | null;
  sex: Sex;
}): number | null {
  if (i.age === null || i.age === undefined || i.age < 18) return null;
  if (!i.sex) return null;
  if (!Number.isFinite(i.creatinine) || i.creatinine <= 0) return null;
  const calc = (female: boolean) => {
    const kappa = female ? 0.7 : 0.9;
    const alpha = female ? -0.241 : -0.302;
    const r = i.creatinine / kappa;
    return (
      142 *
      Math.pow(Math.min(r, 1), alpha) *
      Math.pow(Math.max(r, 1), -1.2) *
      Math.pow(0.9938, i.age as number) *
      (female ? 1.012 : 1)
    );
  };
  const v =
    i.sex === 'Other' ? Math.min(calc(false), calc(true)) : calc(i.sex === 'F');
  return Math.round(v);
}

export function kidneyFlags(line: CheckLine, patient: PatientFacts): FlagDraft[] {
  if (!line.medicine) return [];
  const med = medicineByKey(line.medicine);
  if (!med || !med.kidney.length) return [];
  if (patient.kidneyStatus === 'unknown') {
    return [
      d(
        'kidney.unknown',
        'kidney',
        'amber',
        'Kidney function not known: recheck when creatinine arrives',
      ),
    ];
  }
  if (patient.kidneyStatus !== 'known' || patient.egfr === null) return [];
  const e = patient.egfr;
  const band = med.kidney.find((k) => e >= k.from && e < k.below);
  if (!band) return [];
  return [
    d(
      `kidney.${band.from}-${band.below}`,
      'kidney',
      band.severity,
      `eGFR ${e}: ${med.name.toLowerCase()}, ${band.words}`,
    ),
  ];
}

// ---------- contrast dye and metformin ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "26 Sep, 2:05 PM" from a clinic-clock Date. */
export const contrastWhen = (at: Date): string =>
  `${at.getDate()} ${MONTHS[at.getMonth()]}, ${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() < 12 ? 'AM' : 'PM'}`;

/** Amber flag on a metformin line while a contrast procedure is booked (or was done in the last 48 hours). Exported so the demo seed reuses it. */
export function contrastFlag(line: CheckLine, patient: PatientFacts): FlagDraft | null {
  if (line.medicine !== 'metformin' || !patient.contrast) return null;
  return d(
    'procedure.contrast',
    'procedure',
    'amber',
    `Contrast dye on ${contrastWhen(patient.contrast.at)}: hold metformin on the day and for 48 hours after; check kidney function first`,
  );
}

// ---------- the seven rules ----------

export function checkLine(
  line: CheckLine,
  patient: PatientFacts,
  others: CheckLine[],
): FlagDraft[] {
  const med = line.medicine ? medicineByKey(line.medicine) : undefined;
  if (!med) {
    return [d('list.unmatched', 'list', 'amber', 'Not in the medicine list: checks could not run')];
  }
  const out: FlagDraft[] = [];
  out.push(...allergyFlags(med, patient.allergies ?? []));

  const otherMeds: MedicineDef[] = [];
  for (const o of others) {
    const m = o.medicine ? medicineByKey(o.medicine) : undefined;
    if (m) otherMeds.push(m);
  }
  const seen = new Set<string>();
  const push = (f: FlagDraft | null) => {
    if (f && !seen.has(f.key)) {
      seen.add(f.key);
      out.push(f);
    }
  };
  for (const o of otherMeds) if (o.key !== med.key) push(clashFlag(med, o));
  for (const o of otherMeds) push(doubleFlag(med, o));

  out.push(...doseFlags(med, line, patient));
  out.push(...kidneyFlags(line, patient));
  if (patient.age !== null && patient.age !== undefined && patient.age < 18) {
    out.push(d('age.child', 'age', 'amber', 'Child: these dose rules are for adults; check the dose'));
  }
  const contrast = contrastFlag(line, patient);
  if (contrast) out.push(contrast);
  if (line.doseReadable === false) {
    out.push(d('list.dose-unreadable', 'list', 'amber', 'Dose not readable: check by hand'));
  }
  return out;
}

/** Clash and double flags among typed names the list recognises; one flag per pair. */
export function nameChecks(names: string[]): FlagDraft[] {
  const meds = names
    .map((n) => matchMedicine(n))
    .filter((m): m is MedicineDef => m !== null);
  const out: FlagDraft[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < meds.length; i++) {
    for (let j = i + 1; j < meds.length; j++) {
      for (const f of pairFlags(meds[i], meds[j])) {
        if (!seen.has(f.key)) {
          seen.add(f.key);
          out.push(f);
        }
      }
    }
  }
  return out;
}

// ---------- merging and gates ----------

export function mergeFlags(
  existing: Flag[],
  drafts: FlagDraft[],
  version: number,
  onlyKinds?: FlagKind[],
): Flag[] {
  const inScope = (k: FlagKind) => !onlyKinds || onlyKinds.includes(k);
  const kept = existing.filter((f) => !inScope(f.kind));
  const merged: Flag[] = drafts
    .filter((dr) => inScope(dr.kind))
    .map((dr) => {
      const old = existing.find((f) => f.key === dr.key && f.version === version);
      const flag: Flag = { ...dr, version };
      if (old?.confirmed) flag.confirmed = old.confirmed;
      if (old?.reviewed) flag.reviewed = old.reviewed;
      return flag;
    });
  return [...kept, ...merged];
}

/** Red flags in `after` whose key was not red in `before`. */
export function newRed(before: Flag[], after: Flag[]): Flag[] {
  const had = new Set(before.filter((f) => f.severity === 'red').map((f) => f.key));
  return after.filter((f) => f.severity === 'red' && !had.has(f.key));
}

const confirmedNow = (f: Flag, version: number) => !!f.confirmed && f.version === version;

/** Unconfirmed red allergy flags: only a doctor confirms these. */
export function needsDoctor(flags: Flag[], version: number): Flag[] {
  return flags.filter((f) => f.severity === 'red' && f.kind === 'allergy' && !confirmedNow(f, version));
}

/** Other unconfirmed red flags: the pharmacist needs a written reason. */
export function needsReason(flags: Flag[], version: number): Flag[] {
  return flags.filter((f) => f.severity === 'red' && f.kind !== 'allergy' && !confirmedNow(f, version));
}

/** Amber allergy flags not yet marked reviewed. */
export function needsReview(flags: Flag[], version: number): Flag[] {
  return flags.filter(
    (f) => f.severity === 'amber' && f.kind === 'allergy' && !(f.reviewed && f.version === version),
  );
}
