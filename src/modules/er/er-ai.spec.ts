import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import type { AiResult, StructuredTask } from '../ai/ai-types';
import { ErAiService } from './er-ai';

const NAME = 'Ravi Kumar';
const UHID = 'MHK202600003';
const NUMBER = 'ER-0042';
const COMPLAINT_TEXT = 'Ravi Kumar says his chest feels tight since morning';
const NOTE = 'Ravi Kumar is anxious, wife Latha at the desk';

function fakeAi(mode: 'echo' | 'text' | 'off' | 'sample' = 'echo', text = '') {
  const fake = {
    tasks: [] as StructuredTask<any>[],
    async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
      fake.tasks.push(task);
      if (mode === 'off') return { ok: false, failure: 'off', provider: 'none', model: 'none', latencyMs: 0 };
      if (mode === 'sample') return { ok: true, value: task.sample(), sample: true, provider: 'sample', model: 's', latencyMs: 0 };
      const value = task.validate({ text: mode === 'text' ? text : 'Looks like a heart problem.' });
      if (!value) return { ok: false, failure: 'invalid', provider: 'claude', model: 'm', latencyMs: 1 };
      return { ok: true, value, sample: false, provider: 'claude', model: 'm', latencyMs: 1 };
    },
  };
  return fake;
}

describe('ErAiService', () => {
  const m = models();
  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  const explainInput = {
    colour: 'orange' as const,
    reasons: ['Chest pain', 'Heart rate 104'],
    complaint: 'chest-pain' as const,
    vitals: { spo2: 95, bpSystolic: 150, heartRate: 104 },
  };

  const makeVisit = async () => {
    const vitals = await m.VitalsRecord.create({ uhid: UHID, bpSystolic: 150, bpDiastolic: 90, heartRate: 104, spo2: 95 });
    const arrivedAt = new Date('2026-09-26T10:00:00Z');
    const at = (min: number) => new Date(arrivedAt.getTime() + min * 60_000);
    const visit = await m.ErVisit.create({
      number: NUMBER,
      patient: new Types.ObjectId(),
      patientUhid: UHID,
      patientName: NAME,
      mode: 'walk-in',
      complaint: 'chest-pain',
      complaintText: COMPLAINT_TEXT,
      arrivedAt,
      triage: { suggested: 'orange', reasons: ['Chest pain'], colour: 'orange', byName: 'Nurse Anita', at: at(3) },
      vitalsId: String(vitals._id),
      painScore: 6,
      status: 'waiting-bed',
      pathways: [{ key: 'chest-pain', startedBy: 'rules' }],
      steps: [{ key: 'ecg', doneAt: at(6), byName: 'Nurse Anita' }],
      doctorSeenAt: at(12),
      disposition: { kind: 'admit', byName: 'Dr Shajin', at: at(20), notes: 'Ravi Kumar to ward, wife informed' },
      handoverNote: NOTE,
      case: new Types.ObjectId(),
    });
    return { visit, vitals };
  };

  test('the explanation falls back to the template when the AI is off', async () => {
    const svc = new ErAiService(fakeAi('off') as any, m.ErVisit, m.VitalsRecord);
    const res = await svc.explainTriage(explainInput);
    assert.deepEqual(res, { text: 'Suggested Orange because Chest pain; Heart rate 104.', sample: false });
  });

  test("nothing sent to the AI contains the patient's name, UHID, visit number or ids", async () => {
    const { visit, vitals } = await makeVisit();
    const ai = fakeAi();
    const svc = new ErAiService(ai as any, m.ErVisit, m.VitalsRecord);
    await svc.explainTriage(explainInput);
    await svc.draftHandover(String(visit._id));
    assert.equal(ai.tasks.length, 2);
    for (const task of ai.tasks) {
      const sent = JSON.stringify({ input: task.input, instructions: task.instructions });
      for (const secret of [NAME, 'Kumar', 'Latha', UHID, NUMBER, COMPLAINT_TEXT, NOTE, 'wife', String(visit._id), String(visit.patient), String(visit.case), String(vitals._id)]) {
        assert.ok(!sent.includes(secret), `leaked ${secret}`);
      }
      assert.ok(!/MHK\d{9}/i.test(sent));
      assert.ok(!/\b[a-f\d]{24}\b/i.test(sent));
    }
  });

  test('the handover facts use the readings kept on the visit first, then the Vitals record', async () => {
    const { visit } = await makeVisit();
    await m.ErVisit.updateOne({ _id: visit._id }, { $set: { vitals: { spo2: 91, heartRate: 118 } } });
    const ai = fakeAi();
    await new ErAiService(ai as any, m.ErVisit, m.VitalsRecord).draftHandover(String(visit._id));
    const v = (ai.tasks[0].input as any).facts.vitals;
    assert.equal(v.spo2, 91);
    assert.equal(v.heartRate, 118);
    assert.equal(v.bpSystolic, 150);
  });

  test("the AI's text is used when it is valid", async () => {
    const svc = new ErAiService(fakeAi('text', '  Heart rate and chest pain point to Orange.  ') as any, m.ErVisit, m.VitalsRecord);
    const res = await svc.explainTriage(explainInput);
    assert.deepEqual(res, { text: 'Heart rate and chest pain point to Orange.', sample: false });
  });

  test('an over-length answer or one with a 9-digit run falls back to the template', async () => {
    const long = new ErAiService(fakeAi('text', 'x'.repeat(201)) as any, m.ErVisit, m.VitalsRecord);
    assert.equal((await long.explainTriage(explainInput)).text, 'Suggested Orange because Chest pain; Heart rate 104.');
    const digits = new ErAiService(fakeAi('text', 'Call 9100000123 now.') as any, m.ErVisit, m.VitalsRecord);
    assert.equal((await digits.explainTriage(explainInput)).text, 'Suggested Orange because Chest pain; Heart rate 104.');
    const hex = new ErAiService(fakeAi('text', 'See 507f1f77bcf86cd799439011.') as any, m.ErVisit, m.VitalsRecord);
    assert.equal((await hex.explainTriage(explainInput)).sample, false);
    assert.equal((await hex.explainTriage(explainInput)).text, 'Suggested Orange because Chest pain; Heart rate 104.');
    const empty = new ErAiService(fakeAi('text', '   ') as any, m.ErVisit, m.VitalsRecord);
    assert.equal((await empty.explainTriage(explainInput)).text, 'Suggested Orange because Chest pain; Heart rate 104.');
  });

  test('the template cuts at the last complete reason that fits in 200 characters', async () => {
    const svc = new ErAiService(fakeAi('off') as any, m.ErVisit, m.VitalsRecord);
    const reasons = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)];
    const { text } = await svc.explainTriage({ ...explainInput, reasons });
    assert.equal(text, `Suggested Orange because ${reasons[0]}; ${reasons[1]}.`);
    assert.ok(text.length <= 200);
  });

  test('the sample provider marks the answer as sample', async () => {
    const svc = new ErAiService(fakeAi('sample') as any, m.ErVisit, m.VitalsRecord);
    const res = await svc.explainTriage(explainInput);
    assert.deepEqual(res, { text: 'Suggested Orange because Chest pain; Heart rate 104.', sample: true });
  });

  test('the handover template lists the facts of a chest-pain visit', async () => {
    const { visit } = await makeVisit();
    const svc = new ErAiService(fakeAi('off') as any, m.ErVisit, m.VitalsRecord);
    const res = await svc.draftHandover(String(visit._id));
    assert.equal(res.sample, false);
    assert.equal(
      res.text,
      'The patient came in with chest pain and was triaged Orange. Vitals: SpO₂ 95%, BP 150/90, heart rate 104, pain 6/10. Chest pain pathway: ECG done at 6 min. Seen by a doctor at 12 min. Disposition: admit.',
    );
    assert.ok(res.text.length <= 600);
  });

  test('the handover leaves out missing facts', async () => {
    const visit = await m.ErVisit.create({
      number: 'ER-0043',
      patient: new Types.ObjectId(),
      patientUhid: 'MHK202600004',
      patientName: 'Asha',
      mode: 'walk-in',
      complaint: 'fever',
      arrivedAt: new Date(),
      case: new Types.ObjectId(),
    });
    const svc = new ErAiService(fakeAi('off') as any, m.ErVisit, m.VitalsRecord);
    const res = await svc.draftHandover(String(visit._id));
    assert.equal(res.text, 'The patient came in with fever.');
    assert.ok(!/unknown/i.test(res.text));
  });

  test('draftHandover on an unknown visit is a 404', async () => {
    const svc = new ErAiService(fakeAi() as any, m.ErVisit, m.VitalsRecord);
    await assert.rejects(() => svc.draftHandover(String(new Types.ObjectId())), NotFoundException);
    await assert.rejects(() => svc.draftHandover('nope'), NotFoundException);
  });
});
