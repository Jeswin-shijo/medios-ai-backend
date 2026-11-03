import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueDepositsService } from './revenue-deposits.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueSettingsService } from './revenue-settings.service';

const H = 60 * 60 * 1000;
const T0 = new Date('2026-09-26T00:10:00.000Z');
const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DEPOSIT_OR_TOPUP = /^revenue-bill:[^:]+:(deposit|topup)$/;

describe('Estimates, deposits and top-ups', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let rules: RulesService;
  let bills: RevenueBillsService;
  let estimates: RevenueEstimatesService;
  let deposits: RevenueDepositsService;
  let bedDays: RevenueBedDaysService;
  let patient: any;
  let general: any;
  let icu: any;
  let bedA: any;
  let bedB: any;
  let caseDoc: any;
  let seq = 0;

  const stub = (key: AgentKey, types: MessageTypeDef[]) =>
    registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  const price = (code: string, p: number, category = 'nursing') => m.PriceItem.create({ code, name: code, category, price: p, unit: 'each', active: true });
  const admit = (extra: Record<string, unknown> = {}) =>
    m.Admission.create({
      patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: bedA._id, roomClass: 'general', expectedStayDays: 3,
      status: 'active', admittedAt: T0, admittedBy: 'Nurse', ...extra,
    });
  const deliver = async (from: AgentKey, type: string, payload: Record<string, unknown>, withCase = true) => {
    const msg = await messages.send({ case: withCase ? String(caseDoc._id) : null, from, to: ['coordinator'], type, priority: 'medium', summary: type, payload, dedupeKey: `t${++seq}` });
    assert.equal(msg!.state, 'delivered');
  };
  const assigned = (adm: any) => deliver('bed', 'bed.assigned', { bedId: String(bedA._id), bedLabel: 'GA-01', admissionId: String(adm._id), ward: 'General Ward A' });
  const booking = (priority: 'stat' | 'urgent' | 'routine', procedure = 'coronary-angiography', status = 'booked') =>
    m.ProcedureBooking.create({
      number: `PR-${++seq}`, patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseDoc._id, procedure, priority, status,
      requestedBy: { id: 'd1', name: 'Doctor' }, earliest: T0, start: T0,
    });
  const booked = (b: any) =>
    deliver('scheduling', 'scheduling.procedure-booked', { bookingId: String(b._id), number: b.number, procedure: b.procedure, priority: b.priority, status: 'booked', room: 'cath-1', start: T0, contrast: true });
  const tasks = () => m.TaskAlertItem.find({ link: { $regex: DEPOSIT_OR_TOPUP } }).lean();
  const sent = (type: string) => m.AgentMessage.find({ type }).lean();
  /** The totals listener is not awaited by the bills service, so wait for the effect. */
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail('timed out waiting for the totals listener');
  };
  const quiet = () => new Promise((r) => setTimeout(r, 150));

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    stub('er', ER_MESSAGE_TYPES);
    stub('bed', BED_MESSAGE_TYPES);
    stub('scheduling', SCHEDULING_MESSAGE_TYPES);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const settingsService = new SettingsService(m.HospitalSettings);
    rules = new RulesService(registry, settingsService, events);
    const reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    const revenueSettings = new RevenueSettingsService(settingsService);
    new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    estimates = new RevenueEstimatesService(reg, revenueSettings, prices, m.Bill, m.Estimate, m.ProcedureBooking, m.Admission, m.Bed);
    deposits = new RevenueDepositsService(messages, reg, rules, revenueSettings, prices, bills, estimates, m.Bill, m.TaskAlertItem, m.ProcedureBooking, m.Admission, m.Bed, m.Ward, m.Case);
    bedDays = new RevenueBedDaysService(messages, prices, bills, reg, m.Admission, m.Bed, m.Case, m.Bill, m.ChargeLine, estimates, deposits, new FinalBillService(messages, reg, revenueSettings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment));
    bedDays.clock = () => T0;
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600971', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000071' });
    general = await m.Ward.create({ code: 'GA', name: 'General Ward A', shortName: 'Ward A', floor: 1, type: 'general', gender: 'any', ratePerDay: 1500 });
    icu = await m.Ward.create({ code: 'ICU', name: 'ICU', shortName: 'ICU', floor: 2, type: 'icu', gender: 'any', ratePerDay: 6000 });
    bedA = await m.Bed.create({ ward: general._id, label: 'GA-01', number: 1 });
    bedB = await m.Bed.create({ ward: icu._id, label: 'ICU-01', number: 1 });
    caseDoc = await m.Case.create({ number: 'CASE-0001', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, kind: 'ipd', priority: 'medium', openedAt: T0, openedBy: 'bed' });
    await price('nursing:general', 300);
    await price('nursing:critical', 900);
    await price('proc:coronary-angiography', 40000, 'procedure');
  });

  test('an ER bill never gets a deposit or top-up task, message or clock, even with charges', async () => {
    const er = await bills.open({ kind: 'er', patientId: String(patient._id), caseId: String(caseDoc._id), erVisitId: String(new Types.ObjectId()) });
    await bills.adjust(String(er._id), { payments: 1000 });
    await bills.adjust(String(er._id), { charges: 250000 });
    await booked(await booking('routine'));
    await quiet();
    assert.equal(await deposits.dueFor((await m.Bill.findById(er._id))!), null);
    assert.equal(await deposits.raise(String(er._id)), null);
    assert.equal(await deposits.checkTopUp(String(er._id)), null);
    assert.equal((await tasks()).length, 0, 'no task');
    assert.equal((await sent('revenue.deposit-due')).length + (await sent('revenue.topup-due')).length, 0, 'no message');
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-topup' }), 0, 'no clock');
    assert.ok(await estimates.get(String(er._id)), 'an estimate for the booked procedure is fine');
  });

  test('a STAT procedure booked in the ER asks for nothing', async () => {
    const er = await bills.open({ kind: 'er', patientId: String(patient._id), caseId: String(caseDoc._id), erVisitId: String(new Types.ObjectId()) });
    await booked(await booking('stat'));
    assert.equal((await tasks()).length, 0);
    assert.equal((await sent('revenue.deposit-due')).length, 0);
    // The estimate is a price guide, so it includes the STAT package; the deposit never does.
    assert.equal((await estimates.get(String(er._id)))!.total, 40000);
    // On an outpatient bill a STAT package asks for nothing either.
    const opd = await bills.open({ kind: 'walk-in', patientId: String(patient._id), day: '2026-09-26' });
    assert.equal(await deposits.dueFor((await m.Bill.findById(opd._id))!), null);
  });

  test('bed.assigned from the ER drafts the estimate and raises the deposit task with "after the doctor has explained the plan"', async () => {
    await m.Case.updateOne({ _id: caseDoc._id }, { $set: { kind: 'er' } });
    const adm = await admit();
    const er = await bills.open({ kind: 'er', patientId: String(patient._id), caseId: String(caseDoc._id), erVisitId: String(new Types.ObjectId()) });
    await assigned(adm);
    const bill = (await m.Bill.findById(er._id).lean())!;
    assert.equal(bill.kind, 'admission');
    const [task] = await tasks();
    assert.equal(task.link, `revenue-bill:${er._id}:deposit`);
    assert.equal(task.title, `Collect advance ₹10,000: ${bill.number}`);
    assert.equal(task.subtitle, 'General Ward A · after the doctor has explained the plan');
    assert.equal(task.status, 'Pending');
    const est = (await estimates.get(String(er._id)))!;
    // 3 days x (1500 bed + 300 nursing) + 3 x 1500 allowance
    assert.deepEqual([est.total, est.low, est.high, est.days], [9900, 8910, 11880, 3]);
    const msgs = await sent('revenue.deposit-due');
    assert.equal(msgs.length, 1);
    assert.deepEqual([msgs[0].payload.amount, msgs[0].payload.billNumber], [10000, bill.number]);
    const ready = await sent('revenue.estimate-ready');
    assert.deepEqual([ready.length, ready[0].payload.low, ready[0].payload.high], [1, 8910, 11880]);
    // A replay opens nothing new.
    await assigned(adm);
    assert.equal((await tasks()).length, 1);
    assert.equal(await m.Estimate.countDocuments({}), 1);
    assert.equal((await sent('revenue.deposit-due')).length, 1);
  });

  test('an admission that did not come from the ER has the plain ward subtitle', async () => {
    await assigned(await admit());
    assert.equal((await tasks())[0].subtitle, 'General Ward A');
  });

  test('a routine procedure booking adds its package to the estimate and the deposit, once', async () => {
    await assigned(await admit());
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    const b = await booking('routine');
    await booked(b);
    await booked(b);
    assert.equal((await estimates.get(String(bill._id)))!.total, 9900 + 40000);
    assert.deepEqual((await estimates.get(String(bill._id)))!.bookings, [String(b._id)]);
    const [task] = await tasks();
    assert.equal(task.title, `Collect advance ₹50,000: ${bill.number}`);
    assert.equal(task.subtitle, 'General Ward A');
    assert.equal(await m.Estimate.countDocuments({}), 1);
    // A cancelled booking drops out on the next draft.
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'cancelled' } });
    assert.equal((await estimates.draft(String(bill._id)))!.total, 9900);
    // A STAT booking is in the estimate but never in the deposit.
    await booked(await booking("stat", "chest-xray"));
    assert.equal((await tasks())[0].title, `Collect advance ₹10,000: ${bill.number}`.replace('₹10,000', '₹10,000'));
  });

  test('at 80% use a top-up task, message and clock start; a payment that restores the margin completes it and stops the clock', async () => {
    await assigned(await admit());
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    const id = String(bill._id);
    await bills.adjust(id, { payments: 10000 }); // meets the deposit
    await until(async () => (await m.TaskAlertItem.findOne({ link: `revenue-bill:${id}:deposit` }).lean())!.status === 'Completed');
    await bills.adjust(id, { charges: 6000 }); // 1,800 + 6,000 = 7,800: below 80% of 10,000
    await quiet();
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${id}:topup` }), 0);
    await bills.adjust(id, { charges: 200 }); // 8,000
    await until(async () => (await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${id}:topup` })) === 1);
    const task = (await m.TaskAlertItem.findOne({ link: `revenue-bill:${id}:topup` }).lean())!;
    assert.equal(task.title, `Ask for a top-up ₹10,000: ${bill.number}`);
    assert.deepEqual([task.type, task.category, task.priority, task.status], ['System', 'System', 'Medium', 'Pending']);
    const due = await sent('revenue.topup-due');
    assert.equal(due.length, 1);
    const dueAt = new Date(due[0].payload.dueAt as string).getTime();
    assert.ok(Math.abs(dueAt - (Date.now() + 240 * 60_000)) < 60_000, 'real now + 240 minutes');
    assert.equal(due[0].payload.amount, 10000);
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-topup', state: 'running', ref: id }), 1);
    // More charges do not raise it twice.
    await bills.adjust(id, { charges: 500 });
    await quiet();
    assert.equal((await sent('revenue.topup-due')).length, 1);
    // A payment that restores the margin.
    await bills.adjust(id, { payments: 10000 });
    await until(async () => (await m.TaskAlertItem.findOne({ link: `revenue-bill:${id}:topup` }).lean())!.status === 'Completed');
    await until(async () => (await sent('revenue.topup-met')).length === 1);
    await until(async () => (await m.Clock.countDocuments({ def: 'revenue-topup', state: 'running' })) === 0);
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-topup', state: 'running' }), 0);
  });

  test('a top-up asks for the shortfall plus the ward deposit when charges already exceed payments', async () => {
    await assigned(await admit());
    const id = String((await m.Bill.findOne({ kind: 'admission' }).lean())!._id);
    await bills.adjust(id, { payments: 10000 });
    await until(async () => (await m.TaskAlertItem.findOne({ link: `revenue-bill:${id}:deposit` }).lean())!.status === 'Completed');
    await bills.adjust(id, { charges: 11200 }); // 1,800 + 11,200 = 13,000
    await until(async () => (await sent('revenue.topup-due')).length === 1);
    const task = (await m.TaskAlertItem.findOne({ link: `revenue-bill:${id}:topup` }).lean())!;
    assert.match(task.title, /^Ask for a top-up ₹13,000: /);
    assert.equal((await sent('revenue.topup-due'))[0].payload.amount, 13000);
  });

  test('with the reminder rule off no deposit or top-up task is raised', async () => {
    await rules.set(ADMIN, 'revenue-deposit-reminders', false);
    await assigned(await admit());
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    await booked(await booking('routine'));
    await bills.adjust(String(bill._id), { payments: 1000 });
    await bills.adjust(String(bill._id), { charges: 50000 });
    await quiet();
    assert.equal((await tasks()).length, 0);
    assert.equal((await sent('revenue.deposit-due')).length + (await sent('revenue.topup-due')).length, 0);
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-topup' }), 0);
    assert.ok(await estimates.get(String(bill._id)), 'the estimate is still drafted');
  });

  test('a transfer to ICU rewrites an open deposit task with the new group amount; a met deposit is not asked again', async () => {
    const adm = await admit();
    await assigned(adm);
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    await m.Admission.updateOne({ _id: adm._id }, { $set: { bed: bedB._id, transfers: [{ fromBed: bedA._id, toBed: bedB._id, at: new Date(T0.getTime() + 2 * H), by: 'Nurse' }] } });
    await deliver('bed', 'bed.transferred', { admissionId: String(adm._id), bedId: String(bedB._id), bedLabel: 'ICU-01', fromBedLabel: 'GA-01', ward: 'ICU' });
    assert.equal((await m.Bill.findById(bill._id).lean())!.wardType, 'icu');
    const [task] = await tasks();
    assert.equal(task.title, `Collect advance ₹50,000: ${bill.number}`);
    assert.equal(task.subtitle, 'ICU');
    assert.equal((await estimates.get(String(bill._id)))!.days, 3);
    // Pay the new deposit, then move back: nothing is asked again.
    await bills.adjust(String(bill._id), { payments: 50000 });
    await until(async () => (await m.TaskAlertItem.findOne({ link: `revenue-bill:${bill._id}:deposit` }).lean())!.status === 'Completed');
    await deliver('bed', 'bed.transferred', { admissionId: String(adm._id), bedId: String(bedB._id), bedLabel: 'ICU-01', fromBedLabel: 'ICU-01', ward: 'ICU' });
    assert.equal((await tasks())[0].status, 'Completed');
  });

  test('a priced STAT procedure on an admission is in the estimate but never in the deposit', async () => {
    await assigned(await admit());
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    await booked(await booking('stat'));
    assert.equal((await estimates.get(String(bill._id)))!.total, 9900 + 40000, 'the estimate is a price guide');
    const [task] = await tasks();
    assert.equal(task.title, `Collect advance ₹10,000: ${bill.number}`, 'no package in the deposit');
    assert.equal((await deposits.dueFor((await m.Bill.findById(bill._id))!))!.amount, 10000);
  });

  test('on an outpatient bill a routine booking asks for its package and a STAT one adds nothing', async () => {
    const opd = await bills.open({ kind: 'opd', appointmentId: String(new Types.ObjectId()), patientId: String(patient._id), caseId: String(caseDoc._id), day: isoDate(clinicNow()) });
    await booked(await booking('routine'));
    const [task] = await tasks();
    assert.equal(task.link, `revenue-bill:${opd._id}:deposit`, 'the booking reached this bill');
    assert.equal(task.title, `Collect advance ₹40,000: ${opd.number}`);
    await price('proc:ct-head', 7000, 'procedure');
    await booked(await booking('stat', 'ct-head'));
    assert.equal((await tasks()).length, 1);
    assert.equal((await tasks())[0].title, `Collect advance ₹40,000: ${opd.number}`);
    assert.equal((await deposits.dueFor((await m.Bill.findById(opd._id))!))!.amount, 40000);
  });

  test('a STAT booking for a patient with no active bill opens nothing', async () => {
    await booked(await booking('stat'));
    assert.equal(await m.Bill.countDocuments({}), 0);
    assert.equal(await m.Estimate.countDocuments({}), 0);
    assert.equal((await tasks()).length, 0);
  });

  test('a second dip after a met top-up raises the task again and starts a new clock', async () => {
    await assigned(await admit());
    const id = String((await m.Bill.findOne({ kind: 'admission' }).lean())!._id);
    const link = `revenue-bill:${id}:topup`;
    await bills.adjust(id, { payments: 10000 });
    await until(async () => (await m.TaskAlertItem.findOne({ link: `revenue-bill:${id}:deposit` }).lean())!.status === 'Completed');
    await bills.adjust(id, { charges: 6200 }); // 8,000 of 10,000
    await until(async () => (await sent('revenue.topup-due')).length === 1);
    await bills.adjust(id, { payments: 10000 });
    await until(async () => (await sent('revenue.topup-met')).length === 1);
    await until(async () => (await m.Clock.countDocuments({ def: 'revenue-topup', state: 'running' })) === 0);
    await bills.adjust(id, { charges: 9000 }); // 17,000 of 20,000
    await until(async () => (await sent('revenue.topup-due')).length === 2);
    assert.equal(await m.TaskAlertItem.countDocuments({ link }), 1, 'same link, no duplicate');
    assert.equal((await m.TaskAlertItem.findOne({ link }).lean())!.status, 'Pending');
    await until(async () => (await m.Clock.countDocuments({ def: 'revenue-topup', state: 'running', ref: id })) === 1);
  });

  test('a routine booking after the deposit was met reopens the same task with the new amount', async () => {
    await assigned(await admit());
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    const link = `revenue-bill:${bill._id}:deposit`;
    await bills.adjust(String(bill._id), { payments: 10000 });
    await until(async () => (await m.TaskAlertItem.findOne({ link }).lean())!.status === 'Completed');
    const taskId = String((await m.TaskAlertItem.findOne({ link }).lean())!._id);
    await booked(await booking('routine'));
    const task = (await m.TaskAlertItem.findOne({ link }).lean())!;
    assert.equal(String(task._id), taskId);
    assert.equal(task.status, 'Pending');
    assert.equal(task.title, `Collect advance ₹40,000: ${bill.number}`);
    assert.equal(await m.TaskAlertItem.countDocuments({ link }), 1);
    assert.equal((await sent('revenue.deposit-due')).length, 2);
  });

  test('the desk can edit the days and add lines; a redraft keeps them; others cannot edit', async () => {
    await assigned(await admit());
    const bill = (await m.Bill.findOne({ kind: 'admission' }).lean())!;
    const est = (await estimates.get(String(bill._id)))!;
    await assert.rejects(estimates.edit({ id: 'n1', name: 'Nurse', role: UserRole.NURSE }, String(est._id), { days: 5 }));
    const out = await estimates.edit(ADMIN, String(est._id), { days: 5, extra: [{ name: 'Oxygen', amount: 2000 }] });
    assert.equal(out.total, 5 * 1800 + 5 * 1500 + 2000);
    assert.deepEqual([out.low, out.high], [Math.round(out.total * 0.9), Math.round(out.total * 1.2)]);
    const again = (await estimates.draft(String(bill._id)))!;
    assert.deepEqual([again.days, again.total], [5, out.total]);
  });
});
