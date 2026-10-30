import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AGENT_SCRIPTS } from './agent-scripts';

describe('the inbound agent script', () => {
  const inbound = AGENT_SCRIPTS.inbound;
  const findPatient = inbound.tools!.find((t) => t.name === 'find_patient')!;
  const param = (name: string) => findPatient.parameters.find((p) => p.name === name)!;

  test('the name and the date of birth are always collected before find_patient', () => {
    assert.match(findPatient.description, /date of birth/i);
    assert.match(findPatient.description, /before/i);
    assert.equal(param('date_of_birth').required, true);
    assert.match(inbound.instructions, /date of birth/);
  });

  test('names are spelt in English letters; the date of birth may be said in any form', () => {
    assert.match(param('patient_name').description, /English letters/);
    assert.match(inbound.instructions, /English letters/);
    assert.doesNotMatch(param('date_of_birth').description, /YYYY-MM-DD/);
    assert.doesNotMatch(inbound.instructions, /date as YYYY-MM-DD/);
  });
});
