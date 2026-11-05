import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { doctorAvailability, shortTime } from './availability';

const sessions = [
  { days: [6], start: '09:00', end: '13:00' },
  { days: [6], start: '16:00', end: '20:00' },
];
// Saturday 26 Sep 2026 (local time)
const sat = (h: number, m = 0) => new Date(2026, 8, 26, h, m);

test('in a session with at most one waiting is available now', () => {
  const a = doctorAvailability(sessions, sat(10), 0, 10);
  assert.deepEqual(a, { state: 'now', label: 'Available now', bookable: true });
  assert.equal(doctorAvailability(sessions, sat(10), 1, 10).state, 'now');
});

test('in a session with a queue is busy with a rounded wait', () => {
  const a = doctorAvailability(sessions, sat(10), 4, 10);
  assert.equal(a.state, 'busy');
  assert.equal(a.label, 'About 40 min wait');
  assert.equal(a.bookable, true);
  assert.equal(doctorAvailability(sessions, sat(10), 3, 7).label, 'About 25 min wait');
});

test('between sessions is later with the next start time', () => {
  const a = doctorAvailability(sessions, sat(14), 0, 10);
  assert.deepEqual(a, { state: 'later', label: 'From 4:00 PM', bookable: true, startsAt: '16:00' });
});

test('before the first session is later; session end is exclusive', () => {
  assert.equal(doctorAvailability(sessions, sat(8), 0, 10).startsAt, '09:00');
  assert.equal(doctorAvailability(sessions, sat(13, 0), 0, 10).state, 'later');
});

test('after the last session is done and not bookable', () => {
  const a = doctorAvailability(sessions, sat(20), 0, 10);
  assert.deepEqual(a, { state: 'done', label: 'Finished for today', bookable: false });
});

test('no session today is off', () => {
  const a = doctorAvailability(sessions, new Date(2026, 8, 27, 10), 0, 10);
  assert.deepEqual(a, { state: 'off', label: 'Not in today', bookable: false });
});

test('a doctor on leave is off for the day, even inside a session (R27)', () => {
  assert.deepEqual(doctorAvailability(sessions, sat(10), 0, 10, true), { state: 'off', label: 'On leave today', bookable: false });
  assert.deepEqual(doctorAvailability([], sat(10), 0, 10, true), { state: 'off', label: 'On leave today', bookable: false });
  assert.equal(doctorAvailability(sessions, sat(10), 0, 10, false).state, 'now');
});

test('shortTime formats 12-hour times', () => {
  assert.equal(shortTime('16:00'), '4:00 PM');
  assert.equal(shortTime('09:30'), '9:30 AM');
  assert.equal(shortTime('00:05'), '12:05 AM');
  assert.equal(shortTime('12:00'), '12:00 PM');
});
