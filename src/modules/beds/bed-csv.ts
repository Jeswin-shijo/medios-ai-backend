import { BedSeed, WardSeed } from './bed-layout';
import { Feature, GenderRule, WardType } from './bed-types';

export const BED_CSV_COLUMNS = [
  'ward_code', 'ward_name', 'ward_short_name', 'floor', 'ward_type', 'gender', 'rate_per_day',
  'near_departments', 'bed_number', 'bed_label', 'room', 'features',
] as const;

const WARD_TYPES: WardType[] = ['emergency', 'icu', 'hdu', 'isolation', 'general', 'paediatric', 'maternity', 'twin', 'private', 'deluxe'];
const GENDER_RULES: GenderRule[] = ['male', 'female', 'any'];
const FEATURES: Feature[] = ['oxygen', 'monitor', 'ventilator', 'nearNurses', 'singleRoom', 'attendantBed'];

/** Splits CSV text into rows of fields: quoted fields may hold commas, line breaks and "" for a quote. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push(row); // skips blank lines
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  endRow();
  return rows;
}

const list = (value: string) => value.split(';').map((s) => s.trim()).filter(Boolean);

/**
 * Reads the hospital's real wards and beds from CSV text. Collects every problem,
 * each prefixed "Row N:" (N counts data rows, header excluded); imported beds are free.
 */
export function parseBedCsv(text: string): { wards: WardSeed[]; beds: BedSeed[]; errors: string[] } {
  const wards: WardSeed[] = [];
  const beds: BedSeed[] = [];
  const errors: string[] = [];

  const [header, ...dataRows] = splitCsv(text.replace(/^﻿/, ''));
  const names = (header ?? []).map((h) => h.trim());
  const missing = BED_CSV_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length) return { wards, beds, errors: missing.map((c) => `Missing column: ${c}`) };

  const seenBeds = new Set<string>();
  dataRows.forEach((cells, i) => {
    const n = i + 1;
    const get = (column: (typeof BED_CSV_COLUMNS)[number]) => (cells[names.indexOf(column)] ?? '').trim();
    const problems: string[] = [];
    const integer = (column: 'floor' | 'bed_number') => {
      const v = get(column);
      if (!/^-?\d+$/.test(v)) { problems.push(`${column} must be a number`); return 0; }
      return Number(v);
    };

    for (const column of ['ward_code', 'ward_name', 'ward_short_name'] as const) {
      if (!get(column)) problems.push(`${column} is required`);
    }
    const floor = integer('floor');
    const type = get('ward_type') as WardType;
    if (!WARD_TYPES.includes(type)) problems.push(`unknown ward_type "${type}"`);
    const gender = get('gender') as GenderRule;
    if (!GENDER_RULES.includes(gender)) problems.push(`unknown gender "${gender}"`);
    const ratePerDay = Number(get('rate_per_day'));
    if (!get('rate_per_day') || !Number.isFinite(ratePerDay) || ratePerDay <= 0) problems.push('rate_per_day must be a number');
    const number = integer('bed_number');
    const features = list(get('features'));
    for (const f of features) if (!FEATURES.includes(f as Feature)) problems.push(`unknown feature "${f}"`);

    const code = get('ward_code');
    const ward: WardSeed = {
      code, name: get('ward_name'), shortName: get('ward_short_name'), floor, type, gender, ratePerDay,
      nearDepartments: list(get('near_departments')), sortOrder: wards.length,
    };
    const earlier = wards.find((w) => w.code === code);
    if (earlier) {
      const { sortOrder, ...a } = earlier;
      const { sortOrder: _ignored, ...b } = ward;
      if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`ward ${code} details differ from an earlier row`);
    }
    const key = `${code} ${number}`;
    if (seenBeds.has(key)) problems.push(`duplicate bed ${key}`);

    if (problems.length) {
      errors.push(...problems.map((p) => `Row ${n}: ${p}`));
      return;
    }
    seenBeds.add(key);
    if (!earlier) wards.push(ward);
    beds.push({
      wardCode: code, number, label: get('bed_label') || `${ward.shortName} • Bed ${number}`,
      ...(get('room') ? { room: get('room') } : {}), features: features as Feature[], state: 'free', sample: false,
    });
  });
  return { wards, beds, errors };
}

/** Why an import must not replace the beds yet (null = go ahead). Beds in use are checked first. */
export function importRefusal(counts: { inUse: number; admissions: number; suggestions: number }, force: boolean): string | null {
  if (force) return null;
  if (counts.inUse > 0) return `Beds are in use (${counts.inUse} occupied or held). Re-run with --force to replace them anyway.`;
  if (counts.admissions > 0 || counts.suggestions > 0) {
    return `Admission history exists (${counts.admissions} admissions, ${counts.suggestions} bed suggestions). Importing replaces all beds and deletes these records. Re-run with --force to replace them anyway.`;
  }
  return null;
}
