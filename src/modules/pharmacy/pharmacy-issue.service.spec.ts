import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PHARM, DOC, World, amoxicillin500, aspirin300, buildWorld, clopidogrel300, enoxaparin60 } from '../../test/pharmacy-fixtures';
import { StockWorld, buildStock, inDays } from '../../test/pharmacy-stock-fixtures';

const ASP = 'aspirin-tab-300';
/** 10 tablets: 300 mg twice a day for 5 days. */
const aspirin10 = { ...aspirin300, frequency: 'BD', durationDays: 5 };
const aspirin6 = { ...aspirin300, frequency: 'TDS', durationDays: 2 };
const ticagrelor180 = { medicine: 'ticagrelor', product: 'ticagrelor-tab-90', dose: 180, route: 'oral', frequency: 'STAT' };

describe('PharmacyIssueService: issuing from stock', () => {
  const m = models();
  let w: World;
  let s: StockWorld;

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
    await w.openEr();
  });

  const qty = async (id: unknown) => (await m.PharmacyBatch.findById(id).lean<any>())!.quantity as number;
  const one = async (input: any = aspirin10) => (await s.approved([input])).lines[0].id as string;

  test('issue takes the oldest-expiry batch first and never an expired one', async () => {
    const expired = await s.batch(ASP, 'er', 'EXP', -6, 50);
    const near = await s.batch(ASP, 'er', 'NEAR', 20, 3);
    const later = await s.batch(ASP, 'er', 'LATE', 150, 100);
    const id = await one();
    const view = await s.issue.issue(PHARM, id, {});
    assert.equal(view.status, 'issued');
    assert.deepEqual([await qty(expired._id), await qty(near._id), await qty(later._id)], [50, 0, 93]);
    const moves = await m.PharmacyMovement.find({ kind: 'issued' }).sort({ change: 1 }).lean<any>();
    assert.deepEqual(moves.map((x: any) => x.change), [-7, -3]);
    assert.ok(moves.every((x: any) => String(x.line) === id));
    const line = await w.lineDoc(id);
    assert.equal(line.issuing, undefined);
    assert.deepEqual(line.issued.batches.map((b: any) => [b.batchNo, b.qty]), [['NEAR', 3], ['LATE', 7]]);
    assert.equal(line.issued.store, 'er');
    assert.ok(line.issued.announcedAt);
    assert.ok((await m.PharmacyBatch.find({}).lean<any>()).every((b: any) => b.takes.length === 0));
    const [msg] = await w.sent('pharmacy.issued');
    assert.deepEqual([msg.payload.store, msg.payload.quantity], ['er', 10]);
    // Issuing the last approved line closed the issue round.
    assert.equal((await w.sent('pharmacy.issue-done')).length, 1);
    // A second issue of the same line is refused.
    await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 409 });
  });

  test('a scanned batch is used out of order; a wrong, short or unknown scan is refused', async () => {
    const near = await s.batch(ASP, 'er', 'NEAR', 20, 50);
    const later = await s.batch(ASP, 'er', 'LATE', 150, 50);
    await s.batch('clopidogrel-tab-75', 'er', 'CLOP', 150, 50);
    const short = await s.batch(ASP, 'er', 'SHORT', 100, 4);
    const id = await one();
    await assert.rejects(() => s.issue.issue(PHARM, id, { batchNo: 'CLOP' }), { status: 409 });
    await assert.rejects(() => s.issue.issue(PHARM, id, { batchNo: 'NOPE' }), { status: 409 });
    await assert.rejects(() => s.issue.issue(PHARM, id, { batchNo: 'SHORT' }), (e: any) => e.status === 409 && /4/.test(e.message));
    assert.equal(await qty(short._id), 4);
    await s.issue.issue(PHARM, id, { batchNo: 'LATE' });
    assert.deepEqual([await qty(near._id), await qty(later._id)], [50, 40]);
  });

  test('a scanned expired batch is refused (409) and nothing changes', async () => {
    const expired = await s.batch(ASP, 'er', 'EXP', -6, 50);
    await s.batch(ASP, 'er', 'OK', 100, 50);
    const id = await one();
    await assert.rejects(() => s.issue.issue(PHARM, id, { batchNo: 'EXP' }), { status: 409 });
    assert.equal(await qty(expired._id), 50);
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.issuing], ['approved', undefined]);
    assert.equal(await m.PharmacyMovement.countDocuments({}), 0);
    // Not offered either.
    const opts = await s.issue.options(id);
    assert.deepEqual(opts.stores.find((x) => x.store === 'er')!.batches.map((b) => b.batchNo), ['OK']);
  });

  test('a batch that expires between planning and taking is not taken (the expiry guard), and the issue fails cleanly', async () => {
    const b = await s.batch(ASP, 'er', 'B1', 1, 50);
    const id = await one();
    const model: any = m.PharmacyBatch;
    const orig = model.find;
    let fired = false;
    model.find = function (...args: any[]) {
      const q = orig.apply(this, args);
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const r = await exec();
        if (!fired) {
          fired = true;
          await m.PharmacyBatch.updateOne({ _id: b._id }, { $set: { expiry: inDays(-1) } });
        }
        return r;
      };
      return q;
    };
    try {
      await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 409 });
    } finally {
      model.find = orig;
    }
    assert.ok(fired);
    assert.equal(await qty(b._id), 50);
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.issuing], ['approved', undefined]);
    assert.equal((await m.PharmacyBatch.findById(b._id).lean<any>())!.takes.length, 0);
    assert.equal(await m.PharmacyMovement.countDocuments({}), 0);
  });

  test('two concurrent issues of 6 from one batch of 10 succeed once; the batch ends at 4, never below zero, and the loser\'s line is still approved', async () => {
    const b = await s.batch(ASP, 'er', 'B1', 100, 10);
    // Both are ordered first: the second order sends the first back to To check (Y28), so both are approved after.
    const [va, vc] = [await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin6] }), await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin6] })];
    const [a, c] = [va.lines[0].id as string, vc.lines[0].id as string];
    await w.checks.approve(PHARM, a, { reason: 'intended' });
    await w.checks.approve(PHARM, c, { reason: 'intended' });
    const results = await Promise.allSettled([s.issue.issue(PHARM, a, {}), s.issue.issue(PHARM, c, {})]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(lost.reason.status, 409);
    assert.equal(await qty(b._id), 4);
    const lines = [await w.lineDoc(a), await w.lineDoc(c)];
    assert.deepEqual(lines.map((l) => l.status).sort(), ['approved', 'issued']);
    assert.ok(lines.every((l) => l.issuing === undefined));
    assert.equal(await m.PharmacyMovement.countDocuments({ kind: 'issued' }), 1);
  });

  test('not enough in the ER store: the 409 names the count in that store (no otherStore), the options list both stores, and issuing from main works', async () => {
    const er = await s.batch(ASP, 'er', 'ER1', 100, 2);
    const main = await s.batch(ASP, 'main', 'M1', 100, 50);
    const id = await one();
    await assert.rejects(() => s.issue.issue(PHARM, id, {}), (e: any) => e.status === 409 && e.message === 'Not enough Aspirin tab 300 mg in ER (2 left)' && !('otherStore' in e));
    assert.equal(await qty(er._id), 2);
    assert.equal((await w.lineDoc(id)).status, 'approved');
    const opts = await s.issue.options(id);
    assert.equal(opts.quantity, 10);
    assert.equal(opts.defaultStore, 'er');
    assert.deepEqual(opts.stores.map((x) => [x.store, x.usable]), [['main', 50], ['er', 2]]);
    assert.deepEqual((await s.issue.issueOptions(id)).stores.length, 2);
    await s.issue.issue(PHARM, id, { store: 'main' });
    assert.equal(await qty(main._id), 40);
    assert.equal((await w.lineDoc(id)).issued.store, 'main');
    // A partial take across batches is undone when the total is short.
    const id2 = await one(amoxicillin500);
    await s.batch('amoxicillin-cap-500', 'er', 'A1', 10, 4);
    await assert.rejects(() => s.issue.issue(PHARM, id2, {}), { status: 409 });
    assert.equal((await m.PharmacyBatch.findOne({ batchNo: 'A1' }).lean<any>())!.quantity, 4);
  });

  test('out of stock in both stores opens a stock query with suggestions: ticagrelor to clopidogrel', async () => {
    const v = await s.approved([ticagrelor180], 'stat');
    const id = v.lines[0].id;
    await s.batch('clopidogrel-tab-75', 'main', 'C1', 100, 20);
    await s.batch('clopidogrel-tab-75', 'er', 'C0', -5, 99);
    await s.batch('aspirin-tab-300', 'er', 'A1', 100, 99);
    await s.batch('ticagrelor-tab-90', 'main', 'T0', -1, 99);
    const view = await s.issue.outOfStock(PHARM, id);
    assert.equal(view.status, 'query');
    const q = (await w.lineDoc(id)).query;
    assert.equal(q.kind, 'stock');
    assert.equal(q.question, 'Out of stock in both stores: Ticagrelor tab 90 mg. Choose another medicine, wait for stock, or cancel.');
    assert.deepEqual(q.suggestions, ['clopidogrel']);
    assert.equal((await w.sent('pharmacy.query')).length, 1);
  });

  test('out of stock is refused while either store has enough', async () => {
    const id = await one();
    await s.batch(ASP, 'main', 'M1', 100, 10);
    await assert.rejects(() => s.issue.outOfStock(PHARM, id), { status: 409, message: 'There is stock in Main pharmacy' });
    assert.equal((await w.lineDoc(id)).status, 'approved');
  });

  test('issuing the last approved line closes the issue round, and not before', async () => {
    await s.batch(ASP, 'er', 'A', 100, 20);
    await s.batch('clopidogrel-tab-75', 'er', 'C', 100, 20);
    const v = await s.approved([aspirin300, clopidogrel300], 'stat');
    await s.issue.issue(PHARM, v.lines[0].id, {});
    assert.equal((await w.sent('pharmacy.issue-done')).length, 0);
    await s.issue.issue(PHARM, v.lines[1].id, {});
    assert.equal((await w.sent('pharmacy.issue-done')).length, 1);
  });

  test('an unlisted prescription line is issued with an entered quantity and no stock movement', async () => {
    const id = await one(aspirin300);
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { medicine: null, product: null, dose: null, quantity: null, freeName: 'Syp Ambroxol' } });
    await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 400 });
    await assert.rejects(() => s.issue.issue(PHARM, id, { quantity: 0 }), { status: 400 });
    await s.issue.issue(PHARM, id, { quantity: 7 });
    const line = await w.lineDoc(id);
    assert.equal(line.status, 'issued');
    assert.deepEqual(line.issued.batches, []);
    assert.equal(await m.PharmacyMovement.countDocuments({}), 0);
    const [msg] = await w.sent('pharmacy.issued');
    assert.equal(msg.payload.quantity, 7);
    assert.equal((await w.orders.line(id)).issued!.quantity, 7);
    assert.ok(!/Ambroxol/.test(msg.summary + JSON.stringify(msg.payload)));
  });

  test('a line with an unknown quantity needs one at issue, and a known quantity ignores the typed one', async () => {
    await s.batch(ASP, 'er', 'A', 100, 100);
    const id = await one(aspirin300);
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { quantity: null } });
    await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 400 });
    await s.issue.issue(PHARM, id, { quantity: 9 });
    assert.equal((await m.PharmacyBatch.findOne({ batchNo: 'A' }).lean<any>())!.quantity, 91);
    const id2 = await one(aspirin10);
    await s.issue.issue(PHARM, id2, { quantity: 1 });
    assert.equal((await m.PharmacyBatch.findOne({ batchNo: 'A' }).lean<any>())!.quantity, 81);
  });

  test('low stock alerts once per product and store: an issue that crosses the level raises it, a second issue does not', async () => {
    await s.batch(ASP, 'er', 'A', 100, 12);
    await s.stock.setLevel(PHARM, { product: ASP, store: 'er', reorderLevel: 5 });
    await s.issue.issue(PHARM, await one(aspirin10), {});
    const alerts = () => m.TaskAlertItem.find({ link: `pharmacy-stock:${ASP}:er` }).lean<any>();
    assert.equal((await alerts()).length, 1);
    await s.issue.issue(PHARM, await one(aspirin300), {});
    assert.equal(await s.stock.sweepLowStock(), 0);
    const [a] = await alerts();
    assert.deepEqual([(await alerts()).length, a.status, a.subtitle], [1, 'Pending', '2 left · reorder level 5']);
  });

  test('issue refuses a line with an unconfirmed red allergy flag (and holds it) or an unreviewed amber allergy flag', async () => {
    const b = await s.batch(ASP, 'er', 'A', 100, 50);
    const red = await one();
    await w.redAllergy(red, 'aspirin');
    await assert.rejects(() => s.issue.issue(PHARM, red, {}), { status: 409 });
    const held = await w.lineDoc(red);
    assert.deepEqual([held.status, held.query.kind, held.issuing], ['query', 'allergy', undefined]);
    assert.equal(await qty(b._id), 50);
    const v = await s.approved([enoxaparin60]);
    await s.batch('enoxaparin-syringe-60', 'er', 'E', 100, 50);
    await m.PharmacyLine.updateOne({ _id: v.lines[0].id }, { $push: { flags: { key: 'allergy.cross-nsaid', kind: 'allergy', severity: 'amber', text: 'x', version: 1 } } });
    await assert.rejects(() => s.issue.issue(PHARM, v.lines[0].id, {}), { status: 409 });
    // Y28 backstop: not a dead end, the line is back in To check.
    assert.equal((await w.lineDoc(v.lines[0].id)).status, 'to-check');
    assert.equal(await m.PharmacyMovement.countDocuments({}), 0);
  });

  test('a take left by a crash before the line flipped is undone by repairTakes; a line claimed with no take yet is released; a take of an issued line gets its movement', async () => {
    const v = await s.approved([aspirin300, enoxaparin60, amoxicillin500], 'urgent');
    const [crashed, claimed, done] = v.lines.map((l: any) => l.id as string);
    const ago = (sec: number) => new Date(Date.now() - sec * 1000);
    const bAsp = await s.batch(ASP, 'er', 'A', 100, 40);
    const bAmx = await s.batch('amoxicillin-cap-500', 'er', 'X', 100, 40);
    const by = { id: PHARM.id, name: PHARM.name };
    // crashed: the take was made (stock down), the line never flipped.
    await m.PharmacyBatch.updateOne({ _id: bAsp._id }, { $inc: { quantity: -1 }, $push: { takes: { line: new Types.ObjectId(crashed), qty: 1, realAt: ago(90) } } });
    await m.PharmacyLine.updateOne({ _id: crashed }, { $set: { issuing: { by, store: 'er', realAt: ago(90) } } });
    // claimed: claimed, no take yet.
    await m.PharmacyLine.updateOne({ _id: claimed }, { $set: { issuing: { by, store: 'er', realAt: ago(90) } } });
    // done: the line flipped, the movement was never written.
    await m.PharmacyBatch.updateOne({ _id: bAmx._id }, { $inc: { quantity: -15 }, $push: { takes: { line: new Types.ObjectId(done), qty: 15, realAt: ago(90) } } });
    await m.PharmacyLine.updateOne(
      { _id: done },
      { $set: { status: 'issued', issued: { by, at: clinicNow(), realAt: ago(90), store: 'er', batches: [{ batch: String(bAmx._id), batchNo: 'X', expiry: bAmx.expiry, qty: 15 }] } } },
    );
    const r = await s.issue.repairTakes();
    assert.deepEqual(r, { undone: 2, logged: 1 });
    assert.equal(await qty(bAsp._id), 40);
    assert.equal((await m.PharmacyBatch.findById(bAsp._id).lean<any>())!.takes.length, 0);
    const lc = await w.lineDoc(crashed);
    assert.deepEqual([lc.status, lc.issuing], ['approved', undefined]);
    assert.equal((await w.lineDoc(claimed)).issuing, undefined);
    assert.equal(await qty(bAmx._id), 25);
    const mv = await m.PharmacyMovement.find({ line: done }).lean<any>();
    assert.deepEqual([mv.length, mv[0].change, mv[0].kind, String(mv[0].batch)], [1, -15, 'issued', String(bAmx._id)]);
    assert.equal((await m.PharmacyBatch.findById(bAmx._id).lean<any>())!.takes.length, 0);
    // A fresh claim (set now) is left alone, and a second run does nothing.
    await m.PharmacyLine.updateOne({ _id: claimed }, { $set: { issuing: { by, store: 'er', realAt: ago(5) } } });
    assert.deepEqual(await s.issue.repairTakes(), { undone: 0, logged: 0 });
    assert.ok((await w.lineDoc(claimed)).issuing);
  });

  test('announceIssued sends pharmacy.issued once for an issued line whose message never went out', async () => {
    await s.batch(ASP, 'er', 'A', 100, 50);
    const id = await one();
    await s.issue.issue(PHARM, id, {});
    await m.PharmacyLine.updateOne({ _id: id }, { $unset: { 'issued.announcedAt': '' } });
    assert.equal(await s.issue.announceIssued(id), true);
    assert.equal((await w.sent('pharmacy.issued')).length, 1);
    assert.equal(await s.issue.announceIssued(id), false);
  });

  test('Y28: an allergy recorded after approval sends the approved line back to To check; it leaves the issue clock, can be reviewed and approved, and no issue escalation is left running', async () => {
    await s.batch(ASP, 'er', 'A', 100, 50);
    const id = (await s.approved([aspirin300])).lines[0].id;
    assert.equal((await w.clocksOf('pharmacy-issue')).length, 1);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['NSAIDs'] } });
    await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [clopidogrel300] });
    let line = await w.lineDoc(id);
    assert.equal(line.status, 'to-check');
    assert.equal(line.approved, undefined);
    assert.ok(line.flags.some((f: any) => f.key === 'allergy.cross-nsaid' && !f.reviewed));
    assert.equal((await w.sent('pharmacy.issue-done')).length, 1);
    const [clock] = await w.clocksOf('pharmacy-issue');
    assert.notEqual(clock.state, 'running');
    assert.equal(await m.Escalation.countDocuments({}), 0);
    await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 409 });
    await w.checks.approve(PHARM, id, { allergyReviewed: true });
    const view = await s.issue.issue(PHARM, id, {});
    assert.equal(view.status, 'issued');
  });

  test('Y28: a new red flag from a later order sends the approved line back to To check', async () => {
    const id = (await s.approved([aspirin300])).lines[0].id;
    await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin300] });
    assert.equal((await w.lineDoc(id)).status, 'to-check');
  });

  test('a red allergy flag added between the take and the flip: the flip fails, the take is undone and the line is held', async () => {
    const b = await s.batch(ASP, 'er', 'A', 100, 50);
    const id = await one();
    const model: any = m.PharmacyBatch;
    const orig = model.findOneAndUpdate;
    let fired = false;
    model.findOneAndUpdate = function (...args: any[]) {
      const q = orig.apply(this, args);
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const r = await exec();
        if (!fired) {
          fired = true;
          await w.redAllergy(id, 'aspirin');
        }
        return r;
      };
      return q;
    };
    try {
      await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 409 });
    } finally {
      model.findOneAndUpdate = orig;
    }
    assert.ok(fired);
    const line = await w.lineDoc(id);
    assert.notEqual(line.status, 'issued');
    assert.equal(line.issuing, undefined);
    assert.equal(await qty(b._id), 50);
    assert.equal((await m.PharmacyBatch.findById(b._id).lean<any>())!.takes.length, 0);
    await assert.rejects(() => s.issue.issue(PHARM, id, {}), { status: 409 });
  });

  test('repairTakes racing a slow issue puts the stock back once and the issue fails cleanly', async () => {
    const b1 = await s.batch(ASP, 'er', 'A', 50, 3);
    const b2 = await s.batch(ASP, 'er', 'B', 100, 50);
    const id = await one();
    const model: any = m.PharmacyBatch;
    const orig = model.findOneAndUpdate;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let paused!: () => void;
    const pausedP = new Promise<void>((r) => (paused = r));
    model.findOneAndUpdate = function (...args: any[]) {
      const q = orig.apply(this, args);
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const r = await exec();
        calls++;
        if (calls === 1) {
          paused();
          await gate;
        }
        return r;
      };
      return q;
    };
    const issuing = s.issue.issue(PHARM, id, {}).then(() => 'ok', (e: any) => e);
    await pausedP;
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      await s.issue.repairTakes();
    } finally {
      Date.now = realNow;
    }
    release();
    const res = await issuing;
    model.findOneAndUpdate = orig;
    assert.notEqual(res, 'ok');
    Date.now = () => realNow() + 120_000;
    try {
      await s.issue.repairTakes();
    } finally {
      Date.now = realNow;
    }
    const line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.issuing], ['approved', undefined]);
    assert.deepEqual([await qty(b1._id), await qty(b2._id)], [3, 50]);
    assert.ok((await m.PharmacyBatch.find({}).lean<any>()).every((x: any) => x.takes.length === 0));
    assert.equal(await m.PharmacyMovement.countDocuments({}), 0);
  });

  test('three concurrent repairTakes put a crashed take back once', async () => {
    const b = await s.batch(ASP, 'er', 'A', 100, 40);
    const id = await one();
    const ago = new Date(Date.now() - 90_000);
    await m.PharmacyBatch.updateOne({ _id: b._id }, { $inc: { quantity: -10 }, $push: { takes: { line: new Types.ObjectId(id), qty: 10, realAt: ago } } });
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { issuing: { by: { id: 'x', name: 'x' }, store: 'er', realAt: ago } } });
    await Promise.all([s.issue.repairTakes(), s.issue.repairTakes(), s.issue.repairTakes()]);
    assert.equal(await qty(b._id), 40);
  });

  test('concurrent repairs of an issued line\'s take never throw on the movement and write it once', async () => {
    const id = await one();
    const b = await s.batch(ASP, 'er', 'A', 100, 40);
    const ago = new Date(Date.now() - 90_000);
    const by = { id: PHARM.id, name: PHARM.name };
    await m.PharmacyBatch.updateOne({ _id: b._id }, { $inc: { quantity: -10 }, $push: { takes: { line: new Types.ObjectId(id), qty: 10, realAt: ago } } });
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { status: 'issued', issued: { by, at: clinicNow(), realAt: ago, store: 'er', batches: [{ batch: String(b._id), batchNo: 'A', expiry: b.expiry, qty: 10 }] } } });
    const rs = await Promise.allSettled([s.issue.repairTakes(), s.issue.repairTakes(), s.issue.repairTakes()]);
    assert.ok(rs.every((r) => r.status === 'fulfilled'));
    assert.equal(await m.PharmacyMovement.countDocuments({ line: id }), 1);
    assert.equal(await qty(b._id), 30);
  });

  test('a leftover take on an issued line that is not in its batches goes back to stock, never logged as issued', async () => {
    const id = await one();
    const used = await s.batch(ASP, 'er', 'USED', 100, 40);
    const left = await s.batch(ASP, 'er', 'LEFT', 100, 40);
    const ago = new Date(Date.now() - 90_000);
    const by = { id: PHARM.id, name: PHARM.name };
    await m.PharmacyBatch.updateOne({ _id: used._id }, { $inc: { quantity: -10 } });
    await m.PharmacyBatch.updateOne({ _id: left._id }, { $inc: { quantity: -10 }, $push: { takes: { line: new Types.ObjectId(id), qty: 10, realAt: ago } } });
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { status: 'issued', issued: { by, at: clinicNow(), realAt: ago, store: 'er', batches: [{ batch: String(used._id), batchNo: 'USED', expiry: used.expiry, qty: 10 }] } } });
    await s.issue.repairTakes();
    assert.equal(await qty(left._id), 40);
    assert.equal(await m.PharmacyMovement.countDocuments({ batch: left._id }), 0);
  });
});
