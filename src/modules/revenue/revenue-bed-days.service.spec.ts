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
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    // The capture service registers the other handlers; the bed-day service registers its own three.
    new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    const settingsService = new SettingsService(m.HospitalSettings);
    const revenueSettings = new RevenueSettingsService(settingsService);
    const estimates = new RevenueEstimatesService(reg, revenueSettings, prices, m.Bill, m.Estimate, m.ProcedureBooking, m.Admission, m.Bed);
    const deposits = new RevenueDepositsService(messages, reg, new RulesService(registry, settingsService, new CoordinatorEvents()), revenueSettings, prices, bills, estimates, m.Bill, m.TaskAlertItem, m.ProcedureBooking, m.Admission, m.Bed, m.Ward, m.Case);
    svc = new RevenueBedDaysService(messages, prices, bills, reg, m.Admission, m.Bed, m.Case, m.Bill, m.ChargeLine, estimates, deposits);
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

  test('a settled bill takes no more days and nothing throws', async () => {
    const adm = await admit();
    const bill = await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(adm._id) });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { state: 'settled' } });
    assert.equal(await svc.chargeDue(String(adm._id), at(72)), 0);
    assert.equal(await svc.chargeDue('not-an-id'), 0);
    await deliver('bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', ward: '', admissionId: String(new Types.ObjectId()) });
    assert.equal(await m.ChargeLine.countDocuments({}), 0);
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
});
