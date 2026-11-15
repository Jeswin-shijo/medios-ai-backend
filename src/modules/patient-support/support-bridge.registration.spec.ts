import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { InboundService } from '../calls/inbound.service';
import { SlotsService } from '../calls/slots.service';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { SettingsService } from '../settings/settings.service';
import { SupportBridge } from '../support-bridge/support-bridge';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { TimelineService } from '../timeline/timeline.service';
import { SupportBridgeRegistration } from './support-bridge.registration';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { SupportSettingsService } from './support-settings.service';
import { SupportTextsService } from './support-texts.service';
import { SupportTicketsService } from './support-tickets.service';

describe('SupportBridgeRegistration (Patient Support up behind the phone agent)', () => {
  const m = models();
  let inbound: InboundService;
  let tickets: SupportTicketsService;
  let bridge: SupportBridge;
  let expected: { actor: any; input: any }[];
  let failEr: boolean;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    expected = [];
    failEr = false;
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const settings = new SettingsService(m.HospitalSettings);
    const supportSettings = new SupportSettingsService(settings);
    const timeline = new TimelineService(m.TimelineEvent);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, timeline);
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
      timeline
    );
    tickets = new SupportTicketsService(
      reg,
      supportSettings,
      facts,
      cases,
      escalations,
      m.SupportTicket,
      m.TaskAlertItem,
      m.CoordinatorCounter,
      m.AgentCall,
      m.Patient
    );
    const texts = new SupportTextsService(m.SupportTemplate, m.SupportFaq, settings, supportSettings);
    await texts.ensureDefaults();
    const fakeEr = {
      addExpected: async (actor: any, input: any) => {
        if (failEr) throw new Error('ER is down');
        expected.push({ actor, input });
        return {};
      }
    };
    bridge = new SupportBridge();
    new SupportBridgeRegistration(bridge, tickets, texts, fakeEr as never, m.Patient).onModuleInit();
    inbound = new InboundService(
      m.AgentCall,
      m.InboundSession,
      m.CallerLookup,
      m.Appointment,
      m.Patient,
      new AppointmentEvents(),
      new TasksAlertsService(m.TaskAlertItem),
      settings,
      new SlotsService(m.Appointment),
      undefined,
      bridge
    );
  });

  test('with the module up, request_callback opens a ticket (not a task) and tells the caller its number and owner', async () => {
    const r = await inbound.run('request_callback', { phone: '9876543210', reason: 'A question about fees', topic: 'billing' }, { providerCallId: 'prov-1' });
    assert.equal(r.ok, true);
    assert.match(String(r.message), /Billing in charge/);
    assert.match(String(r.message), /SP-0001/);
    const t: any = await m.SupportTicket.findOne().lean();
    assert.equal(t.number, 'SP-0001');
    assert.equal(t.ticketType, 'billing');
    assert.equal(t.owner, 'billing');
    assert.equal(t.source, 'call-back');
    assert.equal(t.callerName, 'Phone caller');
    assert.equal(t.callerPhone, '+919876543210');
    assert.equal(t.question, 'A question about fees');
    assert.equal(t.providerCallId, 'prov-1');
    assert.equal(await m.TaskAlertItem.countDocuments({ title: /Call back/ }), 0, 'no fallback task is written');
  });

  test('an unknown topic is Other; a verified patient is linked by UHID and named', async () => {
    const p = await m.Patient.create({ uhid: 'MHK202600777', name: 'Rekha Suresh', age: 34, gender: 'Female', phone: '9876543210' });
    const t = await bridge.handlers.openCallTicket!({
      phone: '+919876543210',
      uhid: p.uhid,
      callerName: 'Rekha Suresh',
      reason: '',
      urgent: false,
      topic: 'weather',
      source: 'call-back'
    });
    assert.deepEqual(t, { number: 'SP-0001', ownerLabel: 'Front desk' });
    const row: any = await m.SupportTicket.findOne().lean();
    assert.equal(row.ticketType, 'other');
    assert.equal(String(row.patient), String(p._id));
    assert.equal(row.callerName, 'Rekha Suresh');
    assert.equal(row.question, 'Call-back requested');
  });

  test('a long reason is cut to 1000 characters', async () => {
    await bridge.handlers.openCallTicket!({ phone: '', reason: 'x'.repeat(1500), urgent: false, source: 'call-unanswered' });
    const row: any = await m.SupportTicket.findOne().lean();
    assert.equal(row.question.length, 1000);
    assert.equal(row.source, 'call-unanswered');
  });

  test('an emergency arrival tells the ER, opens an Urgent Clinical ticket of source emergency-call and replies to the caller', async () => {
    const reply = await bridge.handlers.expectedArrival!({
      complaint: 'Chest pain',
      ageSex: '58 M',
      minutes: 20,
      mode: 'ambulance',
      phone: '+919876543210',
      providerCallId: 'prov-9'
    });
    assert.deepEqual(reply, { ok: true, message: 'The ER has been told you are coming. Please come straight to the ER entrance.' });
    assert.equal(expected.length, 1);
    assert.deepEqual(expected[0].input, { complaint: 'Chest pain', ageSex: '58 M', mode: 'ambulance', etaMinutes: 20, phone: '+919876543210' });
    assert.equal(expected[0].actor.id, 'patient-support');
    const t: any = await m.SupportTicket.findOne().lean();
    assert.equal(t.ticketType, 'clinical');
    assert.equal(t.priority, 'urgent');
    assert.equal(t.source, 'emergency-call');
    assert.equal(t.providerCallId, 'prov-9');
    assert.match(t.question, /Chest pain/);
  });

  test('if the ER cannot be told, the ticket is still opened and the caller is offered a call back', async () => {
    failEr = true;
    const reply = await bridge.handlers.expectedArrival!({ complaint: 'Chest pain', ageSex: '', minutes: 20, mode: 'walk-in' });
    assert.equal(reply.ok, false);
    assert.match(reply.message, /request_callback/);
    const t: any = await m.SupportTicket.findOne().lean();
    assert.equal(t.source, 'emergency-call');
    assert.equal(t.priority, 'urgent');
    assert.match(t.question, /could not be told/);
  });

  test('hospital facts come from the approved FAQ, and a call is attached to its ticket', async () => {
    const found = await bridge.handlers.hospitalInfo!('visiting-hours', 'en');
    assert.equal(found.found, true);
    assert.match(found.text, /Visiting hours/);
    const none = await bridge.handlers.hospitalInfo!('weather', 'en');
    assert.equal(none.found, false);
    await bridge.handlers.openCallTicket!({ phone: '', reason: 'Wants a call', urgent: false, source: 'call-back', providerCallId: 'prov-3' });
    const [call] = await m.AgentCall.insertMany([{ provider: 'snapserve', providerCallId: 'prov-3', transcript: [{ speaker: 'agent', text: 'Hello' }] }], {
      lean: true
    });
    await bridge.handlers.attachCall!('prov-3', String(call._id));
    const t: any = await m.SupportTicket.findOne().lean();
    assert.equal(String(t.agentCall), String(call._id));
  });
});
