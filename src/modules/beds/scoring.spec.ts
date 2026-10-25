import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inventoryFromSeed, setState } from '../../test/bed-fixtures';
import { AdmissionRequestInput } from './bed-types';
import { applyRules } from './rules';
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

  test('elderly prefers near the nurses', () => {
    const { ranked } = rank(req({ age: 72, gender: 'Female' }));
    assert.equal(ranked[0].bedId, 'GWB-3');
  });

  test('formatRate', () => {
    assert.equal(formatRate(7500), '₹7,500/day');
  });
});
