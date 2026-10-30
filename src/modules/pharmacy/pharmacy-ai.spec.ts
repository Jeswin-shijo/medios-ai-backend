import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { buildWorld, DOC, World, amoxicillin500, enoxaparin60, ibuprofen400 } from '../../test/pharmacy-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiProviderName } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { PharmacyAiService, templateExplain, validateExplain } from './pharmacy-ai';
import { PharmacyPatientsService } from './pharmacy-patients.service';
import { egfr } from './pharmacy-rules';

const NAME = 'Ravi Kumar';
const UHID = 'MHK202600901';
const PHONE = '9100000001';
const NOTE = 'call wife Latha about the rash';
const REASON = 'Tolerated before, reaction was only mild';
const ALLERGY = 'Penicillin (rash in 2019)';
const FREE_NAME = 'Syp Herbal Tonic';
/** An unlisted line keeps the route text as typed (Y36): it must never reach the AI. */
const FREE_ROUTE = 'apply to the left knee';

/** A provider that records exactly what the AI client is handed and answers with `answer`. */
function stubProvider(name: AiProviderName, answer: unknown | ((req: any) => unknown) = { text: 'It matters because of the recorded allergy.' }) {
  const calls: { instructions: string; input: Record<string, unknown> }[] = [];
  const p: AiProvider = {
    name,
    model: 'm',
    complete: async (req) => {
      calls.push({ instructions: req.instructions, input: req.input });
      return typeof answer === 'function' ? answer(req) : answer;
    },
    check: async () => ({ ok: true, detail: 'fine' }),
  };
  return { p, calls };
}
const aiService = (p: AiProvider, on = true) => new AiService(p, { getSettings: async () => ({ ai: { pharmacyExplain: on } }) } as any, { get: () => 50 } as any);

describe('PharmacyAiService', () => {
  const m = models();
  let w: World;
  let ids: { amox: string; ibu: string; enox: string; free: string; order: string };
  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    w = await buildWorld(m);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: [ALLERGY] } });
    const a = await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', note: 'order note Latha', lines: [{ ...amoxicillin500, note: NOTE, confirm: { reason: REASON } }] });
    const b = await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [{ ...enoxaparin60, note: NOTE }, { ...ibuprofen400, note: NOTE }] });
    const byMed = (med: string) => String(b.lines.find((l: any) => l.medicine === med)!.id);
    const free = await m.PharmacyLine.create({
      order: new Types.ObjectId(a.id),
      patient: w.patientId,
      medicine: null,
      freeName: FREE_NAME,
      dose: 5,
      unit: 'ml',
      route: FREE_ROUTE,
      frequency: 'BD',
      note: NOTE,
      flags: [{ key: 'list.unmatched', kind: 'list', severity: 'amber', text: 'Not in the medicine list: checks could not run', version: 1 }],
    });
    ids = { amox: String(a.lines[0].id), ibu: byMed('ibuprofen'), enox: byMed('enoxaparin'), free: String(free._id), order: a.id };
  });
  const svc = (ai: AiService) => new PharmacyAiService(ai, m.PharmacyLine, new PharmacyPatientsService(m.Patient, m.LabTestReport));
  const flagKeys = async (id: string) => ((await m.PharmacyLine.findById(id).lean())!.flags as any[]).map((f) => f.key as string);

  test("explain falls back to the rule's words and hint when the AI is off", async () => {
    const { p, calls } = stubProvider('none');
    const res = await svc(aiService(p)).explain(ids.amox, 'allergy.amoxicillin');
    assert.deepEqual(res, {
      text: 'Penicillin allergy recorded: amoxicillin is a penicillin. Check what the reaction was and whether this medicine was taken safely before.',
      sample: false,
      source: 'rules',
    });
    assert.equal(calls.length, 0);
  });

  test('the AI being switched off for this feature, or failing, gives the same fallback', async () => {
    const off = stubProvider('claude');
    assert.equal((await svc(aiService(off.p, false)).explain(ids.amox, 'allergy.amoxicillin')).source, 'rules');
    assert.equal(off.calls.length, 0);
    const bad = stubProvider('claude', () => {
      throw new Error(`boom ${NAME}`);
    });
    const res = await svc(aiService(bad.p)).explain(ids.amox, 'allergy.amoxicillin');
    assert.equal(res.source, 'rules');
    assert.equal(res.sample, false);
  });

  test('sample mode returns the template marked sample', async () => {
    const { p } = stubProvider('sample');
    const res = await svc(aiService(p)).explain(ids.amox, 'allergy.amoxicillin');
    assert.equal(res.sample, true);
    assert.equal(res.text, templateExplain('Penicillin allergy recorded: amoxicillin is a penicillin', 'allergy'));
  });

  test('claude mode returns the AI answer, marked as not sample', async () => {
    const { p } = stubProvider('claude', { text: '  It matters because of the recorded allergy.  ' });
    const res = await svc(aiService(p)).explain(ids.amox, 'allergy.amoxicillin');
    assert.deepEqual(res, { text: 'It matters because of the recorded allergy.', sample: false, source: 'ai' });
  });

  test('nothing sent to the AI holds identifying or free text', async () => {
    const blobs: string[] = [];
    for (const mode of ['sample', 'claude'] as const) {
      const { p, calls } = stubProvider(mode);
      // Sample mode never calls the client, so the task is also captured by a spy on the service.
      const spy: any[] = [];
      const real = aiService(p);
      const orig = real.runStructured.bind(real);
      (real as any).runStructured = (task: any) => {
        spy.push({ instructions: task.instructions, input: task.input });
        return orig(task);
      };
      const sp = svc(real);
      for (const id of [ids.amox, ids.ibu, ids.enox, ids.free]) for (const key of await flagKeys(id)) await sp.explain(id, key);
      assert.ok(spy.length >= 4, 'each flag was explained');
      if (mode === 'claude') assert.equal(calls.length, spy.length, 'the client got the same payloads');
      blobs.push(...spy.map((x) => JSON.stringify(x)), ...calls.map((x) => JSON.stringify(x)));
    }
    assert.ok(blobs.length >= 12);
    const secrets = [NAME, 'Ravi', 'Kumar', PHONE, UHID, NOTE, 'Latha', 'order note', REASON, 'rash', '2019', FREE_NAME, 'Herbal', FREE_ROUTE, 'left knee', String(w.patientId), ids.amox, ids.ibu, ids.enox, ids.free, ids.order];
    for (const blob of blobs) {
      for (const s of secrets) assert.ok(!blob.includes(s), `leaked ${s}`);
      assert.ok(!/MHK\d{9}/i.test(blob), 'a UHID reached the AI');
      assert.ok(!/\bMO-\d+/.test(blob), 'an order number reached the AI');
      assert.ok(!/\b[a-f\d]{24}\b/i.test(blob), 'an id reached the AI');
      assert.ok(!/\d{9,}/.test(blob), 'a phone-like number reached the AI');
    }
    const all = blobs.join('\n');
    // Only the matched group of the allergy entry is in the flag text, and an unlisted medicine is never named.
    assert.match(all, /Penicillin allergy recorded: amoxicillin is a penicillin/);
    assert.match(all, /a medicine not in the list/);
  });

  test('the payload is the whitelist: medicine, flag, partner and patient facts', async () => {
    await w.kidneyReport(2.5, { labLine: new Types.ObjectId() });
    const { p, calls } = stubProvider('claude');
    await svc(aiService(p)).explain(ids.ibu, 'clash.enoxaparin');
    assert.equal(calls.length, 1);
    const input = calls[0].input as any;
    assert.deepEqual(Object.keys(input).sort(), ['dose', 'flag', 'frequency', 'medicine', 'other', 'patient', 'route', 'unit']);
    assert.equal(input.medicine, 'Ibuprofen');
    assert.deepEqual(input.other, { medicine: 'Enoxaparin', dose: 60, unit: 'mg', route: 'sc', frequency: 'BD' });
    assert.equal(input.flag.kind, 'clash');
    assert.equal(input.flag.severity, 'red');
    // The eGFR is carried as the number from the kidney result.
    assert.deepEqual(input.patient, { age: 62, sex: 'M', weightKg: 64, egfr: egfr({ creatinine: 2.5, age: 62, sex: 'M' }) });
    assert.equal(typeof input.patient.egfr, 'number');
  });

  test('an unlisted line is sent as a medicine not in the list, and an unreadable dose as null', async () => {
    await m.PharmacyLine.updateOne({ _id: ids.free }, { $push: { flags: { key: 'list.dose-unreadable', kind: 'list', severity: 'amber', text: 'Dose not readable: check by hand', version: 1 } } });
    const { p, calls } = stubProvider('claude');
    await svc(aiService(p)).explain(ids.free, 'list.dose-unreadable');
    const input = calls[0].input as any;
    assert.equal(input.medicine, 'a medicine not in the list');
    assert.equal(input.dose, null);
    assert.equal(input.flag.text, 'Dose not readable: check by hand');
    assert.equal(input.other, undefined);
  });

  test('an AI answer that contains an order number or a UHID is rejected and the template used', async () => {
    for (const text of ['See MO-0007 for details.', `Patient ${UHID} is allergic.`, 'Call 9100000001 now.', `Ref ${new Types.ObjectId()}`, 'Seen in ER-0012.', 'x'.repeat(501), '   ']) {
      const { p } = stubProvider('claude', { text });
      const res = await svc(aiService(p)).explain(ids.amox, 'allergy.amoxicillin');
      assert.equal(res.source, 'rules', text.slice(0, 20));
      assert.match(res.text, /Check what the reaction was/);
    }
    assert.equal(validateExplain({ text: 'ok' })?.text, 'ok');
    assert.equal(validateExplain({ text: 'CASE-12 here' }), null);
    assert.equal(validateExplain(null), null);
  });

  test('explain never changes the line, and unknown lines and flags are 404', async () => {
    const before = JSON.stringify(await m.PharmacyLine.findById(ids.amox).lean());
    const { p } = stubProvider('claude');
    await svc(aiService(p)).explain(ids.amox, 'allergy.amoxicillin');
    assert.equal(JSON.stringify(await m.PharmacyLine.findById(ids.amox).lean()), before);
    await assert.rejects(svc(aiService(p)).explain(ids.amox, 'dose.single'), { status: 404 });
    await assert.rejects(svc(aiService(p)).explain(String(new Types.ObjectId()), 'x'), { status: 404 });
    await assert.rejects(svc(aiService(p)).explain('nope', 'x'), { status: 404 });
  });
});
