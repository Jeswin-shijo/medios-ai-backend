import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { CallTicketInput, CheckupCallResult, ExpectedArrivalInput, SupportBridge } from '../support-bridge/support-bridge';
import { AGENT_SCRIPTS } from './agent-scripts';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { InboundService, ToolContext } from './inbound.service';
import { SlotsService } from './slots.service';
import { CallResult, ProviderError, StartCallRequest, VoiceProvider } from './providers/voice-provider';
import { parseSnapServeResult, SnapServeConfig, SnapServeProvider } from './providers/snapserve.provider';
import { SimulatedProvider } from './providers/simulated.provider';
import { toE164India } from './phone';

// Made-up numbers only. Nothing rings: the provider is a fake, the simulator, or SnapServe with fetch stubbed.
const NUM = { rekha: '+91 98765 43210', other: '+91 98765 43299' };
const e164 = (n: string) => toE164India(n)!;
const TOOLS_SECRET = 'tools-secret-0123456789abcdef';
const EMERGENCY_EN = 'Please come to the ER now, or call 108 for an ambulance.';
const EMERGENCY_TA = 'தயவுசெய்து உடனே அவசர சிகிச்சைப் பிரிவுக்கு வாருங்கள், அல்லது ஆம்புலன்சுக்கு 108 ஐ அழைக்கவும்.';
const TICKET_TYPES = ['appointment', 'billing', 'reports', 'admission', 'discharge', 'directions', 'medicines', 'clinical', 'complaint', 'other'];
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** The owners Patient Support's defaults give the types that do not go to the front desk. */
const OWNER_OF: Record<string, string> = {
  billing: 'Billing in charge',
  admission: 'Ward nurse in charge',
  discharge: 'Ward nurse in charge',
  clinical: 'Duty doctor',
  complaint: 'Patient relations officer'
};

/** Stands in for Patient Support: one ticket per provider call id (A6), and a record of every call made to it. */
function testBridge() {
  const seen = {
    tickets: [] as (CallTicketInput & { number: string; ownerLabel: string })[],
    opened: [] as CallTicketInput[],
    attached: [] as [string, string][],
    info: [] as [string, string][],
    arrivals: [] as ExpectedArrivalInput[],
    checkups: [] as [string, CheckupCallResult][]
  };
  const open = async (i: CallTicketInput) => {
    seen.opened.push(i);
    const same = i.providerCallId ? seen.tickets.find((t) => t.providerCallId === i.providerCallId) : undefined;
    if (same) return { number: same.number, ownerLabel: same.ownerLabel };
    const ticket = { ...i, number: `SP-${String(seen.tickets.length + 1).padStart(4, '0')}`, ownerLabel: OWNER_OF[i.topic ?? ''] ?? 'Front desk' };
    seen.tickets.push(ticket);
    return { number: ticket.number, ownerLabel: ticket.ownerLabel };
  };
  const bridge = new SupportBridge();
  bridge.register({
    openCallTicket: open,
    attachCall: async (providerCallId, agentCallId) => {
      seen.attached.push([providerCallId, agentCallId]);
    },
    hospitalInfo: async (topic, language) => {
      seen.info.push([topic, language]);
      if (!/visit/i.test(topic)) return { found: false, text: 'There is no approved answer for that. Offer a call back (request_callback).' };
      return { found: true, text: language === 'ta' ? 'பார்வையாளர் நேரம் மாலை 4 முதல் 7 வரை.' : 'Visiting hours are 4 PM to 7 PM.' };
    },
    expectedArrival: async (i) => {
      seen.arrivals.push(i);
      // As Patient Support does it: an ER expected card, then an Urgent Clinical ticket for the call.
      await open({
        phone: i.phone ?? '',
        uhid: i.uhid,
        reason: `Coming to the ER: ${i.complaint}`,
        urgent: true,
        topic: 'clinical',
        providerCallId: i.providerCallId,
        source: 'emergency-call'
      });
      return { ok: true, message: 'The ER has been told you are coming. Please come straight to the ER entrance.' };
    },
    checkupResult: async (checkupId, r) => {
      seen.checkups.push([checkupId, r]);
    }
  });
  return { bridge, seen };
}

/** Records every call it is asked to place; nothing rings. */
class FakeProvider implements VoiceProvider {
  readonly live = false;
  started: StartCallRequest[] = [];
  constructor(readonly name: 'none' | 'simulated' | 'snapserve' = 'simulated') {}
  async startCall(request: StartCallRequest) {
    this.started.push(request);
    return { providerCallId: `fake_${this.started.length}` };
  }
}

/** A minimal Express response that records what was sent. */
function response() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    }
  };
  return { res: res as any, sent };
}

describe('Calls and the support bridge', () => {
  const m = models();
  let settings: SettingsService;
  let tasks: TasksAlertsService;
  let slots: SlotsService;
  let allowedNumbers: string[];
  let checkupAgentId: string | undefined;
  const config = {
    get: (key: string) =>
      key === 'callAgent.allowedNumbers'
        ? allowedNumbers
        : key === 'callAgent.snapserve.checkupAgentId'
          ? checkupAgentId
          : key === 'callAgent.toolsSecret'
            ? TOOLS_SECRET
            : undefined
  };

  const inboundWith = (bridge?: SupportBridge) =>
    new InboundService(
      m.AgentCall,
      m.InboundSession,
      m.CallerLookup,
      m.Appointment,
      m.Patient,
      new AppointmentEvents(),
      tasks,
      settings,
      slots,
      undefined,
      bridge
    );
  const callsWith = (provider: VoiceProvider, bridge?: SupportBridge, inbound = inboundWith(bridge)) =>
    new CallsService(
      m.AgentCall,
      m.Appointment,
      m.Patient,
      m.FollowUpItem,
      tasks,
      settings,
      slots,
      inbound,
      config as any,
      provider,
      undefined,
      undefined,
      bridge
    );

  const rekha = () => m.Patient.create({ uhid: 'MHK202600301', name: 'Rekha Suresh', age: 34, gender: 'Female', phone: NUM.rekha, dob: '14 Mar 1992' });
  const verify = async (inbound: InboundService, ctx: ToolContext) => {
    const r = await inbound.run('find_patient', { phone: NUM.rekha, patient_name: 'Rekha Suresh', date_of_birth: '14 March 1992' }, ctx);
    assert.equal(r.verified, true);
    return String(r.caller_ref);
  };
  const session = (code: string) => m.InboundSession.findOne({ code }).lean().exec() as Promise<any>;
  const logged = (providerCallId: string) => m.AgentCall.findOne({ providerCallId }).lean().exec() as Promise<any>;
  const callResult = (over: Partial<CallResult>): CallResult => ({
    outcome: 'enquiry',
    summary: 'Caller asked about the bill.',
    transcript: [{ speaker: 'patient', text: 'I have a question about my bill.' }],
    endedAt: new Date(),
    direction: 'inbound',
    fromNumber: NUM.other,
    ...over
  });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    allowedNumbers = [];
    checkupAgentId = undefined;
    settings = new SettingsService(m.HospitalSettings);
    // Calls may go out at any hour the tests run.
    await settings.updateSettings({ callAgent: { callingHoursStart: '00:00', callingHoursEnd: '23:59' } } as any, { role: UserRole.ADMIN });
    tasks = new TasksAlertsService(m.TaskAlertItem);
    slots = new SlotsService(m.Appointment);
  });

  // ---------------------------------------------------------------- call-backs

  describe('request_callback', () => {
    test("without bridge handlers, request_callback still writes today's task", async () => {
      for (const inbound of [inboundWith(), inboundWith(new SupportBridge())]) {
        await m.TaskAlertItem.deleteMany({}).exec();
        const r = await inbound.run(
          'request_callback',
          { reason: 'Chest pain since morning', urgent: true, topic: 'clinical' },
          { callerNumber: NUM.other, providerCallId: 'c1' }
        );
        assert.equal(r.ok, true);
        assert.match(r.message, /alerted to call back urgently/);
        const written = (await m.TaskAlertItem.find({}).lean().exec()) as any[];
        assert.equal(written.length, 1);
        assert.equal(written[0].title, `Call back urgently: caller ${e164(NUM.other)}`);
        assert.equal(written[0].subtitle, `Chest pain since morning (inbound AI call, ${e164(NUM.other)})`);
        assert.equal(written[0].priority, 'High');
      }
    });

    test('with handlers, request_callback opens a ticket, replies with its number, and writes no task', async () => {
      const { bridge, seen } = testBridge();
      const inbound = inboundWith(bridge);
      await rekha();
      const ctx = { callerNumber: NUM.rekha, providerCallId: 'c2' };
      const ref = await verify(inbound, ctx);
      const r = await inbound.run('request_callback', { caller_ref: ref, reason: 'Question about the discharge summary', urgent: true }, ctx);
      // Urgent may be clinical: the emergency hint stays.
      assert.deepEqual(r, {
        ok: true,
        message: "I've asked the Front desk to call you back. Your reference is SP-0001. If it is an emergency, tell them to call 108 now."
      });
      assert.deepEqual(seen.opened, [
        {
          phone: e164(NUM.rekha),
          uhid: 'MHK202600301',
          callerName: 'Rekha Suresh',
          reason: 'Question about the discharge summary',
          urgent: true,
          topic: 'other',
          providerCallId: 'c2',
          source: 'call-back'
        }
      ]);
      assert.equal(await m.TaskAlertItem.countDocuments().exec(), 0);
      const s = await session(ref);
      assert.equal(s.urgent, true, 'an urgent call-back still marks the session');
      assert.match(s.actions.join(' '), /SP-0001/);
    });

    test('request_callback with topic "billing" opens a Billing ticket owned by Billing in charge; an unknown topic gives Other', async () => {
      const { bridge, seen } = testBridge();
      const inbound = inboundWith(bridge);
      const billing = await inbound.run(
        'request_callback',
        { reason: 'How much is the bill so far?', topic: ' Billing ' },
        { callerNumber: NUM.other, providerCallId: 'c3' }
      );
      assert.equal(seen.opened[0].topic, 'billing');
      assert.equal(billing.message, "I've asked the Billing in charge to call you back. Your reference is SP-0001.", 'a normal call-back has no 108 hint');

      const unknown = await inbound.run(
        'request_callback',
        { reason: 'Is there parking?', topic: 'parking lot' },
        { callerNumber: NUM.other, providerCallId: 'c4' }
      );
      assert.equal(seen.opened[1].topic, 'other');
      assert.equal(unknown.message, "I've asked the Front desk to call you back. Your reference is SP-0002.");
    });

    test("an unverified caller's call-back opens a ticket with the caller-ID phone", async () => {
      const { bridge, seen } = testBridge();
      const inbound = inboundWith(bridge);
      await rekha(); // on file, but this caller never verified
      const r = await inbound.run('request_callback', { reason: 'Wants to speak to someone' }, { callerNumber: NUM.other, providerCallId: 'c5' });
      assert.equal(r.ok, true);
      const [t] = seen.opened;
      assert.equal(t.phone, e164(NUM.other));
      assert.equal(t.uhid, undefined);
      assert.equal(t.callerName, undefined);
      assert.equal(t.urgent, false);
      assert.equal(t.providerCallId, 'c5');
      assert.equal(t.source, 'call-back');
    });

    test("if the ticket can't be opened, the call-back falls back to today's task", async () => {
      const bridge = new SupportBridge();
      bridge.register({
        openCallTicket: async () => {
          throw new Error('database down');
        }
      });
      const r = await inboundWith(bridge).run('request_callback', { reason: 'A question about reports' }, { callerNumber: NUM.other, providerCallId: 'c6' });
      assert.equal(r.ok, true);
      const written = (await m.TaskAlertItem.find({}).lean().exec()) as any[];
      assert.equal(written.length, 1);
      assert.equal(written[0].title, `Call back caller ${e164(NUM.other)}`);
      assert.equal(written[0].priority, 'Medium');
    });
  });

  // ---------------------------------------------------------------- the call log

  describe('recordCall', () => {
    test('the call ends Needs staff after a call-back: still one ticket, and the transcript attaches', async () => {
      const { bridge, seen } = testBridge();
      const inbound = inboundWith(bridge);
      await inbound.run('request_callback', { reason: 'A question about the bill', topic: 'billing' }, { callerNumber: NUM.other, providerCallId: 'c7' });
      await inbound.recordCall(callResult({ providerCallId: 'c7', outcome: 'escalated' }), 'snapserve');

      const row = await logged('c7');
      assert.equal(seen.tickets.length, 1, 'one ticket for the provider call id');
      assert.deepEqual(
        seen.opened.map((o) => [o.source, o.providerCallId, o.urgent]),
        [
          ['call-back', 'c7', false],
          ['call-unanswered', 'c7', false]
        ]
      );
      assert.equal(seen.opened[1].reason, 'Caller asked about the bill.');
      assert.equal(seen.opened[1].phone, e164(NUM.other));
      assert.deepEqual(seen.attached, [['c7', String(row._id)]]);
      assert.equal(row.outcome, 'escalated');
      assert.match(row.actionTaken, /SP-0001/);
      assert.equal(await m.TaskAlertItem.countDocuments().exec(), 0, 'no backup task');
    });

    test('Needs staff with no call-back opens a call-unanswered ticket; a failing handler falls back to the High task', async () => {
      const { bridge, seen } = testBridge();
      await rekha();
      const inbound = inboundWith(bridge);
      const ctx = { callerNumber: NUM.rekha, providerCallId: 'c8' };
      await verify(inbound, ctx);
      await inbound.recordCall(callResult({ providerCallId: 'c8', outcome: 'escalated', summary: '', fromNumber: NUM.rekha }), 'snapserve');
      assert.equal(seen.opened.length, 1);
      assert.deepEqual(
        [seen.opened[0].source, seen.opened[0].reason, seen.opened[0].urgent, seen.opened[0].uhid, seen.opened[0].callerName, seen.opened[0].providerCallId],
        ['call-unanswered', "The caller's question was not answered", false, 'MHK202600301', 'Rekha Suresh', 'c8']
      );
      assert.equal(seen.attached.length, 1);

      const broken = new SupportBridge();
      broken.register({
        openCallTicket: async () => {
          throw new Error('database down');
        }
      });
      await inboundWith(broken).recordCall(callResult({ providerCallId: 'c9', outcome: 'escalated' }), 'snapserve');
      assert.equal(await m.TaskAlertItem.countDocuments({ priority: 'High', title: /^Call back urgently/ }).exec(), 1);
      assert.ok(await logged('c9'), 'the call is still logged');
    });
  });

  // ---------------------------------------------------------------- the new tools

  describe('hospital_info and expected_arrival', () => {
    test('hospital_info returns the approved answer, or the call-back offer', async () => {
      const { bridge, seen } = testBridge();
      const inbound = inboundWith(bridge);
      assert.deepEqual(await inbound.run('hospital_info', { topic: 'visiting hours' }, {}), { ok: true, message: 'Visiting hours are 4 PM to 7 PM.' });
      assert.deepEqual(await inbound.run('hospital_info', { topic: 'visiting hours', language: 'ta' }, {}), {
        ok: true,
        message: 'பார்வையாளர் நேரம் மாலை 4 முதல் 7 வரை.'
      });
      await inbound.run('hospital_info', { topic: 'visiting hours', language: 'tamil' }, {});
      assert.deepEqual(
        seen.info.map(([, language]) => language),
        ['en', 'ta', 'en']
      );
      assert.deepEqual(await inbound.run('hospital_info', { topic: 'helipad' }, {}), {
        ok: false,
        message: 'There is no approved answer for that. Offer a call back (request_callback).'
      });

      for (const plain of [inboundWith(), inboundWith(new SupportBridge())]) {
        const r = await plain.run('hospital_info', { topic: 'visiting hours' }, {});
        assert.equal(r.ok, false);
        assert.match(r.message, /offer a call back from the front desk \(request_callback\)/);
      }
    });

    test('expected_arrival adds an ER card (walk-in, minutes clamped to 240) and an urgent Clinical ticket', async () => {
      const { bridge, seen } = testBridge();
      const inbound = inboundWith(bridge);
      await rekha();
      const ctx = { callerNumber: NUM.rekha, providerCallId: 'c10' };
      const ref = await verify(inbound, ctx);
      const r = await inbound.run(
        'expected_arrival',
        { caller_ref: ref, complaint: 'Chest pain since morning', age_sex: '58 M', minutes: 500, mode: 'car' },
        ctx
      );
      assert.deepEqual(r, { ok: true, message: 'The ER has been told you are coming. Please come straight to the ER entrance.' });
      assert.deepEqual(seen.arrivals, [
        {
          complaint: 'Chest pain since morning',
          ageSex: '58 M',
          minutes: 240,
          mode: 'walk-in',
          phone: e164(NUM.rekha),
          uhid: 'MHK202600301',
          providerCallId: 'c10'
        }
      ]);
      assert.deepEqual(
        seen.tickets.map((t) => [t.source, t.topic, t.urgent, t.providerCallId]),
        [['emergency-call', 'clinical', true, 'c10']]
      );
      // The caller's "Needs staff" at the end adds no second ticket: the session is urgent now.
      await inbound.recordCall(callResult({ providerCallId: 'c10', outcome: 'escalated', fromNumber: NUM.rekha }), 'snapserve');
      assert.equal(seen.opened.length, 1);
      assert.match((await logged('c10')).actionTaken, /ER/);

      // Minutes: at least 1, whole, 30 when not said. Ambulance only when said exactly.
      await inbound.run(
        'expected_arrival',
        { complaint: 'Fall at home', age_sex: '70 F', minutes: 0, mode: 'ambulance' },
        { callerNumber: NUM.other, providerCallId: 'c11' }
      );
      await inbound.run('expected_arrival', { complaint: 'Fall at home', age_sex: '70 F', minutes: '12.6' }, { providerCallId: 'c12' });
      await inbound.run('expected_arrival', { complaint: 'Fall at home', age_sex: '70 F' }, { providerCallId: 'c13' });
      assert.deepEqual(
        seen.arrivals.slice(1).map((a) => [a.minutes, a.mode, a.uhid, a.phone]),
        [
          [1, 'ambulance', undefined, e164(NUM.other)],
          [13, 'walk-in', undefined, undefined],
          [30, 'walk-in', undefined, undefined]
        ]
      );

      const plain = await inboundWith().run('expected_arrival', { complaint: 'Fall at home', age_sex: '70 F', minutes: 20 }, {});
      assert.equal(plain.ok, false);
      assert.match(plain.message, /offer a call back from the front desk \(request_callback\)/);
    });

    test('the tools route lists the two new tools in GET /calls/scripts', async () => {
      const { bridge } = testBridge();
      const inbound = inboundWith(bridge);
      const ctrl = new CallsController(callsWith(new FakeProvider(), bridge, inbound), inbound, config as any);
      const scripts = await ctrl.scripts();
      const tools = scripts.find((s) => s.purpose === 'inbound')!.tools!.map((t) => t.name);
      assert.ok(tools.includes('hospital_info'), tools.join());
      assert.ok(tools.includes('expected_arrival'), tools.join());
      assert.ok(scripts.some((s) => s.purpose === 'checkup'));

      const { res, sent } = response();
      await ctrl.tool('hospital_info', TOOLS_SECRET, {}, { args: { topic: 'visiting hours' }, callId: 'c14' }, res);
      assert.equal(sent.status, 200);
      assert.deepEqual(sent.body, { ok: true, message: 'Visiting hours are 4 PM to 7 PM.' });
    });
  });

  describe('the scripts', () => {
    test('the inbound script sends hospital facts to hospital_info, and its emergency rule gives the emergency line and expected_arrival', () => {
      const inbound = AGENT_SCRIPTS.inbound;
      const text = flat(inbound.instructions);
      assert.ok(
        text.includes(
          'For hospital facts (visiting hours, directions, report times, billing desk hours, OPD timings), call hospital_info first and read its answer exactly; if it has none, offer a call back.'
        )
      );
      assert.ok(text.includes(EMERGENCY_EN));
      assert.ok(text.includes(EMERGENCY_TA));
      assert.match(text, /if they say they are coming, call expected_arrival/i);
      const topic = inbound.tools!.find((t) => t.name === 'request_callback')!.parameters.find((p) => p.name === 'topic')!;
      assert.equal(topic.required, false);
      for (const key of TICKET_TYPES) assert.ok(topic.description.includes(key), key);
      for (const name of ['hospital_info', 'expected_arrival']) assert.ok(inbound.tools!.find((t) => t.name === name)!.preToolMessage);
    });

    test('the checkup script asks the questions in order, stops on an emergency, and returns the answers as data', () => {
      const s = AGENT_SCRIPTS.checkup;
      assert.equal(s.purpose, 'checkup');
      assert.equal(s.title, 'Check-up call after going home');
      assert.deepEqual(s.variables, ['patient_name', 'question_list', 'language']);
      const text = flat(s.instructions);
      const at = ['medicines', 'symptoms', 'antiplatelets', 'exertion', 'followup', 'question', 'rating'].map((key) => text.indexOf(`${key}: "`));
      assert.ok(
        at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])),
        `questions out of order: ${at.join()}`
      );
      assert.ok(text.includes(EMERGENCY_EN));
      assert.ok(text.includes(EMERGENCY_TA));
      assert.match(text, /if an answer is an emergency, stop and say the emergency line/i);
      assert.match(text, /never give medical advice; if they ask a medical question, note it for the doctor/i);
      assert.deepEqual(
        s.dataFields.map((f) => f.name),
        ['checkup_answers', 'rating', 'notes']
      );
      assert.ok(s.outcomes.some((o) => o.label === 'Information given' && o.outcome.startsWith('enquiry')));
    });
  });

  // ---------------------------------------------------------------- check-up calls

  describe('the checkup purpose', () => {
    const MEENAKSHI = { uhid: 'MHK202600303', name: 'Meenakshi T', age: 52, gender: 'Female', phone: NUM.rekha };
    const checkup = (checkupId: string, over: Record<string, unknown> = {}) =>
      ({ checkupId, patientUhid: MEENAKSHI.uhid, group: 'general', language: 'en', ...over }) as {
        checkupId: string;
        patientUhid: string;
        group: 'general' | 'cardiac';
        language: 'en' | 'ta';
      };

    test('canCheckupCall: none false, simulated true, snapserve only with the checkup agent id', () => {
      const can = (name: 'none' | 'simulated' | 'snapserve', id?: string) => {
        checkupAgentId = id;
        return callsWith(new FakeProvider(name)).canCheckupCall();
      };
      assert.equal(can('none'), false);
      assert.equal(can('none', '1999'), false);
      assert.equal(can('simulated'), true);
      assert.equal(can('snapserve'), false);
      assert.equal(can('snapserve', ''), false);
      assert.equal(can('snapserve', '1999'), true);
    });

    test('requestCheckup is refused for doNotCall and places a checkup call with the group variable', async () => {
      const provider = new FakeProvider();
      const calls = callsWith(provider);
      await m.Patient.create({
        uhid: 'MHK202600302',
        name: 'Babu Thomas',
        age: 61,
        gender: 'Male',
        phone: NUM.rekha,
        doNotCall: true,
        doNotCallReason: 'Asked not to be called'
      });
      await assert.rejects(() => calls.requestCheckup(checkup('ck1', { patientUhid: 'MHK202600302' }), 'Patient Support Agent'), ConflictException);
      assert.equal(provider.started.length, 0);

      await m.Patient.create(MEENAKSHI);
      const call = await calls.requestCheckup(checkup('ck2', { group: 'cardiac', language: 'ta' }), 'Patient Support Agent');
      assert.equal(call.status, 'calling');
      assert.equal(call.purpose, 'checkup');
      assert.equal(call.checkupId, 'ck2');
      assert.equal(call.activeKey, 'checkup:ck2');
      assert.equal(call.requestedBy, 'Patient Support Agent');
      assert.equal(provider.started.length, 1);
      assert.equal(provider.started[0].purpose, 'checkup');
      // No slots are offered on a check-up call.
      assert.deepEqual(provider.started[0].variables, { patient_name: 'Meenakshi T', question_list: 'cardiac', language: 'ta', call_ref: String(call._id) });

      const again = await calls.requestCheckup(checkup('ck2', { group: 'cardiac', language: 'ta' }), 'Patient Support Agent');
      assert.equal(String(again._id), String(call._id), 'no second live call for the same check-up');
      assert.equal(await m.AgentCall.countDocuments({ checkupId: 'ck2' }).exec(), 1);
      assert.equal(provider.started.length, 1);

      allowedNumbers = [NUM.other];
      await assert.rejects(
        () => calls.requestCheckup(checkup('ck3'), 'Patient Support Agent'),
        (err: unknown) => err instanceof ConflictException && /CALL_ALLOWED_NUMBERS/.test(err.message)
      );
      await assert.rejects(() => callsWith(new FakeProvider('none')).requestCheckup(checkup('ck4'), 'Patient Support Agent'), ServiceUnavailableException);
    });

    test('a checkup result goes to the bridge with parsed answers and rating', async () => {
      const { bridge, seen } = testBridge();
      const calls = callsWith(new FakeProvider(), bridge);
      await m.Patient.create(MEENAKSHI);
      const call = await calls.requestCheckup(checkup('ck5'), 'Patient Support Agent');
      const payload = {
        id: 'fake_1',
        status: 'completed',
        callSummary: 'Doing well; a mild fever last night.',
        dispositionResult: {
          outcome: 'Information given',
          checkup_answers: '{"medicines":"yes","symptoms":"mild","followup":"no","question":"no","rating":5}',
          rating: '4',
          notes: 'Mild fever last night.'
        },
        variables: { call_ref: String(call._id) }
      };
      assert.deepEqual(await calls.recordResult(parseSnapServeResult(payload)), { matched: true });
      assert.deepEqual(seen.checkups, [
        [
          'ck5',
          {
            outcome: 'enquiry',
            answers: { medicines: 'yes', symptoms: 'mild', followup: 'no', question: 'no' },
            rating: 4,
            notes: 'Mild fever last night.',
            agentCallId: String(call._id)
          }
        ]
      ]);
      const row = (await m.AgentCall.findById(call._id).lean().exec()) as any;
      assert.equal(row.status, 'completed');
      assert.equal(row.outcome, 'enquiry');
      assert.equal(row.activeKey, undefined);
      assert.match(row.actionTaken, /Patient Support/);
      assert.deepEqual(row.result.answers, { medicines: 'yes', symptoms: 'mild', followup: 'no', question: 'no' }, 'the answers are kept on the call');
      assert.equal(row.result.rating, 4);
      assert.equal(await m.AgentCall.countDocuments().exec(), 1, 'no booking or retry call');
      assert.equal(await m.Appointment.countDocuments().exec(), 0);
      assert.deepEqual(await calls.recordResult(parseSnapServeResult(payload)), { matched: true, duplicate: true });
      assert.equal(seen.checkups.length, 1);

      // Unanswered goes to the bridge too; Patient Support decides the next try.
      const second = await calls.requestCheckup(checkup('ck5'), 'Patient Support Agent');
      await calls.recordResult({ callId: String(second._id), outcome: 'no_answer', summary: '', transcript: [] });
      assert.deepEqual(seen.checkups[1], ['ck5', { outcome: 'no_answer', answers: {}, rating: undefined, notes: undefined, agentCallId: String(second._id) }]);
      assert.equal(await m.AgentCall.countDocuments({ status: 'scheduled' }).exec(), 0, 'no retry of its own');
      assert.equal(await m.TaskAlertItem.countDocuments().exec(), 0);

      // The data fields, however they arrive.
      const parsed = (fields: Record<string, unknown>) => parseSnapServeResult({ id: 9, dispositionResult: { outcome: 'Information given', ...fields } });
      assert.deepEqual(parsed({ checkup_answers: '{not json', rating: 9 }).answers, {});
      assert.equal(parsed({ checkup_answers: '{not json', rating: 9 }).rating, undefined);
      assert.deepEqual(parsed({ 'Checkup answers': { medicines: 'no', symptoms: 2 }, rating: 2.5 }).answers, { medicines: 'no' });
      assert.equal(parsed({ rating: 2.5 }).rating, undefined);
      assert.equal(parsed({ rating: 5 }).rating, 5);
      assert.equal(parsed({}).answers, undefined);
    });

    /** An answered check-up call with an emergency answer, delivered as SnapServe would. */
    const answered = (callId: string) =>
      parseSnapServeResult({
        id: 'fake_1',
        status: 'completed',
        callSummary: 'Chest pain at rest since this morning.',
        dispositionResult: { outcome: 'Information given', checkup_answers: { medicines: 'yes', symptoms: 'severe' }, rating: 3 },
        variables: { call_ref: callId }
      });
    const reviewAlerts = () => m.TaskAlertItem.find({ title: 'Review a check-up call: the answers could not be recorded' }).lean().exec() as Promise<any[]>;

    test('a check-up result whose handler throws keeps the answers on the call and raises a review alert', async () => {
      const bridge = new SupportBridge();
      bridge.register({
        checkupResult: async () => {
          throw new Error('Choose one of the allowed answers.');
        }
      });
      const calls = callsWith(new FakeProvider(), bridge);
      await m.Patient.create(MEENAKSHI);
      const call = await calls.requestCheckup(checkup('ck9'), 'Patient Support Agent');
      assert.deepEqual(await calls.recordResult(answered(String(call._id))), { matched: true });

      const row = (await m.AgentCall.findById(call._id).lean().exec()) as any;
      assert.equal(row.status, 'completed');
      assert.deepEqual(row.result.answers, { medicines: 'yes', symptoms: 'severe' });
      assert.equal(row.result.rating, 3);
      assert.match(row.actionTaken, /Choose one of the allowed answers/);
      const alerts = await reviewAlerts();
      assert.equal(alerts.length, 1);
      assert.deepEqual(
        [alerts[0].subtitle, alerts[0].type, alerts[0].category, alerts[0].priority, alerts[0].patientName, alerts[0].uhid],
        ["Open the call's transcript and fill the check-up form by hand.", 'Patient Communication', 'Critical', 'High', 'Meenakshi T', MEENAKSHI.uhid]
      );
      assert.doesNotMatch(alerts[0].title, /Meenakshi/, 'no name in the title');
      // Delivered again: still one alert.
      await calls.recordResult(answered(String(call._id)));
      assert.equal((await reviewAlerts()).length, 1);
    });

    test('a check-up result with no handler raises the same alert', async () => {
      for (const bridge of [undefined, new SupportBridge()]) {
        await m.AgentCall.deleteMany({}).exec();
        await m.TaskAlertItem.deleteMany({}).exec();
        await m.Patient.deleteMany({}).exec();
        const calls = callsWith(new FakeProvider(), bridge);
        await m.Patient.create(MEENAKSHI);
        const call = await calls.requestCheckup(checkup('ck10'), 'Patient Support Agent');
        await calls.recordResult(answered(String(call._id)));
        const row = (await m.AgentCall.findById(call._id).lean().exec()) as any;
        assert.deepEqual(row.result.answers, { medicines: 'yes', symptoms: 'severe' });
        assert.match(row.actionTaken, /Patient Support is not running/);
        const alerts = await reviewAlerts();
        assert.equal(alerts.length, 1);
        assert.deepEqual([alerts[0].category, alerts[0].priority, alerts[0].uhid], ['Critical', 'High', MEENAKSHI.uhid]);
      }
    });

    test('a checkup result with nobody listening is logged; "do not call" still marks the patient', async () => {
      const calls = callsWith(new FakeProvider());
      await m.Patient.create(MEENAKSHI);
      const call = await calls.requestCheckup(checkup('ck6'), 'Patient Support Agent');
      assert.deepEqual(await calls.recordResult({ callId: String(call._id), outcome: 'do_not_call', summary: 'Asked not to be called.', transcript: [] }), {
        matched: true
      });
      const row = (await m.AgentCall.findById(call._id).lean().exec()) as any;
      assert.equal(row.status, 'completed');
      assert.equal(row.outcome, 'do_not_call');
      assert.equal(((await m.Patient.findOne({ uhid: MEENAKSHI.uhid }).lean().exec()) as any).doNotCall, true);
      await assert.rejects(() => calls.requestCheckup(checkup('ck7'), 'Patient Support Agent'), ConflictException);
    });

    test('a check-up call whose result never comes is handed to Patient Support as failed', async () => {
      const { bridge, seen } = testBridge();
      const calls = callsWith(new FakeProvider(), bridge);
      await m.Patient.create(MEENAKSHI);
      const call = await calls.requestCheckup(checkup('ck8'), 'Patient Support Agent');
      await m.AgentCall.updateOne({ _id: call._id }, { startedAt: new Date(Date.now() - 31 * 60_000) }).exec();
      await calls.runDue();
      assert.equal(((await m.AgentCall.findById(call._id).lean().exec()) as any).status, 'failed');
      assert.deepEqual(seen.checkups, [['ck8', { outcome: 'failed', answers: {}, rating: undefined, notes: undefined, agentCallId: String(call._id) }]]);
      await calls.runDue();
      assert.equal(seen.checkups.length, 1, 'once');
    });

    test('the simulator answers a checkup call with every first choice and rating 5', async () => {
      const results: CallResult[] = [];
      const simulator = new SimulatedProvider(0);
      simulator.attachResultHandler(async (r) => {
        results.push(r);
      });
      const start = (group: string) =>
        simulator.startCall({
          callId: `call-${group}`,
          purpose: 'checkup',
          toNumber: e164(NUM.rekha),
          variables: { patient_name: 'Meenakshi T', question_list: group, language: 'en' },
          simulation: 'random'
        });
      await start('general');
      await start('cardiac');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const byCall = Object.fromEntries(results.map((r) => [r.callId, r]));
      assert.equal(byCall['call-general'].outcome, 'enquiry');
      assert.deepEqual(byCall['call-general'].answers, { medicines: 'yes', symptoms: 'none', followup: 'yes', question: 'no' });
      assert.deepEqual(byCall['call-cardiac'].answers, {
        medicines: 'yes',
        symptoms: 'none',
        antiplatelets: 'yes',
        exertion: 'no',
        followup: 'yes',
        question: 'no'
      });
      assert.equal(byCall['call-cardiac'].rating, 5);
      assert.ok(byCall['call-cardiac'].transcript.length > 4);
    });

    test('SnapServe sends a checkup call to the checkup agent, never the booking agent', async () => {
      const realFetch = globalThis.fetch;
      const bodies: any[] = [];
      globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: 77 }), { status: 200 });
      }) as typeof fetch;
      try {
        const cfg: SnapServeConfig = {
          baseUrl: 'https://snapserve.invalid/api',
          apiKey: 'sk_test_not_real',
          confirmationAgentId: '1540',
          bookingAgentId: '1541',
          inboundAgentId: '',
          checkupAgentId: '1999',
          signingSecret: ''
        };
        const request: StartCallRequest = { callId: 'x', purpose: 'checkup', toNumber: e164(NUM.rekha), variables: {}, simulation: 'positive' };
        assert.deepEqual(await new SnapServeProvider(cfg).startCall(request), { providerCallId: '77' });
        assert.equal(bodies[0].agentId, 1999);
        await assert.rejects(() => new SnapServeProvider({ ...cfg, checkupAgentId: '' }).startCall(request), ProviderError);
        assert.equal(bodies.length, 1, 'nothing is sent without a checkup agent');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});
