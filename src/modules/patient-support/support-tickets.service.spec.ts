import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { SUPPORT_ACTOR } from './support-catalogue';
import { SupportSettingsService } from './support-settings.service';
import { SupportTicketsService } from './support-tickets.service';

const MIN = 60_000;
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);
const frontDesk = { id: 'u-desk', name: 'Anita Desk', role: UserRole.STAFF };

describe('SupportTicketsService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let clocks: ClocksService;
  let escalations: EscalationsService;
  let cases: CasesService;
  let svc: SupportTicketsService;
  let patient: any;
  let caseId: string;
  let now: Date;

  const input = (extra: Record<string, unknown> = {}) => ({
    patientId: String(patient._id),
    callerName: 'Suresh Kumar',
    callerPhone: '9100000007',
    ticketType: 'billing',
    question: 'Why is the bill so high?',
    source: 'desk',
    ...extra
  });
  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean();
  const clocksOf = (ref: string) => m.Clock.find({ ref }).sort({ def: 1 }).lean();
  const alertOf = (id: string) => m.TaskAlertItem.findOne({ link: `support-ticket:${id}:urgent` }).lean();

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
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const settings = new SettingsService(m.HospitalSettings);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const reg = new SupportRegistration(registry, messages, m.SupportTicket, m.CheckupCall);
    reg.onModuleInit();
    const facts = new SupportFactsService(
      m.Patient,
      m.Admission,
      m.Bed,
      m.Ward,
      m.ProcedureBooking,
      m.ErVisit,
      m.DischargeOrder,
      m.DischargePlan,
      m.Case,
      new TimelineService(m.TimelineEvent)
    );
    svc = new SupportTicketsService(
      reg,
      new SupportSettingsService(settings),
      facts,
      cases,
      escalations,
      m.SupportTicket,
      m.TaskAlertItem,
      m.CoordinatorCounter,
      m.AgentCall,
      m.Patient
    );
    now = at(10);
    svc.now = () => now;
    patient = await m.Patient.create({ uhid: 'MHK202600905', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000005' });
    caseId = String(
      (
        await cases.openOrJoin({
          patientId: String(patient._id),
          patientUhid: patient.uhid,
          patientName: 'Ravi Kumar',
          kind: 'ipd',
          priority: 'medium',
          openedBy: 'bed'
        })
      ).case._id
    );
  });

  test('a desk ticket gets SP-0001, the owner from its type, a case when the patient has one, and the opened message', async () => {
    const t = await svc.open(frontDesk, input());
    assert.equal(t.number, 'SP-0001');
    assert.deepEqual([t.owner, t.ladder, t.round, t.state, t.shown, t.channel, t.case], ['billing', 'support-billing', 1, 'open', 'Open', 'desk', caseId]);
    assert.equal(t.dueAt.getTime(), at(14).getTime());
    const [msg] = await sent('support.ticket-opened');
    assert.equal(msg.summary, 'SP-0001 opened: Billing');
    assert.equal(String(msg.case), caseId);
    assert.deepEqual([msg.payload.ladder, msg.payload.round, msg.payload.ticketType], ['support-billing', 1, 'billing']);
    assert.deepEqual(
      (await clocksOf(`${t.id}:1`)).map((c) => [c.def, c.state]),
      [['support-response-billing', 'running']]
    );
    assert.equal((await svc.open(frontDesk, input({ ticketType: 'appointment' }))).number, 'SP-0002');
    const line = await m.TimelineEvent.findOne({ title: 'Ticket SP-0001 opened: Billing' }).lean();
    assert.deepEqual([line?.category, line?.subtitle, line?.uhid], ['Communication', 'Why is the bill so high?', 'MHK202600905']);
    // No patient: no case, no timeline; a closed case is not used.
    const anon = await svc.open(frontDesk, { ...input({ ticketType: 'other' }), patientId: undefined });
    assert.equal(anon.case, null);
    await m.Case.updateOne({ _id: caseId }, { $set: { state: 'closed' } });
    assert.equal((await svc.open(frontDesk, input())).case, null);
    await assert.rejects(svc.open({ id: 'x', name: 'Lab', role: UserRole.LAB }, input()), ForbiddenException);
    await assert.rejects(svc.open(frontDesk, input({ callerName: '  ' })), /caller name/);
    await assert.rejects(svc.open(frontDesk, input({ ticketType: 'nope' })), /ticket type/);
    await assert.rejects(svc.open(frontDesk, input({ source: 'call-back', channel: 'phone' })), /channel/);
  });

  test('on the spot: resolved at once, no clock, left out of the average', async () => {
    await assert.rejects(svc.open(frontDesk, input({ onTheSpot: true })), /answer given/);
    const t = await svc.open(frontDesk, input({ onTheSpot: true, resolution: 'Explained the bill at the desk' }));
    assert.deepEqual(
      [t.state, t.onTheSpot, t.shown, t.answeredAt, t.firstResponseMinutes, t.resolvedByName],
      ['resolved', true, 'Resolved', null, null, 'Anita Desk']
    );
    assert.equal(await m.AgentMessage.countDocuments({ type: 'support.ticket-opened' }), 0);
    assert.equal(await m.AgentMessage.countDocuments({ type: 'support.ticket-resolved' }), 1);
    assert.equal(await m.Clock.countDocuments(), 0);
    await assert.rejects(svc.note(frontDesk, t.id, 'late'), ConflictException);
  });

  test('urgent at 02:00: an immediate Critical alert naming the owner title and its holders, due 02:30', async () => {
    const holder = await m.User.create({ name: 'Dr Duty', email: 'duty@x.in', passwordHash: 'x', role: UserRole.DOCTOR });
    await m.DutyTitle.updateOne({ key: 'duty-doctor' }, { $set: { holders: [holder._id] } });
    now = at(2);
    const t = await svc.open(frontDesk, input({ ticketType: 'clinical', urgent: true, channel: 'phone' }));
    assert.equal(t.dueAt.getTime(), at(2, 30).getTime());
    assert.equal((await sent('support.ticket-opened'))[0].summary, 'SP-0001 opened: Clinical (Urgent)');
    const a = (await alertOf(t.id))!;
    assert.deepEqual(
      [a.title, a.subtitle, a.type, a.category, a.priority, a.status, a.patientName, a.uhid],
      [
        'Urgent ticket SP-0001 for Duty doctor: Clinical',
        'Dr Duty · Phone',
        'Patient Communication',
        'Critical',
        'High',
        'Pending',
        'Ravi Kumar',
        'MHK202600905'
      ]
    );
    assert.doesNotMatch(a.title, /Ravi/);
    // Desk owner: "Front desk"; a title nobody holds and no admin exists: "Admins".
    const d = await svc.open(frontDesk, input({ ticketType: 'appointment', urgent: true }));
    assert.equal((await alertOf(d.id))!.subtitle, 'Front desk · Desk');
    const b = await svc.open(frontDesk, input({ ticketType: 'billing', urgent: true }));
    assert.equal((await alertOf(b.id))!.subtitle, 'Admins · Desk');
    // Answering completes it.
    await svc.note(frontDesk, t.id, 'Calling back');
    assert.equal((await alertOf(t.id))!.status, 'Completed');
  });

  test('normal billing at 19:00: due 11:00 next day', async () => {
    now = at(19);
    const t = await svc.open(frontDesk, input());
    assert.equal(t.dueAt.getTime(), at(11, 0, 27).getTime());
  });

  test('a note answers the round once; a second note sends nothing', async () => {
    const t = await svc.open(frontDesk, input());
    now = new Date(now.getTime() + 25 * MIN);
    const a = await svc.note(frontDesk, t.id, 'Checking with accounts');
    assert.deepEqual([a.firstResponseMinutes, a.roundAnsweredAt?.getTime(), a.answeredAt?.getTime()], [25, now.getTime(), now.getTime()]);
    assert.equal((await sent('support.ticket-answered')).length, 1);
    assert.equal((await sent('support.ticket-answered'))[0].summary, 'SP-0001 answered');
    assert.deepEqual(
      (await clocksOf(`${t.id}:1`)).map((c) => c.state),
      ['met']
    );
    now = new Date(now.getTime() + 10 * MIN);
    const b = await svc.note(frontDesk, t.id, 'Still checking');
    assert.equal((await sent('support.ticket-answered')).length, 1);
    assert.equal(b.firstResponseMinutes, 25);
    assert.equal(b.notes.length, 2);
    // A state change on an unanswered ticket is a first response too.
    const u = await svc.open(frontDesk, input({ ticketType: 'appointment' }));
    const w = await svc.setState(frontDesk, u.id, 'waiting');
    assert.deepEqual([w.state, w.shown, w.roundAnsweredAt !== null], ['waiting', 'Waiting on caller', true]);
    await assert.rejects(svc.setState(frontDesk, u.id, 'resolved' as any), /In progress/);
  });

  test('hand on before an answer: the old clock stops, the new ladder clock starts with a fresh due time, the urgent alert names the new owner, and a later answer counts from the first opening', async () => {
    const titleHolder = await m.User.create({ name: 'Ward Sister', email: 'w@x.in', passwordHash: 'x', role: UserRole.NURSE });
    await m.DutyTitle.updateOne({ key: 'ward-nurse-in-charge' }, { $set: { holders: [titleHolder._id] } });
    const t = await svc.open(frontDesk, input({ ticketType: 'billing', urgent: true }));
    assert.match((await alertOf(t.id))!.title, /for Billing in charge: Billing/);
    await assert.rejects(svc.handOn(frontDesk, t.id, 'billing'), /already has that type/);
    now = new Date(now.getTime() + 20 * MIN);
    const h = await svc.handOn(frontDesk, t.id, 'admission', 'Ward question');
    assert.deepEqual([h.round, h.owner, h.ladder, h.ticketType, h.answeredAt, h.roundAnsweredAt], [2, 'ward', 'support-ward', 'admission', null, null]);
    assert.equal(h.dueAt.getTime(), now.getTime() + 30 * MIN);
    const answered = await sent('support.ticket-answered');
    assert.deepEqual([answered.length, answered[0].payload.handedOn, answered[0].payload.round, answered[0].summary], [1, true, 1, 'SP-0001 handed on']);
    const opened = await sent('support.ticket-opened');
    assert.deepEqual(
      [opened.length, opened[1].payload.ladder, opened[1].payload.round, opened[1].summary],
      [2, 'support-ward', 2, 'SP-0001 handed on to Ward nurse in charge']
    );
    assert.deepEqual(
      (await clocksOf(`${t.id}:1`)).map((c) => [c.def, c.state]),
      [['support-response-billing', 'met']]
    );
    const c2 = await clocksOf(`${t.id}:2`);
    assert.deepEqual(
      c2.map((c) => [c.def, c.state, c.dueAt.getTime()]),
      [['support-response-ward', 'running', h.dueAt.getTime()]]
    );
    const a = (await alertOf(t.id))!;
    assert.deepEqual([a.title, a.subtitle, a.status], ['Urgent ticket SP-0001 for Ward nurse in charge: Admission & ward', 'Ward Sister · Desk', 'Pending']);
    now = new Date(now.getTime() + 15 * MIN);
    const done = await svc.note(frontDesk, t.id, 'On it');
    assert.equal(done.firstResponseMinutes, 35);
    assert.equal((await alertOf(t.id))!.status, 'Completed');
  });

  test('hand on after an answer keeps answeredAt and starts round 2', async () => {
    const t = await svc.open(frontDesk, input());
    now = new Date(now.getTime() + 10 * MIN);
    const a = await svc.note(frontDesk, t.id, 'Looking');
    now = new Date(now.getTime() + 60 * MIN);
    const h = await svc.handOn(frontDesk, t.id, 'complaint');
    assert.deepEqual([h.round, h.answeredAt?.getTime(), h.firstResponseMinutes, h.roundAnsweredAt, h.state], [2, a.answeredAt?.getTime(), 10, null, 'open']);
    assert.equal((await sent('support.ticket-answered')).length, 1, 'no second answered message');
    const opened = await sent('support.ticket-opened');
    assert.equal(opened.length, 2);
    assert.deepEqual([opened[1].payload.ladder, h.owner], ['patient-support', 'relations']);
    // A second answer in round 2 does not move firstResponseMinutes.
    now = new Date(now.getTime() + 5 * MIN);
    const n = await svc.note(frontDesk, t.id, 'Relations here');
    assert.equal(n.firstResponseMinutes, 10);
    assert.equal((await sent('support.ticket-answered')).length, 2);
  });

  test('resolve needs a resolution; resolving twice is 409', async () => {
    const t = await svc.open(frontDesk, input({ urgent: true }));
    await assert.rejects(svc.resolve(frontDesk, t.id, '  '), /resolution/);
    await assert.rejects(svc.resolve(frontDesk, t.id, 'x'.repeat(1001)), /1000/);
    now = new Date(now.getTime() + 12 * MIN);
    const r = await svc.resolve(frontDesk, t.id, 'Bill explained and corrected');
    assert.deepEqual(
      [r.state, r.shown, r.resolution, r.firstResponseMinutes, r.roundAnsweredAt !== null],
      ['resolved', 'Resolved', 'Bill explained and corrected', 12, true]
    );
    assert.equal((await sent('support.ticket-resolved')).length, 1);
    assert.equal((await sent('support.ticket-resolved'))[0].summary, 'SP-0001 resolved');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'support.ticket-answered' }), 0);
    assert.equal((await alertOf(t.id))!.status, 'Completed');
    assert.deepEqual(
      (await clocksOf(`${t.id}:1`)).map((c) => c.state),
      ['met']
    );
    const line = await m.TimelineEvent.findOne({ title: 'Ticket SP-0001 resolved' }).lean();
    assert.equal(line?.subtitle, 'Bill explained and corrected');
    await assert.rejects(svc.resolve(frontDesk, t.id, 'again'), new ConflictException('This ticket is already resolved.'));
    await assert.rejects(svc.handOn(frontDesk, t.id, 'other'), ConflictException);
    await assert.rejects(svc.setState(frontDesk, t.id, 'waiting'), ConflictException);
  });

  test('markEscalated flags only unanswered rounds past due', async () => {
    const late = await svc.open(frontDesk, input({ ticketType: 'clinical' })); // due 10:30
    const answered = await svc.open(frontDesk, input({ ticketType: 'clinical' }));
    const fine = await svc.open(frontDesk, input({ ticketType: 'billing' })); // due 14:00
    const done = await svc.open(frontDesk, input({ ticketType: 'clinical' }));
    await svc.note(frontDesk, answered.id, 'seen');
    await svc.resolve(frontDesk, done.id, 'done');
    assert.equal(await svc.markEscalated(at(10, 45)), 1);
    const rows = await svc.list({});
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(late.id)!.shown, 'Escalated');
    assert.equal(byId.get(answered.id)!.shown, 'Open');
    assert.equal(byId.get(fine.id)!.shown, 'Open');
    assert.equal(await svc.markEscalated(at(10, 45)), 0, 'once');
    assert.deepEqual(
      (await svc.list({ shown: 'escalated' })).map((r) => r.id),
      [late.id]
    );
    // Answering clears the shown Escalated.
    const n = await svc.note(frontDesk, late.id, 'sorry');
    assert.deepEqual([n.shown, n.escalatedAt], ['Open', null]);
  });

  test('the same providerCallId opens one ticket; attachCall adds the transcript', async () => {
    const a = await svc.open(SUPPORT_ACTOR, input({ source: 'call-back', providerCallId: 'call-1', patientId: undefined, ticketType: 'other' }));
    const b = await svc.open(SUPPORT_ACTOR, input({ source: 'call-unanswered', providerCallId: 'call-1', patientId: undefined, ticketType: 'other' }));
    assert.equal(b.id, a.id);
    assert.equal(await m.SupportTicket.countDocuments(), 1);
    assert.equal(a.channel, 'phone');
    assert.deepEqual((await svc.detail(a.id)).transcript, []);
    const [call] = await m.AgentCall.insertMany(
      [
        {
          providerCallId: 'call-1',
          transcript: [
            { speaker: 'agent', text: 'Hello' },
            { speaker: 'patient', text: 'My bill' }
          ]
        }
      ],
      { lean: true }
    );
    await svc.attachCall('call-1', String(call._id));
    assert.deepEqual((await svc.detail(a.id)).transcript, [
      { speaker: 'agent', text: 'Hello' },
      { speaker: 'patient', text: 'My bill' }
    ]);
  });

  test('no name in any support message summary', async () => {
    const t = await svc.open(frontDesk, input({ urgent: true }));
    await svc.note(frontDesk, t.id, 'ok');
    await svc.handOn(frontDesk, t.id, 'clinical');
    await svc.resolve(frontDesk, t.id, 'done');
    await svc.open(frontDesk, input({ onTheSpot: true, resolution: 'told' }));
    const all = await m.AgentMessage.find({ type: /^support\./ }).lean();
    assert.ok(all.length === 5);
    for (const x of all) assert.doesNotMatch(x.summary, /ravi|kumar|suresh/i, x.summary);
    // A summary with the name is refused by the registration, so it can never be written.
    const alerts = await m.TaskAlertItem.find({ link: /^support-ticket:/ }).lean();
    for (const a of alerts) assert.doesNotMatch(a.title, /ravi|kumar|suresh/i);
  });
});
