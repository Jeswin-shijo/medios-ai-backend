import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { FinalBillService } from './revenue-final.service';
import { PaymentsService } from './revenue-payments.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueSettingsService } from './revenue-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };

describe('PaymentsService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let bills: RevenueBillsService;
  let final: FinalBillService;
  let svc: PaymentsService;
  let patient: any;

  const stub = (key: AgentKey, types: MessageTypeDef[]) =>
    registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  /** An ER bill with 5000 of charges. */
  const bill = async (charges = 5000) => {
    const b = await bills.open({ kind: 'er', patientId: String(patient._id), erVisitId: String(new Types.ObjectId()) });
    if (charges) await bills.adjust(String(b._id), { charges });
    return b;
  };
  const fresh = (id: unknown) => m.Bill.findById(id).lean();

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
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new RevenueSettingsService(settingsService);
    const reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient);
    final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment);
    svc = new PaymentsService(reg, settings, bills, final, m.Payment);
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600981', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000081' });
  });

  test('a payment issues RC-0001 and lowers the balance; a cancelled payment raises it again', async () => {
    const b = await bill();
    const p = await svc.record(DESK, String(b._id), { amount: 2000, mode: 'cash', kind: 'deposit' });
    assert.equal(p.receiptNumber, 'RC-0001');
    assert.equal(p.amount, 2000);
    assert.deepEqual({ ...(await fresh(b._id))!.totals }, { charges: 5000, discounts: 0, payments: 2000, refunds: 0, balance: 3000 });
    const sent = await m.AgentMessage.find({ type: 'revenue.payment' }).lean();
    assert.equal(sent.length, 1);
    assert.deepEqual(
      { ...sent[0].payload, billId: String((sent[0].payload as any).billId) },
      { billId: String(b._id), billNumber: b.number, receiptNumber: 'RC-0001', amount: 2000, mode: 'cash' },
    );
    assert.ok(!/Ravi/.test(sent[0].summary), 'no name in the summary');

    await assert.rejects(svc.cancel(DESK, String(p._id), 'wrong amount'), /admin/i, 'only an admin cancels');
    const cancelled = await svc.cancel(ADMIN, String(p._id), 'typed the wrong amount');
    assert.equal(cancelled.cancelled.reason, 'typed the wrong amount');
    assert.equal(cancelled.cancelled.by.name, 'Admin');
    assert.ok(cancelled.cancelled.at);
    assert.deepEqual({ ...(await fresh(b._id))!.totals }, { charges: 5000, discounts: 0, payments: 0, refunds: 0, balance: 5000 });
    await assert.rejects(svc.cancel(ADMIN, String(p._id), 'again'), /already cancelled/i, 'cancelled once only');
    assert.equal((await fresh(b._id))!.totals.balance, 5000, 'a second cancel changed nothing');
    assert.equal((await svc.record(DESK, String(b._id), { amount: 100, mode: 'upi', reference: 'U1', kind: 'part' })).receiptNumber, 'RC-0002');
  });

  test('payments are checked: amount 1 to 10,00,000, a known mode, and not on a settled bill', async () => {
    const b = await bill();
    const id = String(b._id);
    for (const amount of [0, -5, 1000001, 10.5]) await assert.rejects(svc.record(DESK, id, { amount, mode: 'cash', kind: 'part' }), /amount/i, String(amount));
    await assert.rejects(svc.record(DESK, id, { amount: 100, mode: 'kiosk' as any, kind: 'part' }), /mode/i);
    await assert.rejects(svc.record(DESK, id, { amount: 100, mode: 'cash', kind: 'weird' as any }), /kind/i);
    assert.equal(await m.Payment.countDocuments({}), 0);
    await svc.record(DESK, id, { amount: 5000, mode: 'card', kind: 'settlement' });
    await final.prepare(DESK, id);
    await final.settle(DESK, id);
    await assert.rejects(svc.record(DESK, id, { amount: 100, mode: 'cash', kind: 'part' }), /settled/i);
    const p = (await m.Payment.findOne({}).lean())!;
    await assert.rejects(svc.cancel(ADMIN, String(p._id), 'late'), /settled/i, 'R18: no cancel on a settled bill');
    assert.deepEqual({ ...(await fresh(b._id))!.totals }, { charges: 5000, discounts: 0, payments: 5000, refunds: 0, balance: 0 });
  });

  test('two payments at once keep the totals exact', async () => {
    const b = await bill();
    const id = String(b._id);
    const got = await Promise.all([
      svc.record(DESK, id, { amount: 1000, mode: 'cash', kind: 'part' }),
      svc.record(DESK, id, { amount: 700, mode: 'upi', reference: 'U9', kind: 'part' }),
      svc.record(DESK, id, { amount: 300, mode: 'card', kind: 'part' }),
    ]);
    assert.deepEqual(got.map((p) => p.receiptNumber).sort(), ['RC-0001', 'RC-0002', 'RC-0003']);
    assert.deepEqual({ ...(await fresh(b._id))!.totals }, { charges: 5000, discounts: 0, payments: 2000, refunds: 0, balance: 3000 });
    assert.equal(await m.Payment.countDocuments({ bill: b._id }), 3);
  });

  test('receipt returns the print data with the header from Settings', async () => {
    const b = await bill();
    const p = await svc.record(DESK, String(b._id), { amount: 1500, mode: 'upi', reference: 'UTR55', kind: 'deposit' });
    const r = await svc.receipt(String(p._id));
    assert.equal(r.receiptNumber, 'RC-0001');
    assert.equal(r.header, "St. Mary's Multi Speciality Hospital, Nagercoil");
    assert.equal(r.billNumber, b.number);
    assert.equal(r.patientName, 'Ravi Kumar');
    assert.equal(r.patientUhid, patient.uhid);
    assert.equal(r.amount, 1500);
    assert.equal(r.mode, 'upi');
    assert.equal(r.reference, 'UTR55');
    assert.equal(r.kind, 'deposit');
    assert.equal(r.receivedBy, 'Front Desk');
    assert.equal(r.balance, 3500);
    assert.equal(r.cancelled, null);
    await assert.rejects(svc.receipt(String(new Types.ObjectId())), /not found/i);
  });

  test('list gives the clinic day\'s payments newest first with the bill and patient, and shows cancelled ones (R35)', async () => {
    const b = await bill();
    const first = await svc.record(DESK, String(b._id), { amount: 100, mode: 'cash', kind: 'part' });
    const second = await svc.record(DESK, String(b._id), { amount: 200, mode: 'upi', kind: 'deposit' });
    await svc.cancel(ADMIN, String(first._id), 'Wrong amount');
    await m.Payment.create({ receiptNumber: 'RC-9999', bill: b._id, amount: 50, mode: 'cash', kind: 'part', by: { id: 'x', name: 'x' }, at: new Date(2001, 0, 1) });
    const rows = await svc.list();
    assert.deepEqual(rows.map((r) => r.receiptNumber), [second.receiptNumber, first.receiptNumber]);
    assert.equal(rows[0].amount, 200);
    assert.equal(rows[0].mode, 'upi');
    assert.equal(rows[0].kind, 'deposit');
    assert.equal(rows[0].billNumber, b.number);
    assert.equal(rows[0].billKind, 'er');
    assert.equal(rows[0].patientName, b.patientName);
    assert.equal(rows[0].patientUhid, b.patientUhid);
    assert.equal(rows[0].cancelled, false);
    assert.equal(rows[1].cancelled, true);
    assert.equal(rows[1].cancelledReason, 'Wrong amount');
    assert.equal((await svc.list({ day: '2001-01-01' })).length, 1);
    await assert.rejects(() => svc.list({ day: '2001-02-31' }), BadRequestException);
  });
});
