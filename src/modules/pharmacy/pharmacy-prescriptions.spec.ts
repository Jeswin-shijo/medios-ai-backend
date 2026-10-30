import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DOC, PHARM, World, buildWorld } from '../../test/pharmacy-fixtures';
import { StockWorld, buildStock } from '../../test/pharmacy-stock-fixtures';
import { PatientsService } from '../patients/patients.service';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { PharmacyPrescriptionsService, prescriptionLine } from './pharmacy-prescriptions.service';
import { PharmacyReconcileService } from './pharmacy-reconcile.service';

const item = (medicine: string, dose: string, frequency = 'OD', duration = '30 days', extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  medicine,
  dose,
  frequency,
  duration,
  route: 'Oral',
  status: 'Active',
  ...extra,
});

describe('prescriptions into Pharmacy', () => {
  const m = models();
  let w: World;
  let s: StockWorld;
  let svc: PharmacyPrescriptionsService;

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
    svc = new PharmacyPrescriptionsService(m.Prescription, m.PharmacyOrder, m.PharmacyLine, w.orders, w.checks, new PatientsService(m.Patient));
  });

  const save = (items: any[], rev = 1) =>
    m.Prescription.create({ uhid: w.patientUhid, doctor: DOC.name, items, pharmacyRev: rev, pharmacyPending: rev > 0 ? true : undefined, pharmacyBy: { id: DOC.id, name: DOC.name } });
  /** What the controller's save does on an edit: a new revision. */
  const edit = async (id: string, items: any[]) => {
    await m.Prescription.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { items, pharmacyPending: true, pharmacyBy: { id: DOC.id, name: DOC.name } }, $inc: { pharmacyRev: 1 } });
  };
  const orderOf = (id: unknown) => m.PharmacyOrder.findOne({ prescription: id }).lean<any>().exec();
  const linesOf = (orderId: unknown) => m.PharmacyLine.find({ order: orderId }).sort({ _id: 1 }).lean<any[]>().exec();

  test('saving a prescription makes one OPD routine order with a line per Active item; a Paused item is left out', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg'), item('Tab Metformin 500 mg', '500 mg', 'BD', '2 weeks'), item('Tab Atorvastatin', '10 mg', 'HS', '30 days', { status: 'Paused' })]);
    assert.equal(await svc.sync(String(rx._id)), 'synced');
    const order = await orderOf(rx._id);
    assert.equal(order.setting, 'OPD');
    assert.equal(order.priority, 'routine');
    assert.equal(order.source, 'prescription');
    assert.equal(order.prescriptionRev, 1);
    assert.equal(order.orderedBy.name, DOC.name);
    assert.equal(order.syncingUntil, undefined);
    const lines = await linesOf(order._id);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.medicine), ['amlodipine', 'metformin']);
    assert.equal(lines[1].quantity, 28);
    assert.equal(await svc.sync(String(rx._id)), 'current');
    assert.equal((await linesOf(order._id)).length, 2);
    assert.equal((await w.sent('pharmacy.to-check')).length, 2);
  });

  test('item mapping: a listed item, "Continue", an unlisted item and a dose in another unit', async () => {
    const a = prescriptionLine(item('Tab Amlodipine 5 mg', '5 mg') as any, 1);
    assert.equal(a.product, 'amlodipine-tab-5');
    assert.equal(a.quantity, 30);
    assert.equal(prescriptionLine(item('Tab Amlodipine 5 mg', '5 mg', 'OD', 'Continue') as any, 1).quantity, null);
    const u = prescriptionLine(item('Syp Herbal Tonic', '5 ml') as any, 1);
    assert.equal(u.medicine, null);
    assert.equal(u.freeName, 'Syp Herbal Tonic');
    assert.equal(u.quantity, null);

    const rx = await save([item('Syp Herbal Tonic', '5 ml'), item('Tab Paracetamol 500 mg', '1 g', 'TDS', '3 days')]);
    await svc.sync(String(rx._id));
    const lines = await linesOf((await orderOf(rx._id))._id);
    const tonic = lines.find((l) => l.freeName === 'Syp Herbal Tonic');
    assert.ok(tonic.flags.some((f: any) => f.severity === 'amber' && f.text === 'Not in the medicine list: checks could not run'));
    const para = lines.find((l) => l.medicine === 'paracetamol');
    assert.equal(para.dose, null);
    assert.equal(para.quantity, null);
    assert.ok(para.flags.some((f: any) => f.severity === 'amber' && f.text === 'Dose not readable: check by hand'));
  });

  test('a prescription goes to the OPD counter even when the patient has an open ER case', async () => {
    await w.openEr();
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    await svc.sync(String(rx._id));
    const order = await orderOf(rx._id);
    assert.equal(order.setting, 'OPD');
    assert.equal((await w.clocksOf('pharmacy-issue')).length, 0);
  });

  test('editing cancels the unissued lines of the earlier revision and adds the new Active items; an unchanged issued item is carried over, not added twice', async () => {
    const keep = item('Tab Amlodipine 5 mg', '5 mg');
    const drop = item('Tab Metformin 500 mg', '500 mg', 'BD', '5 days');
    const rx = await save([keep, drop]);
    await svc.sync(String(rx._id));
    const order = await orderOf(rx._id);
    const [first, second] = await linesOf(order._id);
    await m.PharmacyLine.collection.updateOne({ _id: first._id }, { $set: { status: 'issued', issued: { realAt: new Date() } } });

    await edit(String(rx._id), [{ ...keep, _id: new Types.ObjectId() }, item('Tab Telmisartan 40 mg', '40 mg')]);
    assert.equal(await svc.sync(String(rx._id)), 'synced');
    const lines = await linesOf(order._id);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].status, 'issued');
    assert.equal(lines[0].prescriptionRev, 2);
    assert.equal(lines[1].status, 'cancelled');
    assert.equal(lines[1].cancelled.reason, 'Prescription edited');
    assert.equal(lines[2].medicine, 'telmisartan');
    assert.equal(lines[2].status, 'to-check');
    assert.equal((await orderOf(rx._id)).prescriptionRev, 2);
    assert.equal(String(second._id), String(lines[1]._id));
    assert.equal((await w.sent('pharmacy.cancelled')).length, 1);
  });

  test('editing closes an open query on an earlier line', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    await svc.sync(String(rx._id));
    const order = await orderOf(rx._id);
    const [line] = await linesOf(order._id);
    await w.checks.query(PHARM, String(line._id), { kind: 'dose', question: 'Is this right?' } as any);
    await edit(String(rx._id), [item('Tab Amlodipine 5 mg', '10 mg')]);
    await svc.sync(String(rx._id));
    const old = await w.lineDoc(String(line._id));
    assert.equal(old.status, 'cancelled');
    assert.ok(old.query.answer);
    assert.equal(old.query.answer.outcome, 'cancel');
    const alert = await m.TaskAlertItem.findOne({ link: `pharmacy-line:${String(line._id)}` }).lean<any>().exec();
    assert.equal(alert.status, 'Completed');
    assert.equal((await w.sent('pharmacy.query-answered')).length, 1);
  });

  test('an unconfirmed red allergy on a prescription line is held at once in an allergy query and never appears in To check', async () => {
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { allergies: ['Penicillin'] } });
    const rx = await save([item('Cap Amoxicillin 500 mg', '500 mg', 'TDS', '5 days')]);
    await svc.sync(String(rx._id));
    const [line] = await linesOf((await orderOf(rx._id))._id);
    assert.equal(line.status, 'query');
    assert.equal(line.query.kind, 'allergy');
    assert.equal((await w.sent('pharmacy.to-check')).length, 0);
    assert.equal((await w.orders.list({ status: 'to-check' })).length, 0);
  });

  test('a failed hand-off leaves the prescription saved and pending; reconcile (g) syncs it once', async () => {
    const broken = { sync: async () => Promise.reject(new Error('boom')) } as unknown as PharmacyPrescriptionsService;
    const rxService = new PrescriptionsService(m.Prescription, broken);
    (rxService as any).logger = { error: () => undefined };
    const saved = await rxService.create({ uhid: w.patientUhid, items: [item('Tab Amlodipine 5 mg', '5 mg')] } as any, DOC);
    assert.equal(saved.pharmacyRev, 1);
    assert.equal(await orderOf(saved._id), null);

    const rec = new PharmacyReconcileService(m.PharmacyOrder, m.PharmacyLine, m.Clock, m.AgentMessage, w.orders, w.checks, s.issue, s.stock, m.Prescription, svc);
    assert.equal((await rec.reconcile()).prescriptions, 0); // younger than 30 s
    await m.Prescription.collection.updateOne({ _id: saved._id }, { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    assert.equal((await rec.reconcile()).prescriptions, 1);
    assert.equal((await linesOf((await orderOf(saved._id))._id)).length, 1);
    assert.equal((await rec.reconcile()).prescriptions, 0);
  });

  test('reconcile (g) skips a synced prescription, picks up a pending one, and stops re-syncing one with no Active item', async () => {
    const rec = new PharmacyReconcileService(m.PharmacyOrder, m.PharmacyLine, m.Clock, m.AgentMessage, w.orders, w.checks, s.issue, s.stock, m.Prescription, svc);
    const synced = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    await svc.sync(String(synced._id));
    const empty = await save([item('Tab Metformin 500 mg', '500 mg', 'BD', '5 days', { status: 'Paused' })]);
    const pending = await save([item('Tab Telmisartan 40 mg', '40 mg')]);
    await m.Prescription.collection.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    const calls: string[] = [];
    const real = svc.sync.bind(svc);
    svc.sync = async (id: string) => (calls.push(id), real(id));
    assert.equal((await rec.reconcile()).prescriptions, 1);
    assert.deepEqual([...calls].sort(), [String(empty._id), String(pending._id)].sort());
    assert.equal(await orderOf(pending._id).then((o) => o.prescriptionRev), 1);
    calls.length = 0;
    assert.equal((await rec.reconcile()).prescriptions, 0);
    assert.deepEqual(calls, []);
  });

  test('reconcile (g) leaves a prescription at revision 0 alone, and catches up an edit', async () => {
    const rec = new PharmacyReconcileService(m.PharmacyOrder, m.PharmacyLine, m.Clock, m.AgentMessage, w.orders, w.checks, s.issue, s.stock, m.Prescription, svc);
    const old = await save([item('Tab Amlodipine 5 mg', '5 mg')], 0);
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    const aged = () => m.Prescription.collection.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    await aged();
    assert.equal((await rec.reconcile()).prescriptions, 1);
    assert.equal(await orderOf(old._id), null);
    await edit(String(rx._id), [item('Tab Amlodipine 5 mg', '10 mg')]);
    await aged();
    assert.equal((await rec.reconcile()).prescriptions, 1);
    assert.equal((await orderOf(rx._id)).prescriptionRev, 2);
  });

  test('two first-revision syncs truly contend: one is busy, one order, lines made once', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg'), item('Tab Metformin 500 mg', '500 mg', 'BD', '5 days')]);
    const results = await Promise.all([svc.sync(String(rx._id)), svc.sync(String(rx._id))]);
    assert.deepEqual([...results].sort(), ['busy', 'synced']);
    const orders = await m.PharmacyOrder.find({ prescription: rx._id }).lean().exec();
    assert.equal(orders.length, 1);
    assert.equal((await linesOf(orders[0]._id)).length, 2);
  });

  test('three syncs after an edit: exactly one synced, no duplicate lines', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    await svc.sync(String(rx._id));
    await edit(String(rx._id), [item('Tab Amlodipine 5 mg', '10 mg'), item('Tab Metformin 500 mg', '500 mg', 'BD', '5 days')]);
    const results = await Promise.all([svc.sync(String(rx._id)), svc.sync(String(rx._id)), svc.sync(String(rx._id))]);
    assert.equal(results.filter((r) => r === 'synced').length, 1);
    const order = await orderOf(rx._id);
    const open = (await linesOf(order._id)).filter((l) => l.status === 'to-check');
    assert.equal(open.length, 2);
  });

  test('a live claim gives busy; a lapsed claim re-runs a half-applied revision without duplicate lines', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg'), item('Tab Metformin 500 mg', '500 mg', 'BD', '5 days')]);
    await svc.sync(String(rx._id));
    const order = await orderOf(rx._id);
    await m.PharmacyOrder.collection.updateOne({ _id: order._id }, { $set: { prescriptionRev: 0, syncingUntil: new Date(Date.now() + 30_000) } });
    assert.equal(await svc.sync(String(rx._id)), 'busy');
    await m.PharmacyOrder.collection.updateOne({ _id: order._id }, { $set: { syncingUntil: new Date(Date.now() - 1000) } });
    assert.equal(await svc.sync(String(rx._id)), 'synced');
    assert.equal((await linesOf(order._id)).length, 2);
    const after = await orderOf(rx._id);
    assert.equal(after.prescriptionRev, 1);
    assert.equal(after.syncingUntil, undefined);
  });

  test('Y34: an over-long sync does not release a newer claim or set the revision', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    await svc.sync(String(rx._id));
    const order = await orderOf(rx._id);
    await edit(String(rx._id), [item('Tab Amlodipine 5 mg', '10 mg')]);
    const newer = new Date(Date.now() + 120_000);
    const real = w.orders.announceOrdered.bind(w.orders);
    (w.orders as any).announceOrdered = async (o: any) => {
      // While this sync is still running, its claim lapsed and another sync took over.
      await m.PharmacyOrder.collection.updateOne({ _id: order._id }, { $set: { syncingUntil: newer } });
      return real(o);
    };
    assert.equal(await svc.sync(String(rx._id)), 'busy');
    const after = await orderOf(rx._id);
    assert.equal(after.prescriptionRev, 1);
    assert.equal(new Date(after.syncingUntil).getTime(), newer.getTime());
  });

  test('an ER-case prescription line, once approved, still gets no issue clock', async () => {
    await w.openEr();
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg')]);
    await svc.sync(String(rx._id));
    const [line] = await linesOf((await orderOf(rx._id))._id);
    await w.checks.approve(PHARM, String(line._id), {});
    assert.equal((await w.lineDoc(String(line._id))).status, 'approved');
    assert.equal((await w.clocksOf('pharmacy-issue')).length, 0);
  });

  test('a prescription with no Active item and no order makes no order and stops being pending', async () => {
    const rx = await save([item('Tab Amlodipine 5 mg', '5 mg', 'OD', '30 days', { status: 'Paused' })]);
    assert.equal(await svc.sync(String(rx._id)), 'current');
    assert.equal(await orderOf(rx._id), null);
    assert.equal((await m.Prescription.findById(rx._id).lean<any>().exec()).pharmacyPending, undefined);
  });

  test('a prescription with no patient record is warned about once and stops being pending', async () => {
    const rx = await m.Prescription.create({ uhid: 'MHK999999999', items: [item('Tab Amlodipine 5 mg', '5 mg')], pharmacyRev: 1, pharmacyPending: true, pharmacyBy: { id: DOC.id, name: DOC.name } });
    const warned: string[] = [];
    (svc as any).logger = { warn: (x: string) => warned.push(x), error: () => undefined };
    assert.equal(await svc.sync(String(rx._id)), 'current');
    assert.equal(warned.length, 1);
    assert.equal((await m.Prescription.findById(rx._id).lean<any>().exec()).pharmacyPending, undefined);
  });

  test('an unlisted line stores its route in lower case', async () => {
    assert.equal(prescriptionLine(item('Syp Herbal Tonic', '5 ml') as any, 1).route, 'oral');
    assert.equal(prescriptionLine(item('Syp Herbal Tonic', '5 ml', 'OD', '3 days', { route: ' Topical ' }) as any, 1).route, 'topical');
    assert.equal(prescriptionLine(item('Syp Herbal Tonic', '5 ml', 'OD', '3 days', { route: 'X'.repeat(50) }) as any, 1).route, 'x'.repeat(30));
  });

  test('status reports each item: not sent, or its line with the red and amber flags', async () => {
    const a = item('Tab Amlodipine 5 mg', '5 mg');
    const b = item('Tab Metformin 500 mg', '500 mg', 'BD', '5 days', { status: 'Paused' });
    const rx = await save([a, b]);
    await svc.sync(String(rx._id));
    const st = await svc.status(String(rx._id));
    const sa = st[String(a._id)] as any;
    assert.equal(sa.status, 'to-check');
    assert.equal(sa.red, 0);
    assert.equal(sa.waitingForStock, false);
    assert.deepEqual(st[String(b._id)], { status: 'not-sent' });
    await assert.rejects(() => svc.status(String(new Types.ObjectId())));
  });

  test('a save strips pharmacyRev and pharmacyBy from the body and advances the stored revision by one', async () => {
    const calls: string[] = [];
    const stub = { sync: async (id: string) => void calls.push(id) } as unknown as PharmacyPrescriptionsService;
    const rxService = new PrescriptionsService(m.Prescription, stub);
    const created = await rxService.create({ uhid: w.patientUhid, items: [], pharmacyRev: 50, pharmacyPending: false, pharmacyBy: { id: 'x', name: 'Mallory' } } as any, DOC);
    assert.equal(created.pharmacyRev, 1);
    assert.equal(created.pharmacyBy?.name, DOC.name);
    const stale = await rxService.update(String(created._id), { additionalInstructions: 'a', pharmacyRev: 1, pharmacyBy: { id: 'x', name: 'Mallory' } } as any, PHARM);
    assert.equal(stale.pharmacyRev, 2);
    const again = await rxService.update(String(created._id), { additionalInstructions: 'b', pharmacyRev: 1, pharmacyPending: false } as any, DOC);
    assert.equal(again.pharmacyPending, true);
    assert.equal(again.pharmacyRev, 3);
    assert.equal((await m.Prescription.findById(created._id).lean<any>().exec()).pharmacyBy.name, DOC.name);
    assert.equal(calls.length, 3);
    assert.equal(created.pharmacyPending, true);
  });

  test('a sync that clears the pending flag between load and save does not unflag the new revision', async () => {
    const rxService = new PrescriptionsService(m.Prescription, { sync: async () => 'current' } as unknown as PharmacyPrescriptionsService);
    const created = await rxService.create({ uhid: w.patientUhid, items: [] } as any, DOC);
    const load = rxService.findOne.bind(rxService);
    rxService.findOne = async (id: string) => {
      const doc = await load(id);
      await m.Prescription.collection.updateOne({ _id: doc._id }, { $unset: { pharmacyPending: '' } });
      return doc;
    };
    await rxService.update(String(created._id), { additionalInstructions: 'a' } as any, DOC);
    const stored = await m.Prescription.findById(created._id).lean<any>().exec();
    assert.equal(stored.pharmacyRev, 2);
    assert.equal(stored.pharmacyPending, true);
  });

  test('two concurrent saves advance the stored revision twice (an atomic increment, not read plus one)', async () => {
    const rxService = new PrescriptionsService(m.Prescription, { sync: async () => 'current' } as unknown as PharmacyPrescriptionsService);
    const created = await rxService.create({ uhid: w.patientUhid, items: [] } as any, DOC);
    await Promise.all([
      rxService.update(String(created._id), { additionalInstructions: 'a' } as any, DOC),
      rxService.update(String(created._id), { additionalInstructions: 'b' } as any, DOC),
    ]);
    assert.equal((await m.Prescription.findById(created._id).lean<any>().exec()).pharmacyRev, 3);
  });

  test('check-interactions uses the Pharmacy rules: warfarin with metronidazole gives one "Red: Raises INR sharply (warfarin with metronidazole)"; metformin with cimetidine gives none', async () => {
    const rxService = new PrescriptionsService(m.Prescription, svc);
    const r = await rxService.checkInteractions(['Tab Warfarin 5 mg', 'Tab Metronidazole 400 mg']);
    assert.equal(r.hasInteractions, true);
    assert.deepEqual(r.warnings, ['Red: Raises INR sharply (warfarin with metronidazole)']);
    assert.equal(r.checkedMedicinesCount, 2);
    const none = await rxService.checkInteractions(['Tab Metformin 500 mg', 'Tab Cimetidine 400 mg']);
    assert.deepEqual(none, { hasInteractions: false, warnings: [], checkedMedicinesCount: 2 });
  });
});
