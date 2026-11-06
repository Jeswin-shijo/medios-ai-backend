import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { AppointmentEvents } from '../appointments/appointment-events';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { LAB_MESSAGE_TYPES } from '../lab/lab-coordinator.registration';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PriceListService } from './price-list.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { FinalBillService } from './revenue-final.service';
import { RevenueOpdService } from './revenue-opd.service';
import { RevenueSettingsService } from './revenue-settings.service';
import { SettingsService } from '../settings/settings.service';

describe('RevenueOpdService', () => {
  const m = models();
  let events: AppointmentEvents;
  let svc: RevenueOpdService;
  let bills: RevenueBillsService;
  let messages: MessagesService;
  let registry: AgentRegistry;
  let reg: RevenueCoordinatorRegistration;
  let patient: any;
  let doctor: any;
  const today = () => isoDate(clinicNow());
  const lines = () => m.ChargeLine.find({}).sort({ _id: 1 }).lean();
  const appt = (extra: Record<string, unknown> = {}) =>
    m.Appointment.create({ uhid: patient.uhid, patientName: patient.name, age: 40, gender: 'Male', phone: '9100000061', time: '09:30 AM', date: today(), type: 'Consultation', condition: 'Fever', status: 'Checked In', doctorId: String(doctor._id), doctorName: doctor.name, ...extra });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    events = new AppointmentEvents();
    registry = new AgentRegistry();
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    const stub = (key: AgentKey, types: MessageTypeDef[]) => registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    stub('lab', LAB_MESSAGE_TYPES);
    reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    const revenueSettings = new RevenueSettingsService(new SettingsService(m.HospitalSettings));
    const final = new FinalBillService(messages, reg, revenueSettings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment, m.DischargeOrder);
    svc = new RevenueOpdService(events, prices, bills, m.Appointment, m.Patient, m.ChargeLine, final);
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600961', name: 'Asha Devi', age: 40, gender: 'Female', phone: '9100000061' });
    doctor = await m.OpDoctor.create({ name: 'Dr Arun', departmentCode: 'GEN', tokenPrefix: 'G', room: 'R1', fee: 300, active: true });
  });

  test('a queue check-in opens the OPD bill with the doctor\'s fee', async () => {
    const a = await appt();
    svc.onModuleInit();
    try {
      events.statusChanged({ id: String(a._id), status: 'Checked In' });
      for (let i = 0; i < 50 && !(await lines()).length; i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      svc.onModuleDestroy();
    }
    const l = await lines();
    assert.equal(l.length, 1);
    assert.equal(l[0].code, `opd:${doctor._id}`);
    assert.equal(l[0].unitPrice, 300);
    assert.equal(l[0].category, 'consultation');
    assert.deepEqual(l[0].source, { type: 'opd-fee', ref: String(a._id) });
    const bill = await m.Bill.findOne({}).lean();
    assert.equal(bill!.kind, 'opd');
    assert.equal(String(bill!.appointment), String(a._id));
    assert.equal(bill!.day, today());
    assert.equal(bill!.totals.charges, 300);
  });

  test('checking in twice (skip and back) charges once', async () => {
    const a = await appt();
    await svc.chargeFee(String(a._id));
    await svc.chargeFee(String(a._id));
    assert.equal((await lines()).length, 1);
    assert.equal(await m.Bill.countDocuments({}), 1);
    assert.equal((await m.Bill.findOne({}).lean())!.totals.charges, 300);
  });

  test('a replay opens no ghost bill when the fee line exists', async () => {
    const a = await appt();
    await svc.chargeFee(String(a._id));
    await m.Bill.updateMany({}, { $set: { state: 'settled' } });
    await svc.chargeFee(String(a._id));
    assert.equal(await m.Bill.countDocuments({}), 1);
    assert.equal((await lines()).length, 1);
  });

  test('a doctor with fee 0 gives a needs-price line', async () => {
    const free = await m.OpDoctor.create({ name: 'Dr Zero', departmentCode: 'GEN', tokenPrefix: 'Z', room: 'R1', fee: 0, active: true });
    const a = await appt({ doctorId: String(free._id), time: '10:00 AM' });
    await svc.chargeFee(String(a._id));
    const l = await lines();
    assert.equal(l.length, 1);
    assert.equal(l[0].unitPrice, 0);
    assert.equal(l[0].needsPrice, true);
    assert.equal(l[0].code, `opd:${free._id}`);
  });

  test('a missing doctor still charges 0 with needs-price, and an unknown patient charges nothing', async () => {
    const a = await appt({ doctorId: undefined, time: '10:30 AM' });
    await svc.chargeFee(String(a._id));
    const l = await lines();
    assert.equal(l[0].code, 'opd:unknown');
    assert.equal(l[0].needsPrice, true);
    const b = await appt({ uhid: 'NOPE', time: '11:00 AM' });
    await svc.chargeFee(String(b._id));
    await svc.chargeFee(String(new Types.ObjectId()));
    assert.equal((await lines()).length, 1);
    assert.equal(await m.Bill.countDocuments({}), 1);
  });

  test('catchUp charges a checked-in appointment that has no fee line', async () => {
    const a = await appt();
    const done = await appt({ status: 'Completed', time: '10:00 AM' });
    await appt({ status: 'Scheduled', time: '10:30 AM' });
    await appt({ status: 'Canceled', time: '11:00 AM' });
    await appt({ date: '2026-01-01', time: '11:30 AM' });
    await svc.chargeFee(String(done._id));
    const n = await svc.catchUp(today());
    assert.equal(n, 1);
    const l = await lines();
    assert.deepEqual(l.map((x) => x.source.ref).sort(), [String(a._id), String(done._id)].sort());
    assert.equal(await svc.catchUp(today()), 0);
  });

  test('an OPD lab test that day lands on the OPD bill', async () => {
    const a = await appt();
    await svc.chargeFee(String(a._id));
    await m.PriceItem.create({ code: 'lab:cbc', name: 'CBC', category: 'lab', price: 250, unit: 'each', active: true });
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    const r = await m.LabRequest.create({ number: 'LR-9001', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: new Types.ObjectId(), orderedBy: { id: 'u', name: 'Dr' }, priority: 'routine', orderedAt: new Date(), collectBy: new Date() });
    await m.LabLine.create({ request: r._id, test: 'cbc', status: 'ordered', tatDueAt: new Date() });
    const msg = await messages.send({ case: String(r.case), from: 'lab', to: ['coordinator'], type: 'lab.collected', priority: 'medium', summary: 'collected', payload: { requestId: String(r._id), sampleId: 's', sampleNumber: 'S-1', tube: 'edta', tests: ['cbc'] }, dedupeKey: 'opd-lab-1' });
    assert.equal(msg!.state, 'delivered');
    const bs = await m.Bill.find({}).lean();
    assert.equal(bs.length, 1, 'no second bill');
    assert.equal(bs[0].kind, 'opd');
    const l = await lines();
    assert.equal(l.length, 2);
    assert.equal(String(l[1].bill), String(bs[0]._id));
    assert.equal(l[1].source.type, 'lab');
    assert.equal(bs[0].totals.charges, 300 + l[1].amount);
  });
});
