import { StructuredTask } from '../ai/ai-types';
import {
  AdmissionRequestInput,
  BedInfo,
  Feature,
  NEEDS,
  Need,
  PatientGender,
  RoomClass,
  WardInfo,
} from './bed-types';
import { PatientIdentity, deidentify } from './deidentify';
import { PLAIN_REASON, REASON_MAX, RankedBed, clipReason } from './scoring';

export const AI_CANDIDATE_LIMIT = 5;
export const AI_PICK_LIMIT = 3;
export const NOTES_MAX = 4000;

// Type aliases (not interfaces) so BedAiInput is assignable to Record<string, unknown>.
export type BedAiCandidate = {
  ref: string;
  ward: string;
  floor: number;
  features: Feature[];
  ratePerDay: number;
  ruleReasons: string[];
  stepUp: boolean;
};

export type BedAiInput = {
  patient: {
    age: number;
    gender: PatientGender;
    roomClass: RoomClass;
    needs: Need[];
    department: string;
    expectedStayDays: number;
  };
  notes: string;
  candidates: BedAiCandidate[];
  possibleExtraNeeds: Need[];
};

export type BedAiOutput = {
  extraNeeds: { need: Need; evidence: string }[];
  picks: { ref: string; reason: string }[];
};

const INSTRUCTIONS = [
  'You help a hospital admissions desk choose a bed. You are given a de-identified patient summary, the free-text doctor notes, and up to 5 candidate beds that already follow the hospital rules.',
  'Choose only refs that appear in candidates. Order the best first.',
  `Give at most ${AI_PICK_LIMIT} picks, each with a reason under ${REASON_MAX} characters in plain English.`,
  'Suggest an extra need only from possibleExtraNeeds, and quote the exact words from notes as its evidence.',
  'Never mention or guess the patient identity.',
].join('\n');

export function buildBedAiInput(args: {
  req: AdmissionRequestInput;
  who: PatientIdentity;
  ranked: RankedBed[];
  wards: WardInfo[];
  beds: BedInfo[];
}): { input: BedAiInput; refs: Record<string, string> } {
  const { req, who, ranked, wards, beds } = args;
  const wardById = new Map(wards.map((w) => [w.id, w]));
  const bedById = new Map(beds.map((b) => [b.id, b]));
  const refs: Record<string, string> = {};
  const candidates: BedAiCandidate[] = [];

  ranked.slice(0, AI_CANDIDATE_LIMIT).forEach((r, i) => {
    const bed = bedById.get(r.bedId);
    const ward = bed ? wardById.get(bed.wardId) : undefined;
    if (!bed || !ward) return;
    const ref = `b${i + 1}`;
    refs[ref] = r.bedId;
    candidates.push({
      ref,
      ward: ward.name,
      floor: ward.floor,
      features: [...bed.features],
      ratePerDay: ward.ratePerDay,
      ruleReasons: [...r.reasons],
      stepUp: r.stepUp,
    });
  });

  const input: BedAiInput = {
    patient: {
      age: req.age,
      gender: req.gender,
      roomClass: req.roomClass,
      needs: [...req.needs],
      department: req.department,
      expectedStayDays: req.expectedStayDays,
    },
    notes: deidentify(req.notes, who).slice(0, NOTES_MAX),
    candidates,
    possibleExtraNeeds: NEEDS.filter((n) => !req.needs.includes(n)),
  };
  return { input, refs };
}

export function bedAiTask(input: BedAiInput): StructuredTask<BedAiOutput> {
  return {
    feature: 'bedSuggestions',
    instructions: INSTRUCTIONS,
    input,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['picks', 'extraNeeds'],
      properties: {
        picks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'reason'],
            properties: {
              ref: { type: 'string', enum: input.candidates.map((c) => c.ref) },
              reason: { type: 'string' },
            },
          },
        },
        extraNeeds: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['need', 'evidence'],
            properties: {
              need: { type: 'string', enum: [...input.possibleExtraNeeds] },
              evidence: { type: 'string' },
            },
          },
        },
      },
    },
    validate: (raw) => validateBedAiOutput(raw, input),
    sample: () => sampleBedAiOutput(input),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateBedAiOutput(raw: unknown, input: BedAiInput): BedAiOutput | null {
  if (!isRecord(raw) || !Array.isArray(raw.picks) || !Array.isArray(raw.extraNeeds)) return null;

  const knownRefs = new Set(input.candidates.map((c) => c.ref));
  const picks: BedAiOutput['picks'] = [];
  const seenRefs = new Set<string>();
  for (const p of raw.picks) {
    if (picks.length >= AI_PICK_LIMIT) break;
    if (!isRecord(p) || typeof p.ref !== 'string' || typeof p.reason !== 'string') continue;
    if (!knownRefs.has(p.ref) || seenRefs.has(p.ref)) continue;
    seenRefs.add(p.ref);
    picks.push({ ref: p.ref, reason: clipReason(p.reason) });
  }
  if (picks.length === 0) return null;

  const notes = input.notes.toLowerCase();
  const extraNeeds: BedAiOutput['extraNeeds'] = [];
  const seenNeeds = new Set<Need>();
  for (const e of raw.extraNeeds) {
    if (!isRecord(e) || typeof e.need !== 'string' || typeof e.evidence !== 'string') continue;
    const need = e.need as Need;
    const evidence = e.evidence.trim();
    if (!input.possibleExtraNeeds.includes(need) || seenNeeds.has(need)) continue;
    if (!evidence || !notes.includes(evidence.toLowerCase())) continue;
    seenNeeds.add(need);
    extraNeeds.push({ need, evidence });
  }
  return { extraNeeds, picks };
}

// `(?![A-Za-z0-9])` instead of a trailing \b so "SpO₂" (₂ is not a word character) can match.
const KEYWORDS: Array<[Need, RegExp]> = [
  ['isolation', /\b(TB|tuberculosis|chickenpox|measles|covid)\b/i],
  ['ventilator', /ventilat\w*/i],
  ['pregnant', /\b(pregnan\w*|antenatal)\b/i],
  ['oxygen', /\b(SpO2|SpO₂|oxygen)(?![A-Za-z0-9])/i],
  ['highFallRisk', /\bfall\w*/i],
];

/** The rule reasons as one sentence: "Near the nurses' station, oxygen point and near General Medicine." */
function sampleReason(ruleReasons: string[]): string {
  if (ruleReasons.length === 0) return `${PLAIN_REASON}.`;
  const [first, ...rest] = ruleReasons;
  const parts = [first, ...rest.map((r) => r.charAt(0).toLowerCase() + r.slice(1))];
  const last = parts.pop();
  return clipReason(`${parts.length ? `${parts.join(', ')} and ${last}` : last}.`);
}

/**
 * Needs the notes mention by keyword, among those not yet ticked, quoting the words found.
 * Sample mode answers with it, and the Bed Agent falls back on it when the AI gives no answer.
 */
export function keywordExtraNeeds(notes: string, possibleExtraNeeds: Need[]): BedAiOutput['extraNeeds'] {
  const extraNeeds: BedAiOutput['extraNeeds'] = [];
  for (const [need, pattern] of KEYWORDS) {
    if (!possibleExtraNeeds.includes(need)) continue;
    const match = pattern.exec(notes);
    if (match) extraNeeds.push({ need, evidence: match[0] });
  }
  return extraNeeds;
}

export function sampleBedAiOutput(input: BedAiInput): BedAiOutput {
  const extraNeeds = keywordExtraNeeds(input.notes, input.possibleExtraNeeds);
  const picks = input.candidates
    .slice(0, AI_PICK_LIMIT)
    .map((c) => ({ ref: c.ref, reason: sampleReason(c.ruleReasons) }));
  return { extraNeeds, picks };
}

export function mergePicks(
  ranked: RankedBed[],
  output: BedAiOutput | null,
  refs: Record<string, string>,
  limit: number = AI_PICK_LIMIT,
): Array<RankedBed & { aiReason?: string }> {
  limit = Math.min(limit, ranked.length);
  const byId = new Map(ranked.map((r) => [r.bedId, r]));
  const merged: Array<RankedBed & { aiReason?: string }> = [];
  const used = new Set<string>();

  for (const pick of output?.picks ?? []) {
    const bedId = refs[pick.ref];
    const bed = bedId ? byId.get(bedId) : undefined;
    if (!bed || used.has(bedId) || merged.length >= limit) continue;
    used.add(bedId);
    merged.push({ ...bed, aiReason: pick.reason });
  }
  for (const r of ranked) {
    if (merged.length >= limit) break;
    if (used.has(r.bedId)) continue;
    used.add(r.bedId);
    merged.push(r);
  }
  return merged;
}
