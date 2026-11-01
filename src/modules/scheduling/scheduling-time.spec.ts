import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpSession } from '../opd/schemas/op-doctor.schema';
import { covers, doctorSlots, gridStarts, shiftWindow } from './scheduling-time';

const at = (d: string, h: number, m = 0) => {
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y, mo - 1, da, h, m, 0, 0);
};
const mon_sat: OpSession[] = [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:00' }];
const base = { sessions: mon_sat, slotMinutes: 15, leave: [], takenMinutes: [], notBefore: null };

describe('shift windows', () => {
  test('a night shift dated 26 Sep covers 02:00 on 27 Sep', () => {
    const w = shiftWindow('2026-09-26', 'night');
    assert.ok(covers(w, at('2026-09-27', 2), at('2026-09-27', 2)));
    assert.ok(!covers(w, at('2026-09-26', 19, 59), at('2026-09-26', 19, 59)));
  });
  test('on-call dated 26 Sep covers 07:59 on 27 Sep but not 08:00', () => {
    const w = shiftWindow('2026-09-26', 'on-call');
    assert.ok(covers(w, at('2026-09-27', 7, 59), at('2026-09-27', 7, 59)));
    assert.ok(!covers(w, at('2026-09-27', 8), at('2026-09-27', 8)));
  });
  test('covers is true at the exact shift start instant', () => {
    const w = shiftWindow('2026-09-26', 'evening');
    assert.ok(covers(w, at('2026-09-26', 14), at('2026-09-26', 14)));
  });
  test('morning is half-open and a range must fit inside', () => {
    const w = shiftWindow('2026-09-26', 'morning');
    assert.ok(covers(w, at('2026-09-26', 8), at('2026-09-26', 14)));
    assert.ok(!covers(w, at('2026-09-26', 13), at('2026-09-26', 14, 1)));
  });
});

describe('doctorSlots', () => {
  test('Mon–Sat 09:00–13:00 with 15-min slots give 16 slots', () => {
    const s = doctorSlots({ ...base, date: '2026-09-26' }); // Saturday
    assert.equal(s.length, 16);
    assert.equal(s[0], 540);
    assert.equal(s[15], 780 - 15);
  });
  test('Sunday gives none', () => {
    assert.deepEqual(doctorSlots({ ...base, date: '2026-09-27' }), []);
  });
  test('a taken slot at 09:15 is left out', () => {
    const s = doctorSlots({ ...base, date: '2026-09-26', takenMinutes: [555] });
    assert.equal(s.length, 15);
    assert.ok(!s.includes(555));
  });
  test('a leave day gives none', () => {
    assert.deepEqual(doctorSlots({ ...base, date: '2026-09-26', leave: [{ from: '2026-09-25', to: '2026-09-26' }] }), []);
  });
  test('notBefore 10:05 on the day starts at 10:15; later day gives none; earlier day no effect', () => {
    assert.equal(doctorSlots({ ...base, date: '2026-09-26', notBefore: at('2026-09-26', 10, 5) })[0], 615);
    assert.deepEqual(doctorSlots({ ...base, date: '2026-09-26', notBefore: at('2026-09-27', 8) }), []);
    assert.equal(doctorSlots({ ...base, date: '2026-09-26', notBefore: at('2026-09-25', 23) }).length, 16);
  });
  test('notBefore 10:00:30 starts at 10:15; exactly 10:00:00 keeps 10:00', () => {
    const nb = at('2026-09-26', 10, 0); nb.setSeconds(30);
    assert.equal(doctorSlots({ ...base, date: '2026-09-26', notBefore: nb })[0], 615);
    assert.equal(doctorSlots({ ...base, date: '2026-09-26', notBefore: at('2026-09-26', 10, 0) })[0], 600);
    const ms = at('2026-09-26', 10, 0); ms.setMilliseconds(1);
    assert.equal(doctorSlots({ ...base, date: '2026-09-26', notBefore: ms })[0], 615);
  });
  test('leave boundaries: from is out, day after to has slots', () => {
    const leave = [{ from: '2026-09-26', to: '2026-09-28' }];
    assert.deepEqual(doctorSlots({ ...base, date: '2026-09-26', leave }), []);
    assert.deepEqual(doctorSlots({ ...base, date: '2026-09-28', leave }), []);
    assert.equal(doctorSlots({ ...base, date: '2026-09-29', leave }).length, 16);
  });
  test('slots must fit before the session end; overlapping sessions are de-duplicated', () => {
    const s = doctorSlots({ ...base, date: '2026-09-26', slotMinutes: 25, sessions: [{ days: [6], start: '09:00', end: '10:00' }, { days: [6], start: '09:25', end: '10:15' }] });
    assert.deepEqual(s, [540, 565, 590]);
  });
});

describe('gridStarts', () => {
  test('is on 15-minute marks', () => {
    const g = gridStarts(at('2026-09-26', 9, 7), at('2026-09-26', 9, 45));
    assert.deepEqual(g.map((d) => d.getMinutes()), [15, 30]);
  });
  test('an exact mark is included, the end is not; crosses midnight', () => {
    assert.equal(gridStarts(at('2026-09-26', 9), at('2026-09-26', 9, 30)).length, 2);
    const g = gridStarts(at('2026-09-26', 23, 50), at('2026-09-27', 0, 31));
    assert.deepEqual(g.map((d) => d.getDate() * 10000 + d.getHours() * 100 + d.getMinutes()), [270000, 270015, 270030]);
  });
});
