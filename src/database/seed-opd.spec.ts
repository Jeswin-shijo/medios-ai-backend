import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildCounters, buildDepartments, buildDoctors } from './seed-opd';

test('seed has six departments and eight doctors', () => {
  const departments = buildDepartments();
  assert.equal(departments.length, 6);
  assert.equal(buildDoctors(departments).length, 8);
});

test('doctor token prefixes are unique and every doctor belongs to a department', () => {
  const departments = buildDepartments();
  const doctors = buildDoctors(departments);
  const prefixes = doctors.map((d) => d.tokenPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
  const codes = new Set(departments.map((d) => d.code));
  for (const d of doctors) assert.ok(codes.has(d.departmentCode), d.name);
});

test('every doctor room is in the counters list, plus Consultation Room', () => {
  const doctors = buildDoctors(buildDepartments());
  const counters = buildCounters(doctors);
  for (const d of doctors) assert.ok(counters.includes(d.room), d.room);
  assert.ok(counters.includes('Consultation Room'));
  assert.ok(counters.length <= 12);
});

test('every doctor has a Saturday session and Dr. Suresh Nair is evenings only', () => {
  const doctors = buildDoctors(buildDepartments());
  for (const d of doctors) assert.ok(d.sessions.some((s) => s.days.includes(6)), d.name);
  const suresh = doctors.find((d) => d.name === 'Dr. Suresh Nair')!;
  assert.deepEqual(suresh.sessions.map((s) => s.start), ['17:00']);
});

test('Dr. Shajin leads general medicine with prefix G in Room 101', () => {
  const [first] = buildDoctors(buildDepartments());
  assert.equal(first.name, 'Dr. Shajin');
  assert.equal(first.tokenPrefix, 'G');
  assert.equal(first.room, 'Room 101');
  assert.equal(first.fee, 300);
});
