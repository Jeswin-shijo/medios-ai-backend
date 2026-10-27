import { AdmissionRequestInput, BedInfo, Need, RoomClass, WardInfo, WardType } from './bed-types';
import { CLASS_LABEL, NEAREST_CLASSES } from './rules';
import { RankedBed } from './scoring';

type FoundNeed = { need: Need; evidence: string };

/** Needs found in the notes that the agent adds by itself: they never change the ward. */
export const AUTO_NEEDS: Need[] = ['oxygen', 'highFallRisk'];
/** Needs that change the ward, so a doctor confirms them first. */
export const CONFIRM_NEEDS: Need[] = ['isolation', 'ventilator', 'pregnant', 'monitor'];

export function splitExtraNeeds(
  extra: FoundNeed[],
  ticked: Need[],
  dismissed: Need[],
): { auto: FoundNeed[]; confirm: FoundNeed[] } {
  const seen = new Set<Need>([...ticked, ...dismissed]);
  const auto: FoundNeed[] = [];
  const confirm: FoundNeed[] = [];
  for (const item of extra) {
    if (seen.has(item.need)) continue;
    seen.add(item.need);
    if (AUTO_NEEDS.includes(item.need)) auto.push(item);
    else if (CONFIRM_NEEDS.includes(item.need)) confirm.push(item);
  }
  return { auto, confirm };
}

/** The ward types the agent may assign on its own, in order of preference. */
export function autoClasses(req: AdmissionRequestInput): WardType[] {
  const has = (n: Need) => req.needs.includes(n);
  if (has('isolation')) return ['isolation'];
  if (has('ventilator')) return ['icu'];
  if (has('monitor')) {
    if (req.roomClass === 'icu') return ['icu'];
    if (req.roomClass === 'hdu') return ['hdu'];
    return ['hdu', 'icu'];
  }
  if (req.age < 14 && req.roomClass !== 'icu') return ['paediatric'];
  if (has('pregnant') && req.roomClass !== 'icu') return ['maternity'];
  return [req.roomClass];
}

/** Ranked beds the agent may assign: no step-up beds, only the right ward types, best type first. */
export function autoAssignable(
  req: AdmissionRequestInput,
  ordered: RankedBed[],
  wards: WardInfo[],
  beds: BedInfo[],
): RankedBed[] {
  const wardById = new Map(wards.map((w) => [w.id, w]));
  const bedById = new Map(beds.map((b) => [b.id, b]));
  const classes = autoClasses(req);
  const typeOf = (r: RankedBed): WardType | undefined => {
    const bed = bedById.get(r.bedId);
    return bed ? wardById.get(bed.wardId)?.type : undefined;
  };
  return classes.flatMap((type) => ordered.filter((r) => !r.stepUp && typeOf(r) === type));
}

/** One line for staff when only a nearest class (twin for general, say) has a free bed. */
export function nearestOptionText(
  req: AdmissionRequestInput,
  ordered: RankedBed[],
  wards: WardInfo[],
  beds: BedInfo[],
): string | null {
  const wardById = new Map(wards.map((w) => [w.id, w]));
  const bedById = new Map(beds.map((b) => [b.id, b]));
  const classes = autoClasses(req);
  for (const r of ordered) {
    if (r.stepUp) continue;
    const found = wardById.get(bedById.get(r.bedId)?.wardId ?? '');
    if (!found || classes.includes(found.type)) continue;
    const asked = wards.find((w) => w.type === req.roomClass);
    const head = `No ${CLASS_LABEL[req.roomClass]} beds free. ${CLASS_LABEL[found.type]} available`;
    if (!asked) return head;
    const diff = found.ratePerDay - asked.ratePerDay;
    if (diff === 0) return `${head}, same price`;
    const amount = `₹${Math.abs(diff).toLocaleString('en-IN')}`;
    return `${head}, ${amount} ${diff > 0 ? 'more' : 'less'} a day`;
  }
  return null;
}

/** True when a patient in ICU or HDU is moving to an ordinary ward. */
export function isStepDown(fromType: WardType, toClass: RoomClass): boolean {
  return (fromType === 'icu' || fromType === 'hdu') && toClass !== 'icu' && toClass !== 'hdu';
}
