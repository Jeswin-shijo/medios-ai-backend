import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import type { AiResult, StructuredTask } from '../ai/ai-types';
import { LabAiService, templateSummary } from './lab-ai';

const NAME = 'Ravi Kumar';
const UHID = 'MHK202600003';
const NOTE = 'Ravi Kumar is anxious, please call wife Latha';

function fakeAi(mode: 'echo' | 'off' | 'answer' = 'echo', answer: unknown = null) {
  const fake = {
    tasks: [] as StructuredTask<any>[],
    async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
      fake.tasks.push(task);
      if (mode === 'off') return { ok: false, failure: 'off', provider: 'none', model: 'none', latencyMs: 0 };
      const value = task.validate(mode === 'answer' ? answer : task.sample());
      if (!value) return { ok: false, failure: 'invalid', provider: 'claude', model: 'm', latencyMs: 1 };
      return { ok: true, value, sample: false, provider: 'claude', model: 'm', latencyMs: 1 };
    },
  };
  return fake;
}

describe('LabAiService', () => {
  const m = models();
  let lineId: string;
  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await m.Patient.create({ uhid: UHID, name: NAME, age: 52, gender: 'Male', phone: '9100000001' });
    const request = await m.LabRequest.create({
      number: 'LR-0007',
      patient: new Types.ObjectId(),
      patientUhid: UHID,
      patientName: NAME,
      case: new Types.ObjectId(),
      orderedBy: { id: 'user-doc', name: 'Dr. Shajin' },
      priority: 'stat',
      note: NOTE,
      orderedAt: new Date(),
      collectBy: new Date(),
    });
    const line = await m.LabLine.create({
      request: request._id,
      test: 'electrolytes',
      status: 'released',
      tatDueAt: new Date(),
      results: [
        { param: 'Sodium', value: 140, unit: 'mmol/L', flag: 'normal', critical: false },
        { param: 'Potassium', value: 6.4, unit: 'mmol/L', flag: 'high', critical: true },
      ],
    });
    lineId = String(line._id);
  });
  const svc = (ai: any) => new LabAiService(ai, m.LabLine, m.LabRequest, m.Patient);

  test('the summary falls back to the template when the AI is off', async () => {
    const res = await svc(fakeAi('off')).summarise(lineId);
    assert.equal(res.sample, false);
    assert.deepEqual(res.findings, ['Potassium 6.4 mmol/L — high (critical)']);
    assert.equal(res.interpretation, '1 value(s) outside the reference range; 1 critical.');
    assert.deepEqual(res.recommendations, ['Review with the clinical picture.', 'Critical value — confirm the doctor has acknowledged it.']);
  });

  test('the template for all-normal values', () => {
    const t = templateSummary([{ name: 'Sodium', value: 140, unit: 'mmol/L', referenceRange: '135–145', flag: 'normal', critical: false }]);
    assert.deepEqual(t.findings, ['All values within the reference range.']);
    assert.equal(t.interpretation, 'No abnormal values.');
    assert.deepEqual(t.recommendations, ['Review with the clinical picture.']);
  });

  test('nothing sent to the AI holds the name, UHID, request or sample number, or ids', async () => {
    const ai = fakeAi('echo');
    await svc(ai).summarise(lineId);
    assert.equal(ai.tasks.length, 1);
    const sent = JSON.stringify({ input: ai.tasks[0].input, instructions: ai.tasks[0].instructions });
    for (const bad of [NAME, 'Ravi', UHID, 'LR-', 'S-260926', 'Latha', 'anxious', 'Shajin']) assert.ok(!sent.includes(bad), `leaked ${bad}`);
    assert.ok(!/MHK\d{9}/i.test(sent) && !/\bLR-\d+/.test(sent) && !/\bS-\d{6}-\d{4}/.test(sent) && !/\b[a-f\d]{24}\b/i.test(sent));
    assert.deepEqual(ai.tasks[0].input.patient, { age: 52, sex: 'M' });
    assert.equal(ai.tasks[0].input.test, 'Electrolytes');
  });

  test('text results reach the AI only as normal or abnormal', async () => {
    const request = await m.LabRequest.findOne().lean();
    const line = await m.LabLine.create({
      request: request!._id,
      test: 'blood-culture',
      status: 'released',
      tatDueAt: new Date(),
      results: [{ param: 'Result', value: 'Growth: E. coli — call Ravi Kumar 9876543210', unit: '', flag: 'abnormal', critical: true }],
    });
    const ai = fakeAi('echo');
    const res = await svc(ai).summarise(String(line._id));
    const sent = JSON.stringify({ input: ai.tasks[0].input, instructions: ai.tasks[0].instructions });
    for (const bad of ['Ravi', '9876543210', 'E. coli']) assert.ok(!sent.includes(bad), `leaked ${bad}`);
    assert.equal(ai.tasks[0].input.parameters[0].value, 'abnormal');
    assert.ok(res.findings[0].includes('E. coli'), 'the template for staff still shows the typed text');
  });

  test('a valid AI answer is used, and a sample answer is marked sample', async () => {
    const answer = { findings: ['Potassium is high.'], interpretation: 'Raised potassium.', recommendations: ['Repeat the test.'] };
    const res = await svc(fakeAi('answer', answer)).summarise(lineId);
    assert.deepEqual({ ...res }, { ...answer, sample: false });
  });

  test('an answer with the request number in a finding falls back to the template', async () => {
    const answer = { findings: ['LR-0007 potassium high'], interpretation: 'x', recommendations: ['y'] };
    const res = await svc(fakeAi('answer', answer)).summarise(lineId);
    assert.equal(res.sample, false);
    assert.deepEqual(res.findings, ['Potassium 6.4 mmol/L — high (critical)']);
    for (const bad of ['MHK202600003', 'a'.repeat(24).replace(/a/g, 'b'), '1234567890']) {
      const r = await svc(fakeAi('answer', { findings: [bad], interpretation: 'x', recommendations: [] })).summarise(lineId);
      assert.deepEqual(r.findings, ['Potassium 6.4 mmol/L — high (critical)']);
    }
  });

  test('too many or too long strings fall back to the template', async () => {
    const long = { findings: ['a'.repeat(161)], interpretation: 'x', recommendations: [] };
    assert.deepEqual((await svc(fakeAi('answer', long)).summarise(lineId)).findings, ['Potassium 6.4 mmol/L — high (critical)']);
    const many = { findings: Array(7).fill('ok'), interpretation: 'x', recommendations: [] };
    assert.deepEqual((await svc(fakeAi('answer', many)).summarise(lineId)).findings, ['Potassium 6.4 mmol/L — high (critical)']);
  });

  test('an AI that throws gives the template', async () => {
    const boom = { runStructured: async () => { throw new Error('Ravi Kumar down'); } };
    const res = await svc(boom).summarise(lineId);
    assert.equal(res.sample, false);
    assert.equal(res.findings.length, 1);
  });
});
