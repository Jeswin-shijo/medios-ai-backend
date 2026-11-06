import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import {
  DOC, PHARM, World, amoxicillin500, aspirin300, buildWorld, ceftriaxone1, enoxaparin60, omeprazole20, pantoprazole40,
} from '../../test/pharmacy-fixtures';
import type { LineInput } from './pharmacy-orders.service';

const LEAVE = new Date('2026-09-26T14:00:00.000Z');
const NOTE = ['continues.enoxaparin', 'info', 'Continues ward medicine'];
const RED_TWICE = ['double.enoxaparin', 'red', 'Same medicine twice (enoxaparin)'];
const enoxaparin40: LineInput = { ...enoxaparin60, product: 'enoxaparin-syringe-40', dose: 40 };
const atorvastatin20: LineInput = { medicine: 'atorvastatin', product: 'atorvastatin-tab-20', dose: 20, route: 'oral', frequency: 'OD', durationDays: 30 };

/** The "same medicine" and class-double flags of a line, as [key, severity, text]. */
const twice = (flags: { key: string; kind: string; severity: string; text: string }[]) =>
  flags.filter((f) => f.kind === 'double' || f.kind === 'continues').map((f) => [f.key, f.severity, f.text]);

describe('PharmacyTakeHomeService and the Discharge handlers', () => {
  const m = models();
  let w: World;
  let caseId: string;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    w = await buildWorld(m);
    caseId = String((await w.openWard()).case._id);
  });

  const wardOrder = (lines: LineInput[] = [enoxaparin60]) => w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines });
  const place = (lines: LineInput[], patientId = w.patientId, onCase = caseId) => w.takeHome.place(DOC, { patientId, caseId: onCase, plannedLeaveAt: LEAVE, lines });
  /** Sets the line issued (in the last 24 h, so it still counts as active for the checks). */
  const issue = (id: string) =>
    m.PharmacyLine.updateOne(
      { _id: id },
      { $set: { status: 'issued', issued: { by: { id: PHARM.id, name: PHARM.name }, at: new Date(), realAt: new Date(), store: 'main', batches: [], quantity: 1 } } },
    );
  const completed = (onCase: string | undefined, kind: string) =>
    w.discharge(onCase, 'discharge.completed', { planId: 'p1', orderId: 'o1', admissionId: 'a1', bedLabel: 'GWA-12', kind, leftAt: new Date() });
  const cancelled = (onCase: string | undefined) => w.discharge(onCase, 'discharge.cancelled', { orderId: 'o1', admissionId: 'a1', bedLabel: 'GWA-12' });
  const statusOf = async (id: string) => (await w.lineDoc(id)).status;

  // ---------- the continuation note ----------

  test('a take-home line continuing a ward line gets info, not red, and the ward line stays approved', async () => {
    const ward = await wardOrder();
    assert.equal(ward.setting, 'Ward');
    const wardLine = ward.lines[0].id;
    await w.checks.approve(PHARM, wardLine, {});

    // The order form's live check already shows the note.
    const preview = await w.takeHome.check({ patientId: w.patientId, caseId, lines: [enoxaparin60] });
    assert.deepEqual(twice(preview.lines[0].flags), [NOTE]);

    const th = await place([enoxaparin60]);
    assert.deepEqual(twice(th.lines[0].flags), [NOTE]);
    assert.equal(th.lines[0].status, 'to-check');

    const doc = await w.lineDoc(wardLine);
    assert.equal(doc.status, 'approved', 'an info note never sends an approved line back to To check');
    assert.deepEqual(twice(doc.flags), [NOTE]);
    assert.equal((await w.sent('pharmacy.to-check')).filter((x) => x.payload.lineId === wardLine).length, 1, 'the ward line entered To check once');
    // The note is never a gate: the take-home line is approved with no reason.
    const approved = await w.checks.approve(PHARM, th.lines[0].id, {});
    assert.equal(approved.status, 'approved');
  });

  test('an issued ward line gets no query when a take-home continuation is ordered', async () => {
    const ward = await wardOrder();
    const wardLine = ward.lines[0].id;
    await w.checks.approve(PHARM, wardLine, {});
    await issue(wardLine);

    const th = await place([enoxaparin60]);

    const doc = await w.lineDoc(wardLine);
    assert.equal(doc.query, undefined);
    assert.equal(doc.querySeq, 0);
    assert.equal(doc.status, 'issued');
    assert.equal((await w.sent('pharmacy.query')).length, 0);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `pharmacy-line:${wardLine}` }), 0);
    assert.deepEqual(twice(doc.flags), [NOTE]);
    assert.deepEqual(twice(th.lines[0].flags), [NOTE]);
  });

  test('two take-home lines for one medicine are red', async () => {
    const ward = await wardOrder();
    await w.checks.approve(PHARM, ward.lines[0].id, {});

    // In one order: each line notes the ward line, and the two take-home lines are a red double.
    const preview = await w.takeHome.check({ patientId: w.patientId, caseId, lines: [enoxaparin60, enoxaparin40] });
    for (const l of preview.lines) assert.deepEqual(twice(l.flags).sort(), [NOTE, RED_TWICE].sort());

    // Across two take-home orders: the second is red against the first, and the first is rechecked red.
    const first = await place([enoxaparin60]);
    const second = await place([enoxaparin40]);
    assert.deepEqual(twice(second.lines[0].flags).sort(), [NOTE, RED_TWICE].sort());
    assert.deepEqual(twice((await w.lineDoc(first.lines[0].id)).flags).sort(), [NOTE, RED_TWICE].sort());
    // The ward line only ever reads the note, and stays approved.
    const wardDoc = await w.lineDoc(ward.lines[0].id);
    assert.deepEqual(twice(wardDoc.flags), [NOTE]);
    assert.equal(wardDoc.status, 'approved');
  });

  test('a class double (two PPIs) still flags as before', async () => {
    const ward = await wardOrder([pantoprazole40]);
    await w.checks.approve(PHARM, ward.lines[0].id, {});
    const th = await place([omeprazole20]);
    assert.deepEqual(twice(th.lines[0].flags), [['double.pantoprazole', 'amber', 'Two PPIs (omeprazole with pantoprazole)']]);
    const doc = await w.lineDoc(ward.lines[0].id);
    assert.deepEqual(twice(doc.flags), [['double.omeprazole', 'amber', 'Two PPIs (pantoprazole with omeprazole)']]);
    assert.equal(doc.status, 'approved');
  });

  test('a ward line ordered after a take-home line reads as a continuation too, in the preview and once saved', async () => {
    const th = await place([enoxaparin60]);
    await w.checks.approve(PHARM, th.lines[0].id, {});
    const preview = await w.orders.preview({ patientId: w.patientId, lines: [enoxaparin60] });
    assert.deepEqual(twice(preview.lines[0].flags), [NOTE]);
    const ward = await wardOrder();
    assert.deepEqual(twice(ward.lines[0].flags), [NOTE]);
    const thDoc = await w.lineDoc(th.lines[0].id);
    assert.deepEqual(twice(thDoc.flags), [NOTE]);
    assert.equal(thDoc.status, 'approved');
  });

  test("a doctor's Change on a take-home line keeps the continuation note", async () => {
    const ward = await wardOrder();
    await w.checks.approve(PHARM, ward.lines[0].id, {});
    const th = await place([enoxaparin60]);
    const id = th.lines[0].id;
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'Lower dose at home?' });
    // The answer form's live check reads the same note.
    const preview = await w.orders.preview({ patientId: w.patientId, lines: [enoxaparin40], replacingLineId: id });
    assert.deepEqual(twice(preview.lines[0].flags), [NOTE]);
    const { medicine: _m, ...change } = enoxaparin40;
    const view = await w.checks.answer(DOC, id, { querySeq: 1, outcome: 'change', change });
    assert.equal(view.dose, 40);
    assert.equal(view.status, 'to-check');
    assert.deepEqual(twice(view.flags), [NOTE]);
  });

  // ---------- placing ----------

  test('place makes a Ward take-home order with plannedLeaveAt', async () => {
    const v = await place([amoxicillin500]);
    assert.deepEqual(
      [v.setting, v.takeHome, v.priority, v.note, v.source, v.caseId, v.plannedLeaveAt],
      ['Ward', true, 'urgent', 'Take-home medicines', 'order', caseId, LEAVE.toISOString()],
    );
    assert.deepEqual([v.lines[0].takeHome, v.lines[0].plannedLeaveAt, v.lines[0].status, v.lines[0].defaultStore], [true, LEAVE.toISOString(), 'to-check', 'main']);
    const doc: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([doc.takeHome, new Date(doc.plannedLeaveAt).toISOString(), String(doc.case)], [true, LEAVE.toISOString(), caseId]);
    assert.ok(((await m.Case.findById(caseId).lean()) as any).agents.includes('pharmacy'));
    assert.equal((await w.sent('pharmacy.ordered')).length, 1);
    assert.equal((await w.sent('pharmacy.to-check')).length, 1);

    // A direct order is never take-home and has no leaving time.
    const direct = await wardOrder([aspirin300]);
    assert.equal(direct.takeHome, false);
    assert.equal('plannedLeaveAt' in direct, false);
    assert.deepEqual([direct.lines[0].takeHome, 'plannedLeaveAt' in direct.lines[0]], [false, false]);
  });

  test('place goes through the order flow: a red allergy needs a reason, and the case must be the open case of this patient', async () => {
    await m.Patient.updateOne({ _id: w.patientId }, { allergies: ['Penicillin'] });
    await assert.rejects(() => place([amoxicillin500]), { status: 400, message: 'Confirm the allergy for Amoxicillin with a reason, or remove it' });
    const other = await m.Patient.create({ uhid: 'MHK202600902', name: 'Asha Devi', age: 40, gender: 'Female', phone: '9100000002' });
    const otherCase = String((await w.openWard(String(other._id), other.uhid, other.name)).case._id);
    await assert.rejects(() => place([ceftriaxone1], w.patientId, otherCase), { status: 400 });
    await assert.rejects(() => place([ceftriaxone1], w.patientId, 'not-an-id'), { status: 400 });
    await assert.rejects(() => w.takeHome.place(DOC, { patientId: w.patientId, caseId, plannedLeaveAt: new Date('nope'), lines: [ceftriaxone1] }), { status: 400 });
    await m.Case.updateOne({ _id: otherCase }, { $set: { state: 'closed' } });
    await assert.rejects(() => place([ceftriaxone1], String(other._id), otherCase), { status: 409 });
    assert.equal(await m.PharmacyOrder.countDocuments(), 0, 'nothing was saved');
  });

  test("cancelOrder cancels the order's waiting lines as the Discharge Agent and returns how many", async () => {
    const ward = await wardOrder([aspirin300]);
    const th = await place([enoxaparin60, amoxicillin500, pantoprazole40]);
    const [a, b, c] = th.lines.map((l) => l.id);
    await w.checks.approve(PHARM, b, {});
    await w.checks.approve(PHARM, c, {});
    await issue(c);
    assert.equal(await w.takeHome.cancelOrder(th.id, 'Discharge order not saved'), 2);
    for (const id of [a, b]) {
      const doc = await w.lineDoc(id);
      assert.equal(doc.status, 'cancelled');
      assert.deepEqual([doc.cancelled.by, doc.cancelled.reason], [{ id: 'discharge-agent', name: 'Discharge Agent' }, 'Discharge order not saved']);
    }
    assert.equal(await statusOf(c), 'issued');
    assert.equal(await statusOf(ward.lines[0].id), 'to-check', 'another order is never touched');
    assert.equal(await w.takeHome.cancelOrder(th.id, 'Discharge order not saved'), 0);
    assert.equal(await w.takeHome.cancelOrder(ward.id, 'Discharge order not saved'), 0, 'only a take-home order');
    assert.equal(await statusOf(ward.lines[0].id), 'to-check');
    assert.equal(await w.takeHome.cancelOrder('not-an-id', 'x'), 0);
  });

  // ---------- leaving ----------

  test('discharge.completed cancels waiting ward and take-home lines with the reason and leaves OPD lines alone', async () => {
    // Same case: an ER line from before admission, ward lines in each state, a take-home line and an OPD counter line.
    await w.orders.setLocation(caseId, 'ER');
    const er = await wardOrder([aspirin300]);
    await w.orders.setLocation(caseId, 'OPD');
    const opd = await wardOrder([ceftriaxone1]);
    await w.orders.setLocation(caseId, 'Ward');
    const ward = await wardOrder([enoxaparin60, amoxicillin500, pantoprazole40, atorvastatin20]);
    assert.deepEqual([er.setting, opd.setting, ward.setting], ['ER', 'OPD', 'Ward']);
    const [toCheck, approved, query, issued] = ward.lines.map((l) => l.id);
    await w.checks.approve(PHARM, approved, {});
    await w.checks.query(PHARM, query, { kind: 'dose', question: 'Still needed?' });
    await w.checks.approve(PHARM, issued, {});
    await issue(issued);
    const th = await place([omeprazole20]);

    await completed(caseId, 'home');
    for (const id of [er.lines[0].id, toCheck, approved, query, th.lines[0].id]) {
      const doc = await w.lineDoc(id);
      assert.equal(doc.status, 'cancelled', id);
      assert.deepEqual([doc.cancelled.by, doc.cancelled.reason], [{ id: 'discharge-agent', name: 'Discharge Agent' }, 'Patient discharged']);
    }
    assert.equal((await w.lineDoc(query)).query.answer.outcome, 'cancel', 'the open query is answered by the cancel');
    assert.equal(((await m.TaskAlertItem.findOne({ link: `pharmacy-line:${query}` }).lean()) as any).status, 'Completed');
    assert.equal(await statusOf(issued), 'issued');
    assert.equal(await statusOf(opd.lines[0].id), 'to-check');
    assert.equal((await w.sent('pharmacy.cancelled')).length, 5);

    // The reason names how the patient left.
    const reasons: [string, string][] = [
      ['transfer', 'Patient discharged'],
      ['against-advice', 'Patient discharged'],
      ['died', 'Patient died'],
      ['left-without-discharge', 'Patient left without discharge'],
    ];
    for (const [i, [kind, reason]] of reasons.entries()) {
      const p = await m.Patient.create({ uhid: `MHK20260091${i}`, name: `Patient ${i}`, age: 50, gender: 'Male', phone: `910000001${i}` });
      const c = String((await w.openWard(String(p._id), p.uhid, p.name)).case._id);
      const v = await w.orders.order(DOC, { patientId: String(p._id), priority: 'routine', lines: [amoxicillin500] });
      await completed(c, kind);
      const doc = await w.lineDoc(v.lines[0].id);
      assert.deepEqual([doc.status, doc.cancelled?.reason], ['cancelled', reason], kind);
    }
  });

  test('discharge.cancelled cancels only waiting take-home lines', async () => {
    const ward = await wardOrder([enoxaparin60, aspirin300]);
    await w.checks.approve(PHARM, ward.lines[0].id, {});
    const th = await place([amoxicillin500, pantoprazole40, ceftriaxone1]);
    const [a, b, c] = th.lines.map((l) => l.id);
    await w.checks.approve(PHARM, b, {});
    await w.checks.approve(PHARM, c, {});
    await issue(c);

    await cancelled(caseId);
    for (const id of [a, b]) {
      const doc = await w.lineDoc(id);
      assert.deepEqual([doc.status, doc.cancelled?.reason, doc.cancelled?.by.name], ['cancelled', 'Discharge cancelled', 'Discharge Agent']);
    }
    assert.equal(await statusOf(c), 'issued');
    assert.equal(await statusOf(ward.lines[0].id), 'approved');
    assert.equal(await statusOf(ward.lines[1].id), 'to-check');
    assert.equal((await w.sent('pharmacy.cancelled')).length, 2);
  });

  test('the handlers run twice and cancel once', async () => {
    const ward = await wardOrder([aspirin300]);
    const th = await place([amoxicillin500]);

    const cancel = await cancelled(caseId);
    assert.equal(await statusOf(th.lines[0].id), 'cancelled');
    await w.rerun('discharge.cancelled', String(cancel!._id));
    assert.equal(await statusOf(th.lines[0].id), 'cancelled');
    assert.equal((await w.sent('pharmacy.cancelled')).length, 1);
    // A take-home order placed after the cancel is never swept up by a late re-run of it.
    const again = await place([pantoprazole40]);
    await w.rerun('discharge.cancelled', String(cancel!._id));
    assert.equal(await statusOf(again.lines[0].id), 'to-check');

    const left = await completed(caseId, 'home');
    await w.rerun('discharge.completed', String(left!._id));
    assert.deepEqual([await statusOf(ward.lines[0].id), await statusOf(again.lines[0].id)], ['cancelled', 'cancelled']);
    assert.equal((await w.sent('pharmacy.cancelled')).length, 3);
    assert.equal((await w.sent('pharmacy.cancelled')).filter((x) => x.payload.lineId === ward.lines[0].id).length, 1);

    // A message with no case, or an unknown message, changes nothing and never throws.
    const other = await wardOrder([ceftriaxone1]);
    await completed(undefined, 'home');
    await cancelled(undefined);
    await w.rerun('discharge.completed', 'not-an-id');
    await w.rerun('discharge.cancelled', '64b000000000000000000000');
    assert.equal(await statusOf(other.lines[0].id), 'to-check');
  });
});
