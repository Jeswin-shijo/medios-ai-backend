import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clinicNow, isoDate } from './clinic-time';

describe('clinicNow', () => {
  test('a given day keeps the real time of day', () => {
    const before = new Date();
    const at = clinicNow('2026-09-26');
    assert.equal(isoDate(at), '2026-09-26');
    const minutes = (d: Date) => d.getHours() * 60 + d.getMinutes();
    assert.ok(Math.abs(minutes(at) - minutes(before)) <= 1);
  });

  test('no day or a malformed one is the real date', () => {
    assert.equal(isoDate(clinicNow('')), isoDate(new Date()));
    assert.equal(isoDate(clinicNow('26/09/2026')), isoDate(new Date()));
  });
});
