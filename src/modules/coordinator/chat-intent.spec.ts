import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveQuestion } from './chat-intent';

describe('resolveQuestion', () => {
  test('resolveQuestion finds UHIDs, case numbers and names', () => {
    assert.deepEqual(resolveQuestion('Where is the bed request for mhk202500323?'), { kind: 'case-status', ref: { kind: 'uhid', value: 'MHK202500323' } });
    assert.deepEqual(resolveQuestion('status of case-0007'), { kind: 'case-status', ref: { kind: 'case', value: 'CASE-0007' } });
    assert.deepEqual(resolveQuestion('Status for Asha Nair please'), { kind: 'case-status', ref: { kind: 'name', value: 'Asha Nair' } });
    assert.deepEqual(resolveQuestion('Where is Ravi Kumar'), { kind: 'case-status', ref: { kind: 'name', value: 'Ravi Kumar' } });
    assert.deepEqual(resolveQuestion('Pending approvals for the day'), { kind: 'approvals', ref: { kind: 'name', value: 'day' } });
    assert.deepEqual(resolveQuestion('Anything overdue today?'), { kind: 'overdue' });
    assert.deepEqual(resolveQuestion('what is the weather'), { kind: 'unknown' });
  });

  test("resolveQuestion maps the client's three examples to allocate-bed, discharge-status and agent-workload", () => {
    assert.deepEqual(resolveQuestion('Allocate bed for P-1032'), { kind: 'allocate-bed', ref: { kind: 'name', value: 'P-1032' } });
    assert.deepEqual(resolveQuestion('Check discharge status'), { kind: 'discharge-status' });
    assert.deepEqual(resolveQuestion('Show agent workload'), { kind: 'agent-workload' });
  });

  test('resolveQuestion stays fast on a very long question and ignores a UHID with an extra digit', () => {
    const long = 'status for a' + ' '.repeat(50_000) + 'b' + ' word'.repeat(10_000);
    const started = Date.now();
    resolveQuestion(long);
    assert.ok(Date.now() - started < 100);
    assert.equal(resolveQuestion('status for MHK2025003230').ref?.kind, 'name');
    assert.deepEqual(resolveQuestion(undefined as unknown as string), { kind: 'unknown' });
  });
});
