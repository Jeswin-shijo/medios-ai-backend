import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { PriceListService } from './price-list.service';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueDepositsService } from './revenue-deposits.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueSettingsService } from './revenue-settings.service';
import { RulesService } from '../coordinator/rules.service';
import { SettingsService } from '../settings/settings.service';

const H = 60 * 60 * 1000;
const T0 = new Date('2026-09-26T00:10:00.000Z'); // admitted
const at = (hours: number, minutes = 0) => new Date(T0.getTime() + hours * H + minutes * 60 * 1000);

describe('RevenueBedDaysService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let reg: RevenueCoordinatorRegistration;
  let bills: RevenueBillsService;
  let svc: RevenueBedDaysService;
  let patient: any;
  let general: any;
  let icu: any;
  let bedA: any;
  let bedB: any;
  let caseDoc: any;
  let seq = 0;

  const stub = (key: AgentKey, types: MessageTypeDef[]) =>
    registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  const price = (code: string, p: number) => m.PriceItem.create({ code, name: code, category: 'nursing', price: p, unit: 'day', active: true });
  const admit = (extra: Record<string, unknown> = {}) =>
    m.Admission.create({
      patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: bedA._id, roomClass: 'general', expectedStayDays: 3,
      status: 'active', admittedAt: T0, admittedBy: 'Nurse', ...extra,
    });
  const deliver = async (type: string, payload: Record<string, unknown>, withCase: boolean | null = true) => {
    const msg = await messages.send({
      case: withCase ? String(caseDoc._id) : null, from: 'bed', to: ['coordinator'], type, priority: 'medium', summary: type, payload, dedupeKey: `t${++seq}`,
    });
    assert.equal(msg!.state, 'delivered');
  };
  const lines = (type?: string) => m.ChargeLine.find(type ? { 'source.type': type } : {}).sort({ chargedAt: 1, _id: 1 }).lean();

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    stub('er', ER_MESSAGE_TYPES);
    stub('bed', BED_MESSAGE_TYPES);
    reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    // The capture service registers the other handlers; the bed-day service registers its own three.
    new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    const settingsService = new SettingsService(m.HospitalSettings);
    const revenueSettings = new RevenueSettingsService(settingsService);
    const estimates = new RevenueEstimatesService(reg, revenueSettings, prices, m.Bill, m.Estimate, m.ProcedureBooking, m.Admission, m.Bed);
    const deposits = new RevenueDepositsService(messages, reg, new RulesService(registry, settingsService, new CoordinatorEvents()), revenueSettings, prices, bills, estimates, m.Bill, m.TaskAlertItem, m.ProcedureBooking, m.Admission, m.Bed, m.Ward, m.Case);
    const final = new FinalBillService(messages, reg, revenueSettings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment, m.DischargeOrder);
    svc = new RevenueBedDaysService(messages, prices, bills, reg, m.Admission, m.Bed, m.Case, m.Bill, m.ChargeLine, estimates, deposits, final, revenueSettings, m.DischargeOrder);
    reg.onModuleInit();
    svc.clock = () => at(0);
    patient = await m.Patient.create({ uhid: 'MHK202600961', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000061' });
    general = await m.Ward.create({ code: 'GA', name: 'General Ward A', shortName: 'Ward A', floor: 1, type: 'general', gender: 'any', ratePerDay: 1500 });
    icu = await m.Ward.create({ code: 'ICU', name: 'ICU', shortName: 'ICU', floor: 2, type: 'icu', gender: 'any', ratePerDay: 6000 });
    bedA = await m.Bed.create({ ward: general._id, label: 'GA-01', number: 1 });
    bedB = await m.Bed.create({ ward: icu._id, label: 'ICU-01', number: 1 });
    caseDoc = await m.Case.create({ number: 'CASE-0001', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, kind: 'ipd', priority: 'medium', openedAt: T0, openedBy: 'bed' });
    await price('nursing:general', 300);
    await price('nursing:critical', 900);
  });

  const billOf = (adm: any) => m.Bill.findOne({ kind: 'admission', admission: adm._id }).lean();

  test('an admission at 23:50 is one day at 23:49 next day and two at 23:50', async () => {
    const adm = await admit({ admittedAt: new Date('2026-09-26T23:50:00.000Z') });
    svc.clock = () => new Date('2026-09-26T23:50:00.000Z');
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: 'General Ward A' });
    assert.equal((await lines('bed-day')).length, 1, 'day 1 charged at admission');
    assert.equal(await svc.chargeDue(String(adm._id), new Date('2026-09-27T23:49:00.000Z')), 0);
    assert.equal((await lines('bed-day')).length, 1);
    assert.equal(await svc.chargeDue(String(adm._id), new Date('2026-09-27T23:50:00.000Z')), 2, 'a bed day and a nursing day');
    assert.equal((await lines('bed-day')).length, 2);
    assert.equal((await lines('nursing-day')).length, 2);
  });

  test('a transfer mid-period keeps that period\'s ward rate; the next period uses the new ward', async () => {
    const adm = await admit({ transfers: [{ fromBed: bedA._id, toBed: bedB._id, at: at(10), by: 'Nurse' }], bed: bedB._id });
    svc.clock = () => at(0);
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: 'General Ward A' });
    await svc.chargeDue(String(adm._id), at(49));
    const bed = await lines('bed-day');
    assert.deepEqual(bed.map((l) => l.unitPrice), [1500, 6000, 6000]);
    const nursing = await lines('nursing-day');
    assert.deepEqual(nursing.map((l) => l.unitPrice), [300, 900, 900]);
    assert.equal(bed[0].category, 'bed');
    assert.equal(bed[0].source.ref, `${adm._id}:0`);
    assert.equal(nursing[1].code, 'nursing:critical');
  });

  test('after three missed periods, tick charges each once', async () => {
    const adm = await admit();
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: '' });
    assert.equal((await lines('bed-day')).length, 1);
    assert.equal(await svc.tick(at(72)), 6, 'days 2-4: three bed days and three nursing days');
    assert.equal(await svc.tick(at(72)), 0, 'nothing twice');
    assert.equal((await lines('bed-day')).length, 4);
    assert.equal((await billOf(adm))!.totals.charges, 4 * 1500 + 4 * 300);
  });

  test('an ER bill becomes the admission bill on bed.assigned and keeps its ER charges', async () => {
    const adm = await admit();
    const visitId = new Types.ObjectId();
    const er = await bills.open({ kind: 'er', patientId: String(patient._id), caseId: String(caseDoc._id), erVisitId: String(visitId) });
    await bills.addCharge(String(er._id), { code: 'er:registration', name: 'ER registration', category: 'er', qty: 1, unitPrice: 200, source: { type: 'er.arrived', ref: String(visitId) }, by: { name: 'x' } });
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: 'General Ward A' });
    const all = await m.Bill.find({}).lean();
    assert.equal(all.length, 1, 'no second bill');
    assert.equal(all[0].kind, 'admission');
    assert.equal(String(all[0].admission), String(adm._id));
    assert.equal(all[0].wardType, 'general');
    assert.equal(String(all[0]._id), String(er._id));
    assert.equal(all[0].totals.charges, 200 + 1500 + 300);
    assert.equal((await lines('er.arrived')).length, 1);
  });

  test('the admission is found through the case when the message has no admission id; a replay opens no second bill', async () => {
    const adm = await admit();
    await m.Case.updateOne({ _id: caseDoc._id }, { $set: { 'refs.admissionId': String(adm._id) } });
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: '', ward: '' });
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: '', ward: '' });
    assert.equal(await m.Bill.countDocuments({}), 1);
    assert.equal(await m.ChargeLine.countDocuments({}), 2);
  });

  test('discharge charges the last part period in full', async () => {
    const adm = await admit();
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: '' });
    await m.Admission.updateOne({ _id: adm._id }, { $set: { status: 'discharged', dischargedAt: at(30) } });
    svc.clock = () => at(31);
    await deliver('bed.discharged', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id) });
    assert.equal((await lines('bed-day')).length, 2, 'the 6-hour second period is a full day');
    assert.equal((await lines('nursing-day')).length, 2);
    // Later ticks never add days to a discharged stay.
    assert.equal(await svc.tick(at(200)), 0);
    assert.equal(await svc.chargeDue(String(adm._id), at(200)), 0);
  });

  test('a discharge at exactly 24 h charges one day, not two', async () => {
    const adm = await admit();
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: '' });
    await m.Admission.updateOne({ _id: adm._id }, { $set: { status: 'discharged', dischargedAt: at(24) } });
    svc.clock = () => at(24);
    await deliver('bed.discharged', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id) });
    assert.equal((await lines('bed-day')).length, 1);
    assert.equal((await lines('nursing-day')).length, 1);
  });

  test('bed.discharged with no case and no admission id finds the newest discharged admission on that bed', async () => {
    const old = await admit({ status: 'discharged', dischargedAt: at(-48), admittedAt: at(-72) });
    const adm = await admit({ status: 'discharged', dischargedAt: at(30) });
    await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(adm._id) });
    svc.clock = () => at(31);
    await deliver('bed.discharged', { bedId: String(bedA._id), bedLabel: 'GA-01' }, null);
    assert.equal((await lines('bed-day')).length, 2);
    assert.ok(String((await lines('bed-day'))[0].source.ref).startsWith(String(adm._id)));
    assert.equal(await m.Bill.countDocuments({ admission: old._id }), 0);
  });

  test('bed.transferred catches up the days', async () => {
    const adm = await admit({ transfers: [{ fromBed: bedA._id, toBed: bedB._id, at: at(30), by: 'Nurse' }], bed: bedB._id });
    await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(adm._id) });
    svc.clock = () => at(30);
    await deliver('bed.transferred', { bedId: String(bedB._id), bedLabel: 'ICU-01', fromBedLabel: 'GA-01', admissionId: String(adm._id), ward: 'ICU' }, null);
    assert.equal((await lines('bed-day')).length, 2);
    await deliver('bed.transferred', { bedId: String(bedB._id), bedLabel: 'ICU-01', fromBedLabel: 'GA-01', admissionId: String(adm._id), ward: 'ICU' }, null);
    assert.equal((await lines('bed-day')).length, 2, 'the handler is safe to run again');
  });

  test('sample inpatients are never billed; a bad admission does not stop the tick', async () => {
    const samplePatient = await m.Patient.create({ uhid: 'MHK202600963', name: 'Sample', age: 50, gender: 'Male', phone: '9100000063' });
    const sample = await admit({ sample: true, patient: samplePatient._id, patientUhid: samplePatient.uhid, patientName: samplePatient.name });
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(sample._id), ward: '' });
    assert.equal(await m.Bill.countDocuments({}), 0);
    const other = await m.Patient.create({ uhid: 'MHK202600962', name: 'Lata', age: 40, gender: 'Female', phone: '9100000062' });
    const broken = await m.Admission.create({ patient: other._id, patientUhid: other.uhid, patientName: other.name, bed: new Types.ObjectId(), roomClass: 'general', expectedStayDays: 1, status: 'active', admittedAt: T0, admittedBy: 'N' });
    await m.Bill.create({ number: 'BL-9001', patient: other._id, patientUhid: other.uhid, patientName: other.name, kind: 'admission', admission: broken._id, state: 'open', openedAt: T0, payer: 'self' });
    const good = await admit();
    await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(good._id) });
    assert.equal(await svc.tick(at(1)), 2);
    assert.equal(await m.ChargeLine.countDocuments({}), 2);
  });

  test('a settled bill takes no more days: later ones go on a continuation bill, earlier ones are never charged, and nothing throws', async () => {
    const adm = await admit();
    const bill = await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(adm._id) });
    // Settled at 10 h mid-stay, with no discharge order, so with no checkout grace (R27). Day 1 was never charged.
    await m.Bill.updateOne({ _id: bill._id }, { $set: { state: 'settled', finalAt: at(10), settledAt: at(10) } });
    assert.equal(await svc.chargeDue(String(adm._id), at(72)), 6, 'days 2 to 4: a bed day and a nursing day each');
    const stay = await stayOf(adm);
    assert.deepEqual(stay.map((b: any) => [b.state, b.continuationOf ? String(b.continuationOf) : null]), [['settled', null], ['open', String(bill._id)]]);
    assert.equal(await m.ChargeLine.countDocuments({ bill: bill._id }), 0, 'the settled bill takes nothing');
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': `${adm._id}:0` }), 0, 'day 1 started before the settlement, so it is never charged afterwards');

    // A settled bill with no settledAt (settle always writes one) allows nothing more: no line, no continuation bill.
    const other = await m.Patient.create({ uhid: 'MHK202600967', name: 'Lata', age: 40, gender: 'Female', phone: '9100000067' });
    const old = await admit({ patient: other._id, patientUhid: other.uhid, patientName: other.name });
    const unstamped = await bills.open({ kind: 'admission', patientId: String(other._id), admissionId: String(old._id) });
    await m.Bill.updateOne({ _id: unstamped._id }, { $set: { state: 'settled' } });
    assert.equal(await svc.chargeDue(String(old._id), at(72)), 0);
    assert.equal((await stayOf(old)).length, 1);

    assert.equal(await svc.chargeDue('not-an-id'), 0);
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', ward: '', admissionId: String(new Types.ObjectId()) });
    assert.equal(await m.ChargeLine.countDocuments({}), 6);
  });

  test('a missing price charges 0 and is flagged', async () => {
    await m.PriceItem.deleteMany({});
    const adm = await admit();
    await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(adm._id) });
    await svc.chargeDue(String(adm._id), at(1));
    const n = await lines('nursing-day');
    assert.equal(n[0].unitPrice, 0);
    assert.equal(n[0].needsPrice, true);
  });

  /** The stay's bill, prepared and paid at `hours` (the clinic clock): day 1 of 1500 + 300. */
  const settleAt = (adm: any, hours: number) =>
    m.Bill.findOneAndUpdate(
      { kind: 'admission', admission: adm._id },
      { $set: { state: 'settled', finalAt: at(hours), settledAt: at(hours), 'totals.payments': 1800, 'totals.balance': 0 } },
      { new: true },
    ).lean();
  const order = (adm: any, extra: Record<string, unknown>) =>
    m.DischargeOrder.create({
      plan: new Types.ObjectId(), admission: adm._id, patient: adm.patient, kind: 'home', state: 'ordered', plannedLeaveAt: at(24), windowAt: at(22),
      diagnosis: 'Community-acquired pneumonia', orderedBy: { name: 'Dr Arun' }, orderedAt: at(20), ...extra,
    });
  const stayOf = (adm: any) => m.Bill.find({ kind: 'admission', admission: adm._id }).sort({ openedAt: 1, _id: 1 }).lean();

  test('a bed period starting 3 h after settlement is not charged, 5 h after is charged on the continuation bill', async () => {
    // Two stays admitted at T0, each with its discharge order open. Each bill is settled before the second period starts (at
    // 24 h): A 3 h before it, B 5 h before.
    const other = await m.Patient.create({ uhid: 'MHK202600964', name: 'Lata', age: 40, gender: 'Female', phone: '9100000064' });
    const a = await admit();
    const b = await admit({ patient: other._id, patientUhid: other.uhid, patientName: other.name });
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(a._id), ward: '' });
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(b._id), ward: '' }, null);
    await order(a, {});
    await order(b, { orderedAt: at(18), windowAt: at(18) });
    const settledA = (await settleAt(a, 21))!;
    const settledB = (await settleAt(b, 19))!;

    assert.equal(await svc.tick(at(25)), 2, "B's day 2: a bed day and a nursing day");
    const stayB = await stayOf(b);
    assert.equal(stayB.length, 2);
    const contB = stayB[1] as any;
    assert.deepEqual([contB.state, String(contB.continuationOf), contB.totals.charges], ['open', String(settledB._id), 1500 + 300]);
    assert.deepEqual(
      (await m.ChargeLine.find({ bill: contB._id }).sort({ _id: 1 }).lean()).map((l) => [l.source.type, l.source.ref]),
      [['bed-day', `${b._id}:1`], ['nursing-day', `${b._id}:1`]],
    );
    assert.deepEqual(await m.Bill.findById(settledB._id).lean(), settledB, "B's settled bill is untouched");
    assert.equal((await stayOf(a)).length, 1, 'A: its day 2 starts inside the grace, so nothing is charged and no bill opens');

    // R6: the grace still holds once A's stay has a continuation bill for a late charge.
    const late = (await bills.forCharge({ patientId: String(patient._id), caseId: String(caseDoc._id) })) as any;
    assert.equal(String(late.continuationOf), String(settledA._id));
    assert.equal(await svc.tick(at(30)), 0);
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': `${a._id}:1` }), 0, "A's period inside the grace is never charged");
    // The next period, a day later, is charged for both stays, on their continuation bills.
    assert.equal(await svc.tick(at(48)), 4);
    assert.equal(await m.ChargeLine.countDocuments({ bill: late._id, 'source.ref': `${a._id}:2` }), 2);
    assert.equal(await m.ChargeLine.countDocuments({ bill: contB._id, 'source.ref': `${b._id}:2` }), 2);
    assert.deepEqual(await m.Bill.findById(settledA._id).lean(), settledA, "A's settled bill is untouched");
  });

  test('cancel after settlement: the next periods are charged once each, and the settled bill is untouched', async () => {
    const adm = await admit();
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: '' });
    // Settled at 22 h for a planned 24 h leaving; the order is cancelled at 23 h and the patient stays two more days.
    const settled = (await settleAt(adm, 22))!;
    await order(adm, { state: 'cancelled', cancelled: { by: { name: 'Dr Arun' }, reason: 'Fever again', at: at(23) } });

    assert.equal(await svc.tick(at(49)), 4, 'days 2 and 3: they start after the cancel');
    assert.equal(await svc.tick(at(49)), 0, 'nothing twice');
    assert.equal(await svc.chargeDue(String(adm._id), at(49)), 0);
    assert.equal(await svc.tick(at(72)), 2, 'day 4');
    const stay = await stayOf(adm);
    assert.equal(stay.length, 2, 'one continuation bill');
    const cont = stay[1] as any;
    assert.equal(String(cont.continuationOf), String(settled._id));
    assert.deepEqual(
      (await m.ChargeLine.find({ bill: cont._id, 'source.type': 'bed-day' }).sort({ 'source.ref': 1 }).lean()).map((l) => l.source.ref),
      [1, 2, 3].map((k) => `${adm._id}:${k}`),
    );
    assert.equal(cont.totals.charges, 3 * (1500 + 300));
    assert.equal(await m.ChargeLine.countDocuments({ 'source.type': 'bed-day' }), 4, 'each period once');
    assert.deepEqual(await m.Bill.findById(settled._id).lean(), settled, 'the settled bill is untouched');
    assert.equal(await m.ChargeLine.countDocuments({ bill: settled._id }), 2, 'it keeps its own day 1');

    // Leaving later: the final bill is asked for on the continuation bill, never the settled one.
    await m.Admission.updateOne({ _id: adm._id }, { $set: { status: 'discharged', dischargedAt: at(75) } });
    svc.clock = () => at(76);
    await deliver('bed.discharged', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id) });
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${cont._id}:final` }), 1);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${settled._id}:final` }), 0);
    assert.equal((await stayOf(adm)).length, 2);
  });

  test('a cancel inside the grace: a period starting between the settlement and the cancel stays uncharged', async () => {
    const adm = await admit();
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: '' });
    // Ordered at 20 h, settled at 23 h, cancelled at 25 h: the grace is [23 h, 25 h), and day 2 starts at 24 h.
    await order(adm, { state: 'cancelled', cancelled: { by: { name: 'Dr Arun' }, reason: 'Fever again', at: at(25) } });
    const settled = (await settleAt(adm, 23))!;
    assert.equal(await svc.tick(at(30)), 0, 'day 2 started inside the grace, before the cancel');
    assert.equal(await svc.tick(at(48)), 2, 'day 3 starts after the cancel');
    const stay = await stayOf(adm);
    assert.equal(stay.length, 2);
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': `${adm._id}:1` }), 0, 'day 2 is never charged');
    assert.equal(await m.ChargeLine.countDocuments({ bill: stay[1]._id, 'source.ref': `${adm._id}:2` }), 2);
    assert.deepEqual(await m.Bill.findById(settled._id).lean(), settled, 'the settled bill is untouched');
  });

  test('a settlement with no open discharge order has no grace: a period starting 1 h later is charged on a continuation bill', async () => {
    const p2 = await m.Patient.create({ uhid: 'MHK202600965', name: 'Lata', age: 40, gender: 'Female', phone: '9100000065' });
    const p3 = await m.Patient.create({ uhid: 'MHK202600966', name: 'Arul', age: 55, gender: 'Male', phone: '9100000066' });
    const none = await admit();
    const early = await admit({ patient: p2._id, patientUhid: p2.uhid, patientName: p2.name });
    const checkout = await admit({ patient: p3._id, patientUhid: p3.uhid, patientName: p3.name });
    for (const a of [none, early, checkout]) await bills.open({ kind: 'admission', patientId: String(a.patient), admissionId: String(a._id) });
    // `none` never had an order; `early`'s was cancelled before the settlement; `checkout`'s is open (the control).
    await order(early, { orderedAt: at(18), windowAt: at(18), state: 'cancelled', cancelled: { by: { name: 'Dr Arun' }, reason: 'Fever again', at: at(20) } });
    await order(checkout, {});
    // All three are settled at 23 h, an hour before day 2 starts.
    for (const a of [none, early, checkout]) await settleAt(a, 23);

    assert.equal(await svc.tick(at(25)), 4, 'day 2 of the two stays with no order open at settlement');
    for (const a of [none, early]) {
      const stay = await stayOf(a);
      assert.equal(stay.length, 2);
      assert.equal(await m.ChargeLine.countDocuments({ bill: stay[1]._id, 'source.ref': `${a._id}:1` }), 2);
    }
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': `${checkout._id}:1` }), 0, 'the checkout grace holds while the order is open');
    assert.equal((await stayOf(checkout)).length, 1);
  });
});
