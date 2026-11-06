import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { AppointmentEvents } from '../appointments/appointment-events';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { QueueEvents } from '../queue/queue-events';
import { SettingsService } from '../settings/settings.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PriceListService } from './price-list.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { FinalBillService } from './revenue-final.service';
import { KioskVisitInput, RevenueKioskService } from './revenue-kiosk.service';
import { RevenueOpdService } from './revenue-opd.service';
import { PaymentsService } from './revenue-payments.service';
import { RevenueSettingsService } from './revenue-settings.service';

describe('RevenueKioskService', () => {
  const m = models();
  let opd: RevenueOpdService;
  let svc: RevenueKioskService;
  let bills: RevenueBillsService;
  let patient: any;
  let doctor: any;
  const today = () => isoDate(clinicNow());
  const lines = () => m.ChargeLine.find({}).sort({ _id: 1 }).lean();
  const payments = () => m.Payment.find({}).sort({ _id: 1 }).lean();
  const visit = (extra: Partial<KioskVisitInput> = {}): KioskVisitInput => ({
    visitId: String(new Types.ObjectId()),
    uhid: patient.uhid,
    doctorId: String(doctor._id),
    doctorName: doctor.name,
    fee: 300,
    day: today(),
    reference: 'UPI · SAMPLE-UPI-ab12cd · SAMPLE',
    by: { id: 'k1', name: 'Kiosk: Front kiosk' },
    at: clinicNow(),
    ...extra,
  });
  const appt = (extra: Record<string, unknown> = {}) =>
    m.Appointment.create({ uhid: patient.uhid, patientName: patient.name, age: 40, gender: 'Female', phone: '9100000071', time: '09:30 AM', date: today(), type: 'Consultation', condition: 'Fever', status: 'Checked In', doctorId: String(doctor._id), doctorName: doctor.name, ...extra });

  before(async () => {
    await connectTestDb();
    Logger.overrideLogger(false);
  });
  after(async () => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const registry = new AgentRegistry();
    const messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    const reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    const settings = new RevenueSettingsService(new SettingsService(m.HospitalSettings));
    const final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment, m.DischargeOrder);
    const pay = new PaymentsService(reg, settings, bills, final, m.Payment);
    opd = new RevenueOpdService(new AppointmentEvents(), prices, bills, m.Appointment, m.Patient, m.ChargeLine, final);
    svc = new RevenueKioskService(opd, bills, pay, m.Patient, m.ChargeLine, m.Payment, final, new QueueEvents());
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600971', name: 'Leela Thomas', age: 40, gender: 'Female', phone: '9100000071' });
    doctor = await m.OpDoctor.create({ name: 'Dr Arun', departmentCode: 'GEN', tokenPrefix: 'G', room: 'R1', fee: 300, active: true });
  });

  test("a visit that checked in its appointment pays that appointment's own consultation, charged before the payment", async () => {
    const a = await appt();
    const input = visit({ appointmentId: String(a._id) });
    const record = await svc.record(input);

    const [line] = await lines();
    assert.equal((await lines()).length, 1);
    assert.deepEqual(line.source, { type: 'opd-fee', ref: String(a._id) });
    assert.equal(line.amount, 300);
    const [payment] = await payments();
    assert.equal((await payments()).length, 1);
    assert.equal(payment.mode, 'kiosk');
    assert.equal(payment.kind, 'settlement');
    assert.equal(payment.amount, 300);
    assert.equal(payment.source, `op-visit:${input.visitId}`);
    assert.equal(payment.reference, 'UPI · SAMPLE-UPI-ab12cd · SAMPLE');
    assert.deepEqual({ id: payment.by.id, name: payment.by.name }, { id: 'k1', name: 'Kiosk: Front kiosk' });
    assert.equal(String(payment.bill), String(line.bill));
    // The charge was made before the money landed (ids made in order), so the bill was never in credit.
    assert.ok(String(line._id) < String(payment._id));
    const bill = (await m.Bill.findById(line.bill).lean())!;
    assert.equal(bill.kind, 'opd');
    assert.equal(String(bill.appointment), String(a._id));
    assert.deepEqual([bill.totals.charges, bill.totals.payments, bill.totals.balance], [300, 300, 0]);
    assert.deepEqual(record, { billId: String(bill._id), billNumber: bill.number, receiptNumber: payment.receiptNumber });

    // The check-in hook arriving later finds the charge and adds nothing.
    await opd.chargeFee(String(a._id));
    assert.equal((await lines()).length, 1);
    assert.equal((await m.Bill.findById(line.bill).lean())!.totals.balance, 0);
  });

  test('a walk-in visit has its own consultation line on a walk-in bill', async () => {
    const input = visit({ fee: 450, doctorName: 'Dr B' });
    const record = await svc.record(input);
    const all = await lines();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].source, { type: 'op-visit', ref: input.visitId });
    assert.equal(all[0].code, `opd:${doctor._id}`);
    assert.equal(all[0].name, 'Consultation - Dr B');
    assert.equal(all[0].category, 'consultation');
    assert.deepEqual([all[0].qty, all[0].unitPrice, all[0].amount, all[0].needsPrice], [1, 450, 450, false]);
    const bill = (await m.Bill.findById(all[0].bill).lean())!;
    assert.equal(bill.kind, 'walk-in');
    assert.equal(bill.day, today());
    assert.deepEqual([bill.totals.charges, bill.totals.payments, bill.totals.balance], [450, 450, 0]);
    assert.equal(record.billNumber, bill.number);
    assert.match(record.receiptNumber!, /^RC-\d{4}$/);
  });

  test("a walk-in visit's consultation joins the patient's OPD bill for the day when there is one", async () => {
    const a = await appt();
    await opd.chargeFee(String(a._id));
    const opdBill = (await m.Bill.findOne({ kind: 'opd' }).lean())!;
    await svc.record(visit());
    assert.equal(await m.Bill.countDocuments({}), 1);
    assert.deepEqual((await lines()).map((l) => [String(l.bill), l.source.type]), [
      [String(opdBill._id), 'opd-fee'],
      [String(opdBill._id), 'op-visit'],
    ]);
    // The appointment's own fee is still due; the visit's consultation is paid.
    assert.equal((await m.Bill.findById(opdBill._id).lean())!.totals.balance, 300);
  });

  test('the bill of an earlier day: routing uses the day of the visit', async () => {
    const record = await svc.record(visit({ day: '2026-01-05' }));
    const bill = (await m.Bill.findById(record.billId).lean())!;
    assert.equal(bill.kind, 'walk-in');
    assert.equal(bill.day, '2026-01-05');
  });

  test('a replay, or several at once, record one consultation and one payment', async () => {
    const input = visit();
    const results = await Promise.all([svc.record(input), svc.record(input), svc.record(input)]);
    assert.equal((await lines()).length, 1);
    assert.equal((await payments()).length, 1);
    for (const r of results) assert.deepEqual(r, results[0]);
    assert.deepEqual(await svc.record(input), results[0]);
    assert.equal((await m.Bill.findById(results[0].billId).lean())!.totals.balance, 0);
  });

  test('a fee of 0 goes on as Needs price and takes no payment', async () => {
    const input = visit({ fee: 0 });
    const record = await svc.record(input);
    const [line] = await lines();
    assert.deepEqual([line.amount, line.needsPrice], [0, true]);
    assert.equal((await payments()).length, 0);
    assert.equal(record.receiptNumber, undefined);
    assert.equal(record.billId, String(line.bill));
    assert.deepEqual(await svc.record(input), record);
    assert.equal((await lines()).length, 1);
  });
});
