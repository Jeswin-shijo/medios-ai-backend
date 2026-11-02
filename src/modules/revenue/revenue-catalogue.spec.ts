import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { WardType } from '../beds/bed-types';
import { DEFAULT_ALLOWANCE, DEFAULT_DEPOSITS, DEFAULT_STAY, consultCode, labCode, medCode, nursingCode, procCode, wardGroupOf } from './revenue-catalogue';

describe('revenue catalogue', () => {
  test('every WardType maps to the agreed group, and emergency has none', () => {
    const expected: Record<WardType, string | null> = {
      general: 'general', paediatric: 'general', maternity: 'general',
      private: 'private', twin: 'private', deluxe: 'private', isolation: 'private',
      icu: 'critical', hdu: 'critical', emergency: null,
    };
    for (const [type, group] of Object.entries(expected)) assert.equal(wardGroupOf(type as WardType), group, type);
    assert.deepEqual(DEFAULT_DEPOSITS, { general: 10000, private: 25000, critical: 50000 });
    assert.equal(DEFAULT_STAY.hdu, 2);
    assert.equal(DEFAULT_STAY.icu, 3);
    assert.equal(DEFAULT_STAY.general, 3);
    assert.equal(DEFAULT_ALLOWANCE.icu, 6000);
    assert.equal(DEFAULT_ALLOWANCE.hdu, 4000);
    assert.equal(DEFAULT_ALLOWANCE.deluxe, 2500);
    assert.equal(DEFAULT_ALLOWANCE.maternity, 1500);
  });

  test('price code helpers', () => {
    assert.equal(labCode('cbc'), 'lab:cbc');
    assert.equal(medCode('enoxaparin-40'), 'med:enoxaparin-40');
    assert.equal(procCode('hernia-repair'), 'proc:hernia-repair');
    assert.equal(consultCode('stat'), 'consult:stat');
    assert.equal(nursingCode('critical'), 'nursing:critical');
  });
});
