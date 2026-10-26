import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inventoryFromSeed, setState } from '../../test/bed-fixtures';
import { AdmissionRequestInput } from './bed-types';
import { RuleOutcome, applyRules } from './rules';
import { formatRate, rankBeds } from './scoring';

const NOW = new Date('2026-09-26T10:00:00');
const { wards, beds } = inventoryFromSeed(NOW);

function req(overrides: Partial<AdmissionRequestInput> = {}): AdmissionRequestInput {
  return {
    age: 40,
    gender: 'Male',
    roomClass: 'general',
    needs: [],
    department: 'General Medicine',
    expectedStayDays: 3,
    notes: '',
    ...overrides,
  };
}

const arun = () => req({ age: 68, needs: ['oxygen', 'highFallRisk'] });
const rank = (r: AdmissionRequestInput, inv = beds) => rankBeds(r, applyRules(r, wards, inv, NOW), wards, inv, NOW);
/** A rule outcome offering exactly these beds, to test the ranking on its own. */
const offer = (inv: typeof beds, ids: string[], classUsed: RuleOutcome['classUsed']): RuleOutcome => ({
  candidates: inv.filter((b) => ids.includes(b.id)),
  appliedRules: [],
  blockedBy: [],
  classUsed,
  stepUpPool: [],
});

describe('rankBeds', () => {
  test("Arun's case", () => {
    const { ranked } = rank(arun());
    assert.equal(ranked[0].bedId, 'GWA-4');
    assert.ok(ranked[0].reasons.includes("Near the nurses' station"));
    assert.ok(ranked[0].reasons.includes('Oxygen point'));
    assert.ok(ranked[0].reason.endsWith('₹800/day'));
    assert.ok(ranked.some((r) => r.bedId === 'GWA-8'));
  });

  test('one step-up in the top 3', () => {
    const { ranked } = rank(arun());
    const steps = ranked.filter((r) => r.stepUp);
    assert.equal(steps.length, 1);
    assert.ok(steps[0].bedId.startsWith('HDU-'));
    assert.ok(ranked.indexOf(steps[0]) <= 2);
  });

  test('step-up sits directly after the best bed for Arun', () => {
    const { ranked } = rank(arun());
    assert.equal(ranked[0].bedId, 'GWA-4');
    assert.equal(ranked[1].stepUp, true);
  });

  test("Rekha's case: class-matching beds beat the step-up", () => {
    const { ranked } = rank(req({ age: 30, gender: 'Female', needs: ['oxygen'], department: 'Obstetrics' }));
    assert.ok(ranked[0].bedId.startsWith('GWB-'));
    assert.equal(ranked.findIndex((r) => r.stepUp), 2);
  });

  test('no step-up without oxygen', () => {
    assert.equal(rank(req()).ranked.filter((r) => r.stepUp).length, 0);
  });

  test('reserve blocks a lone HDU step-up', () => {
    const inv = setState(beds, ['HDU-4'], 'occupied');
    const { ranked, reserveBlocked } = rank(arun(), inv);
    assert.equal(ranked.filter((r) => r.stepUp).length, 0);
    assert.ok(reserveBlocked.includes('Last free HDU bed kept in reserve'));
  });

  test('ventilator reserve', () => {
    // The seed has no free ventilator bed: free ICU-3 so it is the last one.
    const inv = setState(setState(beds, ['ICU-4'], 'occupied'), ['ICU-3'], 'free');
    const { ranked, reserveBlocked } = rank(req({ roomClass: 'icu' }), inv);
    assert.deepEqual(ranked, []);
    assert.ok(reserveBlocked.includes('Last free ventilator bed kept in reserve'));
  });

  test('monitor never takes the last ICU bed while HDU has room', () => {
    const { ranked, reserveBlocked } = rank(req({ needs: ['monitor'] }));
    assert.ok(!ranked.some((r) => r.bedId === 'ICU-4'));
    assert.ok(reserveBlocked.includes('Last free ICU bed kept for critical patients'));
  });

  test('isolation reserve: the last free isolation room only goes to a patient who needs it', () => {
    const inv = setState(beds, ['ISO-3'], 'occupied');
    const { ranked, reserveBlocked } = rankBeds(req({ gender: 'Other' }), offer(inv, ['ISO-1', 'PVT-3'], 'private'), wards, inv, NOW);
    assert.deepEqual(ranked.map((r) => r.bedId), ['PVT-3']);
    assert.ok(reserveBlocked.includes('Last free isolation room kept in reserve'));
    assert.deepEqual(rank(req({ needs: ['isolation'] }), inv).ranked.map((r) => r.bedId), ['ISO-1']);
  });

  test('a ward near the department says so and scores higher', () => {
    const near = rank(req()).ranked.find((r) => r.bedId === 'GWA-15');
    const far = rank(req({ department: 'Pediatrics' })).ranked.find((r) => r.bedId === 'GWA-15');
    assert.ok(near?.reasons.includes('Near General Medicine'));
    assert.ok(!far?.reasons.some((r) => r.startsWith('Near ')));
    assert.equal(near.score - far.score, 20);
  });

  test('ties go to the bed free longest, then by id', () => {
    const inv = beds.map((b) => (b.id === 'GWA-27' ? { ...b, freeSince: new Date('2026-09-26T08:00:00') } : b));
    const { ranked } = rank(req({ department: 'Cardiology' }), inv);
    assert.deepEqual(ranked.map((r) => r.bedId), ['GWA-4', 'GWA-8', 'GWA-27', 'GWA-15', 'GWA-20', 'GWA-23']);
  });

  test('a bed outside the requested class ranks below the requested class', () => {
    // ICU beds free longer would win the tie without the class term.
    const inv = setState(beds, ['ICU-5'], 'free').map((b) =>
      b.id.startsWith('ICU-') ? { ...b, freeSince: new Date('2026-09-26T08:00:00') } : b,
    );
    const { ranked } = rankBeds(req({ roomClass: 'hdu', department: 'Cardiology' }), offer(inv, ['ICU-4', 'ICU-5', 'HDU-2'], 'hdu'), wards, inv, NOW);
    assert.deepEqual(ranked.map((r) => r.bedId), ['HDU-2', 'ICU-4', 'ICU-5']);
    assert.equal(ranked[1].score, ranked[0].score - 30);
  });

  test('no class penalty when the requested class is not among the candidates', () => {
    // General ward with a monitor: neither ICU nor HDU is the class asked for.
    const { ranked } = rank(req({ needs: ['monitor'] }), setState(beds, ['ICU-5'], 'free'));
    assert.deepEqual(ranked.map((r) => r.bedId).sort(), ['HDU-2', 'HDU-4', 'ICU-4', 'ICU-5']);
    assert.ok(ranked.every((r) => r.score === 5));
  });

  test('class ICU with a monitor ranks ICU beds only', () => {
    const { ranked } = rank(req({ roomClass: 'icu', needs: ['monitor'] }), setState(beds, ['ICU-5'], 'free'));
    assert.deepEqual(ranked.map((r) => r.bedId), ['ICU-4', 'ICU-5']);
  });

  test('elderly prefers near the nurses', () => {
    const { ranked } = rank(req({ age: 72, gender: 'Female' }));
    assert.equal(ranked[0].bedId, 'GWB-3');
  });

  test('formatRate', () => {
    assert.equal(formatRate(7500), '₹7,500/day');
  });
});
