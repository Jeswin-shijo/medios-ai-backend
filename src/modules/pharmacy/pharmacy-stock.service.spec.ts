import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, PHARM, World, aspirin300, buildWorld } from '../../test/pharmacy-fixtures';
import { StockWorld, buildStock, inDays } from '../../test/pharmacy-stock-fixtures';

const ASP = 'aspirin-tab-300';
const ticagrelor180 = { medicine: 'ticagrelor', product: 'ticagrelor-tab-90', dose: 180, route: 'oral', frequency: 'STAT' };

describe('PharmacyStockService: receiving, adjusting, low stock and waiting', () => {
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

  const stockAlerts = () => m.TaskAlertItem.find({ link: `pharmacy-stock:${ASP}:er` }).lean().exec() as Promise<any[]>;

  test('receive validates, adds to the same batch, logs a movement and never takes an expired batch', async () => {
    await assert.rejects(() => s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B1', expiry: inDays(-1), quantity: 5 }), { status: 400, message: 'This batch has already expired' });
    await assert.rejects(() => s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B1', expiry: inDays(30), quantity: 0 }), { status: 400 });
    await assert.rejects(() => s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B1', expiry: inDays(30), quantity: 100001 }), { status: 400 });
    await assert.rejects(() => s.stock.receive(PHARM, { product: 'nope', store: 'er', batchNo: 'B1', expiry: inDays(30), quantity: 5 }), { status: 400 });
    await s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B1', expiry: inDays(30), quantity: 5 });
    await s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B1', expiry: inDays(30), quantity: 7 });
    assert.equal((await m.PharmacyBatch.find({}).lean()).length, 1);
    assert.equal(await s.stock.usable(ASP, 'er'), 12);
    // The same batch number with another expiry is a conflict.
    await assert.rejects(() => s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B1', expiry: inDays(60), quantity: 1 }), { status: 409 });
    const moves = await m.PharmacyMovement.find({ kind: 'received' }).lean();
    assert.deepEqual(moves.map((x: any) => x.change), [5, 7]);
    // An expired batch is not usable.
    await s.batch(ASP, 'er', 'OLD', -3, 40);
    assert.equal(await s.stock.usable(ASP, 'er'), 12);
  });

  test('adjust never goes below zero; Remove on an expired batch logs reason expired', async () => {
    const b = await s.batch(ASP, 'er', 'B1', 30, 5);
    await assert.rejects(() => s.stock.adjust(PHARM, String(b._id), { change: -6, reason: 'damaged' }), { status: 409, message: 'That would take batch B1 below zero' });
    assert.equal((await m.PharmacyBatch.findById(b._id).lean<any>())!.quantity, 5);
    assert.equal(await m.PharmacyMovement.countDocuments({}), 0);
    await s.stock.adjust(PHARM, String(b._id), { change: -2, reason: 'damaged' });
    assert.equal((await m.PharmacyBatch.findById(b._id).lean<any>())!.quantity, 3);
    await assert.rejects(() => s.stock.adjust(PHARM, String(b._id), { change: -1, reason: 'bogus' as any }), { status: 400 });
    await assert.rejects(() => s.stock.removeExpired(PHARM, String(b._id)), { status: 409 });
    const old = await s.batch(ASP, 'er', 'OLD', -2, 9);
    await s.stock.removeExpired(PHARM, String(old._id));
    assert.equal((await m.PharmacyBatch.findById(old._id).lean<any>())!.quantity, 0);
    const mv = await m.PharmacyMovement.findOne({ batch: old._id }).lean<any>();
    assert.deepEqual([mv.kind, mv.reason, mv.change], ['adjusted', 'expired', -9]);
  });

  test('low stock alerts once per product and store; restocking completes it; dropping again raises it again (one alert, Pending)', async () => {
    const b = await s.batch(ASP, 'er', 'B1', 100, 12);
    await s.stock.setLevel(PHARM, { product: ASP, store: 'er', reorderLevel: 5 });
    assert.equal((await stockAlerts()).length, 0);
    await s.stock.adjust(PHARM, String(b._id), { change: -10, reason: 'damaged' });
    let alerts = await stockAlerts();
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].title, alerts[0].subtitle], ['Low stock: Aspirin tab 300 mg (ER)', '2 left · reorder level 5']);
    assert.deepEqual([alerts[0].type, alerts[0].category, alerts[0].priority, alerts[0].status], ['Medication Alert', 'Medication', 'Medium', 'Pending']);
    assert.ok((await m.PharmacyStockLevel.findOne({ product: ASP, store: 'er' }).lean<any>())!.lowAlertedAt);
    // Another drop and the sweep add nothing.
    await s.stock.adjust(PHARM, String(b._id), { change: -1, reason: 'damaged' });
    assert.equal(await s.stock.sweepLowStock(), 0);
    assert.equal((await stockAlerts()).length, 1);
    // Restocked above the level.
    await s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'B2', expiry: inDays(90), quantity: 50 });
    alerts = await stockAlerts();
    assert.equal(alerts[0].status, 'Completed');
    assert.equal((await m.PharmacyStockLevel.findOne({ product: ASP, store: 'er' }).lean<any>())!.lowAlertedAt, undefined);
    // Dropping again: the same alert document, Pending again.
    const b2 = await m.PharmacyBatch.findOne({ batchNo: 'B2' }).lean<any>();
    await s.stock.adjust(PHARM, String(b2._id), { change: -48, reason: 'damaged' });
    alerts = await stockAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, 'Pending');
    // A flag set whose alert is missing: the sweep puts the alert back.
    await m.TaskAlertItem.deleteMany({});
    assert.equal(await s.stock.sweepLowStock(), 1);
    assert.equal((await stockAlerts()).length, 1);
  });

  test('a pair with no saved level (or level 0) never alerts', async () => {
    const b = await s.batch(ASP, 'er', 'B1', 100, 3);
    await s.stock.adjust(PHARM, String(b._id), { change: -3, reason: 'damaged' });
    await s.stock.setLevel(PHARM, { product: ASP, store: 'main', reorderLevel: 0 });
    assert.equal(await s.stock.sweepLowStock(), 0);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-stock:/ }), 0);
  });

  test('stock lists batches oldest expiry first with near-expiry and expired counts; movements list newest first', async () => {
    await s.batch(ASP, 'er', 'LATE', 200, 10);
    await s.batch(ASP, 'er', 'NEAR', 20, 4);
    await s.batch(ASP, 'er', 'OLD', -2, 6);
    await s.stock.setLevel(PHARM, { product: ASP, store: 'er', reorderLevel: 5 });
    const rows = await s.stock.stock('er');
    const row = rows.find((r) => r.product === ASP)!;
    assert.deepEqual(row.batches.map((b) => b.batchNo), ['OLD', 'NEAR', 'LATE']);
    assert.deepEqual([row.usable, row.nearExpiry, row.expired, row.reorderLevel, row.low, row.label, row.store], [14, 4, 6, 5, false, 'Aspirin tab 300 mg', 'er']);
    await s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'NEW', expiry: inDays(300), quantity: 1 });
    const mv = await s.stock.movements({ product: ASP, store: 'er', limit: 5 });
    assert.equal(mv[0].kind, 'received');
  });

  test('Wait for stock takes the line off the issue clock (pharmacy.issue-done); receiving that product starts a new issue round due 15 min after the receipt (STAT), not overdue', async () => {
    const v = await s.approved([ticagrelor180], 'stat');
    const id = v.lines[0].id;
    await s.issue.outOfStock(PHARM, id);
    const q = (await w.lineDoc(id)).query;
    await w.checks.answer(DOC, id, { querySeq: q.seq, outcome: 'wait' });
    let line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.waitingForStock], ['approved', true]);
    assert.equal((await w.sent('pharmacy.issue-done')).length, 1);
    const before = Date.now();
    await s.stock.receive(PHARM, { product: 'ticagrelor-tab-90', store: 'er', batchNo: 'T1', expiry: inDays(200), quantity: 10 });
    line = await w.lineDoc(id);
    assert.equal(line.waitingForStock, false);
    assert.ok(new Date(line.issueFrom).getTime() >= before - 50);
    const order = await m.PharmacyOrder.findById(line.order).lean<any>();
    assert.equal(order.issueRound, 2);
    assert.equal(order.issueOpen, true);
    const due = new Date(order.issueDueAt).getTime();
    assert.ok(Math.abs(due - (new Date(line.issueFrom).getTime() + 15 * 60_000)) < 1000);
    assert.ok(due > Date.now());
    assert.equal((await w.sent('pharmacy.to-issue')).length, 2);
    // Receiving it again releases nothing and starts nothing.
    await s.stock.receive(PHARM, { product: 'ticagrelor-tab-90', store: 'er', batchNo: 'T1', expiry: inDays(200), quantity: 1 });
    assert.equal((await w.sent('pharmacy.to-issue')).length, 2);
  });

  test('an OPD line waiting for stock is released without a to-issue message', async () => {
    const v = await s.approved([aspirin300], 'routine');
    const id = v.lines[0].id;
    await m.PharmacyOrder.updateOne({ _id: (await w.lineDoc(id)).order }, { $set: { setting: 'OPD' } });
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { waitingForStock: true } });
    const before = (await w.sent('pharmacy.to-issue')).length;
    await s.stock.receive(PHARM, { product: ASP, store: 'main', batchNo: 'B1', expiry: inDays(90), quantity: 5 });
    assert.equal((await w.lineDoc(id)).waitingForStock, false);
    assert.equal((await w.sent('pharmacy.to-issue')).length, before);
  });

  test('a restock never completes an alert that a newer low just raised; the sweep repairs a mismatched alert', async () => {
    const b = await s.batch(ASP, 'er', 'A', 100, 12);
    await s.stock.setLevel(PHARM, { product: ASP, store: 'er', reorderLevel: 5 });
    await s.stock.adjust(PHARM, String(b._id), { change: -10, reason: 'damaged' });
    const levels: any = m.PharmacyStockLevel;
    const orig = levels.findOneAndUpdate;
    let fired = false;
    levels.findOneAndUpdate = function (...args: any[]) {
      const q = orig.apply(this, args);
      const isClear = JSON.stringify(args[1] ?? {}).includes('$unset');
      const exec = q.exec.bind(q);
      q.exec = async () => {
        const r = await exec();
        if (isClear && !fired) {
          fired = true;
          levels.findOneAndUpdate = orig;
          const b2 = await m.PharmacyBatch.findOne({ batchNo: 'R' }).lean<any>();
          await s.stock.adjust(PHARM, String(b2._id), { change: -50, reason: 'damaged' });
        }
        return r;
      };
      return q;
    };
    try {
      await s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'R', expiry: inDays(90), quantity: 50 });
    } finally {
      levels.findOneAndUpdate = orig;
    }
    assert.ok(fired);
    assert.equal(await s.stock.usable(ASP, 'er'), 2);
    assert.ok((await m.PharmacyStockLevel.findOne({ product: ASP, store: 'er' }).lean<any>())!.lowAlertedAt);
    assert.equal((await stockAlerts())[0].status, 'Pending');
    // Force the old end state (alert completed under the new claim's stamp mismatch) and let the sweep repair it.
    await m.TaskAlertItem.updateOne({ link: `pharmacy-stock:${ASP}:er` }, { $set: { status: 'Completed' }, $unset: { lowAlertedAt: '' } });
    assert.equal(await s.stock.sweepLowStock(), 1);
    assert.equal((await stockAlerts())[0].status, 'Pending');
    // A ticked-off alert keeps its stamp and is not raised again.
    await m.TaskAlertItem.updateOne({ link: `pharmacy-stock:${ASP}:er` }, { $set: { status: 'Completed' } });
    assert.equal(await s.stock.sweepLowStock(), 0);
  });

  test('a failure after the stock change is logged, not thrown, and waiting lines are still released; the sweep releases the rest', async () => {
    const v = await s.approved([{ medicine: 'ticagrelor', product: 'ticagrelor-tab-90', dose: 180, route: 'oral', frequency: 'STAT' }], 'stat');
    const id = v.lines[0].id;
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { waitingForStock: true } });
    const real = s.stock.afterChange.bind(s.stock);
    // The deliberate error stays out of the test output.
    const realLogger = (s.stock as any).logger;
    (s.stock as any).logger = { error: () => undefined, log: () => undefined, warn: () => undefined };
    (s.stock as any).afterChange = async () => {
      throw new Error('boom');
    };
    const r = await s.stock.receive(PHARM, { product: 'ticagrelor-tab-90', store: 'er', batchNo: 'T1', expiry: inDays(100), quantity: 4 });
    assert.equal(r.usable, 4);
    assert.equal((await w.lineDoc(id)).waitingForStock, false);
    const b = await m.PharmacyBatch.findOne({ batchNo: 'T1' }).lean<any>();
    await assert.rejects(() => s.stock.adjust(PHARM, String(b._id), { change: -9, reason: 'damaged' }), { status: 409 });
    const out = await s.stock.adjust(PHARM, String(b._id), { change: -1, reason: 'damaged' });
    assert.equal(out.quantity, 3);
    (s.stock as any).afterChange = real;
    (s.stock as any).logger = realLogger;
    // A line marked waiting while stock exists (its release was lost) is released by the sweep.
    await m.PharmacyLine.updateOne({ _id: id }, { $set: { waitingForStock: true } });
    await s.stock.sweepLowStock();
    assert.equal((await w.lineDoc(id)).waitingForStock, false);
  });

  test('concurrent first receives of a new batch all succeed and add up', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 4 }, () => s.stock.receive(PHARM, { product: ASP, store: 'er', batchNo: 'NEW', expiry: inDays(60), quantity: 5 })));
    assert.ok(rs.every((r) => r.status === 'fulfilled'));
    assert.equal(await s.stock.usable(ASP, 'er'), 20);
    assert.equal(await m.PharmacyBatch.countDocuments({}), 1);
  });

  test('Y29: a waiting line is released only when one store holds its full need; partial stock leaves it waiting (no sweep release, no new to-issue, clock or query)', async () => {
    const enox = { medicine: 'enoxaparin', product: 'enoxaparin-syringe-60', dose: 60, route: 'sc', frequency: 'BD', durationDays: 5 };
    const part = await s.batch('enoxaparin-syringe-60', 'er', 'E', 100, 3);
    const v = await s.approved([enox]);
    const id = v.lines[0].id;
    assert.equal((await w.lineDoc(id)).quantity, 10);
    await s.issue.outOfStock(PHARM, id);
    const q = (await w.lineDoc(id)).query;
    await w.checks.answer(DOC, id, { querySeq: q.seq, outcome: 'wait' });
    assert.equal((await w.lineDoc(id)).waitingForStock, true);
    const toIssue = (await w.sent('pharmacy.to-issue')).length;
    const clocks = (await w.clocksOf('pharmacy-issue')).length;
    await s.stock.sweepLowStock();
    assert.equal(await s.stock.releaseWaitingWithStock(), 0);
    // A receive that leaves each store short releases nothing either.
    await s.stock.receive(PHARM, { product: 'enoxaparin-syringe-60', store: 'main', batchNo: 'M', expiry: inDays(100), quantity: 4 });
    let line = await w.lineDoc(id);
    assert.deepEqual([line.status, line.waitingForStock], ['approved', true]);
    assert.equal((await w.sent('pharmacy.to-issue')).length, toIssue);
    assert.equal((await w.clocksOf('pharmacy-issue')).length, clocks);
    assert.equal(await m.PharmacyBatch.countDocuments({ _id: part._id, expiry: { $lt: inDays(0) } }), 0);
    // An expired batch does not count towards the need.
    await s.batch('enoxaparin-syringe-60', 'er', 'OLD', -3, 50);
    assert.equal(await s.stock.releaseWaitingWithStock(), 0);
    assert.equal((await s.issue.outOfStock(PHARM, id).then(() => 'opened', (e: any) => e.status)), 'opened');
    // Answer wait again, then a receive that brings one store to the full need releases it once.
    const q2 = (await w.lineDoc(id)).query;
    await w.checks.answer(DOC, id, { querySeq: q2.seq, outcome: 'wait' });
    await s.stock.receive(PHARM, { product: 'enoxaparin-syringe-60', store: 'er', batchNo: 'E2', expiry: inDays(100), quantity: 7 });
    line = await w.lineDoc(id);
    assert.equal(line.waitingForStock, false);
    const sent = (await w.sent('pharmacy.to-issue')).length;
    assert.equal(sent, toIssue + 1);
    await s.stock.sweepLowStock();
    assert.equal((await w.sent('pharmacy.to-issue')).length, sent);
  });
});
