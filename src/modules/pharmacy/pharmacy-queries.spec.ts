import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, MIN, PHARM, World, amoxicillin500, aspirin300, buildWorld, ceftriaxone1, enoxaparin60 } from '../../test/pharmacy-fixtures';

describe('PharmacyChecksService: queries, answers and the kidney recheck', () => {
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

  const order = async (priority: 'stat' | 'urgent' | 'routine' = 'stat', lines = [aspirin300]) => {
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority, lines });
    return { v, id: v.lines[0].id };
  };
  const alertOf = (id: string) => m.TaskAlertItem.findOne({ link: `pharmacy-line:${id}` }).lean().exec() as Promise<any>;
  const backdateQueryClock = (minutes: number) =>
    m.Clock.collection.updateMany({ def: 'pharmacy-query' }, { $set: { startedAt: new Date(Date.now() - minutes * MIN), dueAt: new Date(Date.now() - 1000) } });

  test('query holds the line: alerts pharmacy-line:<id> (High, "For <doctor>"), starts a pharmacy-query clock due 30 min (STAT) or 120 (routine), and closes the check round', async () => {
    await w.openEr();
    const { v, id } = await order('stat');
    const view = await w.checks.query(PHARM, id, { kind: 'dose', question: 'Is 300 mg intended?' });
    assert.equal(view.status, 'query');
    assert.equal((await w.lineDoc(id)).querySeq, 1);
    const alert = await alertOf(id);
    assert.equal(alert.title, 'Pharmacy query: Aspirin 300 mg (dose)');
    assert.equal(alert.subtitle, `For Dr. Shajin · ${v.number} · answer within 30 min`);
    assert.deepEqual([alert.type, alert.category, alert.priority, alert.status], ['Medication Alert', 'Medication', 'High', 'Pending']);
    assert.deepEqual([alert.patientName, alert.uhid], ['Ravi Kumar', w.patientUhid]);
    const [clock] = await w.clocksOf('pharmacy-query');
    assert.equal(clock.ref, `${id}:q1`);
    assert.ok(Math.abs(new Date(clock.dueAt).getTime() - (Date.now() + 30 * MIN)) < 5_000);
    const [msg] = await w.sent('pharmacy.query');
    assert.deepEqual([msg.payload.querySeq, msg.payload.kind], [1, 'dose']);
    assert.equal((await w.sent('pharmacy.check-done')).length, 1);
    assert.ok(!/Ravi|Kumar|MHK2026/i.test(msg.summary + JSON.stringify(msg.payload)));

    await m.Case.updateMany({}, { $set: { state: 'closed' } });
    const r = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 3 }] });
    await w.checks.query(PHARM, r.lines[0].id, { kind: 'other', question: 'Why?' });
    const clocks = await w.clocksOf('pharmacy-query');
    assert.ok(Math.abs(new Date(clocks[1].dueAt).getTime() - (Date.now() + 120 * MIN)) < 5_000);
    // A second query on a line with an open query is refused.
    await assert.rejects(() => w.checks.query(PHARM, r.lines[0].id, { kind: 'other', question: 'Again' }), { status: 409 });
  });

  test('query() refuses kind stock, and a bad kind or an empty question is 400', async () => {
    await w.openEr();
    const { id } = await order();
    await assert.rejects(() => w.checks.query(PHARM, id, { kind: 'stock', question: 'x' }), { status: 400 });
    await assert.rejects(() => w.checks.query(PHARM, id, { kind: 'nope' as never, question: 'x' }), { status: 400 });
    await assert.rejects(() => w.checks.query(PHARM, id, { kind: 'dose', question: '  ' }), { status: 400 });
    assert.equal((await w.lineDoc(id)).status, 'to-check');
  });

  test('answering Keep confirms the red flags, completes the alert, stops the query clock and returns the line to To check', async () => {
    await w.openEr();
    const { v, id } = await order();
    await w.redAllergy(id);
    await w.checks.query(PHARM, id, { kind: 'allergy', question: 'Reaction?' });
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'keep' }), { status: 400 });
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'keep', reason: 'x'.repeat(301) }), { status: 400 });
    const view = await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'Mild rash only' });
    assert.equal(view.status, 'to-check');
    const line = await w.lineDoc(id);
    assert.deepEqual([line.query.answer.outcome, line.query.answer.by.name, line.query.answer.reason], ['keep', 'Dr. Shajin', 'Mild rash only']);
    assert.ok(line.flags.filter((f: any) => f.severity === 'red').every((f: any) => f.confirmed.reason === 'Mild rash only' && f.confirmed.by === 'Dr. Shajin'));
    assert.equal((await alertOf(id)).status, 'Completed');
    assert.equal((await w.clocksOf('pharmacy-query'))[0].state, 'met');
    assert.equal((await w.sent('pharmacy.query-answered')).length, 1);
    const o: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([o.checkRound, o.checkOpen], [2, true]);
    // Answered once only.
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'keep', reason: 'again' }), { status: 409 });
  });

  test('an expired query clock\'s escalation closes as "Query answered" when the query is answered (the late-stop path)', async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'Dose?' });
    await backdateQueryClock(40);
    await w.clocks.checkDue(new Date());
    const esc: any = await m.Escalation.findOne({ ladder: 'pharmacy-query' }).lean();
    assert.equal(esc.state, 'open');
    const open = await alertOf(id);
    assert.ok(open.title.startsWith('Escalated to'));
    assert.equal(String(open.escalation.id), String(esc._id));
    // One answer path: neither the alert nor its escalation can be closed any other way.
    await assert.rejects(() => w.escalations.acknowledge({ id: 'a', name: 'Admin', role: 'admin' as never }, String(esc._id)), { status: 409 });
    await w.checks.answer(DOC, id, { outcome: 'cancel', reason: 'Not needed' });
    const closed: any = await m.Escalation.findById(esc._id).lean();
    assert.deepEqual([closed.state, closed.ackByName], ['acknowledged', 'Query answered']);
    assert.equal((await alertOf(id)).status, 'Completed');
    assert.equal((await w.clocksOf('pharmacy-query'))[0].state, 'expired');
  });

  test('a line sent back by an answer 40 min after a STAT order is not overdue: round 2 of the check clock is due 15 min after the answer', async () => {
    await w.openEr();
    const { v, id } = await order('stat');
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(v.id) }, { $set: { createdAt: new Date(Date.now() - 40 * MIN) } });
    await m.PharmacyLine.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { enteredCheckAt: new Date(Date.now() - 40 * MIN) } });
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'Dose?' });
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'Intended' });
    const o: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([o.checkRound, o.checkOpen], [2, true]);
    assert.ok(Math.abs(new Date(o.checkDueAt).getTime() - (Date.now() + 15 * MIN)) < 5_000);
    const [, c2] = await w.clocksOf('pharmacy-check');
    assert.ok(Math.abs(new Date(c2.dueAt).getTime() - (Date.now() + 15 * MIN)) < 5_000);
    await w.clocks.checkDue(new Date());
    assert.equal(await m.Escalation.countDocuments({ ladder: 'pharmacy' }), 0);
  });

  test('Change makes version 2 with fresh flags and no carried confirmations, back to To check; Change on an issued line stops it and adds a replacing line', async () => {
    await w.openEr();
    const { id } = await order('stat', [{ ...aspirin300, dose: 1000, product: 'aspirin-tab-300' }]);
    assert.ok((await w.lineDoc(id)).flags.some((f: any) => f.key === 'dose.single' && f.severity === 'red'));
    await m.PharmacyLine.updateOne({ _id: id, 'flags.key': 'dose.single' }, { $set: { 'flags.$.confirmed': { by: 'Neethu George', reason: 'old', at: new Date() } } });
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'Too high?' });
    const view = await w.checks.answer(DOC, id, { outcome: 'change', change: { product: 'aspirin-tab-300', dose: 300, route: 'oral', frequency: 'STAT' } });
    assert.equal(view.status, 'to-check');
    const line = await w.lineDoc(id);
    assert.deepEqual([line.version, line.dose, line.flags.some((f: any) => f.severity === 'red'), line.flags.some((f: any) => f.confirmed)], [2, 300, false, false]);
    assert.equal(line.history.length, 1);
    assert.deepEqual([line.history[0].version, line.history[0].dose], [1, 1000]);
    assert.ok(line.history[0].flags.some((f: any) => f.key === 'dose.single'));
    assert.equal(line.history[0].by.name, 'Dr. Shajin');
    assert.equal(line.query.answer.outcome, 'change');
    assert.equal((await alertOf(id)).status, 'Completed');
    const [to1, to2] = await w.sent('pharmacy.to-check');
    assert.ok(to1 && to2);

    // Issued: the line is stopped and a new line replaces it.
    await w.checks.approve(PHARM, id, {});
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { status: 'issued', issued: { by: { id: 'p', name: 'P' }, at: new Date(), realAt: new Date(), store: 'er', batches: [] } } });
    await w.checks.openQuery(id, { kind: 'dose', question: 'Lower dose please', by: { id: PHARM.id, name: PHARM.name } });
    assert.equal((await w.lineDoc(id)).status, 'issued');
    const out = await w.checks.answer(DOC, id, { outcome: 'change', reason: 'Lower dose', change: { product: 'aspirin-tab-150', dose: 150, route: 'oral', frequency: 'STAT' } });
    assert.equal(out.status, 'stopped');
    const replacement: any = await m.PharmacyLine.findOne({ replaces: id }).lean();
    assert.deepEqual([replacement.status, replacement.dose, replacement.version], ['to-check', 150, 1]);
    assert.equal((await w.sent('pharmacy.stopped')).length, 1);
    assert.equal((await alertOf(id)).status, 'Completed');
  });

  test('a Change answer whose new version still has a red allergy is refused without confirm, and the line is left as it was', async () => {
    await w.openEr();
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    const { id } = await order('stat', [ceftriaxone1]);
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'Choose again' });
    const change = { product: 'amoxicillin-cap-500', dose: 500, route: 'oral', frequency: 'TDS', durationDays: 5 };
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'change', change }), { status: 400 });
    const same = await w.lineDoc(id);
    assert.deepEqual([same.version, same.status, same.query.answer], [1, 'query', undefined]);
    assert.equal((await alertOf(id)).status, 'Pending');
    await w.checks.answer(DOC, id, { outcome: 'change', change: { ...change, confirm: { reason: 'Tolerates amoxicillin' } } });
    const done = await w.lineDoc(id);
    assert.equal(done.version, 2);
    assert.equal(done.flags.find((f: any) => f.kind === 'allergy' && f.severity === 'red').confirmed.reason, 'Tolerates amoxicillin');
    assert.equal(done.status, 'to-check');
  });

  test('cancel with an open query closes the query, completes the alert and stops the query clock', async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'other', question: 'Still needed?' });
    const view = await w.checks.cancel(DOC, id, 'Patient refused');
    assert.equal(view.status, 'cancelled');
    const line = await w.lineDoc(id);
    assert.deepEqual([line.query.answer.outcome, line.query.answer.reason], ['cancel', 'Patient refused']);
    assert.equal((await alertOf(id)).status, 'Completed');
    assert.equal((await w.clocksOf('pharmacy-query'))[0].state, 'met');
    assert.equal((await w.sent('pharmacy.cancelled')).length, 1);
  });

  test('outcomes are checked: keep on a stock query and wait on an allergy query are 400, and wait needs a line approved before', async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'allergy', question: 'x' });
    const fits = { status: 400, message: "That answer doesn't fit this query" };
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'wait', reason: 'x' }), fits);
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'stop', reason: 'x' }), fits);
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'switch' }), fits);
    await w.checks.cancel(DOC, id, 'x');

    // A stock query (only Out of stock opens one) on a never-approved line: wait would skip the approve gates.
    const second = await order('stat', [aspirin300]);
    await w.checks.openQuery(second.id, { kind: 'stock', question: 'Out of stock', by: { id: 'pharmacy-agent', name: 'Pharmacy Agent' } });
    await assert.rejects(() => w.checks.answer(DOC, second.id, { outcome: 'keep', reason: 'x' }), fits);
    await assert.rejects(() => w.checks.answer(DOC, second.id, { outcome: 'change', change: { product: 'aspirin-tab-150', dose: 150, route: 'oral', frequency: 'STAT' } }), fits);
    await assert.rejects(() => w.checks.answer(DOC, second.id, { outcome: 'wait' }), fits);
    assert.equal((await w.lineDoc(second.id)).status, 'query');
  });

  test('wait on a stock query of an approved line returns it approved and waiting for stock; switch makes a replacing line and passes the red-allergy gate', async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.approve(PHARM, id, {});
    await w.checks.openQuery(id, { kind: 'stock', question: 'Out of stock in both stores: Aspirin tab 300 mg. Choose another medicine, wait for stock, or cancel.', by: { id: 'pharmacy-agent', name: 'Pharmacy Agent' } });
    assert.equal((await w.lineDoc(id)).status, 'query');
    const waited = await w.checks.answer(DOC, id, { outcome: 'wait' });
    assert.equal(waited.status, 'approved');
    assert.equal((await w.lineDoc(id)).waitingForStock, true);

    await w.checks.openQuery(id, { kind: 'stock', question: 'Out of stock again', by: { id: 'pharmacy-agent', name: 'Pharmacy Agent' } });
    assert.equal((await w.lineDoc(id)).query.seq, 2);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    const amox = { medicine: 'amoxicillin', product: 'amoxicillin-cap-500', dose: 500, route: 'oral', frequency: 'TDS', durationDays: 5 };
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'switch', switchTo: amox }), { status: 400 });
    assert.equal((await w.lineDoc(id)).status, 'query');
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'switch' }), { status: 400 });
    const sw = await w.checks.answer(DOC, id, { outcome: 'switch', switchTo: { ...amox, confirm: { reason: 'Tolerates it' } } });
    assert.equal(sw.status, 'cancelled');
    const repl: any = await m.PharmacyLine.findOne({ replaces: id }).lean();
    assert.equal(repl.status, 'to-check');
    assert.equal(repl.flags.find((f: any) => f.kind === 'allergy').confirmed.reason, 'Tolerates it');
    assert.equal((await w.sent('pharmacy.cancelled')).length, 1);
  });

  test("a query-answered for query 1 never stops query 2's clock or completes query 2's alert", async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'one' });
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'ok' });
    await w.checks.query(PHARM, id, { kind: 'other', question: 'two' });
    const clocks = await w.clocksOf('pharmacy-query');
    assert.deepEqual(clocks.map((c) => [c.ref, c.state]), [[`${id}:q1`, 'met'], [`${id}:q2`, 'running']]);
    const o: any = await m.PharmacyOrder.findById((await w.lineDoc(id)).order).lean();
    await w.messages.send({
      case: String(o.case), from: 'pharmacy', to: ['coordinator'], type: 'pharmacy.query-answered', priority: 'high', summary: 'late',
      payload: { orderId: String(o._id), orderNumber: o.number, lineId: id, medicine: 'aspirin', priority: 'stat', setting: 'ER', version: 1, checkRound: 1, checkDueAt: new Date(), issueRound: 0, issueDueAt: new Date(), querySeq: 1, outcome: 'keep' },
      dedupeKey: `late:${new Types.ObjectId()}`,
    });
    assert.equal((await w.clocksOf('pharmacy-query'))[1].state, 'running');
    assert.equal((await alertOf(id)).status, 'Pending');
    await w.checks.completeQueryAlert(id);
    assert.equal((await alertOf(id)).status, 'Pending', 'an open query keeps its alert');
    // Query 2's alert is restored for the new query: title and subtitle of query 2, no escalation of query 1.
    assert.equal((await alertOf(id)).title, 'Pharmacy query: Aspirin 300 mg (other)');
  });

  test('a later query on the same line reuses its alert, restoring title, priority and Pending and clearing the old escalation', async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'one' });
    await backdateQueryClock(40);
    await w.clocks.checkDue(new Date());
    assert.ok((await alertOf(id)).escalation);
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'ok' });
    assert.equal((await alertOf(id)).status, 'Completed');
    await w.checks.query(PHARM, id, { kind: 'clash', question: 'two' });
    const alert = await alertOf(id);
    assert.equal(alert.title, 'Pharmacy query: Aspirin 300 mg (clash)');
    assert.deepEqual([alert.status, alert.priority, alert.escalation], ['Pending', 'High', undefined]);
    assert.match(alert.subtitle, /^For Dr\. Shajin · MO-0001 · answer within 30 min$/);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `pharmacy-line:${id}` }), 1);
  });

  test('a recheck that finds an unconfirmed red allergy holds the line in an allergy query at once, even after approval: the line leaves To issue', async () => {
    await w.openEr();
    const { id } = await order('stat', [{ ...amoxicillin500 }]);
    await w.checks.approve(PHARM, id, {});
    assert.equal((await w.orders.worklist('issue')).length, 1);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    await w.orders.recheckPatient(w.patientId, 'order');
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.query.kind, line.query.by.name, line.query.question], ['query', 'allergy', 'Pharmacy Agent', 'Penicillin allergy recorded: amoxicillin is a penicillin. Please confirm with a reason, change the dose, or cancel.']);
    assert.equal((await w.orders.worklist('issue')).length, 0);
    assert.equal((await alertOf(id)).priority, 'High');
    // Never a second query on a line that already has one.
    await m.PharmacyLine.updateOne({ _id: id }, { $pull: { flags: { kind: 'allergy' } } });
    await w.orders.recheckPatient(w.patientId, 'order');
    assert.equal((await w.lineDoc(id)).querySeq, 1);
  });

  test('holdAtOnce queries each line with an unconfirmed red allergy', async () => {
    await w.openEr();
    const { v, id } = await order('stat', [aspirin300]);
    await w.redAllergy(id, 'aspirin');
    const docs = await m.PharmacyLine.find({ order: v.id }).exec();
    await w.checks.holdAtOnce(docs);
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.query.kind, line.query.question], ['query', 'allergy', 'Allergy recorded to aspirin. Please confirm with a reason, change the dose, or cancel.']);
    await w.checks.holdAtOnce(docs);
    assert.equal((await w.lineDoc(id)).querySeq, 1);
  });

  test('releasing a kidney result: enoxaparin goes from amber unknown to red eGFR 28 and one kidney query opens; the same message again opens no second one', async () => {
    const { case: theCase } = await w.openEr();
    const { id } = await order('stat', [{ ...enoxaparin60 }]);
    assert.deepEqual((await w.lineDoc(id)).flags.filter((f: any) => f.kind === 'kidney').map((f: any) => [f.key, f.severity]), [['kidney.unknown', 'amber']]);
    await w.kidneyReport(2.5, { labLine: 'k1' });
    const msg = await w.labResulted(String(theCase._id), 'rft');
    assert.ok(msg);
    const line = await w.lineDoc(id);
    const kidney = line.flags.filter((f: any) => f.kind === 'kidney');
    assert.deepEqual(kidney.map((f: any) => [f.key, f.severity, f.text]), [['kidney.0-30', 'red', 'eGFR 28: enoxaparin, reduce to once daily']]);
    assert.deepEqual([line.status, line.query.kind, line.query.question], ['query', 'kidney', 'Dose may need lowering for kidney function (eGFR 28). Please review.']);
    assert.equal(line.query.by.name, 'Pharmacy Agent');
    // Delivering the same message again changes nothing.
    await w.checks.onKidneyResult(String(msg!._id));
    await w.checks.onKidneyResult(String(msg!._id));
    assert.equal((await w.lineDoc(id)).querySeq, 1);
    assert.equal((await w.sent('pharmacy.query')).length, 1);
    // Keep answers it: the red kidney flag is confirmed with the doctor's reason.
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'Renal-dosed already' });
    const kept = await w.lineDoc(id);
    assert.equal(kept.flags.find((f: any) => f.kind === 'kidney').confirmed.reason, 'Renal-dosed already');
    assert.equal(kept.status, 'to-check');
  });

  test('a lab.resulted for troponin changes nothing', async () => {
    const { case: theCase } = await w.openEr();
    const { id } = await order('stat', [{ ...enoxaparin60 }]);
    await w.kidneyReport(2.5, { labLine: 'k1' });
    await w.labResulted(String(theCase._id), 'troponin');
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.flags.map((f: any) => f.key).filter((k: string) => k.startsWith('kidney'))], ['to-check', ['kidney.unknown']]);
    assert.equal(await m.PharmacyLine.countDocuments({ query: { $exists: true } }), 0);
  });

  test('a new red kidney flag on an issued line opens a query and the line stays issued; Keep closes it, Stop stops the line', async () => {
    const { case: theCase } = await w.openEr();
    const { id } = await order('stat', [{ ...enoxaparin60 }]);
    await w.checks.approve(PHARM, id, {});
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { status: 'issued', issued: { by: { id: 'p', name: 'P' }, at: new Date(), realAt: new Date(), store: 'er', batches: [] } } });
    await w.kidneyReport(2.5, { labLine: 'k1' });
    await w.labResulted(String(theCase._id), 'rft');
    let line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.query.kind, line.query.question], ['issued', 'kidney', 'Dose may need lowering for kidney function (eGFR 28). Please review.']);
    await assert.rejects(() => w.checks.cancel(DOC, id, 'x'), { status: 409 });
    await assert.rejects(() => w.checks.answer(DOC, id, { outcome: 'cancel', reason: 'x' }), { status: 400 });
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'Dose is already reduced' });
    line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.query.answer.outcome], ['issued', 'keep']);
    assert.equal((await alertOf(id)).status, 'Completed');
    assert.equal((await w.clocksOf('pharmacy-query'))[0].state, 'met');

    // A second line, stopped by the answer.
    const second = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [{ ...enoxaparin60, product: 'enoxaparin-syringe-40', dose: 40 }] });
    const id2 = second.lines[0].id;
    await m.PharmacyLine.updateOne({ _id: id2 }, { $set: { status: 'issued', issued: { by: { id: 'p', name: 'P' }, at: new Date(), realAt: new Date(), store: 'er', batches: [] }, flags: [] } });
    await w.orders.recheckPatient(w.patientId, 'kidney', { kinds: ['kidney'] });
    assert.equal((await w.lineDoc(id2)).query.kind, 'kidney');
    const stopped = await w.checks.answer(DOC, id2, { outcome: 'stop', reason: 'Kidney function too low' });
    assert.equal(stopped.status, 'stopped');
    assert.equal((await w.sent('pharmacy.stopped')).length, 1);
    assert.equal((await w.lineDoc(id2)).stopped.reason, 'Kidney function too low');
  });

  test('wait passes the approve gates: a red allergy that arrived during the stock query sends the line to To check and holds it (not approved)', async () => {
    await w.openEr();
    const { id } = await order('stat', [amoxicillin500]);
    await w.checks.approve(PHARM, id, {});
    await w.checks.openQuery(id, { kind: 'stock', question: 'Out of stock', by: { id: 'pharmacy-agent', name: 'Pharmacy Agent' } });
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    // Another order re-checks the stock-queried line: the red allergy is added and no second query opens.
    await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [{ medicine: 'paracetamol', product: 'paracetamol-tab-500', dose: 500, route: 'oral', frequency: 'STAT' }] });
    const mid = await w.lineDoc(id);
    assert.deepEqual([mid.status, mid.query.kind], ['query', 'stock']);
    assert.equal(mid.flags.filter((f: any) => f.key === 'allergy.amoxicillin' && !f.confirmed).length, 1);
    await w.checks.answer(DOC, id, { outcome: 'wait' });
    const line = await w.lineDoc(id);
    assert.notEqual(line.status, 'approved');
    assert.equal(line.waitingForStock, false);
    assert.equal(line.approved, undefined);
    // Held at once: an allergy query for a doctor, so it cannot reach To issue.
    assert.deepEqual([line.status, line.query.kind, line.query.seq], ['query', 'allergy', 2]);
    assert.equal((await w.orders.worklist('issue')).length, 0);
  });

  test('wait with an unreviewed amber allergy goes back to To check (not approved)', async () => {
    await w.openEr();
    const { id } = await order('stat', [aspirin300]);
    await w.checks.approve(PHARM, id, {});
    await w.checks.openQuery(id, { kind: 'stock', question: 'Out of stock', by: { id: 'pharmacy-agent', name: 'Pharmacy Agent' } });
    await m.PharmacyLine.updateOne({ _id: id }, { $push: { flags: { key: 'allergy.cross-nsaid', kind: 'allergy', severity: 'amber', text: 'x', version: 1 } } });
    await w.checks.answer(DOC, id, { outcome: 'wait' });
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.approved, line.waitingForStock], ['to-check', undefined, false]);
    assert.equal((await w.sent('pharmacy.to-check')).length, 2);
  });

  test("a query opened while an answer is being finished is not stopped by the old answer, and its alert is not completed by it", async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'one' });
    const q = (w.checks as any).queries;
    const original = q.completeQueryAlert.bind(q);
    let once = false;
    q.completeQueryAlert = async (lineId: string, seq?: number) => {
      if (!once) {
        once = true;
        await q.openQuery(lineId, { kind: 'kidney', question: 'two', by: { id: 'pharmacy-agent', name: 'Pharmacy Agent' } });
      }
      return original(lineId, seq);
    };
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'ok' });
    const [answered] = await w.sent('pharmacy.query-answered');
    assert.deepEqual([answered.payload.querySeq, answered.payload.outcome], [1, 'keep']);
    assert.deepEqual((await w.clocksOf('pharmacy-query')).map((c) => [c.ref, c.state]), [[`${id}:q1`, 'met'], [`${id}:q2`, 'running']]);
    const alert = await alertOf(id);
    assert.deepEqual([alert.status, alert.querySeq, alert.title], ['Pending', 2, 'Pharmacy query: Aspirin 300 mg (kidney)']);
    const queries = await w.sent('pharmacy.query');
    assert.deepEqual(queries.map((x) => x.payload.querySeq), [1, 2]);
  });

  test("an old escalation never completes an alert a newer query now owns", async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.query(PHARM, id, { kind: 'dose', question: 'one' });
    await backdateQueryClock(40);
    await w.clocks.checkDue(new Date());
    const esc: any = await m.Escalation.findOne({ ladder: 'pharmacy-query' }).lean();
    // The alert is reused by a newer query: escalation cleared, Pending again.
    await m.TaskAlertItem.updateOne({ link: `pharmacy-line:${id}` }, { $unset: { escalation: '' }, $set: { status: 'Pending', querySeq: 2 } });
    await w.escalations.resolve(String(esc._id), 'Query answered');
    assert.equal((await alertOf(id)).status, 'Pending');
    assert.equal(((await m.Escalation.findById(esc._id).lean()) as any).state, 'acknowledged');
  });

  test('a failure after the issued-line flip loses nothing: the replacement is stored with the answer and ensureReplacement adds exactly one, with the doctor\'s dose', async () => {
    await w.openEr();
    const { id } = await order();
    await w.checks.approve(PHARM, id, {});
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { status: 'issued', issued: { by: { id: 'p', name: 'P' }, at: new Date(), realAt: new Date(), store: 'er', batches: [] } } });
    await w.checks.openQuery(id, { kind: 'dose', question: 'Lower?', by: { id: PHARM.id, name: PHARM.name } });
    const real = w.orders.addLines.bind(w.orders);
    let fail = true;
    (w.orders as any).addLines = async (...args: any[]) => {
      if (fail) {
        fail = false;
        throw new Error('transient db error');
      }
      return (real as any)(...args);
    };
    const out = await w.checks.answer(DOC, id, { outcome: 'change', reason: 'Lower', change: { product: 'aspirin-tab-150', dose: 150, route: 'oral', frequency: 'STAT' } });
    assert.equal(out.status, 'stopped');
    const stored = (await w.lineDoc(id)).query.answer.replacement;
    assert.deepEqual([stored.dose, stored.product], [150, 'aspirin-tab-150']);
    assert.equal(await m.PharmacyLine.countDocuments({ replaces: id }), 0);
    // The answer still finished: alert completed, message sent.
    assert.equal((await alertOf(id)).status, 'Completed');
    assert.equal((await w.sent('pharmacy.query-answered')).length, 1);
    const added = await w.checks.ensureReplacement(id);
    assert.equal(String(added!._id), stored.id);
    assert.equal(await w.checks.ensureReplacement(id), null);
    const all: any[] = await m.PharmacyLine.find({ replaces: id }).lean();
    assert.equal(all.length, 1);
    assert.deepEqual([all[0].dose, all[0].status], [150, 'to-check']);
    assert.equal((await w.sent('pharmacy.to-check')).filter((x) => x.payload.lineId === stored.id).length, 1);
  });

  test('the recheck listener acts only on newly added red flags: a changed flag with no new red key opens no query', async () => {
    const { case: theCase } = await w.openEr();
    const { id } = await order('stat', [{ ...enoxaparin60 }]);
    await w.kidneyReport(2.5, { labLine: 'k1' });
    await w.labResulted(String(theCase._id), 'rft');
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'Renal-dosed already' });
    const line = await m.PharmacyLine.findById(id).exec();
    await (w.checks as any).queries.onRechecked([{ line, newRed: [], reason: 'kidney' }]);
    assert.equal((await w.lineDoc(id)).querySeq, 1);
    assert.equal((await w.lineDoc(id)).approved, undefined, 'a Kept line has no stale approval');
  });

  test('Keep never confirms an allergy that arrived while a kidney query was open: it closes its query, returns the line to To check and holds the new allergy', async () => {
    const { case: theCase } = await w.openEr();
    const { id } = await order('stat', [{ ...enoxaparin60 }]);
    await w.kidneyReport(2.5, { labLine: 'k1' });
    await w.labResulted(String(theCase._id), 'rft');
    assert.equal((await w.lineDoc(id)).query.kind, 'kidney');
    // A red allergy arrives while the kidney query is open (no second query opens on the line).
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['enoxaparin'] } });
    await w.orders.recheckPatient(w.patientId, 'order');
    const mid = await w.lineDoc(id);
    assert.equal(mid.query.kind, 'kidney');
    assert.equal(mid.flags.filter((f: any) => f.kind === 'allergy' && f.severity === 'red').length, 1);
    await w.checks.answer(DOC, id, { outcome: 'keep', reason: 'Renal-dosed already' });
    const line = await w.lineDoc(id);
    const allergy = line.flags.find((f: any) => f.kind === 'allergy');
    assert.equal(allergy.confirmed, undefined);
    assert.equal(line.flags.find((f: any) => f.kind === 'kidney').confirmed.reason, 'Renal-dosed already');
    // The kidney query is closed (clock met, one query-answered) and a new allergy query is open with its clock running.
    assert.deepEqual([line.status, line.query.kind, line.query.seq, line.query.answer], ['query', 'allergy', 2, undefined]);
    assert.deepEqual((await w.clocksOf('pharmacy-query')).map((c) => [c.ref, c.state]), [[`${id}:q1`, 'met'], [`${id}:q2`, 'running']]);
    assert.equal((await w.sent('pharmacy.query-answered')).length, 1);
    assert.equal((await alertOf(id)).querySeq, 2);
    // The pharmacist can't approve it: it is in a query, and the allergy still needs a doctor.
    await assert.rejects(() => w.checks.approve(PHARM, id, { reason: 'x' }), { status: 409 });
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { status: 'to-check' } });
    await assert.rejects(() => w.checks.approve(PHARM, id, { reason: 'x' }), { status: 409, message: 'A doctor must confirm this allergy first. Query the doctor.' });
  });
});
