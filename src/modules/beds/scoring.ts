import { AdmissionRequestInput, BedInfo, WardInfo } from './bed-types';
import { RuleOutcome, isFree } from './rules';

export interface RankedBed {
  bedId: string;
  score: number;
  reasons: string[];
  reason: string;
  stepUp: boolean;
}

// Scoring weights, biggest first. A close-watch patient mostly cares about the nurses' station,
// then the floor; everything else only nudges the order.
const W_NEAR_NURSES = 100;
const W_LOWER_FLOOR = 10; // per floor below the top, close-watch patients only
const W_NEAR_DEPARTMENT = 20;
const W_OXYGEN_POINT = 5;
// A bed outside the class asked for: a step-up bed, or another candidate class when the one
// asked for is also on offer. Larger than department + oxygen combined, so such a bed never
// outranks a class-matching bed on those alone.
const W_CLASS_MISMATCH = 30;
const MAX_STEP_UP_INDEX = 2; // a step-up bed is never placed below 3rd
const CLOSE_WATCH_AGE = 70;

export const formatRate = (rate: number): string => `₹${rate.toLocaleString('en-IN')}/day`;

const TEXT = {
  nearNurses: "Near the nurses' station",
  oxygen: 'Oxygen point',
  stepUp: 'Closer monitoring (HDU)',
  icuReserve: 'Last free ICU bed kept for critical patients',
  ventilatorReserve: 'Last free ventilator bed kept in reserve',
  hduReserve: 'Last free HDU bed kept in reserve',
  isolationReserve: 'Last free isolation room kept in reserve',
};

export function rankBeds(
  req: AdmissionRequestInput,
  outcome: RuleOutcome,
  wards: WardInfo[],
  beds: BedInfo[],
  now: Date,
): { ranked: RankedBed[]; reserveBlocked: string[] } {
  const wardById = new Map(wards.map((w) => [w.id, w]));
  const has = (n: AdmissionRequestInput['needs'][number]) => req.needs.includes(n);
  const freeBeds = beds.filter((b) => isFree(b, now));

  // Reserve rule: the last free bed of a scarce kind stays back unless the patient needs it.
  const reserves: Array<{ kept: BedInfo[]; unless: boolean; text: string }> = [
    {
      kept: freeBeds.filter((b) => wardById.get(b.wardId)?.type === 'icu'),
      unless: req.roomClass === 'icu' || has('ventilator'),
      text: TEXT.icuReserve,
    },
    {
      kept: freeBeds.filter((b) => b.features.includes('ventilator')),
      unless: has('ventilator'),
      text: TEXT.ventilatorReserve,
    },
    {
      kept: freeBeds.filter((b) => wardById.get(b.wardId)?.type === 'hdu'),
      unless: req.roomClass === 'hdu' || has('monitor'),
      text: TEXT.hduReserve,
    },
    {
      kept: freeBeds.filter((b) => wardById.get(b.wardId)?.type === 'isolation'),
      unless: has('isolation'),
      text: TEXT.isolationReserve,
    },
  ];
  const held = new Set<string>();
  const reserveBlocked: string[] = [];
  for (const r of reserves) {
    if (r.unless || r.kept.length !== 1) continue;
    const id = r.kept[0].id;
    const inOffer = outcome.candidates.some((b) => b.id === id) || outcome.stepUpPool.some((b) => b.id === id);
    if (!inOffer) continue;
    held.add(id);
    if (!reserveBlocked.includes(r.text)) reserveBlocked.push(r.text);
  }
  const candidates = outcome.candidates.filter((b) => !held.has(b.id));
  const stepUpPool = outcome.stepUpPool.filter((b) => !held.has(b.id));

  // Room class match counts only when the class asked for is among the candidates.
  const classOffered = candidates.some((b) => wardById.get(b.wardId)?.type === req.roomClass);
  const closeWatch = has('highFallRisk') || req.age >= CLOSE_WATCH_AGE;
  const topFloor = Math.max(0, ...wards.map((w) => w.floor));

  const score = (bed: BedInfo, stepUp: boolean): RankedBed => {
    const ward = wardById.get(bed.wardId);
    const reasons: string[] = [];
    let total = 0;
    if (closeWatch) {
      if (bed.features.includes('nearNurses')) {
        total += W_NEAR_NURSES;
        reasons.push(TEXT.nearNurses);
      }
      if (ward) {
        total += (topFloor - ward.floor) * W_LOWER_FLOOR;
        reasons.push(`Floor ${ward.floor}`);
      }
    }
    if (bed.features.includes('oxygen')) {
      total += W_OXYGEN_POINT;
      reasons.push(TEXT.oxygen);
    }
    if (ward?.nearDepartments.includes(req.department)) {
      total += W_NEAR_DEPARTMENT;
      reasons.push(`Near ${req.department}`);
    }
    if (stepUp || (classOffered && ward?.type !== req.roomClass)) total -= W_CLASS_MISMATCH;
    if (stepUp) reasons.push(TEXT.stepUp);
    reasons.push(formatRate(ward?.ratePerDay ?? 0));
    return { bedId: bed.id, score: total, reasons, reason: reasons.join(' • '), stepUp };
  };

  const freeSince = (id: string) => beds.find((b) => b.id === id)?.freeSince?.getTime() ?? Infinity;
  // Best score first; ties go to the bed that has been free longest, then by id.
  const byScore = (a: RankedBed, b: RankedBed) =>
    b.score - a.score || freeSince(a.bedId) - freeSince(b.bedId) || a.bedId.localeCompare(b.bedId);

  const ranked = candidates.map((b) => score(b, false)).sort(byScore);

  // At most one step-up bed: the best of the pool, placed by score but never below 3rd.
  const stepUp = stepUpPool.map((b) => score(b, true)).sort(byScore)[0];
  if (stepUp) {
    const at = ranked.findIndex((r) => byScore(stepUp, r) < 0);
    ranked.splice(Math.min(at === -1 ? ranked.length : at, MAX_STEP_UP_INDEX), 0, stepUp);
  }
  return { ranked, reserveBlocked };
}
