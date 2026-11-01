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

  test('all 7 rooms match spec 5.3', () => {
    const rows = [
      ['cath-lab', 'Cath lab', 'cath-lab', '08:00', '18:00', 15],
      ['ot-1', 'OT 1', 'ot', '08:00', '20:00', 30],
      ['ot-2', 'OT 2', 'ot', '08:00', '20:00', 30],
      ['procedure-room', 'Procedure room', 'procedure', '09:00', '17:00', 10],
      ['xray', 'X-ray', 'xray', '08:00', '20:00', 5],
      ['ct', 'CT', 'ct', '08:00', '20:00', 10],
      ['ultrasound', 'Ultrasound', 'ultrasound', '09:00', '17:00', 5],
    ];
    assert.deepEqual(ROOMS.map((r) => [r.key, r.name, r.kind, r.open, r.close, r.turnover]), rows);
  });

  test('all 12 procedures match spec 5.3', () => {
    const cath = ['cardiologist', 'cath-nurse', 'cath-technician'];
    const ot = (lead: string) => [lead, 'anaesthetist', 'ot-nurse'];
    const rows = [
      ['coronary-angiography', 'Coronary angiography', 'cath-lab', 45, cath, ['rft', 'coag'], true],
      ['coronary-angioplasty', 'Coronary angioplasty', 'cath-lab', 90, cath, ['rft', 'coag'], true],
      ['lap-appendectomy', 'Laparoscopic appendectomy', 'ot', 90, ot('surgeon'), ['cbc', 'coag'], false],
      ['hernia-repair', 'Hernia repair', 'ot', 90, ot('surgeon'), ['cbc', 'coag'], false],
      ['caesarean-section', 'Caesarean section', 'ot', 60, ot('obstetrician'), ['cbc'], false],
      ['fracture-fixation', 'Fracture fixation', 'ot', 120, ot('orthopaedic-surgeon'), ['cbc', 'coag'], false],
      ['upper-gi-endoscopy', 'Upper GI endoscopy', 'procedure', 30, ['physician', 'procedure-nurse'], [], false],
      ['chest-xray', 'Chest X-ray', 'xray', 10, ['radiographer'], [], false],
      ['ct-head', 'CT head', 'ct', 20, ['radiographer'], [], false],
      ['ct-abdomen-contrast', 'CT abdomen (contrast)', 'ct', 30, ['radiographer'], ['rft'], true],
      ['ultrasound-abdomen', 'Ultrasound abdomen', 'ultrasound', 20, ['sonologist'], [], false],
      ['echocardiogram', 'Echocardiogram', 'ultrasound', 30, ['cardiologist'], [], false],
    ];
    assert.deepEqual(
      PROCEDURES.map((p) => [p.key, p.name, p.roomKind, p.minutes, p.team, p.preTests, p.contrast]),
      rows,
    );
  });
});
