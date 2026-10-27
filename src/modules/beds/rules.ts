import {
  AdmissionRequestInput,
  BedInfo,
  Need,
  RoomClass,
  WardInfo,
  WardType,
} from "./bed-types";

export const HOLD_MINUTES = 5;

/** A bed can be offered when it is free, or its hold has run out. */
export function isFree(bed: BedInfo, now: Date): boolean {
  if (bed.state === "free") return true;
  return (
    bed.state === "held" &&
    !!bed.holdExpiresAt &&
    bed.holdExpiresAt.getTime() < now.getTime()
  );
}

export const CLASS_LABEL: Record<RoomClass | "isolation", string> = {
  general: "General ward",
  twin: "Twin room",
  private: "Private room",
  deluxe: "Deluxe suite",
  icu: "ICU",
  hdu: "HDU",
  maternity: "Maternity ward",
  paediatric: "Paediatric ward",
  emergency: "Emergency observation",
  isolation: "Isolation room",
};

/** Classes to try, in order, when the requested one has nothing free. */
export const NEAREST_CLASSES: Record<RoomClass, RoomClass[]> = {
  general: ["twin", "private", "deluxe"],
  twin: ["private", "general", "deluxe"],
  private: ["deluxe", "twin"],
  deluxe: ["private"],
  hdu: ["icu"],
  icu: [],
  maternity: [],
  paediatric: [],
  emergency: [],
};

export const RULE_TEXT = {
  free: "Free & cleaned",
  male: "Men's ward only",
  female: "Women's ward only",
  other: "Single rooms only",
  child: "Children's ward (under 14)",
  pregnant: "Maternity ward",
  isolation: "Isolation room",
  ventilator: "ICU bed with a ventilator",
  monitor: "ICU or HDU (monitor)",
  oxygen: "Oxygen needed",
} as const;

export interface RuleOutcome {
  candidates: BedInfo[];
  appliedRules: string[];
  blockedBy: string[];
  classUsed: RoomClass | "isolation";
  classNote?: string;
  stepUpPool: BedInfo[];
  /** True when no ward type meets every limiting need (isolation with a ventilator, say). */
  conflict: boolean;
}

const OTHER_GENDER_WARDS: WardType[] = [
  "icu",
  "hdu",
  "emergency",
  "paediatric",
];
const STEP_UP_CLASSES: Array<RoomClass | "isolation"> = [
  "general",
  "twin",
  "private",
  "deluxe",
  "emergency",
];

/** The gender a twin roommate sets: the patient in the bed, or the one it is held for. */
const roommateGender = (bed: BedInfo, now: Date) =>
  bed.state === "occupied"
    ? bed.occupantGender
    : bed.state === "held" && !isFree(bed, now)
      ? bed.holdGender
      : undefined;

/** A ticked need that limits which wards can be used. */
interface WardLimit {
  rule: string;
  types: WardType[];
}

/** For running text: "general ward", but acronyms stay as they are ("ICU"). */
const lowerLabel = (type: RoomClass | "isolation"): string => {
  const label = CLASS_LABEL[type];
  return label === label.toUpperCase() ? label : label.toLowerCase();
};

export function applyRules(
  req: AdmissionRequestInput,
  wards: WardInfo[],
  beds: BedInfo[],
  now: Date,
): RuleOutcome {
  const wardById = new Map(wards.map((w) => [w.id, w]));
  const has = (n: Need) => req.needs.includes(n);

  const genderRule =
    req.gender === "Male"
      ? RULE_TEXT.male
      : req.gender === "Female"
        ? RULE_TEXT.female
        : RULE_TEXT.other;

  // Ticked needs that limit the wards, in NEEDS order. A bed must meet every one of them.
  const limits: WardLimit[] = [];
  if (has("isolation"))
    limits.push({ rule: RULE_TEXT.isolation, types: ["isolation"] });
  if (has("ventilator"))
    limits.push({ rule: RULE_TEXT.ventilator, types: ["icu"] });
  if (has("monitor"))
    limits.push({ rule: RULE_TEXT.monitor, types: ["icu", "hdu"] });
  const needRules = limits.map((l) => l.rule);

  // The ward types allowed, and the classes to try in turn when none of them has a free bed.
  let wardTypes: WardType[];
  let nearest: RoomClass[] = [];
  if (limits.length) {
    // Only wards every limiting need allows. The chosen class narrows them when it is one
    // of them (HDU with a monitor: HDU, then ICU); otherwise the needs replace it (a
    // ventilator means ICU). Isolation outranks the children's and maternity wards.
    const allowed = limits.reduce(
      (types, l) => types.filter((t) => l.types.includes(t)),
      limits[0].types,
    );
    if (allowed.includes(req.roomClass)) {
      wardTypes = [req.roomClass];
      nearest = NEAREST_CLASSES[req.roomClass].filter((c) =>
        allowed.includes(c),
      );
    } else {
      wardTypes = allowed;
    }
  } else if (req.age < 14 && req.roomClass !== "icu") {
    wardTypes = ["paediatric"];
    needRules.push(RULE_TEXT.child);
  } else if (has("pregnant") && req.roomClass !== "icu") {
    wardTypes = ["maternity"];
    needRules.push(RULE_TEXT.pregnant);
  } else {
    wardTypes = [req.roomClass];
    nearest = NEAREST_CLASSES[req.roomClass];
  }
  if (has("oxygen")) needRules.push(RULE_TEXT.oxygen);
  // No ward type meets every limiting need (isolation with a ventilator, say).
  const conflict = wardTypes.length === 0;

  // Every rule except the ward type: free, not the current bed, features, gender.
  const passes = (bed: BedInfo): boolean => {
    const ward = wardById.get(bed.wardId);
    if (!ward || !isFree(bed, now) || bed.id === req.currentBedId) return false;
    if (has("oxygen") && !bed.features.includes("oxygen")) return false;
    if (has("ventilator") && !bed.features.includes("ventilator"))
      return false;
    if (has("monitor") && !bed.features.includes("monitor")) return false;
    if (ward.gender === "male" && req.gender !== "Male") return false;
    if (ward.gender === "female" && req.gender !== "Female") return false;
    if (ward.type === "twin" && bed.room) {
      const clash = beds.some((o) => {
        if (o.id === bed.id || o.wardId !== bed.wardId || o.room !== bed.room)
          return false;
        const roommate = roommateGender(o, now);
        return !!roommate && roommate !== req.gender;
      });
      if (clash) return false;
    }
    if (
      req.gender === "Other" &&
      !bed.features.includes("singleRoom") &&
      !OTHER_GENDER_WARDS.includes(ward.type)
    ) {
      return false;
    }
    return true;
  };
  const inTypes = (types: WardType[]) =>
    beds.filter(
      (b) =>
        types.includes(wardById.get(b.wardId)?.type as WardType) && passes(b),
    );
  const rate = (type: WardType) =>
    wards.find((w) => w.type === type)?.ratePerDay ?? 0;

  let candidates = inTypes(wardTypes);
  let classNote: string | undefined;
  if (candidates.length === 0) {
    for (const alt of nearest) {
      const found = inTypes([alt]);
      if (found.length === 0) continue;
      candidates = found;
      wardTypes = [alt];
      const diff = rate(alt) - rate(req.roomClass);
      const d = Math.abs(diff).toLocaleString("en-IN");
      const priceDiff =
        diff === 0
          ? "same price"
          : diff > 0
            ? `₹${d} more a day`
            : `₹${d} less a day`;
      classNote = `No ${lowerLabel(req.roomClass)} beds free for this patient. ${CLASS_LABEL[alt]}, ${priceDiff}`;
      break;
    }
  }

  // The class the beds count as; "ICU or HDU" (a monitor with another class) counts as ICU.
  const classUsed: RoomClass | "isolation" = wardTypes[0] ?? req.roomClass;
  const appliedRules = [RULE_TEXT.free, genderRule, ...needRules];
  // The class label, unless a need's rule already names it ("Isolation room") or names
  // several classes ("ICU or HDU (monitor)").
  if (wardTypes.length === 1 && !appliedRules.includes(CLASS_LABEL[classUsed]))
    appliedRules.push(CLASS_LABEL[classUsed]);

  // A step-up only when no ticked need decides the ward.
  const stepUpPool =
    !limits.length && has("oxygen") && STEP_UP_CLASSES.includes(classUsed)
      ? inTypes(["hdu"])
      : [];

  const blockedBy = conflict
    ? [`No bed meets all of: ${limits.map((l) => l.rule).join(", ")}`]
    : candidates.length === 0
      ? [
          `No free ${wardTypes.map(lowerLabel).join(" or ")} bed that matches: ${appliedRules.slice(1).join(", ")}`,
        ]
      : [];

  const outcome: RuleOutcome = {
    candidates,
    appliedRules,
    blockedBy,
    classUsed,
    stepUpPool,
    conflict,
  };
  if (classNote) outcome.classNote = classNote;
  return outcome;
}
