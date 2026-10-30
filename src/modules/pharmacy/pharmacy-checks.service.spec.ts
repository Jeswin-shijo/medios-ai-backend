import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, MIN, PHARM, World, amoxicillin500, aspirin300, buildWorld, clopidogrel300, ceftriaxone1, enoxaparin60, ibuprofen400 } from '../../test/pharmacy-fixtures';

describe('PharmacyChecksService: the pharmacist checks', () => {
  const m = models();
  let w: World;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    w = await buildWorld(m);
  });

  test('approving an ER line sends pharmacy.approved and pharmacy.to-issue and starts the issue clock due 15 min later (STAT); an OPD line sends no to-issue', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300] });
    const id = v.lines[0].id;
    const view = await w.checks.approve(PHARM, id, {});
    assert.equal(view.status, 'approved');
    assert.equal((await w.sent('pharmacy.approved')).length, 1);
    assert.equal((await w.sent('pharmacy.to-issue')).length, 1);
    const [issue] = await w.clocksOf('pharmacy-issue');
    assert.equal(issue.ref, `${v.id}:i1`);
    assert.ok(Math.abs(new Date(issue.dueAt).getTime() - (Date.now() + 15 * MIN)) < 5_000);
    const line = await w.lineDoc(id);
    assert.deepEqual([line.approved.by.name, !!line.checkedAt, !!line.issueFrom, line.waitingForStock], ['Neethu George', true, true, false]);
    assert.equal((await w.sent('pharmacy.check-done')).length, 1);
    // A line that is no longer waiting for the check can't be approved again.
    await assert.rejects(() => w.checks.approve(PHARM, id, {}), { status: 409 });

    // OPD: a patient with no ER case. The line is approved for the counter and no issue clock starts.
    await m.Case.updateMany({}, { $set: { state: 'closed' } });
    const opd = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [{ medicine: 'amlodipine', product: 'amlodipine-tab-5', dose: 5, route: 'oral', frequency: 'OD', durationDays: 3 }] });
    assert.equal(opd.setting, 'OPD');
    await w.checks.approve(PHARM, opd.lines[0].id, {});
    assert.equal((await w.sent('pharmacy.approved')).length, 2);
    assert.equal((await w.sent('pharmacy.to-issue')).length, 1);
    assert.equal(await m.Clock.countDocuments({ def: 'pharmacy-issue' }), 1);
  });

  test("a red allergy line can't be approved, with or without a reason (409); after the doctor's Keep it can be", async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300] });
    const id = v.lines[0].id;
    // A real allergy on the record (Y48: every approval rechecks it). The first approval holds the line in an allergy query.
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Aspirin'] } });
    await assert.rejects(() => w.checks.approve(PHARM, id, {}), { status: 409 });
    assert.equal((await w.lineDoc(id)).status, 'query');
    await assert.rejects(() => w.checks.approve(PHARM, id, { reason: 'I checked it', allergyReviewed: true }), { status: 409 });
    assert.equal((await w.sent('pharmacy.approved')).length, 0);
    // The doctor's Keep confirms the red allergy flag with the doctor's reason, and the line is back in To check.
    await w.checks.answer(DOC, id, { querySeq: 1, outcome: 'keep', reason: 'Tolerated it since' });
    const kept = await w.lineDoc(id);
    assert.equal(kept.status, 'to-check');
    assert.equal(kept.flags.find((f: any) => f.kind === 'allergy').confirmed.reason, 'Tolerated it since');
    const done = await w.checks.approve(PHARM, id, {});
    assert.equal(done.status, 'approved');
  });

  test('an unconfirmed red clash needs a reason; an amber allergy needs Allergy reviewed', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [{ ...enoxaparin60, frequency: 'STAT', durationDays: undefined }, ibuprofen400] });
    const ibu = v.lines.find((l) => l.medicine === 'ibuprofen')!.id;
    await assert.rejects(() => w.checks.approve(PHARM, ibu, {}), { status: 400, message: 'A reason is required to approve a red flag' });
    await assert.rejects(() => w.checks.approve(PHARM, ibu, { reason: '   ' }), { status: 400 });
    const ok = await w.checks.approve(PHARM, ibu, { reason: 'Short course, monitored' });
    assert.equal(ok.status, 'approved');
    const stored = await w.lineDoc(ibu);
    assert.equal(stored.approved.reason, 'Short course, monitored');
    assert.equal(stored.flags.find((f: any) => f.key.startsWith('clash.')).confirmed.reason, 'Short course, monitored');

    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    const v2 = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [ceftriaxone1] });
    const cef = v2.lines[0].id;
    assert.ok((await w.lineDoc(cef)).flags.some((f: any) => f.key === 'allergy.cross-penicillin' && f.severity === 'amber'));
    await assert.rejects(() => w.checks.approve(PHARM, cef, {}), { status: 400, message: 'Tick Allergy reviewed to approve' });
    await w.checks.approve(PHARM, cef, { allergyReviewed: true });
    const approved = await w.lineDoc(cef);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.flags.find((f: any) => f.kind === 'allergy').reviewed.by, 'Neethu George');
  });

  test('Y48: an allergy recorded after ordering is seen at approval (red: refused and held; amber: needs Allergy reviewed)', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [amoxicillin500] });
    const id = v.lines[0].id;
    assert.deepEqual((await w.lineDoc(id)).flags, []);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    await assert.rejects(() => w.checks.approve(PHARM, id, { reason: 'ok', allergyReviewed: true }), { status: 409 });
    const held = await w.lineDoc(id);
    assert.equal(held.status, 'query');
    assert.equal(held.query.kind, 'allergy');
    assert.ok(held.flags.some((f: any) => f.kind === 'allergy' && f.severity === 'red'));

    // Amber: a cephalosporin ordered first, penicillin recorded after.
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: [] } });
    const v2 = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [ceftriaxone1] });
    const cef = v2.lines[0].id;
    assert.deepEqual((await w.lineDoc(cef)).flags, []);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    await assert.rejects(() => w.checks.approve(PHARM, cef, {}), { status: 400, message: 'Tick Allergy reviewed to approve' });
    const ok = await w.checks.approve(PHARM, cef, { allergyReviewed: true });
    assert.equal(ok.status, 'approved');
  });

  test('approving the earliest of two waiting lines moves the check due to the other line, and an expired round raises no second escalation', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300, clopidogrel300] });
    const [a, b] = v.lines.map((l) => l.id);
    const t = Date.now();
    await m.PharmacyLine.updateOne({ _id: a }, { $set: { enteredCheckAt: new Date(t - 10 * MIN) } });
    await m.PharmacyLine.updateOne({ _id: b }, { $set: { enteredCheckAt: new Date(t - 2 * MIN) } });
    // Approving B leaves A's due as the round's due.
    await w.checks.approve(PHARM, b, {});
    let order: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.equal(new Date(order.checkDueAt).getTime(), t - 10 * MIN + 15 * MIN);
    // Let the round expire and escalate, then approve A: nothing escalates twice.
    await m.Clock.collection.updateMany({ def: 'pharmacy-check' }, { $set: { startedAt: new Date(t - 20 * MIN), dueAt: new Date(t - 5 * MIN) } });
    await w.clocks.checkDue(new Date());
    assert.equal(await m.Escalation.countDocuments({ ladder: 'pharmacy' }), 1);
    await w.checks.approve(PHARM, a, {});
    await w.clocks.checkDue(new Date());
    await w.clocks.checkDue(new Date());
    assert.equal(await m.Escalation.countDocuments({ ladder: 'pharmacy' }), 1);
    order = await m.PharmacyOrder.findById(v.id).lean();
    assert.equal(order.checkOpen, false);
  });

  test('approving the earliest of two lines moves the clock to the later line due', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300, clopidogrel300] });
    const [a, b] = v.lines.map((l) => l.id);
    const t = Date.now();
    await m.PharmacyLine.updateOne({ _id: a }, { $set: { enteredCheckAt: new Date(t - 10 * MIN) } });
    await m.PharmacyLine.updateOne({ _id: b }, { $set: { enteredCheckAt: new Date(t - 2 * MIN) } });
    await w.orders.syncRounds(v.id);
    await w.checks.approve(PHARM, a, {});
    const order: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.equal(new Date(order.checkDueAt).getTime(), t - 2 * MIN + 15 * MIN);
    const [clock] = await w.clocksOf('pharmacy-check');
    assert.equal(clock.state, 'running');
    assert.equal(new Date(clock.dueAt).getTime(), t - 2 * MIN + 15 * MIN);
  });

  test('reject alerts pharmacy-rejected:<id> (tickable) and sends pharmacy.rejected', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300] });
    const id = v.lines[0].id;
    await assert.rejects(() => w.checks.reject(PHARM, id, ''), { status: 400 });
    const view = await w.checks.reject(PHARM, id, 'Wrong strength for this patient');
    assert.equal(view.status, 'rejected');
    const alert: any = await m.TaskAlertItem.findOne({ link: `pharmacy-rejected:${id}` }).lean();
    assert.equal(alert.title, 'Rejected: Aspirin 300 mg');
    assert.equal(alert.subtitle, `For Dr. Shajin · ${v.number} · Wrong strength for this patient`);
    assert.deepEqual([alert.type, alert.category, alert.priority, alert.status], ['Medication Alert', 'Medication', 'Medium', 'Pending']);
    assert.equal(alert.escalation, undefined);
    assert.equal((await w.sent('pharmacy.rejected')).length, 1);
    assert.equal((await w.lineDoc(id)).rejected.reason, 'Wrong strength for this patient');
    assert.equal((await w.sent('pharmacy.check-done')).length, 1);
    await assert.rejects(() => w.checks.reject(PHARM, id, 'again'), { status: 409 });
  });

  test('cancel works on to-check and approved lines, and an issued line can be stopped only by answering a query', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300, clopidogrel300] });
    const [a, b] = v.lines.map((l) => l.id);
    await assert.rejects(() => w.checks.cancel(DOC, a, ''), { status: 400 });
    const cancelled = await w.checks.cancel(DOC, a, 'Ordered by mistake');
    assert.equal(cancelled.status, 'cancelled');
    const msgs = await w.sent('pharmacy.cancelled');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].payload.lineId, a);
    await w.checks.approve(PHARM, b, {});
    assert.equal((await w.checks.cancel(DOC, b, 'Stop')).status, 'cancelled');
    await m.PharmacyLine.updateOne({ _id: a }, { $set: { status: 'issued' } });
    await assert.rejects(() => w.checks.cancel(DOC, a, 'x'), { status: 409, message: 'An issued line can be stopped only by answering a query' });
    // A line that is already closed is refused too.
    await assert.rejects(() => w.checks.cancel(DOC, b, 'x'), { status: 409 });
  });
});
