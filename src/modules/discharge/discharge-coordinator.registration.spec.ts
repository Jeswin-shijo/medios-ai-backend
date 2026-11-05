import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { AgentKey, MessageTypeDef, validatePayload } from '../coordinator/coordinator-types';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { LAB_MESSAGE_TYPES } from '../lab/lab-coordinator.registration';
import { PHARMACY_MESSAGE_TYPES } from '../pharmacy/pharmacy-coordinator.registration';
import { REVENUE_MESSAGE_TYPES } from '../revenue/revenue-coordinator.registration';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { DISCHARGE_CLOCKS, DISCHARGE_MESSAGE_TYPES, DischargeRegistration, WAKE_TYPES } from './discharge-coordinator.registration';
import { DischargeSettingsService } from './discharge-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DOCTOR = { id: 'd1', name: 'Dr. Shajin' };
const MIN = 60_000;
const H = 60 * MIN;
/** Clinic "now" for the status test: 26 Sep 2026, 15:00 local. */
const T0 = new Date(2026, 8, 26, 15, 0, 0, 0);
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);

describe('DischargeRegistration', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let clocks: ClocksService;
  let cases: CasesService;
  let settingsService: SettingsService;
  let rules: RulesService;
  let settings: DischargeSettingsService;
  let reg: DischargeRegistration;
  let logged: string[];
  let patientId: Types.ObjectId;
  let caseId: string;

  const stub = (key: AgentKey, types: MessageTypeDef[]) =>
    registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  const def = () => registry.get('discharge')!;
  const closeCheck = async (id = caseId) => {
    const check = registry.closeChecks().find((c) => c.agent === 'discharge');
    assert.ok(check, 'the Discharge close check is registered');
    return check.check(id);
  };
  const clocksOf = (orderId: string) => m.Clock.find({ ref: orderId }).sort({ def: 1 }).lean();
  const admission = (extra: Record<string, unknown> = {}) =>
    m.Admission.create({
      patient: patientId, patientUhid: 'MHK202600905', patientName: 'Ravi Kumar', bed: new Types.ObjectId(), roomClass: 'general',
      expectedStayDays: 3, admittedAt: new Date(), admittedBy: 'Seed', ...extra,
    });
  const plan = (admissionId: unknown, state = 'planned') =>
    m.DischargePlan.create({
      admission: admissionId, case: caseId, patient: patientId, patientUhid: 'MHK202600905', patientName: 'Ravi Kumar',
      bedLabel: 'GWA-12', wardName: 'General ward A', targetDay: '2026-09-27', targetAt: new Date(), state,
    });
  const order = (state: string, extra: Record<string, unknown> = {}) =>
    m.DischargeOrder.create({
      plan: new Types.ObjectId(), admission: new Types.ObjectId(), patient: patientId, kind: 'home', state, plannedLeaveAt: T0, windowAt: T0,
      diagnosis: 'Acute appendicitis, operated', orderedBy: DOCTOR, orderedAt: T0, ...extra,
    });
  /** A discharge.window-opened payload for an order: its two due times (real time), and whether the summary is already signed. */
  const opened = (orderId: string, leaveDueAt: Date, summaryDueAt: Date, summarySigned = false) => ({
    orderId, admissionId: String(new Types.ObjectId()), bedLabel: 'GWA-12', kind: 'home', plannedLeaveAt: new Date(Date.now() + 2 * H), leaveDueAt, summaryDueAt, summarySigned,
  });
  const completed = (orderId: string) => ({ planId: String(new Types.ObjectId()), orderId, admissionId: String(new Types.ObjectId()), bedLabel: 'GWA-12', kind: 'home', leftAt: new Date() });
  const cancelled = (orderId: string) => ({ orderId, admissionId: String(new Types.ObjectId()), bedLabel: 'GWA-12' });

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
    stub('bed', BED_MESSAGE_TYPES);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    settingsService = new SettingsService(m.HospitalSettings);
    rules = new RulesService(registry, settingsService, events);
    settings = new DischargeSettingsService(settingsService);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    reg = new DischargeRegistration(registry, messages, cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    (reg as any).logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    reg.onModuleInit();
    const p = await m.Patient.create({ uhid: 'MHK202600905', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000005' });
    patientId = p._id as Types.ObjectId;
    caseId = String((await cases.openOrJoin({ patientId: String(p._id), patientUhid: p.uhid, patientName: 'Ravi Kumar', kind: 'ipd', priority: 'medium', openedBy: 'bed' })).case._id);
  });

  test('registers seven message types, two clocks, two rules and one close check', async () => {
    const payloads: Record<string, Record<string, string>> = {
      'discharge.planned': { planId: 'string', admissionId: 'string', bedLabel: 'string', targetDay: 'string' },
      'discharge.ordered': { orderId: 'string', planId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', plannedLeaveAt: 'date' },
      'discharge.window-opened': {
        orderId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', plannedLeaveAt: 'date', leaveDueAt: 'date', summaryDueAt: 'date',
        summarySigned: 'boolean',
      },
      'discharge.summary-signed': { orderId: 'string', summaryId: 'string', bedLabel: 'string', kind: 'string' },
      'discharge.ready': { orderId: 'string', bedLabel: 'string', kind: 'string' },
      'discharge.completed': { planId: 'string', orderId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', leftAt: 'date' },
      'discharge.cancelled': { orderId: 'string', admissionId: 'string', bedLabel: 'string' },
    };
    assert.deepEqual(DISCHARGE_MESSAGE_TYPES.map((t) => t.type), Object.keys(payloads));
    assert.ok(registry.isBuilt('discharge'));
    for (const [t, payload] of Object.entries(payloads)) {
      const d = registry.messageType(t);
      assert.equal(d?.agent, 'discharge', t);
      assert.deepEqual(d!.payload, payload, t);
      assert.ok(d!.description, t);
    }
    // Every field is required and non-null; a Left without discharge with no order sends orderId ''.
    const done = registry.messageType('discharge.completed')!;
    const lwd = { planId: 'p1', orderId: '', admissionId: 'a1', bedLabel: 'GWA-12', kind: 'left-without-discharge', leftAt: new Date() };
    assert.deepEqual(validatePayload(done, lwd), []);
    assert.deepEqual(validatePayload(done, { ...lwd, kind: null }), ['discharge.completed: "kind" is missing']);

    // The clocks (Values), both closed by their work and named by the order.
    assert.deepEqual(DISCHARGE_CLOCKS.map((c) => c.key), ['discharge-leave', 'discharge-summary']);
    assert.deepEqual(def().clocks!.map((c) => c.key), ['discharge-leave', 'discharge-summary']);
    const leave = registry.clock('discharge-leave')!;
    const summary = registry.clock('discharge-summary')!;
    assert.deepEqual(
      [leave.agent, leave.label, leave.startOn, leave.stopOn, leave.minutes, leave.ladder],
      ['discharge', 'Order to leaving', 'discharge.window-opened', ['discharge.completed', 'discharge.cancelled'], 120, 'discharge'],
    );
    assert.deepEqual(
      [summary.agent, summary.label, summary.startOn, summary.stopOn, summary.minutes, summary.ladder],
      ['discharge', 'Summary signed', 'discharge.window-opened', ['discharge.summary-signed', 'discharge.completed', 'discharge.cancelled'], 60, 'discharge-doctor'],
    );
    for (const c of [leave, summary]) {
      assert.deepEqual([c.resolveEscalationOnStop, c.resolvedBy], [true, 'Discharge Agent'], c.key);
      assert.equal(c.refFrom!('discharge.window-opened', { orderId: 'o1' }), 'o1', c.key);
      assert.equal(c.refFrom!('discharge.completed', { orderId: '' }), null, `${c.key}: no order, no clock`);
      assert.equal(c.detailFrom!({ bedLabel: 'GWA-12', kind: 'home' }), 'GWA-12 (Home)', c.key);
      assert.equal(c.detailFrom!({ bedLabel: 'HDU-1', kind: 'against-advice' }), 'HDU-1 (Against advice)', c.key);
      assert.equal(c.detailFrom!({ bedLabel: 'HDU-1', kind: 'constructor' }), 'HDU-1', `${c.key}: an unknown kind is left out`);
      assert.equal(c.alertLink!(null), null, c.key);
    }
    assert.equal(leave.alertLink!('o1'), 'discharge-order:o1');
    assert.equal(summary.alertLink!('o1'), 'discharge-order:o1:summary');
    const due = new Date('2026-09-26T08:00:00.000Z');
    assert.equal(leave.dueFrom!({ leaveDueAt: due, summaryDueAt: new Date(0) })!.getTime(), due.getTime());
    assert.equal(leave.dueFrom!({ leaveDueAt: due.toISOString() })!.getTime(), due.getTime(), 'a due time that went through JSON');
    assert.equal(summary.dueFrom!({ leaveDueAt: new Date(0), summaryDueAt: due })!.getTime(), due.getTime());
    assert.equal(leave.dueFrom!({ leaveDueAt: 'not a date' }), null, 'an unusable due time falls back to the minutes');
    assert.equal(summary.dueFrom!({}), null);
    // R20: a window that opens on a summary already signed starts no summary clock; every stop still matches.
    assert.equal(leave.match, undefined);
    assert.equal(summary.match!('discharge.window-opened', { summarySigned: true }), false);
    assert.equal(summary.match!('discharge.window-opened', { summarySigned: false }), true);
    for (const stop of summary.stopOn) assert.equal(summary.match!(stop, { summarySigned: true }), true, stop);

    // The rules (A6): the locked one reuses the placeholder's key; the switch has no settingPath.
    assert.deepEqual(def().rules, [
      {
        key: 'discharge-dependency-checks', agent: 'discharge', label: "Never discharge without a doctor's order",
        description: "Every real discharge goes through the doctor's order and its checklist.", default: true, locked: true,
      },
      {
        key: 'discharge-morning-reminder', agent: 'discharge', label: 'Remind the doctor on the target day',
        description: "At the reminder time on the target day, the admission's doctor gets a task when there is no discharge order yet.", default: true,
      },
    ]);
    assert.deepEqual(registry.closeChecks().filter((c) => c.agent === 'discharge').map((c) => c.label), ['Discharge complete']);

    // It wakes on these, each another agent's real message type.
    assert.deepEqual([...WAKE_TYPES], [
      'bed.assigned', 'bed.transferred', 'bed.discharged',
      'lab.resulted', 'lab.cancelled', 'lab.critical', 'lab.critical-acked',
      'pharmacy.issued', 'pharmacy.cancelled', 'pharmacy.stopped', 'pharmacy.rejected',
      'scheduling.followup-booked',
      'revenue.bill-final', 'revenue.bill-settled',
    ]);
    assert.deepEqual(def().handles!.map((h) => h.type), [...WAKE_TYPES]);
    const theirs = new Set([...BED_MESSAGE_TYPES, ...LAB_MESSAGE_TYPES, ...PHARMACY_MESSAGE_TYPES, ...SCHEDULING_MESSAGE_TYPES, ...REVENUE_MESSAGE_TYPES].map((t) => t.type));
    for (const t of WAKE_TYPES) assert.ok(theirs.has(t), `${t} is a message another agent sends`);
  });

  test('the Coming rule row is gone once registered', async () => {
    const bare = new RulesService(new AgentRegistry(), settingsService, new CoordinatorEvents());
    assert.ok((await bare.list()).some((r) => r.comingWith === 'discharge'), 'the placeholder shows while the agent is not built');

    const list = await rules.list();
    assert.equal(list.some((r) => r.comingWith === 'discharge'), false);
    assert.deepEqual(list.filter((r) => r.agent === 'discharge'), [
      {
        key: 'discharge-dependency-checks', agent: 'discharge', label: "Never discharge without a doctor's order",
        description: "Every real discharge goes through the doctor's order and its checklist.", value: true, locked: true,
      },
      {
        key: 'discharge-morning-reminder', agent: 'discharge', label: 'Remind the doctor on the target day',
        description: "At the reminder time on the target day, the admission's doctor gets a task when there is no discharge order yet.", value: true, locked: false,
      },
    ]);
    await assert.rejects(() => rules.set(ADMIN, 'discharge-dependency-checks', false), ConflictException);
    // The switch is kept with the Coordinator's rules (no settingPath into the stripped discharge section).
    await rules.set(ADMIN, 'discharge-morning-reminder', false);
    assert.equal(await rules.isOn('discharge-morning-reminder'), false);
    assert.deepEqual((await settingsService.getSettings()).coordinator.rules, { 'discharge-morning-reminder': false });
  });

  test('window-opened starts both clocks with dueAt from the payload, and completed stops them', async () => {
    const a = String(new Types.ObjectId());
    // Not the 120 and 60 minute fallbacks, so the payload's due times are told apart from them.
    const leaveDueAt = new Date(Date.now() + 3 * H);
    const summaryDueAt = new Date(Date.now() + 90 * MIN);
    await reg.send('discharge.window-opened', caseId, opened(a, leaveDueAt, summaryDueAt), 'GWA-12: Discharge window opened (Home)');
    let rows = await clocksOf(a);
    assert.deepEqual(rows.map((c) => [c.def, c.state, String(c.case), c.dueAt.getTime(), c.detail]), [
      ['discharge-leave', 'running', caseId, leaveDueAt.getTime(), 'GWA-12 (Home)'],
      ['discharge-summary', 'running', caseId, summaryDueAt.getTime(), 'GWA-12 (Home)'],
    ]);
    // The signed summary stops only its own clock.
    await reg.send('discharge.summary-signed', caseId, { orderId: a, summaryId: 's1', bedLabel: 'GWA-12', kind: 'home' }, 'GWA-12: Summary signed (Home)');
    rows = await clocksOf(a);
    assert.deepEqual(rows.map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'met']]);
    await reg.send('discharge.completed', caseId, completed(a), 'GWA-12: Patient left (Home)');
    rows = await clocksOf(a);
    assert.deepEqual(rows.map((c) => [c.def, c.state]), [['discharge-leave', 'met'], ['discharge-summary', 'met']]);

    // With both running, completed stops both; another order's completed does not.
    const b = String(new Types.ObjectId());
    await reg.send('discharge.window-opened', caseId, opened(b, leaveDueAt, summaryDueAt), 'GWA-12: Discharge window opened (Home)');
    await reg.send('discharge.completed', caseId, completed(String(new Types.ObjectId())), 'GWA-14: Patient left (Home)');
    assert.deepEqual((await clocksOf(b)).map((c) => c.state), ['running', 'running']);
    await reg.send('discharge.completed', caseId, completed(b), 'GWA-12: Patient left (Home)');
    assert.deepEqual((await clocksOf(b)).map((c) => c.state), ['met', 'met']);
  });

  test('window-opened with summarySigned true starts only the leave clock', async () => {
    const a = String(new Types.ObjectId());
    // Signed in the evening, before the window opens: the stop finds no clock.
    await reg.send('discharge.summary-signed', caseId, { orderId: a, summaryId: 's1', bedLabel: 'GWA-12', kind: 'home' }, 'GWA-12: Summary signed (Home)');
    assert.equal(await m.Clock.countDocuments({ ref: a }), 0);
    // The window opens next morning on the signed summary.
    const leaveDueAt = new Date(Date.now() + 3 * H);
    await reg.send('discharge.window-opened', caseId, opened(a, leaveDueAt, new Date(Date.now() + 90 * MIN), true), 'GWA-12: Discharge window opened (Home)');
    assert.deepEqual((await clocksOf(a)).map((c) => [c.def, c.state, c.dueAt.getTime()]), [['discharge-leave', 'running', leaveDueAt.getTime()]]);
    assert.equal(await m.Clock.countDocuments({ def: 'discharge-summary' }), 0);
    // Past the summary's due time nothing escalates to the duty doctor, and the leave clock still stops.
    assert.equal(await clocks.checkDue(new Date(Date.now() + 2 * H)), 0);
    await reg.send('discharge.completed', caseId, completed(a), 'GWA-12: Patient left (Home)');
    assert.deepEqual((await clocksOf(a)).map((c) => [c.def, c.state]), [['discharge-leave', 'met']]);
    assert.equal(await m.Escalation.countDocuments(), 0);
  });

  test('cancelled stops both clocks', async () => {
    const a = String(new Types.ObjectId());
    await reg.send('discharge.window-opened', caseId, opened(a, new Date(Date.now() + 3 * H), new Date(Date.now() + 90 * MIN)), 'GWA-12: Discharge window opened (Home)');
    await reg.send('discharge.cancelled', caseId, cancelled(a), 'GWA-12: Discharge order cancelled');
    assert.deepEqual((await clocksOf(a)).map((c) => [c.def, c.state]), [['discharge-leave', 'met'], ['discharge-summary', 'met']]);

    // Overdue: each escalates on its own ladder, naming the bed and the kind (A4); the cancel closes both.
    const b = String(new Types.ObjectId());
    await reg.send('discharge.window-opened', caseId, opened(b, new Date(Date.now() - MIN), new Date(Date.now() - 2 * MIN)), 'GWA-12: Discharge window opened (Home)');
    assert.equal(await clocks.checkDue(new Date()), 2);
    const raised = await m.Escalation.find().sort({ ladder: 1 }).lean();
    assert.deepEqual(raised.map((e) => [e.ladder, e.reason, e.alertLink, e.closesOnStop, e.state]), [
      ['discharge', 'Order to leaving overdue — GWA-12 (Home)', `discharge-order:${b}`, true, 'open'],
      ['discharge-doctor', 'Summary signed overdue — GWA-12 (Home)', `discharge-order:${b}:summary`, true, 'open'],
    ]);
    await reg.send('discharge.cancelled', caseId, cancelled(b), 'GWA-12: Discharge order cancelled');
    assert.ok((await clocksOf(b)).every((c) => c.state === 'expired' && c.stoppedAt), 'both stopped');
    const closed = await m.Escalation.find().lean();
    assert.deepEqual(closed.map((e) => [e.state, e.ackByName]), [['acknowledged', 'Discharge Agent'], ['acknowledged', 'Discharge Agent']]);
    const alerts = await m.TaskAlertItem.find({ link: { $in: [`discharge-order:${b}`, `discharge-order:${b}:summary`] } }).lean();
    assert.deepEqual(alerts.map((x) => x.status), ['Completed', 'Completed']);
  });

  test('close check: n/a without an admission, fail while the plan is open, pass once completed, n/a for a sample admission', async () => {
    assert.equal(await closeCheck(), 'n/a', 'no admission on the case');
    assert.equal(await closeCheck('not-an-id'), 'n/a');
    const a = await admission();
    await cases.addRefs(caseId, { admissionId: String(a._id) });
    assert.equal(await closeCheck(), 'fail', 'admitted, no plan yet');
    const p = await plan(a._id);
    for (const state of ['planned', 'ordered', 'ready']) {
      await m.DischargePlan.updateOne({ _id: p._id }, { $set: { state } });
      assert.equal(await closeCheck(), 'fail', state);
    }
    await m.DischargePlan.updateOne({ _id: p._id }, { $set: { state: 'completed' } });
    assert.equal(await closeCheck(), 'pass', 'completed');

    // A sample occupant is not the agent's concern, plan or no plan.
    const other = await m.Patient.create({ uhid: 'MHK202600906', name: 'Mary Jeni', age: 40, gender: 'Female', phone: '9100000006' });
    const otherCase = String((await cases.openOrJoin({ patientId: String(other._id), patientUhid: other.uhid, patientName: other.name, kind: 'ipd', priority: 'medium', openedBy: 'bed' })).case._id);
    const sample = await admission({ patient: new Types.ObjectId(), sample: true });
    await cases.addRefs(otherCase, { admissionId: String(sample._id) });
    assert.equal(await closeCheck(otherCase), 'n/a', 'a sample admission');
  });

  test('close check: an admission discharged before the Discharge Agent, with no plan, passes', async () => {
    const a = await admission({ status: 'discharged', dischargedAt: new Date(), dischargedBy: 'Nurse Anjali Thomas' });
    await cases.addRefs(caseId, { admissionId: String(a._id) });
    assert.equal(await m.DischargePlan.countDocuments(), 0);
    assert.equal(await closeCheck(), 'pass');
    // A plan the old route left open does not hold the case either.
    await plan(a._id, 'ordered');
    assert.equal(await closeCheck(), 'pass');
  });

  test('a wake handler that throws is logged, not rethrown', async () => {
    const seen: string[] = [];
    reg.wake.set('bed.assigned', async (id) => {
      seen.push(id);
      throw new Error('boom');
    });
    const payload = { bedId: String(new Types.ObjectId()), bedLabel: 'GWA-12', admissionId: String(new Types.ObjectId()), ward: 'General ward A' };
    const msg = await messages.send({ case: caseId, from: 'bed', to: ['coordinator'], type: 'bed.assigned', priority: 'medium', summary: 'GWA-12: placed', payload });
    assert.deepEqual(seen, [String(msg!._id)], 'the handler ran once, with the message id');
    assert.deepEqual([msg!.state, msg!.attempts], ['delivered', 0], 'delivered, not retried or failed');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /bed\.assigned/);
    assert.match(logged[0], /boom/);

    // Called directly it resolves too, and a type nobody has filled yet does nothing.
    const handler = (t: string) => def().handles!.find((h) => h.type === t)!.handler;
    await assert.doesNotReject(handler('bed.assigned')(String(new Types.ObjectId())));
    await assert.doesNotReject(handler('lab.resulted')(String(new Types.ObjectId())));
    assert.equal(logged.length, 2);
  });

  test("status: open orders, no capacity, and today's share that left within the target (A5)", async () => {
    reg.clock = () => T0;
    assert.deepEqual(await def().status(), { open: 0, capacity: null, onTimePct: null });
    await order('ordered');
    await order('ready');
    await order('cancelled');
    await order('left', { windowAt: at(9), leftAt: at(10, 30) }); // 90 min
    await order('left', { windowAt: at(10), leftAt: at(12) }); // 120 min: on the target counts as on time
    await order('left', { windowAt: at(11), leftAt: at(13, 30) }); // 150 min: over
    await order('left', { windowAt: at(8, 0, 25), leftAt: at(16, 0, 25) }); // yesterday: not today's
    assert.deepEqual(await def().status(), { open: 2, capacity: null, onTimePct: 67 });
    // The target comes from Settings → Discharge.
    await settings.save(ADMIN, { leaveMinutes: 150 });
    assert.equal((await def().status()).onTimePct, 100);
  });

  test('send: to the Coordinator on the case; a summary naming the patient, or a bad message, is not sent and returns false', async () => {
    const ready = (orderId: string) => ({ orderId, bedLabel: 'GWA-12', kind: 'home' });
    assert.equal(await reg.send('discharge.ready', caseId, ready('o1'), 'GWA-12: Ready to leave (Home)'), true);
    const sent = (await m.AgentMessage.findOne({ type: 'discharge.ready', 'payload.orderId': 'o1' }).lean())!;
    assert.deepEqual([String(sent.case), sent.from, sent.to, sent.priority, sent.summary], [caseId, 'discharge', ['coordinator'], 'medium', 'GWA-12: Ready to leave (Home)']);
    assert.equal(await reg.send('discharge.ready', null, ready('o2'), 'GWA-14: Ready to leave (Home)'), true);
    assert.equal((await m.AgentMessage.findOne({ 'payload.orderId': 'o2' }).lean())!.case, null, 'no case');
    // The same message again within the minute: the Coordinator already has it, so it counts as sent.
    assert.equal(await reg.send('discharge.ready', caseId, ready('o1'), 'GWA-12: Ready to leave (Home)'), true);
    assert.equal(await m.AgentMessage.countDocuments({ 'payload.orderId': 'o1' }), 1);
    assert.equal(logged.length, 0);

    // The case's patient named in the summary, in any case or spacing: refused, and the warning does not repeat the name.
    assert.equal(await reg.send('discharge.ready', caseId, ready('o3'), 'GWA-12: ravi  KUMAR is ready (Home)'), false);
    assert.equal(await m.AgentMessage.countDocuments({ 'payload.orderId': 'o3' }), 0);
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], /ravi|kumar/i);
    // A short name inside a longer word is not the name: "Ann" in "planned".
    const ann = await m.Patient.create({ uhid: 'MHK202600907', name: 'Ann', age: 30, gender: 'Female', phone: '9100000007' });
    const annCase = String((await cases.openOrJoin({ patientId: String(ann._id), patientUhid: ann.uhid, patientName: 'Ann', kind: 'ipd', priority: 'medium', openedBy: 'bed' })).case._id);
    const planned = { planId: 'p4', admissionId: String(new Types.ObjectId()), bedLabel: 'GWA-15', targetDay: '2026-09-29' };
    assert.equal(await reg.send('discharge.planned', annCase, planned, 'GWA-15: Discharge planned for 29 Sep'), true);

    // A message the Coordinator refuses (a field missing, a type of no agent): false, never a throw.
    assert.equal(await reg.send('discharge.ready', caseId, { orderId: 'o5', bedLabel: 'GWA-12' }, 'GWA-12: Ready to leave (Home)'), false);
    assert.equal(await reg.send('discharge.nope', caseId, ready('o6'), 'GWA-12: Ready to leave (Home)'), false);
    assert.equal(logged.length, 3);
    assert.match(logged[1], /discharge\.ready/);
    assert.match(logged[2], /discharge\.nope/);
  });
});
