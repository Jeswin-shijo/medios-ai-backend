import * as assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { pastRequests, sampleInpatients, snapshotHistory, SampleBed } from './sample-inpatients';
import { WardType } from '../modules/beds/bed-types';
import { buildBedSeed } from '../modules/beds/bed-layout';

const WARDS: { type: WardType; near: string[]; n: number; gender: (i: number) => 'Male' | 'Female' }[] = [
  { type: 'icu', near: ['Emergency & Critical Care'], n: 6, gender: (i) => (i % 2 ? 'Male' : 'Female') },
  { type: 'hdu', near: ['Cardiology'], n: 4, gender: (i) => (i % 2 ? 'Male' : 'Female') },
  { type: 'general', near: ['General Medicine', 'General Surgery'], n: 40, gender: () => 'Male' },
  { type: 'general', near: ['General Medicine'], n: 30, gender: () => 'Female' },
  { type: 'paediatric', near: ['Pediatrics'], n: 8, gender: (i) => (i % 2 ? 'Male' : 'Female') },
  { type: 'maternity', near: ['Obstetrics'], n: 9, gender: () => 'Female' },
  { type: 'twin', near: ['General Medicine'], n: 6, gender: (i) => (i % 2 ? 'Male' : 'Female') },
];
const BEDS: SampleBed[] = WARDS.flatMap((w, wi) =>
  Array.from({ length: w.n }, (_, i) => ({
    label: `W${wi} • Bed ${i + 1}`,
    wardName: `Ward ${wi}`,
    wardType: w.type,
    occupantGender: w.gender(i),
    nearDepartments: w.near,
    features: i < 3 ? (['oxygen'] as const).slice() : [],
  })),
);
const DEMO_NOW = new Date('2026-09-26T10:30:00Z');
const DAY = 24 * 60 * 60_000;

describe('sample inpatients', () => {
  test('sample inpatients fit their ward: gender, age band, one per occupied sample bed', () => {
    const list = sampleInpatients(BEDS, DEMO_NOW);
    assert.equal(list.length, BEDS.length);
    assert.equal(new Set(list.map((a) => a.label)).size, BEDS.length);
    assert.equal(new Set(list.map((a) => a.uhid)).size, BEDS.length);
    const band: Partial<Record<WardType, [number, number]>> = { paediatric: [1, 13], maternity: [20, 38], icu: [45, 80], hdu: [45, 80] };
    for (const a of list) {
      const bed = BEDS.find((b) => b.label === a.label)!;
      assert.equal(a.gender, bed.occupantGender);
      const [lo, hi] = band[bed.wardType] ?? [18, 80];
      assert.ok(a.age >= lo && a.age <= hi, `${bed.wardType} age ${a.age}`);
      assert.match(a.uhid, /^MHK20269\d{4}$/);
      assert.equal(a.department, bed.nearDepartments[0]);
      assert.ok(a.name.length > 3);
      assert.ok(a.expectedStayDays >= 2 && a.expectedStayDays <= 12);
      const ago = DEMO_NOW.getTime() - a.admittedAt.getTime();
      assert.ok(ago >= 0 && ago <= 9 * DAY);
      if (bed.wardType === 'maternity') assert.ok(a.needs.includes('pregnant'));
      if (bed.wardType === 'icu') assert.ok(a.needs.includes('monitor'));
    }
  });

  const HOUR = 60 * 60_000;
  const dueOf = (a: { admittedAt: Date; expectedStayDays: number }) => a.admittedAt.getTime() + a.expectedStayDays * DAY;
  function layoutInpatients() {
    const layout = buildBedSeed();
    const ward = new Map(layout.wards.map((w) => [w.code, w]));
    const beds: SampleBed[] = layout.beds
      .filter((b) => b.sample)
      .map((b) => ({
        label: b.label,
        wardName: ward.get(b.wardCode)!.name,
        wardType: ward.get(b.wardCode)!.type,
        occupantGender: b.occupantGender!,
        nearDepartments: ward.get(b.wardCode)!.nearDepartments,
        features: b.features,
      }));
    return sampleInpatients(beds, DEMO_NOW);
  }

  test('no sample stay is more than 12 hours overdue at the demo time', () => {
    for (const list of [sampleInpatients(BEDS, DEMO_NOW), layoutInpatients()]) {
      for (const a of list) {
        assert.ok(dueOf(a) >= DEMO_NOW.getTime() - 12 * HOUR, `${a.label} due ${new Date(dueOf(a)).toISOString()}`);
        assert.ok(a.expectedStayDays >= 2 && a.expectedStayDays <= 12);
        const ago = DEMO_NOW.getTime() - a.admittedAt.getTime();
        assert.ok(ago >= 0 && ago <= 9 * DAY);
      }
    }
  });

  test('10 to 25 stays fall due within 24 hours, most of them still ahead', () => {
    for (const list of [sampleInpatients(BEDS, DEMO_NOW), layoutInpatients()]) {
      const soon = list.filter((a) => dueOf(a) < DEMO_NOW.getTime() + DAY);
      assert.ok(soon.length >= 10 && soon.length <= 25, `due ${soon.length}`);
      const ahead = soon.filter((a) => dueOf(a) >= DEMO_NOW.getTime()).length;
      assert.ok(ahead * 3 >= soon.length * 2, `ahead ${ahead} of ${soon.length}`);
    }
  });

  test('the same input gives the same inpatients', () => {
    assert.deepEqual(sampleInpatients(BEDS, DEMO_NOW), sampleInpatients(BEDS, DEMO_NOW));
  });

  test('history has 168 hourly points that never exceed the totals', () => {
    const current = {
      totals: { total: 100, occupied: 70, free: 20, cleaning: 6, blocked: 4, held: 0 },
      byType: {
        general: { total: 60, occupied: 45, free: 10, cleaning: 3, blocked: 2 },
        icu: { total: 40, occupied: 25, free: 10, cleaning: 3, blocked: 2 },
      },
    };
    const realNow = new Date('2026-10-27T09:25:00Z');
    const points = snapshotHistory(realNow, current);
    assert.equal(points.length, 168);
    assert.equal(new Set(points.map((p) => p.hour.getTime())).size, 168);
    assert.ok(points.every((p) => p.hour.getTime() < realNow.getTime() && p.hour.getTime() % 3_600_000 === 0));
    for (const p of points) {
      const t = p.totals;
      assert.equal(t.total, 100);
      assert.ok(t.occupied >= 0 && t.free >= 0 && t.occupied + t.free + t.cleaning + t.blocked + t.held <= t.total);
      for (const [type, c] of Object.entries(p.byType)) {
        const cap = (current.byType as Record<string, { total: number }>)[type].total;
        assert.equal(c!.total, cap);
        assert.ok(c!.occupied >= 0 && c!.free >= 0 && c!.occupied + c!.free + c!.cleaning + c!.blocked <= cap);
      }
      assert.ok(p.expected && p.expected.discharges >= 0 && p.expected.admissions >= 0);
    }
    assert.deepEqual(snapshotHistory(realNow, current), points);
  });

  test('past requests cover the most recent admissions with ai and rules decisions', () => {
    const list = sampleInpatients(BEDS, DEMO_NOW);
    const past = pastRequests(list);
    assert.equal(past.length, 10);
    assert.ok(past.some((p) => p.by === 'ai') && past.some((p) => p.by === 'rules'));
    for (const p of past) {
      assert.ok(p.reason.length > 0 && p.reason.length <= 140);
      assert.ok(p.requestedAt.getTime() < p.assignedAt.getTime());
      assert.ok(p.assignedAt.getTime() <= p.admission.admittedAt.getTime());
    }
  });
});
