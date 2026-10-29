import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  COLLECT_MINUTES,
  CRITICAL_LIMITS,
  LAB_TESTS,
  effectiveLimits,
  flagValue,
  groupIntoTubes,
  targetMinutes,
  testByKey,
} from './lab-catalogue';

describe('lab-catalogue', () => {
  test('potassium 6.4 is high and critical; 5.4 is high, not critical', () => {
    assert.deepEqual(flagValue('electrolytes', 'Potassium', 6.4), { flag: 'high', critical: true });
    assert.deepEqual(flagValue('electrolytes', 'Potassium', 5.4), { flag: 'high', critical: false });
  });

  test('a value exactly on a bound is normal', () => {
    assert.deepEqual(flagValue('electrolytes', 'Potassium', 5.1), { flag: 'normal', critical: false });
    assert.deepEqual(flagValue('electrolytes', 'Potassium', 3.5), { flag: 'normal', critical: false });
    assert.deepEqual(flagValue('electrolytes', 'Potassium', 3.4), { flag: 'low', critical: false });
  });

  test('troponin 0.05 is critical', () => {
    assert.deepEqual(flagValue('troponin', 'Troponin I', 0.05), { flag: 'high', critical: true });
    assert.equal(flagValue('troponin', 'Troponin I', 0.04).critical, false);
  });

  test('blood culture "Growth: gram-positive cocci" is abnormal and critical; "No growth" is normal', () => {
    assert.deepEqual(flagValue('blood-culture', 'Result', 'Growth: gram-positive cocci'), { flag: 'abnormal', critical: true });
    assert.deepEqual(flagValue('blood-culture', 'Result', 'No growth'), { flag: 'normal', critical: false });
    assert.deepEqual(flagValue('blood-culture', 'Result', '  no GROWTH '), { flag: 'normal', critical: false });
  });

  test('urine protein "Trace" is abnormal, "Nil" normal', () => {
    assert.deepEqual(flagValue('urine', 'Protein', 'Trace'), { flag: 'abnormal', critical: false });
    assert.deepEqual(flagValue('urine', 'Protein', 'Nil'), { flag: 'normal', critical: false });
    assert.deepEqual(flagValue('urine', 'Sugar', 'negative'), { flag: 'normal', critical: false });
    assert.equal(flagValue('urine', 'Protein', '').flag, 'abnormal');
  });

  test('wrong value type throws', () => {
    assert.throws(() => flagValue('urine', 'Protein', 3), /text/i);
    assert.throws(() => flagValue('electrolytes', 'Sodium', 'high'), /number/i);
    assert.throws(() => flagValue('nope', 'x', 1), /unknown/i);
    assert.throws(() => flagValue('cbc', 'nope', 1), /unknown/i);
  });

  test('CBC and HbA1c share one EDTA tube; RFT, electrolytes and troponin share one serum tube', () => {
    const tubes = groupIntoTubes(['hba1c', 'rft', 'cbc', 'troponin', 'electrolytes', 'cbc']);
    assert.deepEqual(tubes, [
      { tube: 'edta', tests: ['cbc', 'hba1c'] },
      { tube: 'serum', tests: ['rft', 'electrolytes', 'troponin'] },
    ]);
    assert.throws(() => groupIntoTubes(['nope']), /unknown/i);
  });

  test('urgent target is STAT × 2 and overrides apply only to known tests', () => {
    assert.equal(targetMinutes('cbc', 'stat'), 30);
    assert.equal(targetMinutes('cbc', 'urgent'), 60);
    assert.equal(targetMinutes('cbc', 'routine'), 120);
    assert.equal(targetMinutes('cbc', 'urgent', { cbc: { stat: 20 } }), 40);
    assert.equal(targetMinutes('cbc', 'routine', { cbc: { routine: 90 } }), 90);
    assert.equal(targetMinutes('cbc', 'stat', { cbc: { stat: 0 } }), 30);
    assert.equal(targetMinutes('cbc', 'stat', { cbc: { stat: 4321 } }), 30);
    assert.equal(targetMinutes('cbc', 'stat', { cbc: { stat: 1.5 } }), 30);
    assert.equal(targetMinutes('cbc', 'stat', { zzz: { stat: 5 } }), 30);
    assert.throws(() => targetMinutes('zzz', 'stat', { zzz: { stat: 5 } }), /unknown/i);
  });

  test('an admin override of a critical limit is used', () => {
    const limits = effectiveLimits({ 'electrolytes.Potassium': { high: 5.8 } });
    assert.equal(flagValue('electrolytes', 'Potassium', 6.0, limits).critical, true);
    assert.equal(flagValue('electrolytes', 'Potassium', 5.7, limits).critical, false);
    assert.equal(flagValue('electrolytes', 'Potassium', 6.0).critical, false);
  });

  test('a null override removes a bound; unknown keys and bad values are ignored', () => {
    const limits = effectiveLimits({
      'electrolytes.Potassium': { low: null },
      'bogus.key': { high: 1 },
      'cbc.WBC': { high: 'x' as unknown as number },
    });
    assert.equal(limits['electrolytes.Potassium'].low, undefined);
    assert.equal(limits['electrolytes.Potassium'].high, 6.2);
    assert.equal(limits['bogus.key'], undefined);
    assert.equal(limits['cbc.WBC'].high, 30);
    assert.equal(flagValue('electrolytes', 'Potassium', 1, limits).critical, false);
    assert.equal(CRITICAL_LIMITS['electrolytes.Potassium'].low, 2.8);
  });

  test('catalogue basics', () => {
    assert.equal(LAB_TESTS.length, 15);
    assert.equal(testByKey('abg')?.params[1].name, 'pCO₂');
    assert.equal(testByKey('ddimer')?.params[0].unit, 'ng/mL FEU');
    assert.deepEqual(COLLECT_MINUTES, { stat: 15, urgent: 60, routine: 240 });
    for (const key of Object.keys(CRITICAL_LIMITS)) {
      const [t, p] = key.split('.');
      assert.ok(testByKey(t)?.params.some((x) => x.name === p), key);
    }
  });
});
