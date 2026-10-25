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
    assert.match(out.blockedBy[0], /ventilator/);
  });

  test("monitor", () => {
    const out = applyRules(req({ needs: ["monitor"] }), wards, beds, NOW);
    assert.deepEqual(ids(out).sort(), ["HDU-2", "HDU-4", "ICU-4"]);
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
