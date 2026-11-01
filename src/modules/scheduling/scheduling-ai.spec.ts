import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { leaks, templateSummary, validateSummary } from './scheduling-ai';

describe('Scheduling AI summary helpers', () => {
  test('the leak check refuses each identifying pattern', () => {
    for (const bad of ['call 9100000070', '507f1f77bcf86cd799439011', 'PR-0001 is late', 'CO-0002', 'MHK202600970', 'CASE-12', 'Dr. Arun', 'dr. arun']) assert.ok(leaks(bad), bad);
    for (const ok of ['3 appointments, average wait 12 min', 'Cath lab is 40% booked', 'two conflicts are open']) assert.ok(!leaks(ok), ok);
  });

  test('validateSummary trims, caps at 500 characters and refuses a leak or an empty answer', () => {
    assert.deepEqual(validateSummary({ text: '  fine  ' }), { text: 'fine' });
    assert.equal(validateSummary({ text: 'x'.repeat(501) }), null);
    assert.equal(validateSummary({ text: '   ' }), null);
    assert.equal(validateSummary({ text: 'ask Dr. Rao' }), null);
    assert.equal(validateSummary(null), null);
    assert.equal(validateSummary({ text: 5 }), null);
  });

  test('the fallback sentence is built from the counts alone', () => {
    const text = templateSummary({
      appointmentsByDepartment: { Cardiology: 2, Medicine: 1 },
      avgWaitMin: 12,
      conflictsByKind: { leave: 1 },
      waitlist: 3,
      roomUsePctByKind: { ot: 40 },
      consultsByPriorityStatus: { 'stat/paged': 2 },
    });
    assert.match(text, /3 appointments/);
    assert.match(text, /average wait 12 min/);
    assert.match(text, /1 conflict\b/);
    assert.match(text, /3 on the waitlist/);
    assert.match(text, /2 open consults/);
  });
});
