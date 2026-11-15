import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentStatusService } from '../coordinator/agent-status.service';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { validatePayload } from '../coordinator/coordinator-types';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { SUPPORT_CLOCKS, SUPPORT_MESSAGE_TYPES, SupportRegistration, WAKE_TYPES } from './support-coordinator.registration';

const MIN = 60_000;
/** "Now" for the status test: 26 Sep 2026, 15:00 local. */
const T0 = new Date(2026, 8, 26, 15, 0, 0, 0);
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);

describe('SupportRegistration', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let clocks: ClocksService;
  let cases: CasesService;
  let rules: RulesService;
  let reg: SupportRegistration;
  let events: CoordinatorEvents;
  let logged: string[];
  let patientId: Types.ObjectId;
  let caseId: string;

  const def = () => registry.get('patient-support')!;
  const opened = (ticketId: string, ladder: string, dueAt: Date, round = 1, ticketType = 'billing', number = 'SP-0001') => ({
    ticketId,
    number,
    ticketType,
    priority: 'normal',
    ladder,
    round,
    dueAt
  });
  const answered = (ticketId: string, round = 1, handedOn = false, number = 'SP-0001') => ({ ticketId, number, round, handedOn });
  const clocksOf = (ref: string) => m.Clock.find({ ref }).sort({ def: 1 }).lean();
  const ticket = (extra: Record<string, unknown> = {}) =>
    m.SupportTicket.create({
      number: `SP-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
      ticketType: 'billing',
      owner: 'billing',
      ladder: 'support-billing',
      source: 'desk',
      question: 'Q',
      openedById: 'u1',
      openedByName: 'Anita',
      openedAt: T0,
      dueAt: at(18),
      ...extra
    });
  const checkup = (state: string) =>
    m.CheckupCall.create({
      number: `CK-${Math.floor(Math.random() * 1e9)}`,
      sourceKey: String(new Types.ObjectId()),
      patient: patientId,
      patientUhid: 'MHK202600905',
      patientName: 'Ravi Kumar',
      kind: 'home',
      leftAt: T0,
      dueDay: '2026-09-28',
      group: 'general',
      state
    });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const settingsService = new SettingsService(m.HospitalSettings);
    rules = new RulesService(registry, settingsService, events);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    reg = new SupportRegistration(registry, messages, m.SupportTicket, m.CheckupCall);
    logged = [];
    (reg as any).logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    reg.onModuleInit();
    const p = await m.Patient.create({ uhid: 'MHK202600905', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000005' });
    patientId = p._id as Types.ObjectId;
    caseId = String(
      (await cases.openOrJoin({ patientId: String(p._id), patientUhid: p.uhid, patientName: 'Ravi Kumar', kind: 'ipd', priority: 'medium', openedBy: 'bed' }))
        .case._id
    );
  });

  test('registers nine message types, five clocks, two rules and no close check', async () => {
    assert.deepEqual(
      SUPPORT_MESSAGE_TYPES.map((t) => t.type),
      [
        'support.update-sent',
        'support.update-skipped',
        'support.ticket-opened',
        'support.ticket-answered',
        'support.ticket-resolved',
        'support.checkup-done',
        'support.checkup-worrying',
        'support.checkup-reviewed',
        'support.complaint'
      ]
    );
    assert.ok(registry.isBuilt('patient-support'));
    for (const t of SUPPORT_MESSAGE_TYPES) assert.equal(registry.messageType(t.type)?.agent, 'patient-support', t.type);
    const open = registry.messageType('support.ticket-opened')!;
    assert.deepEqual(open.payload, {
      ticketId: 'string',
      number: 'string',
      ticketType: 'string',
      priority: 'string',
      ladder: 'string',
      round: 'number',
      dueAt: 'date'
    });
    assert.deepEqual(validatePayload(open, opened('t1', 'support-billing', new Date())), []);
    assert.deepEqual(validatePayload(open, { ...opened('t1', 'support-billing', new Date()), round: null }), ['support.ticket-opened: "round" is missing']);
    assert.deepEqual(registry.messageType('support.ticket-answered')!.payload, { ticketId: 'string', number: 'string', round: 'number', handedOn: 'boolean' });
    assert.deepEqual(registry.messageType('support.checkup-worrying')!.payload, { checkupId: 'string', number: 'string', dueAt: 'date' });
    assert.deepEqual(registry.messageType('support.complaint')!.payload, { feedbackId: 'string', ticketId: 'string', number: 'string' });

    assert.deepEqual(
      SUPPORT_CLOCKS.map((c) => c.key),
      ['support-response', 'support-response-billing', 'support-response-ward', 'support-response-clinical', 'support-checkup-doctor']
    );
    assert.deepEqual(
      def().clocks!.map((c) => c.key),
      SUPPORT_CLOCKS.map((c) => c.key)
    );
    const rows = SUPPORT_CLOCKS.map((c) => [c.key, c.label, c.startOn, c.stopOn, c.minutes, c.ladder, c.resolveEscalationOnStop, c.resolvedBy]);
    const resp = ['support.ticket-answered', 'support.ticket-resolved'];
    assert.deepEqual(rows, [
      ['support-response', 'First response', 'support.ticket-opened', resp, 240, 'patient-support', true, 'Ticket answered'],
      ['support-response-billing', 'First response', 'support.ticket-opened', resp, 240, 'support-billing', true, 'Ticket answered'],
      ['support-response-ward', 'First response', 'support.ticket-opened', resp, 240, 'support-ward', true, 'Ticket answered'],
      ['support-response-clinical', 'First response', 'support.ticket-opened', resp, 30, 'support-clinical', true, 'Ticket answered'],
      ['support-checkup-doctor', 'Doctor review', 'support.checkup-worrying', ['support.checkup-reviewed'], 60, 'support-clinical', true, 'Doctor reviewed']
    ]);
    const billing = registry.clock('support-response-billing')!;
    assert.equal(billing.refFrom!('support.ticket-opened', { ticketId: 't1', round: 2 }), 't1:2');
    assert.equal(billing.refFrom!('support.ticket-opened', { ticketId: 't1' }), null);
    assert.equal(billing.alertLink!('t1:2'), 'support-ticket:t1:2');
    assert.equal(billing.alertLink!(null), null);
    assert.equal(billing.detailFrom!({ number: 'SP-0001', ticketType: 'billing' }), 'SP-0001 (Billing)');
    assert.equal(billing.detailFrom!({ number: 'SP-0001', ticketType: 'constructor' }), 'SP-0001');
    assert.equal(billing.match!('support.ticket-opened', { ladder: 'support-billing' }), true);
    assert.equal(billing.match!('support.ticket-opened', { ladder: 'support-ward' }), false);
    assert.equal(billing.match!('support.ticket-answered', { ladder: 'support-ward' }), true);
    const due = new Date('2026-09-26T08:00:00.000Z');
    assert.equal(billing.dueFrom!({ dueAt: due.toISOString() })!.getTime(), due.getTime());
    assert.equal(billing.dueFrom!({ dueAt: 'nope' }), null);
    const doc = registry.clock('support-checkup-doctor')!;
    assert.equal(doc.refFrom!('support.checkup-worrying', { checkupId: 'c1' }), 'c1');
    assert.equal(doc.alertLink!('c1'), 'support-checkup:c1');
    assert.equal(doc.detailFrom!({ number: 'CK-0001' }), 'CK-0001 (needs doctor)');

    assert.deepEqual(def().rules, [
      {
        key: 'support-consent',
        agent: 'patient-support',
        label: 'Never send without consent',
        description: 'Family updates go only to patients whose consent is recorded.',
        default: true,
        locked: true
      },
      {
        key: 'support-auto-updates',
        agent: 'patient-support',
        label: 'Send family updates automatically',
        description: 'When it is off, updates wait as Held for staff to send.',
        default: true
      }
    ]);
    assert.equal(def().closeChecks, undefined);
    assert.deepEqual(
      registry.closeChecks().filter((c) => c.agent === 'patient-support'),
      []
    );
    assert.deepEqual(
      [...WAKE_TYPES],
      [
        'bed.assigned',
        'bed.transferred',
        'scheduling.procedure-booked',
        'scheduling.procedure-done',
        'revenue.estimate-ready',
        'revenue.bill-final',
        'discharge.completed',
        'scheduling.followup-booked'
      ]
    );
    assert.deepEqual(
      def().handles!.map((h) => h.type),
      [...WAKE_TYPES]
    );
    assert.ok((await rules.list()).some((r) => r.key === 'support-consent' && r.locked));
  });

  test("a billing ticket's opened message starts only support-response-billing, due at the payload's dueAt", async () => {
    const t = String(new Types.ObjectId());
    const dueAt = new Date(Date.now() + 90 * MIN); // not the 240 minute fallback
    assert.equal(await reg.send('support.ticket-opened', null, opened(t, 'support-billing', dueAt), 'SP-0001 opened: Billing (Normal)'), true);
    const rows = await clocksOf(`${t}:1`);
    assert.deepEqual(
      rows.map((c) => [c.def, c.state, c.dueAt.getTime(), c.detail]),
      [['support-response-billing', 'running', dueAt.getTime(), 'SP-0001 (Billing)']]
    );
    assert.equal(await m.Clock.countDocuments(), 1);
  });

  test("answered stops the round's clock; resolved stops it too; a later round's clock is separate", async () => {
    const a = String(new Types.ObjectId());
    const dueAt = new Date(Date.now() + 90 * MIN);
    await reg.send('support.ticket-opened', null, opened(a, 'support-ward', dueAt, 1, 'admission'), 'SP-0001 opened');
    await reg.send('support.ticket-answered', null, answered(a, 1, true), 'SP-0001 answered');
    assert.deepEqual(
      (await clocksOf(`${a}:1`)).map((c) => [c.def, c.state]),
      [['support-response-ward', 'met']]
    );
    // Hand on: a new round starts its own clock on another ladder.
    await reg.send('support.ticket-opened', null, opened(a, 'support-billing', dueAt, 2), 'SP-0001 opened round 2');
    assert.deepEqual(
      (await clocksOf(`${a}:2`)).map((c) => [c.def, c.state]),
      [['support-response-billing', 'running']]
    );
    assert.deepEqual(
      (await clocksOf(`${a}:1`)).map((c) => c.state),
      ['met'],
      'round 1 stays as it was'
    );
    // Resolved stops the round that is running, and only it.
    await reg.send('support.ticket-resolved', null, { ticketId: a, number: 'SP-0001', round: 2 }, 'SP-0001 resolved');
    assert.deepEqual(
      (await clocksOf(`${a}:2`)).map((c) => c.state),
      ['met']
    );
    // Another ticket's answer does not stop this one.
    const b = String(new Types.ObjectId());
    await reg.send('support.ticket-opened', null, opened(b, 'patient-support', dueAt, 1, 'appointment'), 'SP-0002 opened');
    await reg.send('support.ticket-answered', null, answered(String(new Types.ObjectId())), 'SP-0003 answered');
    assert.deepEqual(
      (await clocksOf(`${b}:1`)).map((c) => [c.def, c.state]),
      [['support-response', 'running']]
    );
  });

  test('an expired response clock escalates on the ticket ladder with "First response overdue — SP-0001 (Billing)" and link support-ticket:<id>:1', async () => {
    const t = String(new Types.ObjectId());
    await reg.send('support.ticket-opened', null, opened(t, 'support-billing', new Date(Date.now() - MIN)), 'SP-0001 opened: Billing (Normal)');
    assert.equal(await clocks.checkDue(new Date()), 1);
    const raised = await m.Escalation.find().lean();
    assert.deepEqual(
      raised.map((e) => [e.ladder, e.reason, e.alertLink, e.closesOnStop, e.state]),
      [['support-billing', 'First response overdue — SP-0001 (Billing)', `support-ticket:${t}:1`, true, 'open']]
    );
  });

  test('answered after expiry closes the escalation ("Ticket answered")', async () => {
    const t = String(new Types.ObjectId());
    await reg.send('support.ticket-opened', null, opened(t, 'support-billing', new Date(Date.now() - MIN)), 'SP-0001 opened: Billing (Normal)');
    await clocks.checkDue(new Date());
    await reg.send('support.ticket-answered', null, answered(t), 'SP-0001 answered');
    const esc = await m.Escalation.find().lean();
    assert.deepEqual(
      esc.map((e) => [e.state, e.ackByName]),
      [['acknowledged', 'Ticket answered']]
    );
    const alerts = await m.TaskAlertItem.find({ link: `support-ticket:${t}:1` }).lean();
    assert.deepEqual(
      alerts.map((x) => x.status),
      ['Completed']
    );
  });

  test('checkup-worrying starts the doctor clock (60 min); reviewed stops it', async () => {
    const c = String(new Types.ObjectId());
    const dueAt = new Date(Date.now() + 45 * MIN);
    assert.equal(await reg.send('support.checkup-worrying', caseId, { checkupId: c, number: 'CK-0001', dueAt }, 'CK-0001: needs a doctor'), true);
    assert.deepEqual(
      (await clocksOf(c)).map((x) => [x.def, x.state, x.dueAt.getTime(), x.detail]),
      [['support-checkup-doctor', 'running', dueAt.getTime(), 'CK-0001 (needs doctor)']]
    );
    await reg.send('support.checkup-worrying', caseId, { checkupId: 'c2', number: 'CK-0002', dueAt }, 'CK-0002: needs a doctor');
    await reg.send('support.checkup-reviewed', caseId, { checkupId: c, number: 'CK-0001' }, 'CK-0001: reviewed');
    assert.deepEqual(
      (await clocksOf(c)).map((x) => x.state),
      ['met']
    );
    assert.deepEqual(
      (await clocksOf('c2')).map((x) => x.state),
      ['running']
    );
  });

  test('status: open counts unresolved tickets plus due check-ups', async () => {
    reg.clock = () => T0;
    assert.deepEqual(await def().status(), { open: 0, capacity: null, onTimePct: null });
    await ticket({ state: 'open' });
    await ticket({ state: 'in-progress' });
    await ticket({ state: 'waiting' });
    await ticket({ state: 'resolved' });
    await checkup('scheduled');
    await checkup('due');
    await checkup('calling');
    await checkup('completed');
    await checkup('not-reached');
    assert.deepEqual(await def().status(), { open: 5, capacity: null, onTimePct: null });
    // Answered today: two by their due time (on it counts), one late; yesterday's does not count.
    await ticket({ roundAnsweredAt: at(10), dueAt: at(11) });
    await ticket({ roundAnsweredAt: at(11), dueAt: at(11) });
    await ticket({ roundAnsweredAt: at(13), dueAt: at(12) });
    await ticket({ roundAnsweredAt: at(9, 0, 25), dueAt: at(8, 0, 25) });
    assert.deepEqual(await def().status(), { open: 9, capacity: null, onTimePct: 67 });
  });

  test('a wake handler that throws is logged, not rethrown; the next handler for the type still runs', async () => {
    const seen: string[] = [];
    reg.onWake('discharge.completed', async (id) => {
      seen.push(`first:${id}`);
      throw new Error('boom');
    });
    reg.onWake('discharge.completed', async (id) => {
      seen.push(`second:${id}`);
    });
    const payload = { planId: 'p1', orderId: '', admissionId: String(new Types.ObjectId()), bedLabel: 'GWA-12', kind: 'home', leftAt: new Date() };
    // discharge.completed is another agent's type: register a stub so the message can be sent.
    registry.register({
      key: 'discharge',
      messageTypes: [
        {
          type: 'discharge.completed',
          agent: 'discharge',
          description: 'x',
          payload: { planId: 'string', orderId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', leftAt: 'date' }
        }
      ],
      status: async () => ({ open: 0, capacity: null, onTimePct: null })
    });
    const msg = await messages.send({
      case: caseId,
      from: 'discharge',
      to: ['coordinator'],
      type: 'discharge.completed',
      priority: 'medium',
      summary: 'GWA-12: left',
      payload
    });
    assert.deepEqual(seen, [`first:${msg!._id}`, `second:${msg!._id}`]);
    assert.deepEqual([msg!.state, msg!.attempts], ['delivered', 0]);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /discharge\.completed/);
    assert.match(logged[0], /boom/);
    // A type nobody has a handler for does nothing.
    const handler = def().handles!.find((h) => h.type === 'bed.assigned')!.handler;
    await assert.doesNotReject(handler(String(new Types.ObjectId())));
    assert.equal(logged.length, 1);
  });

  test('send: to the Coordinator; a summary naming the patient is refused; a bad message returns false', async () => {
    const done = (id: string) => ({ ticketId: id, number: 'SP-0001', round: 1 });
    assert.equal(await reg.send('support.ticket-resolved', caseId, done('t1'), 'SP-0001 resolved', 'Ravi Kumar'), true);
    const sent = (await m.AgentMessage.findOne({ type: 'support.ticket-resolved' }).lean())!;
    assert.deepEqual([String(sent.case), sent.from, sent.to, sent.priority], [caseId, 'patient-support', ['coordinator'], 'medium']);
    assert.equal(logged.length, 0);
    // The name in the summary, in any case or spacing: refused, logged without the name.
    assert.equal(await reg.send('support.ticket-resolved', caseId, done('t2'), 'ravi  KUMAR asked about the bill', 'Ravi Kumar'), false);
    assert.equal(await m.AgentMessage.countDocuments({ 'payload.ticketId': 't2' }), 0);
    assert.equal(logged.length, 1);
    assert.doesNotMatch(logged[0], /ravi|kumar/i);
    // Part of a longer word is not the name.
    assert.equal(await reg.send('support.ticket-resolved', caseId, done('t3'), 'SP-0003 planned', 'Ann'), true);
    // Refused by the Coordinator: false, never a throw.
    assert.equal(await reg.send('support.ticket-resolved', caseId, { ticketId: 't4', number: 'SP-0004' }, 'SP-0004 resolved'), false);
    assert.equal(await reg.send('support.nope', null, {}, 'x'), false);
    assert.equal(logged.length, 3);
  });

  test('the hub reports patient-support as built once registered', async () => {
    const fresh = new AgentRegistry();
    const status = new AgentStatusService(fresh, new CoordinatorEvents());
    assert.equal(status.list().find((a) => a.key === 'patient-support')!.built, false);
    new SupportRegistration(fresh, messages, m.SupportTicket, m.CheckupCall).onModuleInit();
    await status.poll(new Date());
    const view = status.list().find((a) => a.key === 'patient-support')!;
    assert.equal(view.built, true);
    assert.equal(view.online, true);
    assert.equal(fresh.isBuilt('patient-support'), true);
  });
});
