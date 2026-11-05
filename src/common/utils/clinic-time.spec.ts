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

  test('a given moment (an injected clock) keeps its time and takes the CLINIC_DATE day', () => {
    const saved = process.env.CLINIC_DATE;
    try {
      const at = new Date(2026, 10, 5, 14, 37, 12);
      delete process.env.CLINIC_DATE;
      assert.equal(clinicNow(at).getTime(), at.getTime());
      process.env.CLINIC_DATE = '2026-09-26';
      const pinned = clinicNow(at);
      assert.equal(isoDate(pinned), '2026-09-26');
      assert.deepEqual([pinned.getHours(), pinned.getMinutes(), pinned.getSeconds()], [14, 37, 12]);
      assert.equal(at.getDate(), 5, 'the moment passed in is not changed');
    } finally {
      if (saved === undefined) delete process.env.CLINIC_DATE;
      else process.env.CLINIC_DATE = saved;
    }
  });
});
