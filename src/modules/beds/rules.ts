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
  const needRules: string[] = [];

  // Which wards are allowed, and which class that counts as (first matching rule wins).
  let classUsed: RoomClass | "isolation" = req.roomClass;
  let wardTypes: WardType[] = [req.roomClass];
  let needsVentilatorBed = false;
  let isStandardClass = false;
  if (has("ventilator")) {
    classUsed = "icu";
    wardTypes = ["icu"];
    needsVentilatorBed = true;
    needRules.push(RULE_TEXT.ventilator);
  } else if (has("isolation")) {
    classUsed = "isolation";
    wardTypes = ["isolation"];
    needRules.push(RULE_TEXT.isolation);
  } else if (has("monitor")) {
    classUsed = req.roomClass === "hdu" ? "hdu" : "icu";
    wardTypes = ["icu", "hdu"];
    needRules.push(RULE_TEXT.monitor);
  } else if (req.age < 14 && req.roomClass !== "icu") {
    classUsed = "paediatric";
    wardTypes = ["paediatric"];
    needRules.push(RULE_TEXT.child);
  } else if (has("pregnant") && req.roomClass !== "icu") {
    classUsed = "maternity";
    wardTypes = ["maternity"];
    needRules.push(RULE_TEXT.pregnant);
  } else {
    isStandardClass = true;
  }
  if (has("oxygen")) needRules.push(RULE_TEXT.oxygen);

  // Every rule except the ward class: free, not the current bed, oxygen, gender.
  const passes = (bed: BedInfo): boolean => {
    const ward = wardById.get(bed.wardId);
    if (!ward || !isFree(bed, now) || bed.id === req.currentBedId) return false;
    if (has("oxygen") && !bed.features.includes("oxygen")) return false;
    if (needsVentilatorBed && !bed.features.includes("ventilator"))
      return false;
    if (ward.gender === "male" && req.gender !== "Male") return false;
    if (ward.gender === "female" && req.gender !== "Female") return false;
    if (ward.type === "twin" && bed.room) {
      const clash = beds.some(
        (o) =>
          o.id !== bed.id &&
          o.wardId === bed.wardId &&
          o.room === bed.room &&
          o.state === "occupied" &&
          o.occupantGender &&
          o.occupantGender !== req.gender,
      );
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
  if (candidates.length === 0 && isStandardClass) {
    for (const alt of NEAREST_CLASSES[req.roomClass]) {
      const found = inTypes([alt]);
      if (found.length === 0) continue;
      candidates = found;
      classUsed = alt;
      const diff = rate(alt) - rate(req.roomClass);
      const d = Math.abs(diff).toLocaleString("en-IN");
      const priceDiff =
        diff === 0
          ? "same price"
          : diff > 0
            ? `₹${d} more a day`
            : `₹${d} less a day`;
      classNote = `No ${CLASS_LABEL[req.roomClass].toLowerCase()} beds free for this patient. ${CLASS_LABEL[alt]}, ${priceDiff}`;
      break;
    }
  }

  const classLabel = CLASS_LABEL[classUsed];
  const appliedRules = [RULE_TEXT.free, genderRule, ...needRules];
  if (!appliedRules.includes(classLabel)) appliedRules.push(classLabel);

  const stepUpPool =
    has("oxygen") && STEP_UP_CLASSES.includes(classUsed)
      ? inTypes(["hdu"])
      : [];

  const blockedBy =
    candidates.length === 0
      ? [
          `No free ${classLabel.toLowerCase()} bed that matches: ${appliedRules.slice(1).join(", ")}`,
        ]
      : [];

  const outcome: RuleOutcome = {
    candidates,
    appliedRules,
    blockedBy,
    classUsed,
    stepUpPool,
  };
  if (classNote) outcome.classNote = classNote;
  return outcome;
}
