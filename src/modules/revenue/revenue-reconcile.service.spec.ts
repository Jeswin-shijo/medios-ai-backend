import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { ApprovalsService } from '../coordinator/approvals.service';
import { AgentRegistry } from '../coordinator/agent-registry';
import { ClocksService } from '../coordinator/clocks.service';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { CorrectionsService } from './revenue-corrections.service';
import { RevenueDepositsService } from './revenue-deposits.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueOpdService } from './revenue-opd.service';
import { PaymentsService } from './revenue-payments.service';
import { RevenueReconcileService } from './revenue-reconcile.service';
import { RefundsService } from './revenue-refunds.service';
import { RevenueSettingsService } from './revenue-settings.service';

const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const BY = { id: 'd1', name: 'Doctor' };

describe('RevenueReconcileService', () => {
  const m = models();
  let messages: MessagesService;
  let reg: RevenueCoordinatorRegistration;
  let bills: RevenueBillsService;
  let final: FinalBillService;
  let payments: PaymentsService;
  let deposits: RevenueDepositsService;
  let capture: RevenueCaptureService;
  let corrections: CorrectionsService;
  let reconcile: RevenueReconcileService;
  let approvals: ApprovalsService;
  let patient: any;
  let caseId: string;

  const sent = (type: string) => m.AgentMessage.find({ type }).lean();
  /** Moves a record's updatedAt back so the pass no longer treats it as in flight (the grace is 30 s). */
  const age = (model: any, id: unknown, createdAt = false) =>
    model.collection.updateOne({ _id: id }, { $set: { updatedAt: new Date(Date.now() - 120_000), ...(createdAt ? { createdAt: new Date(Date.now() - 120_000) } : {}) } });
  /** Makes one message type fail to send until the returned function restores it. */
  const failing = (type: string) => {
    const original = messages.send.bind(messages);
    (messages as any).send = async (input: any) => {
      if (input.type === type) throw new Error('bus down');
      return original(input);
    };
    return () => {
      (messages as any).send = original;
    };
  };
  const erBill = async (charges = 1000) => {
    const b = await bills.open({ kind: 'er', patientId: String(patient._id), caseId, erVisitId: String(new Types.ObjectId()) });
    // A real line: reconcile rewrites totals from the lines, so a bare adjust would be healed away.
    if (charges) await bills.addCharge(String(b._id), { code: 'x', name: 'Charge', category: 'other', qty: 1, unitPrice: charges, source: { type: 'manual', ref: String(new Types.ObjectId()) }, by: { name: 'Desk' } });
    return b;
  };
  const fresh = (id: unknown) => m.Bill.findById(id).lean();

  before(async () => {
    await connectTestDb();
    // The deliberate faults in these tests log warnings; keep the output clean.
    Logger.overrideLogger(false);
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    const stub = (key: AgentKey, types: MessageTypeDef[]) => registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    stub('er', ER_MESSAGE_TYPES);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, events);
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new RevenueSettingsService(settingsService);
    const rules = new RulesService(registry, settingsService, events);
    reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    capture = new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment, m.OpVisit, m.QueueToken);
    payments = new PaymentsService(reg, settings, bills, final, m.Payment);
    const opd = new RevenueOpdService(new AppointmentEvents(), prices, bills, m.Appointment, m.Patient, m.ChargeLine, final);
    const estimates = new RevenueEstimatesService(reg, settings, prices, m.Bill, m.Estimate, m.ProcedureBooking, m.Admission, m.Bed);
    deposits = new RevenueDepositsService(messages, reg, rules, settings, prices, bills, estimates, m.Bill, m.TaskAlertItem, m.ProcedureBooking, m.Admission, m.Bed, m.Ward, m.Case);
    const bedDays = new RevenueBedDaysService(messages, prices, bills, reg, m.Admission, m.Bed, m.Case, m.Bill, m.ChargeLine, estimates, deposits, final);
    const refunds = new RefundsService(reg, settings, bills, approvals, final, m.Refund, m.TaskAlertItem);
    corrections = new CorrectionsService(reg, bills, approvals, final, prices, capture, m.Correction, m.ChargeLine);
    reconcile = new RevenueReconcileService(
      reg, bills, final, payments, estimates, deposits, refunds, capture, bedDays, opd,
      m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.TaskAlertItem, m.Clock,
      m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.Admission,
    );
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600995', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000095' });
    caseId = String(new Types.ObjectId());
    // R32: the Revenue Agent first ran long ago, so the 7-day window is the lower bound unless a test says otherwise.
    await m.CoordinatorCounter.create({ key: 'revenue-start', last: Date.now() - 30 * 86_400_000 });
    await m.PriceItem.create({ code: 'med:para500', name: 'Paracetamol 500 mg', category: 'pharmacy', price: 4, unit: 'each', active: true });
  });

  test('a pharmacy line issued while the agent was down is charged once by reconcile', async () => {
    const order = await m.PharmacyOrder.create({ number: 'PO-1', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: new Types.ObjectId(caseId), setting: 'ER', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    const line = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued', issued: { quantity: 3 } as any });
    await reconcile.reconcile();
    assert.equal(await m.ChargeLine.countDocuments({}), 0, 'a line younger than 30 seconds is left alone');
    await age(m.PharmacyLine, line._id);
    const first = await reconcile.reconcile();
    await reconcile.reconcile();
    const lines = await m.ChargeLine.find({}).lean();
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].source.type, lines[0].source.ref, lines[0].qty, lines[0].amount], ['pharmacy.issued', String(line._id), 3, 12]);
    assert.equal(first.charges, 1);
  });

  test('a deposit task deleted by mistake is re-raised; a completed one is not reopened', async () => {
    const adm = new Types.ObjectId();
    const bill = await bills.open({ kind: 'admission', patientId: String(patient._id), caseId, admissionId: String(adm) });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { wardType: 'general' } });
    const link = `revenue-bill:${bill._id}:deposit`;
    assert.equal(await deposits.raise(String(bill._id)), 10000);
    await m.TaskAlertItem.deleteOne({ link });
    await age(m.Bill, bill._id);
    const first = await reconcile.reconcile();
    const task = (await m.TaskAlertItem.findOne({ link }).lean())!;
    assert.equal(task.status, 'Pending');
    assert.equal(task.title, `Collect advance ₹10,000: ${bill.number}`);
    assert.equal(first.tasks, 1);
    await m.TaskAlertItem.updateOne({ link }, { $set: { status: 'Completed' } });
    // R33: the first pass touched the bill, so age it again; ensureDepositTask must really run, and must leave the task alone.
    await age(m.Bill, bill._id);
    let calls = 0;
    const original = deposits.ensureDepositTask.bind(deposits);
    deposits.ensureDepositTask = async (id: string) => {
      calls++;
      return original(id);
    };
    const second = await reconcile.reconcile();
    assert.equal(calls, 1, 'the second pass looked at the bill');
    assert.equal(second.tasks, 0);
    assert.equal((await m.TaskAlertItem.findOne({ link }).lean())!.status, 'Completed');
    assert.equal(await m.TaskAlertItem.countDocuments({ link }), 1);
  });

  test('a bill-final message that failed to send is re-sent once', async () => {
    const bill = await erBill(1000);
    const restore = failing('revenue.bill-final');
    await final.prepare(DESK, String(bill._id));
    restore();
    assert.equal((await sent('revenue.bill-final')).length, 0);
    assert.equal((await fresh(bill._id))!.announcedAt, undefined);
    await reconcile.reconcile();
    assert.equal((await sent('revenue.bill-final')).length, 0, 'a bill younger than 30 seconds is left alone');
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    const msgs = await sent('revenue.bill-final');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].payload.balance, 1000);
    assert.ok((await fresh(bill._id))!.announcedAt);
  });

  test('a bill-settled message that failed to send is re-sent once', async () => {
    const bill = await erBill(1000);
    const id = String(bill._id);
    await payments.record(DESK, id, { amount: 1000, mode: 'cash', kind: 'settlement' });
    await final.prepare(DESK, id);
    const restore = failing('revenue.bill-settled');
    const settled = await final.settle(DESK, id);
    restore();
    assert.equal(settled.state, 'settled');
    assert.equal((await sent('revenue.bill-settled')).length, 0);
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    assert.equal((await sent('revenue.bill-settled')).length, 1);
    assert.ok((await fresh(bill._id))!.announcedAt);
  });

  test('a deposit ask whose message failed to send is re-sent once', async () => {
    const bill = await bills.open({ kind: 'admission', patientId: String(patient._id), caseId, admissionId: String(new Types.ObjectId()) });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { wardType: 'general' } });
    const restore = failing('revenue.deposit-due');
    await assert.rejects(deposits.raise(String(bill._id)), /bus down/);
    restore();
    assert.equal((await sent('revenue.deposit-due')).length, 0);
    assert.ok(await m.TaskAlertItem.exists({ link: `revenue-bill:${bill._id}:deposit` }), 'the task was written before the send');
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    const msgs = await sent('revenue.deposit-due');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].payload.amount, 10000);
    assert.ok((await fresh(bill._id))!.depositAsk?.announcedAt);
  });

  test('totals are healed when a line was written but its total was not', async () => {
    const bill = await erBill(1000);
    const id = String(bill._id);
    await payments.record(DESK, id, { amount: 300, mode: 'cash', kind: 'part' });
    // The crash: a line landed, the totals never moved.
    await m.ChargeLine.create({ bill: bill._id, code: 'x', name: 'Dressing', category: 'consumables', qty: 1, unitPrice: 500, amount: 500, source: { type: 'manual', ref: 'lost-total' }, chargedAt: new Date(), by: { id: '', name: 'Desk' } });
    await m.ChargeLine.collection.updateMany({ bill: bill._id }, { $set: { createdAt: new Date(Date.now() - 120_000), updatedAt: new Date(Date.now() - 120_000) } });
    await m.Payment.collection.updateMany({ bill: bill._id }, { $set: { updatedAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 120_000) } });
    await age(m.Bill, bill._id);
    const r = await reconcile.reconcile();
    const totals = (await fresh(bill._id))!.totals;
    assert.deepEqual([totals.charges, totals.discounts, totals.payments, totals.refunds, totals.balance], [1500, 0, 300, 0, 1200]);
    assert.equal(r.totals, 1);
    await age(m.Bill, bill._id);
    assert.equal((await reconcile.reconcile()).totals, 0, 'a second pass finds nothing to heal');
  });

  test('totals of a bill with an applied reversal are left alone, and a bill with a correction in flight is skipped', async () => {
    const bill = await erBill(0);
    const line = await m.ChargeLine.create({ bill: bill._id, code: 'lab:cbc', name: 'CBC', category: 'lab', qty: 1, unitPrice: 1000, amount: 1000, source: { type: 'lab', ref: 'r:cbc' }, chargedAt: new Date(), by: { id: '', name: 'T' }, reversed: true });
    const done = await m.Correction.create({ bill: bill._id, line: line._id, kind: 'reversal', reason: 'x', requestedBy: BY, state: 'approved', appliedAt: new Date(), delta: -1000 });
    // R26: the reversal credit, and the cancelled discount of 200 that went with it.
    await m.ChargeLine.create({ bill: bill._id, code: 'correction:reversal', name: 'Reversal', category: 'lab', qty: 1, unitPrice: -1000, amount: -1000, source: { type: 'correction', ref: String(done._id) }, chargedAt: new Date(), by: BY });
    await m.ChargeLine.create({ bill: bill._id, code: 'correction:reversal', name: 'Discount', category: 'discount', qty: 1, unitPrice: -200, amount: -200, source: { type: 'correction', ref: 'earlier-discount' }, chargedAt: new Date(), by: BY });
    await m.ChargeLine.create({ bill: bill._id, code: 'correction:reversal', name: 'Discount cancelled', category: 'discount', qty: 1, unitPrice: 200, amount: 200, source: { type: 'correction', ref: `${done._id}:discount` }, chargedAt: new Date(), by: BY });
    const earlier = await m.Correction.create({ bill: bill._id, kind: 'discount', reason: 'x', requestedBy: BY, state: 'approved', appliedAt: new Date(), amount: 200, delta: -200 });
    await m.ChargeLine.updateOne({ 'source.ref': 'earlier-discount' }, { $set: { 'source.ref': String(earlier._id) } });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { 'totals.charges': 0, 'totals.discounts': 0, 'totals.balance': 0 } });
    await m.ChargeLine.collection.updateMany({ bill: bill._id }, { $set: { createdAt: new Date(Date.now() - 120_000), updatedAt: new Date(Date.now() - 120_000) } });
    await age(m.Bill, bill._id);
    assert.equal((await reconcile.reconcile()).totals, 0);
    assert.equal((await fresh(bill._id))!.totals.balance, 0);

    // A correction approved but not yet applied holds the bill: its lines may or may not have reached the totals.
    await m.Correction.create({ bill: bill._id, kind: 'discount', reason: 'x', requestedBy: BY, state: 'approved', amount: 50 });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { 'totals.charges': 77, 'totals.balance': 77 } });
    await reconcile.reconcile();
    assert.equal((await fresh(bill._id))!.totals.charges, 77);
  });

  test('a void refund whose message failed to send gets it again, which stops its clock', async () => {
    const bill = await erBill(0);
    const refund = await m.Refund.create({ number: 'RF-0001', bill: bill._id, amount: 500, state: 'void', waiting: false, voidReason: 'Nothing left to refund' });
    await reg.send('revenue.refund-due', bill, { refundId: String(refund._id), refundNumber: 'RF-0001', billNumber: bill.number, amount: 500, dueAt: new Date(Date.now() + 3_600_000) }, { text: 'Refund RF-0001 to pay', dedupeKey: `refund-due:${refund._id}` });
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-refund', state: 'running' }), 1);
    await age(m.Refund, refund._id);
    await reconcile.reconcile();
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-refund', state: 'running' }), 0);
    assert.equal((await sent('revenue.refund-void')).length, 1);
    assert.ok((await m.Refund.findById(refund._id).lean())!.announcedAt);
    await age(m.Refund, refund._id);
    await reconcile.reconcile();
    assert.equal((await sent('revenue.refund-void')).length, 1);
  });

  test('a running refund clock whose refund was rejected or is gone is stopped', async () => {
    const bill = await erBill(0);
    const rejected = await m.Refund.create({ number: 'RF-0002', bill: bill._id, amount: 500, state: 'rejected', waiting: false });
    const gone = new Types.ObjectId();
    for (const [id, number] of [[rejected._id, 'RF-0002'], [gone, 'RF-0003']] as const) {
      await reg.send('revenue.refund-due', bill, { refundId: String(id), refundNumber: number, billNumber: bill.number, amount: 500, dueAt: new Date(Date.now() + 3_600_000) }, { text: `Refund ${number} to pay`, dedupeKey: `refund-due:${id}` });
    }
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-refund', state: 'running' }), 2);
    await m.Clock.collection.updateMany({ def: 'revenue-refund' }, { $set: { startedAt: new Date(Date.now() - 120_000) } });
    await reconcile.reconcile();
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-refund', state: 'running' }), 0);
    assert.equal((await sent('revenue.refund-void')).length, 2);
  });

  test('a suggested reversal lost to a pending desk correction is suggested again once the line is free', async () => {
    const bill = await erBill(0);
    const request = await m.LabRequest.create({ number: 'LR-0001', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: new Types.ObjectId(caseId), orderedBy: BY, priority: 'routine', orderedAt: new Date(), collectBy: new Date() });
    await m.LabLine.create({ request: request._id, test: 'cbc', status: 'cancelled', tatDueAt: new Date() });
    const { line } = await bills.addCharge(String(bill._id), { code: 'lab:cbc', name: 'CBC', category: 'lab', qty: 1, unitPrice: 400, source: { type: 'lab', ref: `${request._id}:cbc` }, by: { name: 'Revenue Agent' } });
    // The real drop path: the desk's correction is pending when lab.cancelled arrives, so the agent's suggestion is refused.
    const desk = await corrections.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'change', qty: 2, reason: 'Two vials' });
    await capture.replay('lab.cancelled', { case: caseId, payload: { requestId: String(request._id), test: 'cbc' } });
    assert.equal(await m.Correction.countDocuments({ line: line._id, kind: 'reversal' }), 0, 'the suggestion was dropped');
    await age(m.Bill, bill._id);
    assert.equal((await reconcile.reconcile()).reversals, 0, 'while the desk correction is pending nothing is suggested');
    await approvals.act(ADMIN, String(desk!.approvalId), 'rejected');
    await m.Correction.collection.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 120_000) } });
    await m.LabLine.collection.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 120_000) } });
    await age(m.Bill, bill._id);
    const first = await reconcile.reconcile();
    const suggested = await m.Correction.find({ line: line._id, kind: 'reversal', suggested: true }).lean();
    assert.equal(suggested.length, 1);
    assert.equal(suggested[0].state, 'pending');
    assert.equal(first.reversals, 1);
    await age(m.Bill, bill._id);
    assert.equal((await reconcile.reconcile()).reversals, 0);
    assert.equal(await m.Correction.countDocuments({ line: line._id, kind: 'reversal', suggested: true }), 1, 'once per line');
  });

  test('R29: a failed final-requested send is re-sent by reconcile and its clock starts', async () => {
    const bill = await erBill(1000);
    const restore = failing('revenue.final-requested');
    assert.equal(await final.request('agent', String(bill._id)), true);
    restore();
    assert.ok(await m.TaskAlertItem.exists({ link: `revenue-bill:${bill._id}:final` }), 'the task is written first');
    assert.equal((await sent('revenue.final-requested')).length, 0);
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-final', state: 'running' }), 0);
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    assert.equal((await sent('revenue.final-requested')).length, 1);
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-final', state: 'running' }), 1);
    assert.ok((await fresh(bill._id))!.announcedAt);
  });

  test('R29: an ER bill for a visit that already left gets its final request from reconcile', async () => {
    const visit = await m.ErVisit.create({ number: 'ER-9001', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, mode: 'walk-in', complaint: 'chest-pain', arrivedAt: new Date(), case: new Types.ObjectId(caseId), status: 'left', leftReason: 'home' });
    const bill = await bills.open({ kind: 'er', patientId: String(patient._id), caseId, erVisitId: String(visit._id) });
    await age(m.Bill, bill._id);
    await age(m.ErVisit, visit._id);
    await reconcile.reconcile(); // charges the arrival, which touches the bill
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    assert.ok(await m.TaskAlertItem.exists({ link: `revenue-bill:${bill._id}:final` }));
    assert.equal((await sent('revenue.final-requested')).length, 1);
    // A visit that left by admission is not asked for: its stay's own bill asks at discharge.
    const other = await m.Patient.create({ uhid: 'MHK202600996', name: 'Asha', age: 30, gender: 'Female', phone: '9100000096' });
    const admitted = await m.ErVisit.create({ number: 'ER-9002', patient: other._id, patientUhid: other.uhid, patientName: other.name, mode: 'walk-in', complaint: 'x', arrivedAt: new Date(), case: new Types.ObjectId(caseId), status: 'left', leftReason: 'admitted' });
    const keep = await bills.open({ kind: 'er', patientId: String(other._id), caseId, erVisitId: String(admitted._id) });
    await age(m.Bill, keep._id);
    await age(m.ErVisit, admitted._id);
    await reconcile.reconcile();
    await age(m.Bill, keep._id);
    await reconcile.reconcile();
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${keep._id}:final` }), 0);
  });

  test('R29: an admission bill whose admission is discharged gets its final request from reconcile', async () => {
    const adm = await m.Admission.create({ patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: new Types.ObjectId(), roomClass: 'general', expectedStayDays: 3, status: 'discharged', admittedAt: new Date(Date.now() - 86_400_000), dischargedAt: new Date(), admittedBy: 'Nurse' } as any);
    const bill = await bills.open({ kind: 'admission', patientId: String(patient._id), caseId, admissionId: String(adm._id) });
    await age(m.Bill, bill._id);
    await age(m.Admission, adm._id);
    await reconcile.reconcile();
    assert.ok(await m.TaskAlertItem.exists({ link: `revenue-bill:${bill._id}:final` }));
  });

  test('R30: a miss newer than 300 charged rows is still charged in one pass', async () => {
    const order = await m.PharmacyOrder.create({ number: 'PO-9', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: new Types.ObjectId(caseId), setting: 'ER', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    const anyBill = new Types.ObjectId();
    const old = new Date(Date.now() - 2 * 3_600_000);
    const charged = await m.PharmacyLine.insertMany(Array.from({ length: 305 }, () => ({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued', issued: { quantity: 1 } })));
    await m.ChargeLine.insertMany(charged.map((l) => ({ bill: anyBill, code: 'med:para500', name: 'P', category: 'pharmacy', qty: 1, unitPrice: 4, amount: 4, source: { type: 'pharmacy.issued', ref: String(l._id) }, chargedAt: old, by: { id: '', name: 'Revenue Agent' } })));
    await m.PharmacyLine.collection.updateMany({}, { $set: { updatedAt: old } });
    const miss = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued', issued: { quantity: 2 } as any });
    await age(m.PharmacyLine, miss._id);
    await reconcile.reconcile();
    assert.ok(await m.ChargeLine.exists({ 'source.type': 'pharmacy.issued', 'source.ref': String(miss._id) }));
  });

  test('R30: an issued medicine that was then stopped is still charged', async () => {
    const order = await m.PharmacyOrder.create({ number: 'PO-10', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: new Types.ObjectId(caseId), setting: 'ER', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    const line = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'stopped', issued: { quantity: 2 } as any });
    await age(m.PharmacyLine, line._id);
    await reconcile.reconcile();
    const charge = await m.ChargeLine.findOne({ 'source.ref': String(line._id) }).lean();
    assert.equal(charge!.amount, 8);
    // A stopped line that was never issued has no quantity and is not charged.
    const never = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'stopped' });
    await age(m.PharmacyLine, never._id);
    await reconcile.reconcile();
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': String(never._id) }), 0);
  });

  test('R32: a record older than the Revenue Agent\'s first start is never charged', async () => {
    await m.CoordinatorCounter.updateOne({ key: 'revenue-start' }, { $set: { last: Date.now() - 100_000 } });
    const order = await m.PharmacyOrder.create({ number: 'PO-11', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: new Types.ObjectId(caseId), setting: 'ER', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    const before = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued', issued: { quantity: 1 } as any });
    const after = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued', issued: { quantity: 1 } as any });
    await age(m.PharmacyLine, before._id); // 120 s ago: before the start
    await m.PharmacyLine.collection.updateOne({ _id: after._id }, { $set: { updatedAt: new Date(Date.now() - 50_000) } });
    await reconcile.reconcile();
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': String(before._id) }), 0);
    assert.equal(await m.ChargeLine.countDocuments({ 'source.ref': String(after._id) }), 1);
  });

  test('R31: the deposit ask is written before the task, so a failed task write is healed', async () => {
    const bill = await bills.open({ kind: 'admission', patientId: String(patient._id), caseId, admissionId: String(new Types.ObjectId()) });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { wardType: 'general' } });
    const create = m.TaskAlertItem.create.bind(m.TaskAlertItem);
    (m.TaskAlertItem as any).create = async () => {
      throw new Error('db down');
    };
    await assert.rejects(deposits.raise(String(bill._id)), /db down/);
    (m.TaskAlertItem as any).create = create;
    assert.equal((await fresh(bill._id))!.depositAsk?.amount, 10000, 'the marker came first');
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${bill._id}:deposit` }), 0);
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    assert.ok(await m.TaskAlertItem.exists({ link: `revenue-bill:${bill._id}:deposit` }));
    await age(m.Bill, bill._id);
    await reconcile.reconcile();
    assert.equal((await sent('revenue.deposit-due')).length, 1);
  });

  test('R31: estimates.reannounce never throws', async () => {
    const original = m.Estimate.findById;
    (m.Estimate as any).findById = () => {
      throw new Error('db down');
    };
    try {
      const estimates = (reconcile as any).estimates as RevenueEstimatesService;
      assert.equal(await estimates.reannounce(String(new Types.ObjectId())), false);
    } finally {
      (m.Estimate as any).findById = original;
    }
  });

  test("R30: kiosk bills settle: today's once its token is done, an earlier clinic day's whatever the token; an appointment bill is left alone", async () => {
    const today = isoDate(clinicNow());
    const before = parseIsoDay(today);
    before.setDate(before.getDate() - 1);
    const yesterday = isoDate(before);
    /** A kiosk visit paid on `day`: its token, its consultation on that day's walk-in bill, and the kiosk payment (balance 0). */
    const kioskVisit = async (day: string) => {
      const token = await m.QueueToken.create({ date: day, number: 1, label: 'G-001', uhid: patient.uhid, patientName: patient.name, status: 'waiting' });
      const visit = await m.OpVisit.create({ date: day, uhid: patient.uhid, patientName: patient.name, doctorId: 'd1', doctorName: 'Dr. A', fee: 300, status: 'paid', provider: 'cash', kioskId: 'k1', kioskName: 'Front kiosk', via: 'card', expiresAt: new Date(), tokenId: String(token._id) });
      const bill = await bills.open({ kind: 'walk-in', patientId: String(patient._id), day });
      await bills.addCharge(String(bill._id), { code: 'opd:d1', name: 'Consultation - Dr. A', category: 'consultation', qty: 1, unitPrice: 300, source: { type: 'op-visit', ref: String(visit._id) }, by: { name: 'Revenue Agent' } });
      await payments.recordKiosk(String(bill._id), { amount: 300, reference: 'Cash at counter', source: `op-visit:${visit._id}`, by: { id: 'k1', name: 'Kiosk: Front kiosk' }, at: clinicNow() });
      await age(m.Bill, bill._id);
      return { bill, token };
    };
    const earlier = await kioskVisit(yesterday);
    const now = await kioskVisit(today);
    // An earlier day's OPD bill of an appointment never marked Completed: nothing due, but not a kiosk bill.
    const appointment = await m.Appointment.create({ uhid: patient.uhid, patientName: patient.name, age: 62, gender: 'Male', phone: '9100000095', time: '09:30 AM', date: yesterday, type: 'Consultation', condition: 'Fever', status: 'Checked In' });
    const opdBill = await bills.open({ kind: 'opd', patientId: String(patient._id), appointmentId: String(appointment._id), day: yesterday });
    await age(m.Bill, opdBill._id);

    const first = await reconcile.reconcile();
    assert.equal((await fresh(earlier.bill._id))!.state, 'settled', 'the backstop: the day is over');
    assert.equal((await fresh(now.bill._id))!.state, 'open', "today's waits for its token");
    assert.equal((await fresh(opdBill._id))!.state, 'open', 'an appointment bill behaves as before');
    assert.equal(first.settled, 1);

    // The token was marked done while the event was missed: the next pass settles it.
    await m.QueueToken.updateOne({ _id: now.token._id }, { $set: { status: 'completed' } });
    await age(m.Bill, now.bill._id);
    const second = await reconcile.reconcile();
    assert.equal((await fresh(now.bill._id))!.state, 'settled');
    assert.equal(second.settled, 1);
    assert.equal((await fresh(opdBill._id))!.state, 'open');
  });

  test('a missing bed logs its warning once per admission, not on every tick', async () => {
    const warnings: string[] = [];
    const original = Logger.prototype.warn;
    Logger.prototype.warn = function (msg: any, ...rest: any[]) {
      warnings.push(String(msg));
      return original.call(this, msg, ...rest);
    };
    try {
      const adm = await m.Admission.create({ patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: new Types.ObjectId(), roomClass: 'general', expectedStayDays: 3, status: 'active', admittedAt: new Date(Date.now() - 3_600_000), admittedBy: 'Nurse' });
      await bills.open({ kind: 'admission', patientId: String(patient._id), admissionId: String(adm._id) });
      await reconcile.reconcile();
      await reconcile.reconcile();
      await reconcile.reconcile();
    } finally {
      Logger.prototype.warn = original;
    }
    assert.equal(warnings.filter((w) => /not found; will retry/.test(w)).length, 1);
  });
});
