import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { isoDate, clinicNow } from '../../common/utils/clinic-time';
import { RevenueBillsService } from './revenue-bills.service';

const BY = { id: 'u1', name: 'Pharmacy Agent' };
const line = (ref: string, unitPrice = 100, qty = 1) => ({
  code: 'med:para', name: 'Paracetamol', category: 'pharmacy' as const, qty, unitPrice, source: { type: 'pharmacy', ref }, by: BY,
});

describe('RevenueBillsService', () => {
  const m = models();
  let svc: RevenueBillsService;
  let patient: any;
  const oid = () => String(new (require('mongoose').Types.ObjectId)());

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    delete process.env.CLINIC_DATE;
    await resetTestDb();
    svc = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    patient = await m.Patient.create({ uhid: 'MHK202600971', name: 'Mohan Raj', age: 58, gender: 'Male', phone: '9100000071' });
  });

  test('forCharge prefers the case\'s open ER or admission bill, then the day\'s OPD bill, then a walk-in bill', async () => {
    const pid = String(patient._id);
    const caseId = oid();
    const walk = await svc.forCharge({ patientId: pid, caseId });
    assert.equal(walk.kind, 'walk-in');
    assert.equal(walk.day, isoDate(clinicNow()));
    assert.equal(String((await svc.forCharge({ patientId: pid })).id), String(walk.id));

    const opd = await svc.open({ kind: 'opd', patientId: pid, appointmentId: oid() });
    assert.equal(String((await svc.forCharge({ patientId: pid, caseId })).id), String(opd.id));

    const er = await svc.open({ kind: 'er', patientId: pid, caseId, erVisitId: oid() });
    assert.equal(String((await svc.forCharge({ patientId: pid, caseId })).id), String(er.id));
    assert.equal(String((await svc.forCharge({ patientId: pid, caseId: null })).id), String(opd.id));

    const adm = await svc.open({ kind: 'admission', patientId: pid, caseId, admissionId: oid() });
    assert.equal(String((await svc.forCharge({ patientId: pid, caseId })).id), String(adm.id));

    await m.Bill.updateOne({ _id: adm._id }, { state: 'settled' });
    assert.equal(String((await svc.forCharge({ patientId: pid, caseId })).id), String(er.id));
    await m.Bill.updateOne({ _id: er._id }, { state: 'final' });
    assert.equal(String((await svc.forCharge({ patientId: pid, caseId })).id), String(er.id));
  });

  test('the same source charged twice is one line and one total', async () => {
    const bill = await svc.open({ kind: 'walk-in', patientId: String(patient._id) });
    const first = await svc.addCharge(String(bill.id), line('rx-1', 120, 2));
    const second = await svc.addCharge(String(bill.id), line('rx-1', 120, 2));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(String(second.line._id), String(first.line._id));
    assert.equal(await m.ChargeLine.countDocuments({ bill: bill._id }), 1);
    const got = await m.Bill.findById(bill._id).lean();
    assert.equal(first.line.amount, 240);
    assert.deepEqual({ ...got!.totals }, { charges: 240, discounts: 0, payments: 0, refunds: 0, balance: 240 });
    await assert.rejects(() => svc.addCharge(String(bill.id), line('x', 10, 0)), (e: any) => e.status === 400);
    await assert.rejects(() => svc.addCharge(String(bill.id), { ...line('y'), qty: 1, unitPrice: -5 }), (e: any) => e.status === 400);
  });

  test('two charges at once keep the totals exact', async () => {
    const bill = await svc.open({ kind: 'walk-in', patientId: String(patient._id) });
    const seen: string[] = [];
    svc.onTotalsChanged.push((id) => seen.push(id));
    const refs = Array.from({ length: 20 }, (_, i) => `r${i % 10}`);
    const out = await Promise.all(refs.map((r, i) => svc.addCharge(String(bill.id), line(r, 10 + (i % 10)))));
    assert.equal(out.filter((o) => o.created).length, 10);
    const lines = await m.ChargeLine.find({ bill: bill._id }).lean();
    assert.equal(lines.length, 10);
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const got = await m.Bill.findById(bill._id).lean();
    assert.equal(got!.totals.charges, sum);
    assert.equal(got!.totals.balance, sum);
    assert.equal(seen.length, 10);
    assert.ok(seen.every((id) => id === String(bill.id)));
  });

  test('open is idempotent per link', async () => {
    const pid = String(patient._id);
    const appt = oid();
    const a = await svc.open({ kind: 'opd', patientId: pid, appointmentId: appt });
    const b = await svc.open({ kind: 'opd', patientId: pid, appointmentId: appt });
    assert.equal(String(a.id), String(b.id));
    assert.match(a.number, /^BL-\d{4}$/);
    const [w1, w2] = await Promise.all([svc.open({ kind: 'walk-in', patientId: pid }), svc.open({ kind: 'walk-in', patientId: pid })]);
    assert.equal(String(w1.id), String(w2.id));
    const c = await svc.open({ kind: 'opd', patientId: pid, appointmentId: oid() });
    assert.notEqual(a.number, c.number);
    assert.equal(await m.Bill.countDocuments({}), 3);
    assert.equal(a.patientUhid, 'MHK202600971');
    assert.equal(a.patientName, 'Mohan Raj');
  });

  test('patientTotal and view read the active bill; a credit line is allowed only for a correction', async () => {
    const pid = String(patient._id);
    assert.equal(await svc.patientTotal(pid), null);
    const walk = await svc.open({ kind: 'walk-in', patientId: pid });
    assert.equal(await svc.patientTotal(pid), null);
    await svc.addCharge(String(walk.id), line('a', 300));
    assert.deepEqual(await svc.patientTotal(pid), { charges: 300, payments: 0, balance: 300, billNumber: walk.number });
    const er = await svc.open({ kind: 'er', patientId: pid, erVisitId: oid() });
    await svc.adjust(String(er.id), { charges: 1000, payments: 400 });
    assert.deepEqual(await svc.patientTotal(pid), { charges: 1000, payments: 400, balance: 600, billNumber: er.number });
    await svc.addCharge(String(er.id), { ...line('c1', -200), source: { type: 'correction', ref: 'c1' } });
    const v = await svc.view(String(er.id));
    assert.equal(v.lines.length, 1);
    assert.equal(v.bill.totals.balance, 400);
    assert.equal((await svc.list({ kind: 'er' })).length, 1);
    assert.equal((await svc.list({ q: 'mohan' })).length, 2);
  });

  test('a source is charged once across all bills', async () => {
    const pid = String(patient._id);
    const walk = await svc.open({ kind: 'walk-in', patientId: pid });
    const first = await svc.addCharge(String(walk.id), line('rx-9', 150));
    const opd = await svc.open({ kind: 'opd', patientId: pid, appointmentId: oid() });
    const again = await svc.addCharge(String(opd.id), line('rx-9', 150));
    assert.equal(again.created, false);
    assert.equal(String(again.line._id), String(first.line._id));
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': 'rx-9' }), 1);
    assert.equal((await m.Bill.findById(walk._id).lean())!.totals.charges, 150);
    assert.equal((await m.Bill.findById(opd._id).lean())!.totals.charges, 0);
  });

  test('a failed adjust removes the new line so a retry charges cleanly', async () => {
    const bill = await svc.open({ kind: 'walk-in', patientId: String(patient._id) });
    const real = svc.adjust.bind(svc);
    let fail = true;
    svc.adjust = async (id, d) => {
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
      return real(id, d);
    };
    await assert.rejects(() => svc.addCharge(String(bill.id), line('rx-5', 80)), /boom/);
    assert.equal(await m.ChargeLine.countDocuments({}), 0);
    const r = await svc.addCharge(String(bill.id), line('rx-5', 80));
    assert.equal(r.created, true);
    assert.equal((await m.Bill.findById(bill._id).lean())!.totals.balance, 80);
  });

  test('a settled bill refuses charges, huge amounts are 400, and bad listeners do not break a charge', async () => {
    const bill = await svc.open({ kind: 'walk-in', patientId: String(patient._id) });
    await assert.rejects(() => svc.addCharge(String(bill.id), line('big', Number.MAX_SAFE_INTEGER, 2)), (e: any) => e.status === 400);
    svc.onTotalsChanged.push(() => { throw new Error('sync'); });
    svc.onTotalsChanged.push(() => Promise.reject(new Error('async')) as never);
    const ok = await svc.addCharge(String(bill.id), line('ok', 10));
    assert.equal(ok.created, true);
    await new Promise((r) => setImmediate(r));
    await m.Bill.updateOne({ _id: bill._id }, { state: 'settled' });
    await assert.rejects(() => svc.addCharge(String(bill.id), line('late', 10)), (e: any) => e.status === 409);
  });

  test('a charge line\'s corrections are ObjectIds: a pushed id can be found by query', async () => {
    const bill = await svc.open({ kind: 'walk-in', patientId: String(patient._id) });
    await svc.addCharge(String(bill.id), line('rx-c', 50));
    const found = await m.ChargeLine.findOne({ bill: bill._id }).lean();
    const id = new (require('mongoose').Types.ObjectId)();
    await m.ChargeLine.updateOne({ _id: found!._id }, { $push: { corrections: id } });
    assert.equal(await m.ChargeLine.countDocuments({ corrections: String(id) }), 1);
    assert.equal(await m.ChargeLine.countDocuments({ corrections: new (require('mongoose').Types.ObjectId)() }), 0);
  });
});
