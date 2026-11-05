import * as assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { atClinicTime, dayStatus, toRealTime, windowStart } from './discharge-time';

/** A local (clinic) moment: "2026-09-26" at 20:00. */
const at = (day: string, h: number, m = 0) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
};
const iso = (d: Date) => d.toISOString();

describe('discharge time', () => {
  test('windowStart: an order at 20:00 for 10:00 tomorrow opens at 08:00 tomorrow; an order for now + 1 h opens now', () => {
    assert.equal(iso(windowStart(at('2026-09-26', 20), at('2026-09-27', 10), 120)), iso(at('2026-09-27', 8)));
    const now = at('2026-09-26', 14, 5);
    assert.equal(iso(windowStart(now, at('2026-09-26', 15, 5), 120)), iso(now), 'now + 1 h');
    assert.equal(iso(windowStart(now, at('2026-09-26', 16, 5), 120)), iso(now), 'exactly the target away');
    assert.equal(iso(windowStart(now, at('2026-09-26', 16, 6), 120)), iso(at('2026-09-26', 14, 6)), 'a minute beyond the target');
    assert.equal(iso(windowStart(at('2026-09-26', 20), at('2026-09-27', 10), 240)), iso(at('2026-09-27', 6)), 'the target is a setting');
  });

  test('dayStatus gives planned, due tomorrow, due today and overdue', () => {
    const now = at('2026-09-26', 10);
    assert.equal(dayStatus('2026-09-28', now), 'planned');
    assert.equal(dayStatus('2026-10-30', now), 'planned');
    assert.equal(dayStatus('2026-09-27', now), 'due-tomorrow');
    assert.equal(dayStatus('2026-09-26', now), 'due-today');
    assert.equal(dayStatus('2026-09-25', now), 'overdue');
    assert.equal(dayStatus('2026-08-31', now), 'overdue');
    // The clinic day of now decides, not 24-hour distances.
    assert.equal(dayStatus('2026-09-27', at('2026-09-26', 23, 59)), 'due-tomorrow');
    assert.equal(dayStatus('2026-09-26', at('2026-09-26', 0, 0)), 'due-today');
    assert.equal(dayStatus('2026-09-25', at('2026-09-26', 0, 0)), 'overdue');
    // Month and year ends.
    assert.equal(dayStatus('2026-10-01', at('2026-09-30', 9)), 'due-tomorrow');
    assert.equal(dayStatus('2027-01-01', at('2026-12-31', 9)), 'due-tomorrow');
    assert.equal(dayStatus('2027-01-02', at('2026-12-31', 9)), 'planned');
  });

  test('toRealTime adds the real-minus-clinic offset', () => {
    const saved = process.env.CLINIC_DATE;
    process.env.CLINIC_DATE = '2026-09-26';
    // The real day is 40 days after the pinned clinic day; the time of day is shared.
    mock.timers.enable({ apis: ['Date'], now: at('2026-11-05', 19, 0) });
    try {
      assert.equal(iso(toRealTime(at('2026-09-26', 19, 0))), iso(at('2026-11-05', 19, 0)), 'clinic now is real now');
      assert.equal(iso(toRealTime(at('2026-09-27', 8, 0))), iso(at('2026-11-06', 8, 0)), '08:00 tomorrow on the clinic clock');
      assert.equal(iso(toRealTime(at('2026-09-26', 9, 30))), iso(at('2026-11-05', 9, 30)), 'earlier today');
      delete process.env.CLINIC_DATE;
      assert.equal(iso(toRealTime(at('2026-09-27', 8, 0))), iso(at('2026-09-27', 8, 0)), 'unpinned, the clinic clock is the real clock');
    } finally {
      mock.timers.reset();
      if (saved === undefined) delete process.env.CLINIC_DATE;
      else process.env.CLINIC_DATE = saved;
    }
  });

  test('atClinicTime is the day at that 24-hour time on the clinic clock', () => {
    assert.equal(iso(atClinicTime('2026-09-27', '11:00')), iso(at('2026-09-27', 11)));
    assert.equal(iso(atClinicTime('2026-09-26', '00:00')), iso(at('2026-09-26', 0)));
    assert.equal(iso(atClinicTime('2026-09-26', '23:59')), iso(at('2026-09-26', 23, 59)));
    assert.throws(() => atClinicTime('2026-09-26', '24:00'), (e: any) => e.status === 400);
    assert.throws(() => atClinicTime('2026-09-26', '9:00'), (e: any) => e.status === 400);
    assert.throws(() => atClinicTime('26 Sep 2026', '11:00'), (e: any) => e.status === 400);
    assert.throws(() => atClinicTime('', '11:00'), (e: any) => e.status === 400, 'no day is not "today"');
    // A well-formed day that is not on the calendar is refused, never rolled over to the next month.
    for (const day of ['2026-02-30', '2026-09-31', '2026-13-01', '2026-00-10']) {
      assert.throws(() => atClinicTime(day, '11:00'), (e: any) => e.status === 400, `${day} is not a real day`);
    }
    assert.equal(iso(atClinicTime('2028-02-29', '11:00')), iso(at('2028-02-29', 11)), 'a leap day is real');
  });
});
