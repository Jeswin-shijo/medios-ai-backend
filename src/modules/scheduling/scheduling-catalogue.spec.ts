import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { testByKey } from '../lab/lab-catalogue';
import { PROCEDURES, ROOMS, SKILLS, SKILL_LABEL, procedureByKey, roomByKey } from './scheduling-catalogue';

describe('scheduling catalogue', () => {
  test('twelve procedures; angiography is 45 min in the cath lab with cardiologist, cath nurse and cath technician, pre-tests rft and coag, contrast', () => {
    assert.equal(PROCEDURES.length, 12);
    const a = procedureByKey('coronary-angiography')!;
    assert.equal(a.minutes, 45);
    assert.equal(a.roomKind, 'cath-lab');
    assert.deepEqual(a.team, ['cardiologist', 'cath-nurse', 'cath-technician']);
    assert.deepEqual(a.preTests, ['rft', 'coag']);
    assert.equal(a.contrast, true);
    assert.deepEqual(procedureByKey('caesarean-section')!.preTests, ['cbc']);
  });

  test('every pre-test is a Lab test key', () => {
    for (const p of PROCEDURES) for (const t of p.preTests) assert.ok(testByKey(t), `${p.key}: ${t}`);
  });

  test('seven rooms, 19 skills, every team skill and room kind exists', () => {
    assert.equal(ROOMS.length, 7);
    assert.equal(SKILLS.length, 19);
    assert.equal(SKILL_LABEL['ent-surgeon'], 'ENT surgeon');
    assert.equal(SKILL_LABEL['cath-nurse'], 'Cath nurse');
    assert.equal(roomByKey('ot-2')!.turnover, 30);
    for (const p of PROCEDURES) {
      assert.ok(ROOMS.some((r) => r.kind === p.roomKind));
      for (const s of p.team) assert.ok(SKILL_LABEL[s]);
    }
  });
});
