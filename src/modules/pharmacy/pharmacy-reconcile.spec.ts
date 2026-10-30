import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, PHARM, World, aspirin300, buildWorld } from '../../test/pharmacy-fixtures';
import { StockWorld, buildStock } from '../../test/pharmacy-stock-fixtures';
import { PHARMACY_AGENT } from './pharmacy-queries.service';
import { PatientsService } from '../patients/patients.service';
import { PharmacyPrescriptionsService } from './pharmacy-prescriptions.service';
import { PharmacyReconcileService } from './pharmacy-reconcile.service';

const aspirin10 = { ...aspirin300, frequency: 'BD', durationDays: 5 };
const metformin500 = { medicine: 'metformin', product: 'metformin-tab-500', dose: 500, route: 'oral', frequency: 'BD', durationDays: 5 };
const amlodipine5 = { medicine: 'amlodipine', product: 'amlodipine-tab-5', dose: 5, route: 'oral', frequency: 'OD', durationDays: 5 };

describe('PharmacyReconcileService', () => {
  const m = models();
  let w: World;
  let s: StockWorld;
  let rec: PharmacyReconcileService;
  let rxSvc: PharmacyPrescriptionsService;
  let logged: string[];

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    w = await buildWorld(m);
    s = buildStock(m, w);
    rxSvc = new PharmacyPrescriptionsService(m.Prescription, m.PharmacyOrder, m.PharmacyLine, w.orders, w.checks, new PatientsService(m.Patient));
    rec = new PharmacyReconcileService(m.PharmacyOrder, m.PharmacyLine, m.Clock, m.AgentMessage, w.orders, w.checks, s.issue, s.stock, m.Prescription, rxSvc);
    // The deliberate failures stay out of the test output; tests read what was logged.
    logged = [];
    (rec as any).logger = { error: (x: string) => logged.push(x), log: () => undefined, warn: () => undefined };
    await w.openEr();
  });

  /** Timestamps are immutable through the model: age every row through the collection, so nothing counts as "in flight". */
  const old = () => new Date(Date.now() - 5 * 60_000);
  const settle = async () => {
    for (const c of [m.PharmacyOrder, m.PharmacyLine]) await c.collection.updateMany({}, { $set: { updatedAt: old() } });
    await m.PharmacyOrder.collection.updateMany({}, { $set: { createdAt: old() } });
    await m.AgentMessage.collection.updateMany({}, { $set: { createdAt: old() } });
    await m.PharmacyLine.collection.updateMany({ 'issued.realAt': { $exists: true } }, { $set: { 'issued.realAt': old() } });
  };
  const pass = async () => {
    await settle();
    return rec.reconcile();
  };
  const sent = (type: string) => m.AgentMessage.countDocuments({ type }).exec();
  const wipe = (...types: string[]) => m.AgentMessage.deleteMany({ type: { $in: types } });
  const clocksOf = (def: string) => m.Clock.find({ def }).sort({ startedAt: 1, _id: 1 }).lean<any[]>().exec();
  const alertOf = (lineId: string) => m.TaskAlertItem.findOne({ link: `pharmacy-line:${lineId}` }).lean<any>().exec();
  const order = async (lines: any[] = [aspirin10], priority: 'stat' | 'urgent' | 'routine' = 'urgent') => w.orders.order(DOC, { patientId: w.patientId, priority, lines });
  const orderDoc = (id: string) => m.PharmacyOrder.findById(id).lean<any>().exec();
  const ZERO = { ordered: 0, rounds: 0, done: 0, queries: 0, answers: 0, issued: 0, takes: 0, replacements: 0, holds: 0, released: 0, prescriptions: 0 };

  test('an order whose pharmacy.ordered was lost is announced once; one younger than 30 s is left alone', async () => {
    const v = await order();
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(v.id) }, { $unset: { announcedAt: '' } });
    await wipe('pharmacy.ordered');
    // Younger than 30 s: left alone.
    assert.equal((await rec.reconcile()).ordered, 0);
    assert.equal(await sent('pharmacy.ordered'), 0);
    const first = await pass();
    assert.equal(first.ordered, 1);
    assert.equal(await sent('pharmacy.ordered'), 1);
    assert.ok((await orderDoc(v.id)).announcedAt);
    assert.deepEqual(await pass(), ZERO);
    assert.equal(await sent('pharmacy.ordered'), 1);
  });

  test('Y35: an order with no lines is never announced', async () => {
    const patient = await m.Patient.findById(w.patientId).lean<any>().exec();
    const empty = await w.orders.createOrder({ patient, priority: 'routine', orderedBy: DOC, source: 'order' });
    await wipe('pharmacy.ordered');
    const r = await pass();
    assert.equal(r.ordered, 0);
    assert.equal(await sent('pharmacy.ordered'), 0);
    assert.equal((await orderDoc(String(empty._id))).announcedAt, undefined);
  });

  test('a line flipped to To check with no round (a crash before publish) gets a round and a running check clock', async () => {
    const v = await order();
    const oid = new Types.ObjectId(v.id);
    await m.PharmacyOrder.collection.updateOne({ _id: oid }, { $set: { checkRound: 0, checkOpen: false }, $unset: { checkDueAt: '' } });
    await m.Clock.deleteMany({});
    await wipe('pharmacy.to-check');
    const first = await pass();
    assert.equal(first.rounds, 1);
    const o = await orderDoc(v.id);
    assert.deepEqual([o.checkRound, o.checkOpen], [1, true]);
    const clocks = await clocksOf('pharmacy-check');
    assert.equal(clocks.length, 1);
    assert.deepEqual([clocks[0].state, clocks[0].ref], ['running', `${v.id}:c1`]);
    assert.equal(await sent('pharmacy.to-check'), 1);
    assert.deepEqual(await pass(), ZERO);
    assert.equal(await sent('pharmacy.to-check'), 1);
  });

  test('an open round with no clock (a crash before to-check was sent) gets its to-check resent', async () => {
    const v = await order();
    assert.equal((await clocksOf('pharmacy-check')).length, 1);
    await m.Clock.deleteMany({});
    await wipe('pharmacy.to-check');
    const first = await pass();
    assert.equal(first.rounds, 1);
    const clocks = await clocksOf('pharmacy-check');
    assert.deepEqual(clocks.map((c) => [c.state, c.ref]), [['running', `${v.id}:c1`]]);
    assert.equal(await sent('pharmacy.to-check'), 1);
    assert.deepEqual(await pass(), ZERO);
  });

  test('a start message sent a moment ago is not resent (it would be dropped as a duplicate); the next pass repairs it', async () => {
    await order();
    await m.Clock.deleteMany({});
    await m.PharmacyOrder.collection.updateMany({}, { $set: { updatedAt: old() } });
    await m.PharmacyLine.collection.updateMany({}, { $set: { updatedAt: old() } });
    // The to-check message is 10 s old (inside the 60 s window).
    await m.AgentMessage.collection.updateMany({}, { $set: { createdAt: old() } });
    await m.AgentMessage.collection.updateMany({ type: 'pharmacy.to-check' }, { $set: { createdAt: new Date(Date.now() - 10_000) } });
    assert.equal((await rec.reconcile()).rounds, 0);
    assert.equal((await clocksOf('pharmacy-check')).length, 0);
    await m.AgentMessage.collection.updateMany({ type: 'pharmacy.to-check' }, { $set: { createdAt: old() } });
    assert.equal((await rec.reconcile()).rounds, 1);
    assert.equal((await clocksOf('pharmacy-check')).length, 1);
  });

  test('a running clock of a closed round (a crash before check-done) is stopped by check-done for that round only; the next round keeps running', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.approve(PHARM, lineId, { reason: 'intended' });
    assert.equal(await sent('pharmacy.check-done'), 1);
    // The line goes back to check: round 2 opens.
    assert.equal(await w.checks.sendBackToCheck(lineId), true);
    const [c1, c2] = await clocksOf('pharmacy-check');
    assert.deepEqual([c1.state, c2.state], ['met', 'running']);
    // Round 1's clock never heard check-done.
    await m.Clock.collection.updateOne({ _id: c1._id }, { $set: { state: 'running' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await m.AgentMessage.deleteMany({ type: 'pharmacy.check-done' });
    const first = await pass();
    assert.equal(first.done, 1);
    const after = await clocksOf('pharmacy-check');
    assert.deepEqual(after.map((c) => [c.ref, c.state]), [[`${v.id}:c1`, 'met'], [`${v.id}:c2`, 'running']]);
    const dones = await m.AgentMessage.find({ type: 'pharmacy.check-done' }).lean<any[]>();
    assert.deepEqual(dones.map((d) => d.payload.checkRound), [1]);
    assert.deepEqual(await pass(), ZERO);
  });

  test('a closed round whose done message failed to send gets it re-sent, even though its open flag is already false', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.approve(PHARM, lineId, { reason: 'intended' });
    const [c1] = await clocksOf('pharmacy-check');
    await m.Clock.collection.updateOne({ _id: c1._id }, { $set: { state: 'running' }, $unset: { stoppedAt: '' } });
    await m.AgentMessage.deleteMany({ type: 'pharmacy.check-done' });
    assert.equal((await orderDoc(v.id)).checkOpen, false);
    const first = await pass();
    assert.equal(first.done, 1);
    assert.equal(await sent('pharmacy.check-done'), 1);
    assert.equal((await clocksOf('pharmacy-check'))[0].state, 'met');
    assert.deepEqual(await pass(), ZERO);
  });

  test('an open query with no clock and no alert gets both; a query answered between the read and the repair is not reopened', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.query(PHARM, lineId, { kind: 'dose', question: 'Is this dose right?' });
    assert.ok(await alertOf(lineId));
    const breakIt = async () => {
      await m.Clock.deleteMany({ def: 'pharmacy-query' });
      await m.TaskAlertItem.deleteMany({ link: `pharmacy-line:${lineId}` });
      await wipe('pharmacy.query');
    };
    await breakIt();
    const first = await pass();
    assert.equal(first.queries, 1);
    const clocks = await clocksOf('pharmacy-query');
    assert.deepEqual(clocks.map((c) => [c.state, c.ref]), [['running', `${lineId}:q1`]]);
    assert.equal((await alertOf(lineId)).status, 'Pending');
    assert.equal(await sent('pharmacy.query'), 1);
    assert.deepEqual(await pass(), ZERO);

    // Break it again, and let the doctor answer in the moment between the repair's read and its write.
    await breakIt();
    await settle();
    const clockModel: any = m.Clock;
    const orig = clockModel.exists;
    let fired = false;
    clockModel.exists = function (...args: any[]) {
      const q = orig.apply(this, args);
      if (fired || !JSON.stringify(args[0] ?? {}).includes('pharmacy-query')) return q;
      fired = true;
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const r = await exec();
        await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'keep', reason: 'Dose is right' });
        return r;
      };
      return q;
    };
    try {
      assert.equal((await rec.reconcile()).queries, 0);
    } finally {
      clockModel.exists = orig;
    }
    assert.ok(fired);
    assert.equal(await sent('pharmacy.query'), 0);
    assert.equal((await clocksOf('pharmacy-query')).length, 0);
    const line = await w.lineDoc(lineId);
    assert.equal(line.query.answer.outcome, 'keep');
    assert.equal(line.status, 'to-check');
  });

  test('an answered query whose clock still runs gets query-answered resent, and its escalation closes', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.query(PHARM, lineId, { kind: 'dose', question: 'Is this dose right?' });
    await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'keep', reason: 'Dose is right' });
    const [c] = await clocksOf('pharmacy-query');
    assert.equal(c.state, 'met');
    // The answer's message never reached the clock, and the alert is still Pending.
    await m.Clock.collection.updateOne({ _id: c._id }, { $set: { state: 'running' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await m.TaskAlertItem.updateOne({ link: `pharmacy-line:${lineId}` }, { $set: { status: 'Pending' } });
    await m.AgentMessage.deleteMany({ type: 'pharmacy.query-answered' });
    const first = await pass();
    assert.equal(first.answers, 1);
    assert.equal((await clocksOf('pharmacy-query'))[0].state, 'met');
    assert.equal((await alertOf(lineId)).status, 'Completed');
    assert.equal(await sent('pharmacy.query-answered'), 1);
    assert.deepEqual(await pass(), ZERO);
  });

  test('an expired query clock never marked met is closed by the resent answer', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.query(PHARM, lineId, { kind: 'dose', question: 'Is this dose right?' });
    await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'keep', reason: 'Dose is right' });
    const [c] = await clocksOf('pharmacy-query');
    await m.Clock.collection.updateOne({ _id: c._id }, { $set: { state: 'expired' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await m.AgentMessage.deleteMany({ type: 'pharmacy.query-answered' });
    assert.equal((await pass()).answers, 1);
    assert.ok((await clocksOf('pharmacy-query'))[0].stoppedAt);
    assert.deepEqual(await pass(), ZERO);
  });

  test('a resent query-answered for query 1, after the 60 s duplicate window, never stops query 2\'s clock, and query 2\'s alert stays Pending', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.query(PHARM, lineId, { kind: 'dose', question: 'Is this dose right?' });
    await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'keep', reason: 'Dose is right' });
    await w.checks.query(PHARM, lineId, { kind: 'other', question: 'And the frequency?' });
    const [c1, c2] = await clocksOf('pharmacy-query');
    assert.deepEqual([c1.ref, c2.ref], [`${lineId}:q1`, `${lineId}:q2`]);
    // Query 1's answer message was lost, so its clock still runs; its message key is outside the window.
    await m.Clock.collection.updateOne({ _id: c1._id }, { $set: { state: 'running' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await m.AgentMessage.deleteMany({ type: 'pharmacy.query-answered' });
    const first = await pass();
    assert.equal(first.answers, 1);
    const [a, b] = await clocksOf('pharmacy-query');
    assert.deepEqual([a.ref, a.state, b.ref, b.state], [`${lineId}:q1`, 'met', `${lineId}:q2`, 'running']);
    const alert = await alertOf(lineId);
    assert.equal(alert.status, 'Pending');
    assert.equal(alert.querySeq, 2);
    const msgs = await m.AgentMessage.find({ type: 'pharmacy.query-answered' }).lean<any[]>();
    assert.deepEqual(msgs.map((x) => x.payload.querySeq), [1]);
    assert.deepEqual(await pass(), ZERO);
  });

  test('an issued line without pharmacy.issued gets it once', async () => {
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 50);
    const v = await s.approved([aspirin10]);
    const lineId = v.lines[0].id as string;
    await s.issue.issue(PHARM, lineId, {});
    assert.equal(await sent('pharmacy.issued'), 1);
    await m.PharmacyLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $unset: { 'issued.announcedAt': '' } });
    await wipe('pharmacy.issued');
    // Issued a moment ago: left alone.
    assert.equal((await rec.reconcile()).issued, 0);
    const first = await pass();
    assert.equal(first.issued, 1);
    assert.equal(await sent('pharmacy.issued'), 1);
    assert.ok((await w.lineDoc(lineId)).issued.announcedAt);
    assert.deepEqual(await pass(), ZERO);
    assert.equal(await sent('pharmacy.issued'), 1);
  });

  test('Y20b: an answered Change whose stored replacement is missing gets it added once', async () => {
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 50);
    const v = await s.approved([aspirin10]);
    const lineId = v.lines[0].id as string;
    await s.issue.issue(PHARM, lineId, {});
    assert.equal(await w.checks.openQuery(lineId, { kind: 'dose', question: 'Dose too high?', by: PHARMACY_AGENT }), true);
    await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'change', change: { product: 'aspirin-tab-150', dose: 150, route: 'oral', frequency: 'OD', durationDays: 5 } });
    const replacementId = (await w.lineDoc(lineId)).query.answer.replacement.id as string;
    assert.ok(await w.lineDoc(replacementId));
    // The add never happened.
    await m.PharmacyLine.collection.deleteOne({ _id: new Types.ObjectId(replacementId) });
    assert.equal(await w.lineDoc(replacementId), null);
    const first = await pass();
    assert.equal(first.replacements, 1);
    const added = await w.lineDoc(replacementId);
    assert.equal(added.status, 'to-check');
    assert.equal(String(added.replaces), lineId);
    assert.equal(await m.PharmacyLine.countDocuments({ replaces: new Types.ObjectId(lineId) }), 1);
    assert.deepEqual(await pass(), ZERO);
  });

  test('Y21b: an approved or to-check line with an unconfirmed red allergy flag and no query is held at once', async () => {
    const approved = (await s.approved([aspirin10])).lines[0].id as string;
    const checking = (await order([{ ...aspirin300, frequency: 'TDS', durationDays: 2 }])).lines[0].id as string;
    // The second order sent the first back to To check (Y28); approve the first again so one line is approved, one to-check.
    await w.checks.approve(PHARM, approved, { reason: 'intended' });
    await w.redAllergy(approved);
    await w.redAllergy(checking);
    assert.equal((await w.lineDoc(approved)).status, 'approved');
    const first = await pass();
    assert.equal(first.holds, 2);
    for (const id of [approved, checking]) {
      const line = await w.lineDoc(id);
      assert.deepEqual([line.status, line.query.kind, line.query.answer], ['query', 'allergy', undefined]);
      assert.equal(line.query.by.id, 'pharmacy-agent');
      assert.equal((await alertOf(id)).status, 'Pending');
    }
    assert.equal((await clocksOf('pharmacy-query')).length, 2);
    assert.deepEqual(await pass(), ZERO);
  });

  test('Y27: an issued line with an unconfirmed red flag and no open query gets a query for that flag; an allergy is held like at ordering', async () => {
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 100);
    await s.batch('metformin-tab-500', 'er', 'M1', 100, 100);
    const clash = (await s.approved([aspirin10])).lines[0].id as string;
    await s.issue.issue(PHARM, clash, {});
    const allergy = (await s.approved([metformin500])).lines[0].id as string;
    await s.issue.issue(PHARM, allergy, {});
    await m.PharmacyLine.updateOne({ _id: clash }, { $push: { flags: { key: 'clash.aspirin-clopidogrel', kind: 'clash', severity: 'red', text: 'Aspirin with clopidogrel raises bleeding risk', version: 1 } } });
    await w.redAllergy(allergy, 'metformin');
    const first = await pass();
    assert.equal(first.holds, 2);
    const a = await w.lineDoc(clash);
    assert.deepEqual([a.status, a.query.kind, a.query.redKeys, a.query.answer], ['issued', 'clash', ['clash.aspirin-clopidogrel'], undefined]);
    const b = await w.lineDoc(allergy);
    assert.deepEqual([b.status, b.query.kind], ['issued', 'allergy']);
    assert.equal((await clocksOf('pharmacy-query')).length, 2);
    assert.deepEqual(await pass(), ZERO);
  });

  test('stock takes left by a crash are put back, and a waiting line whose stock arrived is released', async () => {
    const b = await s.batch('aspirin-tab-300', 'er', 'B1', 100, 7);
    const v = await s.approved([aspirin10]);
    const lineId = v.lines[0].id as string;
    // A take for a line that is approved and not being issued: nothing will ever flip it.
    await m.PharmacyBatch.collection.updateOne({ _id: b._id }, { $set: { takes: [{ line: new Types.ObjectId(lineId), qty: 3, realAt: old() }] } });
    const first = await pass();
    assert.equal(first.takes, 1);
    const batch = await m.PharmacyBatch.findById(b._id).lean<any>();
    assert.deepEqual([batch.quantity, batch.takes.length], [10, 0]);
    assert.equal((await pass()).takes, 0);

    await m.PharmacyLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $set: { waitingForStock: true } });
    const second = await pass();
    assert.equal(second.released, 1);
    assert.equal((await w.lineDoc(lineId)).waitingForStock, false);
    assert.deepEqual(await pass(), ZERO);
  });

  test('a consistent database sends nothing', async () => {
    await s.batch('metformin-tab-500', 'er', 'M1', 100, 100);
    const v = await s.approved([metformin500]);
    await s.issue.issue(PHARM, v.lines[0].id as string, {});
    await order([amlodipine5]);
    // A second aspirin while one is issued: the issued line is asked at once (Y30), so nothing is left for reconcile.
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 100);
    await s.issue.issue(PHARM, (await s.approved([aspirin10])).lines[0].id as string, {});
    await order([aspirin10]);
    await w.checks.query(PHARM, (await order([aspirin10])).lines[0].id as string, { kind: 'dose', question: 'Is it right?' });
    await settle();
    const before = await m.AgentMessage.countDocuments({}).exec();
    const clocksBefore = await m.Clock.countDocuments({}).exec();
    assert.deepEqual(await rec.reconcile(), ZERO);
    assert.deepEqual(await rec.reconcile(), ZERO);
    assert.equal(await m.AgentMessage.countDocuments({}).exec(), before);
    assert.equal(await m.Clock.countDocuments({}).exec(), clocksBefore);
  });

  test('one failing item doesn\'t stop the pass', async () => {
    // A broken order: its announcement throws. A broken query and an unannounced issue sit behind it.
    const bad = await order();
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(bad.id) }, { $unset: { announcedAt: '' } });
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 100);
    const issuedId = (await s.approved([{ ...aspirin300, frequency: 'TDS', durationDays: 2 }])).lines[0].id as string;
    await s.issue.issue(PHARM, issuedId, {});
    await m.PharmacyLine.collection.updateOne({ _id: new Types.ObjectId(issuedId) }, { $unset: { 'issued.announcedAt': '' } });
    await wipe('pharmacy.issued');
    const queryLine = (await order([{ medicine: 'metformin', product: 'metformin-tab-500', dose: 500, route: 'oral', frequency: 'BD', durationDays: 5 }])).lines[0].id as string;
    await w.checks.query(PHARM, queryLine, { kind: 'dose', question: 'Is it right?' });
    await m.Clock.deleteMany({ def: 'pharmacy-query' });
    await settle();
    const orig = w.orders.announceOrdered.bind(w.orders);
    (w.orders as any).announceOrdered = async () => {
      throw new Error('boom');
    };
    try {
      const out = await rec.reconcile();
      assert.equal(out.ordered, 0);
      assert.equal(out.queries, 1);
      assert.equal(out.issued, 1);
      assert.deepEqual(logged, [`Reconcile: announcing order ${(await orderDoc(bad.id)).number} failed: boom`]);
    } finally {
      (w.orders as any).announceOrdered = orig;
    }
    assert.equal((await clocksOf('pharmacy-query')).length, 1);
    assert.ok((await w.lineDoc(issuedId)).issued.announcedAt);
  });

  test('600 rows that always fail never starve a repairable row behind them: the window moves on', async () => {
    const first = await order();
    const [doc] = await m.PharmacyOrder.find({ _id: new Types.ObjectId(first.id) }).lean<any[]>();
    const past = Math.floor(Date.now() / 1000) - 86_400;
    // Older ids than the repairable order, so they sit in front of it.
    const extra = Array.from({ length: 600 }, (_, i) => {
      const { prescription: _p, announcedAt: _a, ...rest } = doc;
      return { ...rest, _id: Types.ObjectId.createFromTime(past + i), number: `MO-9${String(i).padStart(4, '0')}`, case: new Types.ObjectId() };
    });
    await m.PharmacyOrder.collection.insertMany(extra);
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(first.id) }, { $unset: { announcedAt: '' } });
    await settle();
    const orig = w.orders.announceOrdered.bind(w.orders);
    (w.orders as any).announceOrdered = async (o: any) => {
      if (String(o._id) !== first.id) throw new Error('boom');
      return orig(o);
    };
    try {
      assert.equal((await rec.reconcile()).ordered, 0, 'the first window is all failures');
      assert.equal((await rec.reconcile()).ordered, 1, 'the next window reaches the repairable order');
    } finally {
      (w.orders as any).announceOrdered = orig;
    }
  });
  test('Y30: ordering a second aspirin while one is issued opens a query on the issued line at once, with no reconcile pass', async () => {
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 100);
    const issued = (await s.approved([aspirin10])).lines[0].id as string;
    await s.issue.issue(PHARM, issued, {});
    await order([aspirin10]);
    const line = await w.lineDoc(issued);
    assert.deepEqual([line.status, line.query.kind, line.query.redKeys, line.query.answer], ['issued', 'other', ['double.aspirin'], undefined]);
    assert.equal((await alertOf(issued)).status, 'Pending');
    assert.equal((await clocksOf('pharmacy-query')).length, 1);
    assert.deepEqual(await pass(), ZERO);
  });

  test('(d) completes the alert before publishing: a failed completion is completed by the next pass, and no alert stays Pending', async () => {
    const v = await order();
    const lineId = v.lines[0].id as string;
    await w.checks.query(PHARM, lineId, { kind: 'dose', question: 'Is this dose right?' });
    await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'keep', reason: 'Dose is right' });
    const [c] = await clocksOf('pharmacy-query');
    await m.Clock.collection.updateOne({ _id: c._id }, { $set: { state: 'running' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await m.TaskAlertItem.updateOne({ link: `pharmacy-line:${lineId}` }, { $set: { status: 'Pending' } });
    await m.AgentMessage.deleteMany({ type: 'pharmacy.query-answered' });
    await settle();
    const real = w.checks.completeQueryAlert.bind(w.checks);
    (w.checks as any).completeQueryAlert = async () => {
      throw new Error('db blip');
    };
    try {
      assert.equal((await rec.reconcile()).answers, 0);
    } finally {
      (w.checks as any).completeQueryAlert = real;
    }
    assert.equal((await clocksOf('pharmacy-query'))[0].state, 'running');
    assert.equal(await sent('pharmacy.query-answered'), 0);
    assert.equal((await pass()).answers, 1);
    assert.equal((await alertOf(lineId)).status, 'Completed');
    assert.equal((await clocksOf('pharmacy-query'))[0].state, 'met');
    assert.deepEqual(await pass(), ZERO);
  });

  test('an expired (escalated) check clock whose done was lost is marked met by the resent done', async () => {
    const v = await order();
    await w.checks.approve(PHARM, v.lines[0].id as string, { reason: 'intended' });
    const [c] = await clocksOf('pharmacy-check');
    await m.Clock.collection.updateOne({ _id: c._id }, { $set: { state: 'expired' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await wipe('pharmacy.check-done');
    assert.equal((await pass()).done, 1);
    assert.ok((await clocksOf('pharmacy-check'))[0].stoppedAt);
    assert.deepEqual(await pass(), ZERO);
  });

  test('issue round: an open round with no clock gets its to-issue resent', async () => {
    const v = await s.approved([aspirin10]);
    assert.equal((await clocksOf('pharmacy-issue')).length, 1);
    await m.Clock.deleteMany({ def: 'pharmacy-issue' });
    await wipe('pharmacy.to-issue');
    assert.equal((await pass()).rounds, 1);
    assert.deepEqual((await clocksOf('pharmacy-issue')).map((c) => [c.state, c.ref]), [['running', `${v.id}:i1`]]);
    assert.equal(await sent('pharmacy.to-issue'), 1);
    assert.deepEqual(await pass(), ZERO);
  });

  test('issue round: a running clock of a closed round gets issue-done for that round', async () => {
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 50);
    const v = await s.approved([aspirin10]);
    await s.issue.issue(PHARM, v.lines[0].id as string, {});
    const [c] = await clocksOf('pharmacy-issue');
    assert.equal(c.state, 'met');
    await m.Clock.collection.updateOne({ _id: c._id }, { $set: { state: 'running' }, $unset: { stoppedAt: '', metMinutes: '' } });
    await wipe('pharmacy.issue-done');
    assert.equal((await pass()).done, 1);
    assert.equal((await clocksOf('pharmacy-issue'))[0].state, 'met');
    const dones = await m.AgentMessage.find({ type: 'pharmacy.issue-done' }).lean<any[]>();
    assert.deepEqual(dones.map((d) => d.payload.issueRound), [1]);
    assert.deepEqual(await pass(), ZERO);
  });

  test('issue round: an OPD order has no issue clock, and reconcile starts none', async () => {
    const v = await order();
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(v.id) }, { $set: { setting: 'OPD' } });
    await w.checks.approve(PHARM, v.lines[0].id as string, { reason: 'intended' });
    assert.deepEqual(await pass(), ZERO);
    assert.equal((await clocksOf('pharmacy-issue')).length, 0);
    assert.equal(await sent('pharmacy.to-issue'), 0);
  });

  test('a line stuck mid-issue is cleared by repairTakes before the allergy hold, so it can be issued after the doctor and pharmacist act', async () => {
    await s.batch('aspirin-tab-300', 'er', 'B1', 100, 50);
    const lineId = (await s.approved([aspirin10])).lines[0].id as string;
    await m.PharmacyLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $set: { issuing: { by: { id: PHARM.id, name: PHARM.name }, store: 'er', realAt: old() } } });
    await w.redAllergy(lineId);
    await pass();
    // The claim is gone before (or with) the hold; any hold left for the next pass arrives on a clean line.
    assert.equal((await w.lineDoc(lineId)).issuing, undefined);
    await pass();
    const line = await w.lineDoc(lineId);
    assert.deepEqual([line.status, line.query?.kind, line.issuing], ['query', 'allergy', undefined]);
    await w.checks.answer(DOC, lineId, { querySeq: 1, outcome: 'keep', reason: 'Tolerated before' });
    await w.checks.approve(PHARM, lineId, { reason: 'intended' });
    const issued = await s.issue.issue(PHARM, lineId, {});
    assert.equal(issued.status, 'issued');
  });
});
