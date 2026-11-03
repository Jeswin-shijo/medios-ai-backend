import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { ApprovalsService } from '../coordinator/approvals.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { FinalBillService } from './revenue-final.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RefundsService } from './revenue-refunds.service';
import { RevenueSettingsService } from './revenue-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };

describe('RefundsService', () => {
  const m = models();
  let approvals: ApprovalsService;
  let bills: RevenueBillsService;
  let final: FinalBillService;
  let svc: RefundsService;
  let reg: RevenueCoordinatorRegistration;
  let patient: any;

  /** A final ER bill: 3000 charged, 3500 paid, so 500 is owed back. */
  const owing = async () => {
    const b = await bills.open({ kind: 'er', patientId: String(patient._id), erVisitId: String(new Types.ObjectId()) });
    await bills.adjust(String(b._id), { charges: 3000, payments: 3500 });
    await final.prepare(ADMIN, String(b._id));
    return b;
  };
  const totals = async (id: unknown) => ({ ...(await m.Bill.findById(id).lean())!.totals });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const stub = (key: AgentKey, types: MessageTypeDef[]) => registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    stub('er', ER_MESSAGE_TYPES);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, events);
    const settings = new RevenueSettingsService(new SettingsService(m.HospitalSettings));
    reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient);
    final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment);
    svc = new RefundsService(reg, settings, bills, approvals, final, m.Refund, m.TaskAlertItem);
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600983', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000083' });
  });

  test('a refund is approved, then paid, which stops its clock; the bill can then settle', async () => {
    const b = await owing();
    const r = await svc.request(DESK, String(b._id));
    assert.equal(r.number, 'RF-0001');
    assert.equal(r.state, 'requested');
    assert.equal(r.amount, 500);
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.refund-due' }), 0, 'nothing is due before approval');
    await assert.rejects(() => final.settle(ADMIN, String(b._id)), /A correction or refund is waiting/);
    await approvals.act(ADMIN, String(r.approvalId), 'approved');
    const approved = await m.Refund.findById(r._id).lean();
    assert.equal(approved!.state, 'approved');
    const due = await m.AgentMessage.find({ type: 'revenue.refund-due' }).lean();
    assert.equal(due.length, 1);
    assert.ok(!/Ravi/.test(due[0].summary));
    const dueAt = new Date((due[0].payload as any).dueAt).getTime();
    assert.ok(Math.abs(dueAt - (Date.now() + 2880 * 60_000)) < 60_000, 'dueAt is real now plus the refund target');
    const task = await m.TaskAlertItem.findOne({ link: `revenue-refund:${r._id}` }).lean();
    assert.equal(task!.status, 'Pending');
    assert.equal((await m.Clock.find({ def: 'revenue-refund', state: 'running' }).lean()).length, 1);

    await assert.rejects(() => svc.pay(DESK, String(r._id), { mode: 'bitcoin' as any }), /cash, upi or card/);
    const paid = await svc.pay(DESK, String(r._id), { mode: 'cash', reference: 'voucher 7' });
    assert.equal(paid.state, 'paid');
    assert.equal(paid.paid!.mode, 'cash');
    assert.deepEqual(await totals(b._id), { charges: 3000, discounts: 0, payments: 3500, refunds: 500, balance: 0 });
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.refund-paid' }), 1);
    assert.equal((await m.TaskAlertItem.findOne({ link: `revenue-refund:${r._id}` }).lean())!.status, 'Completed');
    assert.equal((await m.Clock.find({ def: 'revenue-refund', state: 'running' }).lean()).length, 0);
    await assert.rejects(() => svc.pay(DESK, String(r._id), { mode: 'cash' }), /already paid|not waiting/);
    assert.deepEqual(await totals(b._id), { charges: 3000, discounts: 0, payments: 3500, refunds: 500, balance: 0 });
    // R27: paying the refund brings the balance to 0 and settles the bill.
    assert.equal((await m.Bill.findById(b._id).lean())!.state, 'settled');
  });

  test('a refund is only for a final bill that owes money, and only one at a time', async () => {
    const open = await bills.open({ kind: 'er', patientId: String(patient._id), erVisitId: String(new Types.ObjectId()) });
    await bills.adjust(String(open._id), { charges: 100, payments: 300 });
    await assert.rejects(() => svc.request(DESK, String(open._id)), /Prepare the final bill first/);
    const b = await owing();
    await assert.rejects(() => svc.request(DESK, String(open._id)), /Prepare the final bill first/);
    await svc.request(DESK, String(b._id));
    await assert.rejects(() => svc.request(DESK, String(b._id)), /already waiting/);
    const zero = await bills.open({ kind: 'er', patientId: String(patient._id), erVisitId: String(new Types.ObjectId()) });
    await bills.adjust(String(zero._id), { charges: 100, payments: 100 });
    await final.prepare(ADMIN, String(zero._id));
    await assert.rejects(() => svc.request(DESK, String(zero._id)), /owes the patient nothing/);
  });

  test('an admin\'s own refund request is approved at once; a rejected one can be asked again', async () => {
    const b = await owing();
    const r = await svc.request(ADMIN, String(b._id));
    assert.equal(r.state, 'approved');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.refund-due' }), 1);
    const c = await owing();
    const q = await svc.request(DESK, String(c._id));
    await approvals.act(ADMIN, String(q.approvalId), 'rejected');
    assert.equal((await m.Refund.findById(q._id).lean())!.state, 'rejected');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.refund-due' }), 1);
    const again = await svc.request(DESK, String(c._id));
    assert.equal(again.state, 'requested');
  });

  test('a throw while paying leaves the refund approved and a retry pays it once', async () => {
    const b = await owing();
    const r = await svc.request(ADMIN, String(b._id));
    const real = bills.adjust.bind(bills);
    let boom = true;
    (bills as any).adjust = async (...a: any[]) => {
      if (boom) {
        boom = false;
        throw new Error('db down');
      }
      return (real as any)(...a);
    };
    await assert.rejects(() => svc.pay(DESK, String(r._id), { mode: 'upi', reference: 'u1' }), /db down/);
    assert.equal((await m.Refund.findById(r._id).lean())!.state, 'approved');
    assert.equal((await totals(b._id)).refunds, 0);
    await svc.pay(DESK, String(r._id), { mode: 'upi', reference: 'u1' });
    assert.equal((await totals(b._id)).refunds, 500);
    assert.equal((await totals(b._id)).balance, 0);
  });

  test('a refund cannot be paid before approval, and the desk only sees it paid by one pass', async () => {
    const b = await owing();
    const r = await svc.request(DESK, String(b._id));
    await assert.rejects(() => svc.pay(DESK, String(r._id), { mode: 'cash' }), /approved/);
    const rec = await svc.receipt(String(r._id));
    assert.equal(rec.refundNumber, 'RF-0001');
    assert.equal(rec.amount, 500);
  });

  test('a throw while approving rolls the claim back, so the approval can be rejected and the refund cannot be paid', async () => {
    const b = await owing();
    const r = await svc.request(DESK, String(b._id));
    const real = reg.send.bind(reg);
    let boom = true;
    (reg as any).send = async (...a: any[]) => {
      if (boom) {
        boom = false;
        throw new Error('bus down');
      }
      return (real as any)(...a);
    };
    await assert.rejects(() => approvals.act(ADMIN, String(r.approvalId), 'approved'), /bus down/);
    assert.equal((await m.Refund.findById(r._id).lean())!.state, 'requested');
    await approvals.act(ADMIN, String(r.approvalId), 'rejected');
    const after = await m.Refund.findById(r._id).lean();
    assert.equal(after!.state, 'rejected');
    await assert.rejects(() => svc.pay(DESK, String(r._id), { mode: 'cash' }), /not been approved/);
  });

  test('a late charge that shrinks what is owed makes the refund pay the smaller amount, and the bill settles', async () => {
    const b = await owing();
    const r = await svc.request(ADMIN, String(b._id));
    await bills.adjust(String(b._id), { charges: 200 });
    const paid = await svc.pay(DESK, String(r._id), { mode: 'cash' });
    assert.equal(paid.state, 'paid');
    assert.equal(paid.paid!.amount, 300);
    assert.deepEqual(await totals(b._id), { charges: 3200, discounts: 0, payments: 3500, refunds: 300, balance: 0 });
    assert.equal((await m.Bill.findById(b._id).lean())!.state, 'settled');
  });

  test('when nothing is owed any more the refund is void, its clock stops and the bill settles', async () => {
    const b = await owing();
    const r = await svc.request(ADMIN, String(b._id));
    assert.equal((await m.Clock.find({ def: 'revenue-refund', state: 'running' }).lean()).length, 1);
    await bills.adjust(String(b._id), { charges: 500 });
    const v = await svc.pay(DESK, String(r._id), { mode: 'cash' });
    assert.equal(v.state, 'void');
    assert.deepEqual(await totals(b._id), { charges: 3500, discounts: 0, payments: 3500, refunds: 0, balance: 0 });
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.refund-void' }), 1);
    assert.equal((await m.Clock.find({ def: 'revenue-refund', state: 'running' }).lean()).length, 0);
    assert.equal((await m.TaskAlertItem.findOne({ link: `revenue-refund:${r._id}` }).lean())!.status, 'Completed');
    assert.equal((await m.Bill.findById(b._id).lean())!.state, 'settled');
  });
  test('listPending shows a waiting refund with its bill, and not a paid one', async () => {
    const b = await owing();
    const r = await svc.request(DESK, String(b._id));
    const rows = await svc.listPending();
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], requestedAt: undefined }, {
      approvalId: String(r.approvalId), type: 'refund', kind: 'refund', recordId: String(r._id),
      bill: { id: String(b._id), number: b.number, kind: 'er', patientName: 'Ravi Kumar', patientUhid: 'MHK202600983' },
      amount: 500, reason: '', requestedBy: 'Front Desk', requestedAt: undefined,
    });
    await approvals.act(ADMIN, String(r.approvalId), 'approved');
    assert.equal((await svc.listPending()).length, 0, 'approved means no longer waiting');
    await svc.pay(DESK, String(r._id), { mode: 'cash' });
    assert.equal((await svc.listPending()).length, 0, 'paid is absent');
  });
});
