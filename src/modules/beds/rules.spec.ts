import * as assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inventoryFromSeed, setState } from "../../test/bed-fixtures";
import { AdmissionRequestInput } from "./bed-types";
import { applyRules } from "./rules";

const NOW = new Date("2026-09-26T10:00:00");
const { wards, beds } = inventoryFromSeed(NOW);

function req(
  overrides: Partial<AdmissionRequestInput> = {},
): AdmissionRequestInput {
  return {
    age: 40,
    gender: "Male",
    roomClass: "general",
    needs: [],
    department: "General Medicine",
    expectedStayDays: 3,
    notes: "",
    ...overrides,
  };
}

const ids = (r: { candidates: { id: string }[] }) =>
  r.candidates.map((b) => b.id);

describe("applyRules", () => {
  test("only free beds", () => {
    const out = applyRules(req(), wards, beds, NOW);
    for (const b of out.candidates)
      assert.equal(beds.find((x) => x.id === b.id)?.state, "free");

    const past = beds.map((b) =>
      b.id === "GWA-4"
        ? {
            ...b,
            state: "held" as const,
            holdExpiresAt: new Date("2026-09-26T09:00:00"),
          }
        : b,
    );
    assert.ok(ids(applyRules(req(), wards, past, NOW)).includes("GWA-4"));

    const future = beds.map((b) =>
      b.id === "GWA-4"
        ? {
            ...b,
            state: "held" as const,
            holdExpiresAt: new Date("2026-09-26T10:05:00"),
          }
        : b,
    );
    assert.ok(!ids(applyRules(req(), wards, future, NOW)).includes("GWA-4"));
  });

  test("male general → Ward A only", () => {
    const out = applyRules(req(), wards, beds, NOW);
    assert.deepEqual(ids(out), [
      "GWA-4",
      "GWA-8",
      "GWA-15",
      "GWA-20",
      "GWA-23",
      "GWA-27",
    ]);
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "General ward",
    ]);
  });

  test("female general → Ward B", () => {
    const out = applyRules(req({ gender: "Female" }), wards, beds, NOW);
    assert.ok(out.candidates.length > 0);
    assert.ok(ids(out).every((id) => id.startsWith("GWB-")));
  });

  test("child", () => {
    const out = applyRules(req({ age: 9 }), wards, beds, NOW);
    assert.ok(out.candidates.length > 0);
    assert.ok(ids(out).every((id) => id.startsWith("PED-")));
    assert.deepEqual(
      ids(applyRules(req({ age: 9, roomClass: "icu" }), wards, beds, NOW)),
      ["ICU-4"],
    );
  });

  test("pregnant", () => {
    const out = applyRules(
      req({ gender: "Female", needs: ["pregnant"] }),
      wards,
      beds,
      NOW,
    );
    assert.ok(out.candidates.length > 0);
    assert.ok(ids(out).every((id) => id.startsWith("MAT-")));
  });

  test("isolation", () => {
    const out = applyRules(req({ needs: ["isolation"] }), wards, beds, NOW);
    assert.deepEqual(ids(out), ["ISO-1", "ISO-3"]);
    assert.equal(out.classUsed, "isolation");
  });

  test("ventilator", () => {
    const out = applyRules(
      req({ roomClass: "icu", needs: ["ventilator"] }),
      wards,
      beds,
      NOW,
    );
    assert.equal(out.candidates.length, 0);
    assert.deepEqual(out.blockedBy, [
      "No free ICU bed that matches: Men's ward only, ICU bed with a ventilator, ICU",
    ]);
  });

  test("ventilator raises the class to ICU", () => {
    const inv = setState(beds, ["ICU-3"], "free");
    const out = applyRules(req({ needs: ["ventilator"] }), wards, inv, NOW);
    assert.deepEqual(ids(out), ["ICU-3"]);
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "ICU bed with a ventilator",
      "ICU",
    ]);
  });

  test("ventilator with a monitor → ICU ventilator beds", () => {
    const inv = setState(beds, ["ICU-3"], "free");
    const out = applyRules(
      req({ roomClass: "hdu", needs: ["ventilator", "monitor"] }),
      wards,
      inv,
      NOW,
    );
    assert.deepEqual(ids(out), ["ICU-3"]);
    assert.deepEqual(out.blockedBy, []);
    assert.ok(out.appliedRules.includes("ICU bed with a ventilator"));
    assert.ok(out.appliedRules.includes("ICU or HDU (monitor)"));
  });

  test("monitor", () => {
    const out = applyRules(req({ needs: ["monitor"] }), wards, beds, NOW);
    assert.deepEqual(ids(out).sort(), ["HDU-2", "HDU-4", "ICU-4"]);
    // The monitor rule names both classes, so no single class label follows it.
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "ICU or HDU (monitor)",
    ]);
  });

  test("monitor needs a bed with a monitor", () => {
    const inv = beds.map((b) =>
      b.id === "HDU-2"
        ? { ...b, features: b.features.filter((f) => f !== "monitor") }
        : b,
    );
    const out = applyRules(req({ needs: ["monitor"] }), wards, inv, NOW);
    assert.ok(!ids(out).includes("HDU-2"));
  });

  test("class ICU with a monitor → ICU beds only", () => {
    const inv = setState(beds, ["ICU-5"], "free");
    const out = applyRules(
      req({ roomClass: "icu", needs: ["monitor"] }),
      wards,
      inv,
      NOW,
    );
    assert.deepEqual(ids(out), ["ICU-4", "ICU-5"]);
    assert.deepEqual(out.blockedBy, []);
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "ICU or HDU (monitor)",
      "ICU",
    ]);
  });

  test("class HDU with a monitor → HDU only, then ICU with the price difference", () => {
    const inv = setState(beds, ["ICU-5"], "free");
    const hdu = req({ roomClass: "hdu", needs: ["monitor"] });
    const out = applyRules(hdu, wards, inv, NOW);
    assert.deepEqual(ids(out), ["HDU-2", "HDU-4"]);
    assert.equal(out.classNote, undefined);
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "ICU or HDU (monitor)",
      "HDU",
    ]);

    const full = applyRules(
      hdu,
      wards,
      setState(inv, ["HDU-2", "HDU-4"], "occupied"),
      NOW,
    );
    assert.deepEqual(ids(full), ["ICU-4", "ICU-5"]);
    assert.equal(full.classUsed, "icu");
    assert.equal(
      full.classNote,
      "No HDU beds free for this patient. ICU, ₹3,500 more a day",
    );
    assert.ok(full.appliedRules.includes("ICU"));
  });

  test("ventilator with isolation → a conflict and no beds", () => {
    // A ventilator bed and isolation rooms are free, but no bed is both.
    const inv = setState(beds, ["ICU-3"], "free");
    const out = applyRules(
      req({ needs: ["ventilator", "isolation"] }),
      wards,
      inv,
      NOW,
    );
    assert.deepEqual(ids(out), []);
    assert.deepEqual(out.blockedBy, [
      "No bed meets all of: Isolation room, ICU bed with a ventilator",
    ]);
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "Isolation room",
      "ICU bed with a ventilator",
    ]);
    assert.deepEqual(out.stepUpPool, []);
  });

  test("isolation with a monitor → a conflict and no beds", () => {
    const out = applyRules(
      req({ needs: ["isolation", "monitor", "oxygen"] }),
      wards,
      beds,
      NOW,
    );
    assert.deepEqual(ids(out), []);
    assert.deepEqual(out.blockedBy, [
      "No bed meets all of: Isolation room, ICU or HDU (monitor)",
    ]);
    assert.deepEqual(out.appliedRules, [
      "Free & cleaned",
      "Men's ward only",
      "Isolation room",
      "ICU or HDU (monitor)",
      "Oxygen needed",
    ]);
    assert.deepEqual(out.stepUpPool, []);
  });

  test("isolation comes before the children's and maternity wards", () => {
    const child = applyRules(
      req({ age: 9, needs: ["isolation"] }),
      wards,
      beds,
      NOW,
    );
    assert.deepEqual(ids(child), ["ISO-1", "ISO-3"]);
    assert.ok(!child.appliedRules.includes("Children's ward (under 14)"));
    const pregnant = applyRules(
      req({ gender: "Female", needs: ["pregnant", "isolation"] }),
      wards,
      beds,
      NOW,
    );
    assert.deepEqual(ids(pregnant), ["ISO-1", "ISO-3"]);
  });

  test("oxygen", () => {
    const out = applyRules(req({ needs: ["oxygen"] }), wards, beds, NOW);
    assert.deepEqual(ids(out), ["GWA-4", "GWA-8"]);
    assert.ok(out.appliedRules.includes("Oxygen needed"));
    assert.deepEqual(out.stepUpPool.map((b) => b.id).sort(), [
      "HDU-2",
      "HDU-4",
    ]);
  });

  test("twin roommates", () => {
    assert.deepEqual(
      ids(applyRules(req({ roomClass: "twin" }), wards, beds, NOW)),
      ["TWN-2"],
    );
    assert.deepEqual(
      ids(
        applyRules(
          req({ roomClass: "twin", gender: "Female" }),
          wards,
          beds,
          NOW,
        ),
      ),
      ["TWN-7", "TWN-12"],
    );
  });

  test("a twin roommate's live hold counts like an occupant", () => {
    // Room 4: TWN-7 is free; TWN-8 is held for a man instead of occupied by a woman.
    const heldFor = (expires: string) =>
      beds.map((b) =>
        b.id === "TWN-8"
          ? {
              ...b,
              state: "held" as const,
              occupantGender: undefined,
              holdGender: "Male" as const,
              holdExpiresAt: new Date(expires),
            }
          : b,
      );
    const live = heldFor("2026-09-26T10:05:00");
    const twin = req({ roomClass: "twin" });
    const twinWoman = req({ roomClass: "twin", gender: "Female" });
    assert.ok(!ids(applyRules(twinWoman, wards, live, NOW)).includes("TWN-7"));
    assert.ok(ids(applyRules(twin, wards, live, NOW)).includes("TWN-7"));
    const expired = heldFor("2026-09-26T09:00:00");
    assert.ok(ids(applyRules(twinWoman, wards, expired, NOW)).includes("TWN-7"));
  });

  test("Other gender falls back to private", () => {
    const out = applyRules(req({ gender: "Other" }), wards, beds, NOW);
    assert.equal(out.classUsed, "private");
    assert.deepEqual(ids(out), ["PVT-3", "PVT-8"]);
    assert.equal(
      out.classNote,
      "No general ward beds free for this patient. Private room, ₹1,700 more a day",
    );
  });

  test("full ward falls back to twin", () => {
    const freeGwa = beds
      .filter((b) => b.wardId === "GWA" && b.state === "free")
      .map((b) => b.id);
    const out = applyRules(
      req(),
      wards,
      setState(beds, freeGwa, "occupied"),
      NOW,
    );
    assert.equal(out.classUsed, "twin");
    assert.deepEqual(ids(out), ["TWN-2"]);
    assert.equal(
      out.classNote,
      "No general ward beds free for this patient. Twin room, ₹700 more a day",
    );
  });

  test("cheaper fallback says less", () => {
    const pvt = beds.filter((b) => b.wardId === "PVT").map((b) => b.id);
    const out = applyRules(
      req({ roomClass: "twin" }),
      wards,
      setState(beds, ["TWN-2", ...pvt], "occupied"),
      NOW,
    );
    assert.equal(out.classUsed, "general");
    assert.ok(out.classNote?.endsWith("General ward, ₹700 less a day"));
  });

  test("transfer excludes current bed", () => {
    const out = applyRules(req({ currentBedId: "GWA-4" }), wards, beds, NOW);
    assert.ok(!ids(out).includes("GWA-4"));
  });
});
