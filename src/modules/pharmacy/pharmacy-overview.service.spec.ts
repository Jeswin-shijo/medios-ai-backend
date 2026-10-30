import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, MIN, PHARM, World, amoxicillin500, aspirin300, buildWorld, enoxaparin60 } from '../../test/pharmacy-fixtures';
import { StockWorld, buildStock } from '../../test/pharmacy-stock-fixtures';
import { UserRole } from '../users/schemas/user.schema';
import { PharmacyOverviewService } from './pharmacy-overview.service';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { SettingsService } from '../settings/settings.service';

const amlodipine = { medicine: 'amlodipine', product: 'amlodipine-tab-5', dose: 5, route: 'oral', frequency: 'OD', durationDays: 3 };

describe('Pharmacy overview, close check, status, snapshots and settings', () => {
  const m = models();
  let w: World;
  let s: StockWorld;
  let overview: PharmacyOverviewService;
  let settings: PharmacySettingsService;

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
    settings = new PharmacySettingsService(new SettingsService(m.HospitalSettings));
    overview = new PharmacyOverviewService(m.PharmacySnapshot, m.PharmacyOrder, m.PharmacyLine, settings, s.stock);
  });

  const def = () => w.registry.definitions().find((d) => d.key === 'pharmacy')!;
  const closeCheck = (caseId: unknown) => def().closeChecks![0].check(String(caseId));
  const caseOf = async () => (await m.Case.findOne({}).lean<any>())!._id;

  test('a case with a line to check, or an issued line with an open query, fails the close check', async () => {
    assert.equal(def().closeChecks![0].label, 'Medicine orders checked');
    await w.openEr();
    const erCase = await caseOf();
    assert.equal(await closeCheck(erCase), 'n/a');
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin300, enoxaparin60] });
    assert.equal(await closeCheck(erCase), 'fail');
    await w.checks.approve(PHARM, v.lines[0].id, { reason: 'ok' });
    assert.equal(await closeCheck(erCase), 'fail');
    await w.checks.approve(PHARM, v.lines[1].id, { reason: 'ok' });
    assert.equal(await closeCheck(erCase), 'pass');

    // An issued line with an open query still blocks.
    const query = { seq: 1, kind: 'dose', question: 'q', by: { id: PHARM.id, name: PHARM.name }, at: new Date(), openedRealAt: new Date(), dueAt: new Date(), suggestions: [] };
    await m.PharmacyLine.updateOne({ _id: v.lines[0].id }, { $set: { status: 'issued', query } });
    assert.equal(await closeCheck(erCase), 'fail');
    await m.PharmacyLine.updateOne({ _id: v.lines[0].id }, { $set: { 'query.answer': { outcome: 'keep', by: { id: DOC.id, name: DOC.name }, reason: 'r', at: new Date(), realAt: new Date() } } });
    assert.equal(await closeCheck(erCase), 'pass');
  });

  test('approved OPD lines waiting at the counter do not block the close check', async () => {
    const opd = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [amlodipine] });
    assert.equal(opd.setting, 'OPD');
    const opdCase = await caseOf();
    assert.equal(await closeCheck(opdCase), 'fail');
    await w.checks.approve(PHARM, opd.lines[0].id, {});
    assert.equal((await w.lineDoc(opd.lines[0].id)).status, 'approved');
    assert.equal(await closeCheck(opdCase), 'pass');
  });

  test('status counts lines to check, with an open query, and approved but not issued; onTimePct is the met share of check clocks stopped in 24 h', async () => {
    await w.openEr();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin300, enoxaparin60, amoxicillin500] });
    assert.equal((await def().status()).open, 3);
    await w.checks.approve(PHARM, v.lines[0].id, { reason: 'ok' });
    await w.checks.query(PHARM, v.lines[1].id, { kind: 'dose', question: 'Dose?' });
    // to-check, query and approved all count; an issued line does not.
    assert.equal((await def().status()).open, 3);
    await m.PharmacyLine.updateOne({ _id: v.lines[0].id }, { $set: { status: 'issued' } });
    const status = await def().status();
    assert.deepEqual([status.open, status.capacity, status.onTimePct], [2, 0, null]);

    const clock = (state: string, stoppedAt?: Date) =>
      ({ def: 'pharmacy-check', startedBy: new Types.ObjectId(), startedAt: new Date(Date.now() - 60 * MIN), dueAt: new Date(), state, ref: String(new Types.ObjectId()), ...(stoppedAt ? { stoppedAt } : {}) });
    await m.Clock.collection.insertMany([
      clock('met', new Date()), clock('met', new Date()), clock('met', new Date()), clock('expired', new Date()),
      clock('met', new Date(Date.now() - 48 * 60 * MIN)), clock('running'),
    ] as never);
    assert.equal((await def().status()).onTimePct, 75);
  });

  test("cards count today's orders, lines to check, open queries, lines issued today and low pairs", async () => {
    await w.openEr();
    const a = await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin300, enoxaparin60, amoxicillin500] });
    const old = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [amlodipine] });
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(old.id) }, { $set: { createdAt: new Date(Date.now() - 3 * 24 * 60 * MIN) } });
    await w.checks.query(PHARM, a.lines[1].id, { kind: 'dose', question: 'Dose?' });
    await w.checks.approve(PHARM, a.lines[2].id, { reason: 'ok' });
    await m.PharmacyLine.updateOne({ _id: a.lines[2].id }, { $set: { status: 'issued', 'issued.realAt': new Date() } });
    // Issued yesterday: not today.
    await m.PharmacyLine.updateOne({ _id: old.lines[0].id }, { $set: { status: 'issued', 'issued.realAt': new Date(Date.now() - 2 * 24 * 60 * MIN) } });
    await s.batch('aspirin-tab-300', 'er', 'A1', 100, 5);
    await s.stock.setLevel(PHARM, { product: 'aspirin-tab-300', store: 'er', reorderLevel: 10 });
    await s.batch('aspirin-tab-300', 'main', 'A2', 100, 500);
    await s.stock.setLevel(PHARM, { product: 'aspirin-tab-300', store: 'main', reorderLevel: 10 });

    const { cards } = await overview.overview();
    assert.deepEqual(
      [cards.ordersToday.value, cards.toCheck.value, cards.openQueries.value, cards.issuedToday.value, cards.lowStock.value],
      [1, 1, 1, 1, 1],
    );
    assert.equal(cards.ordersToday.spark.length, 24);
  });

  test('check time rows and performance come from the line timestamps', async () => {
    await w.openEr();
    const stat = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300, enoxaparin60] });
    const urgent = await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [amoxicillin500] });
    const now = Date.now();
    const times = async (id: string, minutes: number) =>
      m.PharmacyLine.updateOne({ _id: id }, { $set: { enteredCheckAt: new Date(now - minutes * MIN), checkedAt: new Date(now) } });
    await times(stat.lines[0].id, 10); // within the 15 minute STAT target
    await times(stat.lines[1].id, 20); // late
    await times(urgent.lines[0].id, 30); // within 60
    const query = (min: number, answerAfter: number) => ({
      seq: 1, kind: 'dose', question: 'q', by: { id: PHARM.id, name: PHARM.name }, at: new Date(), openedRealAt: new Date(now - min * MIN),
      dueAt: new Date(now - (min - 30) * MIN), suggestions: [],
      answer: { outcome: 'keep', by: { id: DOC.id, name: DOC.name }, reason: 'r', at: new Date(), realAt: new Date(now - (min - answerAfter) * MIN) },
    });
    await m.PharmacyLine.updateOne({ _id: stat.lines[0].id }, { $set: { query: query(60, 20) } }); // answered in 20, due in 30: on time
    await m.PharmacyLine.updateOne({ _id: stat.lines[1].id }, { $set: { query: query(60, 40) } }); // late

    const o = await overview.overview();
    const row = (p: string) => o.checkTime.find((r) => r.priority === p)!;
    assert.deepEqual([row('stat').count, row('stat').avgMin, row('stat').targetMin, row('stat').onTimePct], [2, 15, 15, 50]);
    assert.deepEqual([row('urgent').count, row('urgent').avgMin, row('urgent').targetMin, row('urgent').onTimePct], [1, 30, 60, 100]);
    assert.deepEqual([row('routine').count, row('routine').avgMin, row('routine').onTimePct], [0, null, null]);
    assert.deepEqual([o.performance.avgCheckMin, o.performance.checkOnTimePct, o.performance.queriesOnTimePct], [20, 67, 50]);
    assert.equal(o.performance.ordersByHour.length, 24);
    assert.equal(o.performance.ordersByHour.reduce((a, b) => a + b, 0), 2);
  });

  test('stock alerts list the low rows, near-expiry and expired batches', async () => {
    await s.batch('aspirin-tab-300', 'main', 'NEAR', 30, 40);
    await s.batch('aspirin-tab-300', 'main', 'OLD', -3, 9);
    await s.batch('aspirin-tab-300', 'main', 'FAR', 300, 40);
    const { stockAlerts } = await overview.overview();
    assert.deepEqual(stockAlerts.nearExpiry.map((b) => [b.batchNo, b.quantity, b.store]), [['NEAR', 40, 'main']]);
    assert.deepEqual(stockAlerts.expired.map((b) => [b.batchNo, b.quantity]), [['OLD', 9]]);
    assert.equal(stockAlerts.low.length, 0);
  });

  test('only an admin saves settings; a saved STAT check target of 10 sets the next order\'s check due; 0 and 1441 are 400', async () => {
    const admin = { id: 'a', name: 'Admin', role: UserRole.ADMIN };
    await assert.rejects(() => settings.save(PHARM, { nearExpiryDays: 30 }), { status: 403 });
    await assert.rejects(() => settings.save(DOC, { nearExpiryDays: 30 }), { status: 403 });
    for (const bad of [{ targets: { check: { stat: 0 } } }, { targets: { check: { stat: 1441 } } }, { targets: { check: { stat: 1.5 } } }, { targets: { lab: { stat: 5 } } },
      { targets: { check: { later: 5 } } }, { targets: { toString: { stat: 5 } } }, { nearExpiryDays: 0 }, { nearExpiryDays: 366 }, { other: 1 }, 'x', null]) {
      await assert.rejects(() => settings.save(admin, bad), { status: 400 }, JSON.stringify(bad));
    }
    assert.equal((await settings.get()).targets.check.stat, 15);
    const saved = await settings.save(admin, { targets: { check: { stat: 10 } }, nearExpiryDays: 30 });
    assert.deepEqual([saved.targets.check.stat, saved.targets.check.urgent, saved.nearExpiryDays], [10, 60, 30]);
    // A second save keeps the first one's values.
    await settings.save(admin, { targets: { issue: { routine: 100 } } });
    const got = await settings.get();
    assert.deepEqual([got.targets.check.stat, got.targets.issue.routine, got.nearExpiryDays], [10, 100, 30]);

    await w.openEr();
    const before = Date.now();
    const v = await w.orders.order(DOC, { patientId: w.patientId, priority: 'stat', lines: [aspirin300] });
    const order = await m.PharmacyOrder.findById(v.id).lean<any>();
    const due = new Date(order.checkDueAt).getTime();
    assert.ok(due >= before + 10 * MIN && due <= Date.now() + 10 * MIN, 'check due is 10 minutes out');
  });

  test('the snapshot upserts one record per hour', async () => {
    await w.openEr();
    await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [aspirin300] });
    await overview.snapshot();
    await overview.snapshot();
    assert.equal(await m.PharmacySnapshot.countDocuments({}), 1);
    const snap = await m.PharmacySnapshot.findOne({}).lean<any>();
    assert.deepEqual([snap.ordersToday, snap.toCheck, snap.openQueries, snap.issuedToday, snap.lowStock], [1, 1, 0, 0, 0]);
    const day = await overview.series('24h');
    assert.equal(day.points.length, 24);
    assert.equal(day.points[23].ordersToday, 1);
    assert.equal(day.points[0].ordersToday, null);
    assert.equal((await overview.series('7d')).points.length, 168);
  });
});
