import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { ApprovalsService } from '../coordinator/approvals.service';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { REVENUE_MESSAGE_TYPES, RevenueCoordinatorRegistration } from './revenue-coordinator.registration';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };

describe('RevenueCoordinatorRegistration', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let approvals: ApprovalsService;
  let reg: RevenueCoordinatorRegistration;
  let caseId: string;
  let patientId: Types.ObjectId;

  const bill = (extra: Record<string, unknown> = {}) =>
    m.Bill.create({
      number: `BL-${Math.random().toString().slice(2, 8)}`, patient: patientId, patientUhid: 'MHK1', patientName: 'Ravi Kumar', kind: 'er', state: 'open',
      case: caseId, erVisit: new Types.ObjectId(), openedAt: new Date(), ...extra,
    });
  const closeCheck = () => registry.closeChecks().find((c) => c.agent === 'revenue')!.check(caseId);
  const def = () => registry.definitions().find((d) => d.key === 'revenue')!;

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
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, events);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    reg.onModuleInit();
    const p = await m.Patient.create({ uhid: 'MHK202600903', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000003' });
    patientId = p._id as Types.ObjectId;
    caseId = String((await cases.openOrJoin({ patientId: String(p._id), patientUhid: p.uhid, patientName: 'Ravi Kumar', kind: 'er', priority: 'high', openedBy: 'er' })).case._id);
  });

  test('the agent is built with its 10 message types, 3 clocks and 2 rules', async () => {
    assert.equal(REVENUE_MESSAGE_TYPES.length, 10);
    const payloads: Record<string, Record<string, string>> = {
      'estimate-ready': { billId: 'string', billNumber: 'string', low: 'number', high: 'number' },
      'deposit-due': { billId: 'string', billNumber: 'string', amount: 'number' },
      'topup-due': { billId: 'string', billNumber: 'string', amount: 'number', dueAt: 'date' },
      'topup-met': { billId: 'string', billNumber: 'string' },
      payment: { billId: 'string', billNumber: 'string', receiptNumber: 'string', amount: 'number', mode: 'string' },
      'final-requested': { billId: 'string', billNumber: 'string', dueAt: 'date' },
      'bill-final': { billId: 'string', billNumber: 'string', balance: 'number' },
      'bill-settled': { billId: 'string', billNumber: 'string', total: 'number' },
      'refund-due': { refundId: 'string', refundNumber: 'string', billNumber: 'string', amount: 'number', dueAt: 'date' },
      'refund-paid': { refundId: 'string', refundNumber: 'string', billNumber: 'string' },
    };
    for (const [t, payload] of Object.entries(payloads)) {
      const d = registry.messageType(`revenue.${t}`);
      assert.equal(d?.agent, 'revenue', t);
      assert.deepEqual(d!.payload, payload, t);
    }
    assert.deepEqual(await def().status(), { open: 0, capacity: 0, onTimePct: null });
    assert.deepEqual(def().handles ?? [], []);

    const f = registry.clock('revenue-final')!;
    const t = registry.clock('revenue-topup')!;
    const r = registry.clock('revenue-refund')!;
    assert.deepEqual([f.startOn, f.stopOn, f.minutes, f.ladder], ['revenue.final-requested', ['revenue.bill-final', 'revenue.bill-settled'], 60, 'revenue']);
    assert.deepEqual([t.startOn, t.stopOn, t.minutes, t.ladder], ['revenue.topup-due', ['revenue.topup-met', 'revenue.bill-settled'], 240, 'revenue']);
    assert.deepEqual([r.startOn, r.stopOn, r.minutes, r.ladder], ['revenue.refund-due', ['revenue.refund-paid'], 2880, 'revenue']);
    assert.deepEqual([f.resolveEscalationOnStop, t.resolveEscalationOnStop, r.resolveEscalationOnStop], [true, true, true]);
    assert.deepEqual([f.resolvedBy, t.resolvedBy, r.resolvedBy], ['Final bill ready', 'Top-up met', 'Refund paid']);
    assert.equal(f.alertLink!('b1'), 'revenue-bill:b1:final');
    assert.equal(t.alertLink!('b1'), 'revenue-bill:b1:topup');
    assert.equal(r.alertLink!('r1'), 'revenue-refund:r1');
    assert.equal(f.detailFrom!({ billNumber: 'BL-0001' }), 'BL-0001');
    assert.equal(r.detailFrom!({ refundNumber: 'RF-0001', billNumber: 'BL-0001' }), 'RF-0001');

    const never = registry.rules().find((x) => x.key === 'revenue-never-hold-care')!;
    assert.deepEqual([never.agent, never.label, never.locked, never.default], ['revenue', 'Never hold care for money', true, true]);
    const remind = registry.rules().find((x) => x.key === 'revenue-deposit-reminders')!;
    assert.deepEqual([remind.label, remind.default, remind.locked], ['Remind the billing desk to collect deposits', true, undefined]);

    // The clock follows the payload's dueAt and ref, and stops on the stop message.
    const dueAt = new Date(Date.now() + 30 * 60_000);
    const payload = { billId: 'b1', billNumber: 'BL-0001', dueAt };
    await reg.send('revenue.final-requested', { number: 'BL-0001', case: caseId }, payload, { text: 'Final bill requested' });
    const running = await m.Clock.find({ def: 'revenue-final' }).lean();
    assert.equal(running.length, 1);
    assert.equal(running[0].ref, 'b1');
    assert.equal(running[0].dueAt.getTime(), dueAt.getTime());
    const sent = await m.AgentMessage.findOne({ type: 'revenue.final-requested' }).lean();
    assert.equal(sent!.summary, 'BL-0001: Final bill requested');
    await reg.send('revenue.bill-final', { number: 'BL-0001', case: caseId }, { billId: 'b1', billNumber: 'BL-0001', balance: 1234 }, { text: 'Final bill ready', amount: 1234 });
    assert.equal((await m.AgentMessage.findOne({ type: 'revenue.bill-final' }).lean())!.summary, 'BL-0001: Final bill ready (₹1,234)');
    assert.equal(await m.Clock.countDocuments({ def: 'revenue-final', state: 'running' }), 0);
  });

  test('close check fails on an open bill, passes when settled, is n/a with no bill', async () => {
    assert.equal(await closeCheck(), 'n/a');
    const b = await bill();
    assert.equal(await closeCheck(), 'fail', 'open');
    await m.Bill.updateOne({ _id: b._id }, { state: 'final', 'totals.balance': 500 });
    assert.equal(await closeCheck(), 'fail', 'final with a balance');
    await m.Bill.updateOne({ _id: b._id }, { state: 'settled', 'totals.balance': 0 });
    assert.equal(await closeCheck(), 'pass', 'settled');
    const refund = await m.Refund.create({ number: 'RF-0001', bill: b._id, amount: 100, state: 'requested' });
    assert.equal(await closeCheck(), 'fail', 'refund requested');
    await m.Refund.updateOne({ _id: refund._id }, { state: 'approved' });
    assert.equal(await closeCheck(), 'fail', 'refund approved');
    await m.Refund.updateOne({ _id: refund._id }, { state: 'paid' });
    assert.equal(await closeCheck(), 'pass', 'refund paid');
    await m.Refund.updateOne({ _id: refund._id }, { state: 'rejected' });
    assert.equal(await closeCheck(), 'pass', 'refund rejected');
    // OPD bills and other cases' bills are not the case's concern.
    await m.Bill.deleteMany({});
    await bill({ kind: 'opd', erVisit: undefined, appointment: new Types.ObjectId(), day: '2026-09-26' });
    await bill({ case: new Types.ObjectId() });
    assert.equal(await closeCheck(), 'n/a');
  });

  test('the status counts open bills, open deposit and top-up tasks, and final bills with a balance', async () => {
    await bill();
    await bill({ kind: 'admission', erVisit: undefined, admission: new Types.ObjectId() });
    await bill({ kind: 'admission', erVisit: undefined, admission: new Types.ObjectId(), state: 'final', totals: { balance: 300 } });
    await bill({ kind: 'admission', erVisit: undefined, admission: new Types.ObjectId(), state: 'final', totals: { balance: 0 } });
    await bill({ kind: 'admission', erVisit: undefined, admission: new Types.ObjectId(), state: 'settled' });
    const task = (link: string, status: string) =>
      m.TaskAlertItem.create({ title: 't', type: 'System', category: 'System', priority: 'Medium', link, status });
    await task('revenue-bill:b1:deposit', 'Pending');
    await task('revenue-bill:b2:topup', 'Pending');
    await task('revenue-bill:b3:deposit', 'Completed');
    await task('revenue-bill:b4:final', 'Pending');
    assert.equal((await def().status()).open, 2 + 2 + 1);
  });

  test('an approval decision reaches the registered listener; a throwing listener reopens the approval', async () => {
    const seen: string[] = [];
    let fail = true;
    reg.onCorrectionDecision.push(async (id, decision, actor) => {
      seen.push(`${decision}:${actor.name}`);
      if (fail) throw new Error('boom');
    });
    reg.onRefundDecision.push(async (_id, decision) => {
      seen.push(`refund:${decision}`);
    });
    assert.deepEqual(registry.approvalType('revenue.correction')?.roles, [UserRole.ADMIN]);
    assert.equal(registry.approvalType('revenue.refund')?.primary.kind, 'approve');

    const a = await approvals.request({ type: 'revenue.correction', case: caseId, summary: 'BL-0001: discount', source: { kind: 'revenue-correction', id: 'c1' } });
    await assert.rejects(() => approvals.act(ADMIN, String(a._id), 'approved'), /boom/);
    assert.equal((await m.Approval.findById(a._id).lean())!.state, 'open');
    fail = false;
    await approvals.act(ADMIN, String(a._id), 'approved');
    assert.equal((await m.Approval.findById(a._id).lean())!.state, 'approved');
    assert.deepEqual(seen, ['approved:Admin', 'approved:Admin']);

    const r = await approvals.request({ type: 'revenue.refund', case: caseId, summary: 'BL-0001: refund', source: { kind: 'revenue-refund', id: 'r1' } });
    await approvals.act(ADMIN, String(r._id), 'rejected');
    assert.deepEqual(seen.slice(2), ['refund:rejected']);
  });
});
