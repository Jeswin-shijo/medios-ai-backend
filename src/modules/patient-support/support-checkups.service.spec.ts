import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { DISCHARGE_MESSAGE_TYPES } from '../discharge/discharge-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { SupportBridge } from '../support-bridge/support-bridge';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SUPPORT_ACTOR } from './support-catalogue';
import { SupportCheckupsService } from './support-checkups.service';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { SupportFeedbackService } from './support-feedback.service';
import { SupportSettingsService } from './support-settings.service';
import { SupportTextsService } from './support-texts.service';
import { SupportTicketsService } from './support-tickets.service';

const MIN = 60_000;
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);
const oid = () => new Types.ObjectId();
const raw = async (model: any, doc: Record<string, unknown>) => (await model.insertMany([doc], { lean: true }))[0];
const DOCTOR = { id: 'd1', name: 'Dr Review', role: UserRole.DOCTOR };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };
const DESK = { id: 'f1', name: 'Anita Desk', role: UserRole.STAFF };

const FINE = { medicines: 'yes', symptoms: 'none', followup: 'yes', question: 'no' };
const CARDIAC_FINE = { ...FINE, antiplatelets: 'yes', exertion: 'no' };

describe('SupportCheckupsService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let reg: SupportRegistration;
  let bridge: SupportBridge;
  let svc: SupportCheckupsService;
  let escalations: EscalationsService;
  let cases: CasesService;
  let now: Date;
  let savedClinicDate: string | undefined;
  let patient: any;
  let caseId: string;
  let canCall: boolean;
  let dialed: any[];
  let nextCall: (i: any) => Promise<any>;
  let expected: any[];
  let failExpected: boolean;
  let cancelled: string[];
  let cardiologist: { name: string } | null;
  let canceledCalls: string[];

  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean();
  const alertOf = (link: string) => m.TaskAlertItem.findOne({ link }).lean();
  const leave = (kind: 'home' | 'against-advice' | 'transfer' | 'died' = 'home', planId = oid(), onCase: string | null = caseId) =>
    messages.send({
      case: onCase,
      from: 'discharge' as any,
      to: ['coordinator'],
      type: 'discharge.completed',
      priority: 'medium',
      summary: 'discharge.completed (spec)',
      payload: { planId: String(planId), orderId: '', admissionId: String(oid()), bedLabel: 'A-1', kind, leftAt: at(15) }
    });
  const plan = (id = oid()) => raw(m.DischargePlan, { _id: id, admission: oid(), patient: patient._id, case: new Types.ObjectId(caseId) });
  const leaveFor = async (kind: 'home' | 'against-advice' | 'transfer' | 'died' = 'home') => {
    const p = await plan();
    const msg = await leave(kind, p._id);
    await svc.fromDischarge(String(msg.id ?? (msg as any)._id));
    return p;
  };
  const makeOne = async (dueNow = true) => {
    const c = await svc.scheduleFor(String(patient._id), at(15), 'home', `discharge:${oid()}`, { caseId });
    if (dueNow) {
      now = at(10, 0, 28);
      await svc.makeDue(now);
    }
    return String(c._id);
  };
  const holder = async () => {
    const u = await m.User.create({ name: 'Dr Duty', email: 'duty@x.in', passwordHash: 'x', role: UserRole.DOCTOR });
    await m.DutyTitle.updateOne({ key: 'duty-doctor' }, { $set: { holders: [u._id] } });
  };
  const later = (minutes = 3) => (now = new Date(now.getTime() + minutes * MIN));
  const rowOf = (id: string) => m.CheckupCall.findById(id).lean() as Promise<any>;

  before(async () => {
    savedClinicDate = process.env.CLINIC_DATE;
    process.env.CLINIC_DATE = '2026-09-26';
    await connectTestDb();
  });
  after(async () => {
    if (savedClinicDate === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinicDate;
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    now = at(10);
    canCall = false;
    dialed = [];
    expected = [];
    failExpected = false;
    cancelled = [];
    cardiologist = null;
    canceledCalls = [];
    nextCall = async () => ({ _id: oid(), status: 'calling', providerCallId: 'prov-1' });
    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    registry.register({
      key: 'discharge' as any,
      messageTypes: DISCHARGE_MESSAGE_TYPES as any,
      status: async () => ({ open: 0, capacity: 0, onTimePct: null })
    });
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const settings = new SettingsService(m.HospitalSettings);
    const supportSettings = new SupportSettingsService(settings);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    reg = new SupportRegistration(registry, messages, m.SupportTicket, m.CheckupCall);
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
    const tickets = new SupportTicketsService(
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
    tickets.now = () => now;
    const feedback = new SupportFeedbackService(reg, tickets, cases, m.SupportFeedback, m.Patient);
    const texts = new SupportTextsService(m.SupportTemplate, m.SupportFaq, settings, supportSettings);
    await texts.ensureDefaults();
    bridge = new SupportBridge();
    const fakeCalls = {
      canCheckupCall: () => canCall,
      requestCheckup: async (i: any) => (dialed.push(i), nextCall(i)),
      cancel: async (id: string) => (canceledCalls.push(id), {})
    };
    const fakeEr = {
      addExpected: async (actor: any, input: any) => {
        if (failExpected) throw new Error('ER is down');
        expected.push({ actor, input });
        return {};
      }
    };
    const fakeRoster = { onCall: async () => cardiologist };
    const fakeUpdates = { cancelForDeath: async (id: string) => (cancelled.push(id), 0) };
    svc = new SupportCheckupsService(
      reg,
      messages,
      facts,
      feedback,
      texts,
      fakeUpdates as any,
      supportSettings,
      escalations,
      fakeCalls as any,
      bridge,
      fakeEr as any,
      fakeRoster as any,
      m.CheckupCall,
      m.Patient,
      m.DischargePlan,
      m.FollowUpItem,
      m.AgentCall,
      m.TaskAlertItem,
      m.CoordinatorCounter
    );
    svc.clock = () => now;
    svc.clinic = () => now;
    svc.onModuleInit();

    patient = await m.Patient.create({
      uhid: 'MHK202600905',
      name: 'Ravi Kumar',
      age: 62,
      gender: 'Male',
      phone: '9100000005',
      consent: { messages: true, calls: true }
    });
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

  test('a home discharge makes one scheduled check-up due on day 2; transfer and died make none; delivered twice still one', async () => {
    const p = await plan();
    const msg: any = await leave('home', p._id);
    await svc.fromDischarge(String(msg.id ?? msg._id));
    await svc.fromDischarge(String(msg.id ?? msg._id));
    const all = await m.CheckupCall.find().lean();
    assert.equal(all.length, 1);
    const c: any = all[0];
    assert.deepEqual(
      [c.number, c.state, c.dueDay, c.kind, c.group, c.sourceKey, String(c.case)],
      ['CU-0001', 'scheduled', '2026-09-28', 'home', 'general', `discharge:${p._id}`, caseId]
    );
    assert.equal(c.leftAt.getTime(), at(15).getTime());
    for (const kind of ['transfer', 'died'] as const) {
      const other = await plan();
      const x: any = await leave(kind, other._id);
      await svc.fromDischarge(String(x.id ?? x._id));
    }
    assert.equal(await m.CheckupCall.countDocuments(), 1);
    // The handler is registered for the Coordinator's wake-up, next to any others.
    assert.equal(reg.wake.get('discharge.completed')?.length, 1);
    assert.equal(typeof bridge.handlers.checkupResult, 'function');
  });

  test('against advice gets a check-up', async () => {
    await leaveFor('against-advice');
    const c: any = await m.CheckupCall.findOne().lean();
    assert.deepEqual([c.kind, c.state], ['against-advice', 'scheduled']);
  });

  test('the cardiac group comes from an angiography booking', async () => {
    await raw(m.ProcedureBooking, {
      number: 'PR-1',
      patient: patient._id,
      case: new Types.ObjectId(caseId),
      procedure: 'coronary-angiography',
      status: 'booked'
    });
    await leaveFor('home');
    assert.equal(((await m.CheckupCall.findOne().lean()) as any).group, 'cardiac');
    const d = await svc.detail(String((await m.CheckupCall.findOne().lean())!._id));
    assert.deepEqual(
      d.questions.map((q) => q.key),
      ['medicines', 'symptoms', 'antiplatelets', 'exertion', 'followup', 'question', 'rating']
    );
  });

  test('makeDue waits for the day and time, and skips a dead patient and cancels their waiting updates', async () => {
    const id = await makeOne(false);
    assert.equal(await svc.makeDue(at(10, 0, 27)), 0, 'not yet the day');
    assert.equal(await svc.makeDue(at(9, 59, 28)), 0, 'not yet 10:00');
    assert.equal(await svc.makeDue(at(10, 0, 28)), 1);
    assert.equal((await rowOf(id)).state, 'due');
    const id2 = await makeOne(false);
    await m.Patient.updateOne({ _id: patient._id }, { $set: { status: 'Deceased' } });
    assert.equal(await svc.makeDue(at(10, 0, 28)), 0);
    assert.deepEqual([(await rowOf(id2)).state, (await rowOf(id2)).skipReason], ['skipped', 'deceased']);
    assert.deepEqual(cancelled, [String(patient._id), String(patient._id)], 'the earlier due check-up is skipped too');
  });

  test('makeDue skips do-not-contact and no phone', async () => {
    const a = await makeOne(false);
    await m.Patient.updateOne({ _id: patient._id }, { $set: { doNotCall: true } });
    await svc.makeDue(at(10, 0, 28));
    assert.deepEqual([(await rowOf(a)).state, (await rowOf(a)).skipReason], ['skipped', 'do-not-contact']);
    await m.Patient.updateOne({ _id: patient._id }, { $set: { doNotCall: false, phone: '12' } });
    const b = await makeOne(false);
    await svc.makeDue(at(10, 0, 28));
    assert.deepEqual([(await rowOf(b)).state, (await rowOf(b)).skipReason], ['skipped', 'no-phone']);
  });

  test('calls off: due check-ups stay in To do', async () => {
    const id = await makeOne();
    assert.equal(await svc.dialDue(at(11, 0, 28)), 0);
    assert.equal(dialed.length, 0);
    assert.equal((await rowOf(id)).state, 'due');
    assert.deepEqual(
      (await svc.list('to-do')).map((r) => r.id),
      [id]
    );
  });

  test('simulated calls on with consent.calls: dialDue places one call; without consent.calls it stays in To do', async () => {
    canCall = true;
    const id = await makeOne();
    assert.equal(await svc.dialDue(at(9, 0, 28)), 0, 'before the check-up hours');
    assert.equal(await svc.dialDue(at(18, 0, 28)), 0, 'after the check-up hours');
    assert.equal(await svc.dialDue(at(11, 0, 28)), 1);
    assert.deepEqual(dialed, [{ checkupId: id, patientUhid: 'MHK202600905', group: 'general', language: 'en' }]);
    const c = await rowOf(id);
    assert.equal(c.state, 'calling');
    assert.ok(c.agentCall);
    assert.equal(await svc.dialDue(at(11, 1, 28)), 0, 'one call only');
    assert.equal(dialed.length, 1);

    await m.Patient.updateOne({ _id: patient._id }, { $set: { consent: { messages: true, calls: false } } });
    const id2 = await makeOne();
    assert.equal(await svc.dialDue(at(11, 2, 28)), 0);
    assert.equal(dialed.length, 1);
    assert.equal((await rowOf(id2)).state, 'due');
  });

  test('a refused dial leaves it in To do and waits an hour before trying again', async () => {
    canCall = true;
    nextCall = async () => {
      throw new Error('on the do-not-call list');
    };
    const id = await makeOne();
    assert.equal(await svc.dialDue(at(11, 0, 28)), 0);
    assert.equal((await rowOf(id)).state, 'due');
    assert.equal(await svc.dialDue(at(11, 30, 28)), 0);
    assert.equal(dialed.length, 1, 'held off');
    await svc.dialDue(at(12, 1, 28));
    assert.equal(dialed.length, 2);
  });

  test('a scheduled dial stays due', async () => {
    canCall = true;
    const callId = oid();
    nextCall = async () => ({ _id: callId, status: 'scheduled' });
    const id = await makeOne();
    assert.equal(await svc.dialDue(at(11, 0, 28)), 0);
    const c = await rowOf(id);
    assert.equal(c.state, 'due');
    assert.equal(String(c.agentCall), String(callId));
    await svc.dialDue(at(11, 5, 28));
    assert.equal(dialed.length, 1, 'not dialled again while its call waits');
  });

  test('an emergency answer: sent-to-er, an ER expected card for that patient, an alert naming the Duty doctor and the Cardiology on-call for a cardiac patient, and no doctor clock', async () => {
    await holder();
    cardiologist = { name: 'Dr Heart' };
    await raw(m.ProcedureBooking, {
      number: 'PR-1',
      patient: patient._id,
      case: new Types.ObjectId(caseId),
      procedure: 'coronary-angioplasty',
      status: 'booked'
    });
    const id = String((await svc.scheduleFor(String(patient._id), at(15), 'home', 'discharge:x', { caseId }))._id);
    now = at(10, 0, 28);
    await svc.makeDue(now);
    const d = await svc.submit(DOCTOR, id, { group: 'cardiac', answers: { ...CARDIAC_FINE, exertion: 'rest', followup: 'yes' } });
    assert.deepEqual([d.state, d.result, d.emergency, d.worrying], ['completed', 'sent-to-er', ['exertion'], []]);
    assert.equal(d.answers.followup, undefined, 'the form stops at the emergency');
    assert.equal(expected.length, 1);
    assert.deepEqual(expected[0].input, {
      complaint: 'Check-up CU-0001: Chest pain at rest',
      ageSex: '62 M',
      mode: 'walk-in',
      etaMinutes: 30,
      patientId: String(patient._id)
    });
    assert.equal(expected[0].actor, SUPPORT_ACTOR);
    const a: any = await alertOf(`support-checkup:${id}:er`);
    assert.deepEqual(
      [a.title, a.subtitle, a.type, a.category, a.priority, a.status, a.patientName, a.uhid],
      [
        'Check-up CU-0001 sent to the ER',
        'Duty doctor: Dr Duty; Cardiology on call: Dr Heart',
        'Patient Communication',
        'Critical',
        'High',
        'Pending',
        'Ravi Kumar',
        'MHK202600905'
      ]
    );
    const [done] = await sent('support.checkup-done');
    assert.equal(done.summary, 'CU-0001: check-up done (sent-to-er)');
    assert.deepEqual([done.payload.outcome, String(done.case)], ['sent-to-er', caseId]);
    assert.equal((await sent('support.checkup-worrying')).length, 0);
    assert.equal(await m.Clock.countDocuments({ def: 'support-checkup-doctor' }), 0);
    const line = await m.TimelineEvent.findOne({ title: 'Check-up call CU-0001: sent to the ER' }).lean();
    assert.equal(line?.category, 'Communication');
  });

  test('an emergency still raises the alert when the ER card fails, and a general patient has no cardiology line', async () => {
    failExpected = true;
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: { medicines: 'yes', symptoms: 'severe' } });
    const a: any = await alertOf(`support-checkup:${id}:er`);
    assert.equal(a.subtitle, 'Duty doctor: Admins');
    assert.equal(((await rowOf(id)) as any).result, 'sent-to-er');
  });

  test('a worrying answer: needs-doctor, the alert, and a 60-minute clock', async () => {
    await holder();
    const id = await makeOne();
    const d = await svc.submit(NURSE, id, { group: 'general', answers: { ...FINE, symptoms: 'mild', question: 'yes' }, questionText: 'Can I drive?' });
    assert.deepEqual([d.result, d.worrying, d.questionText], ['needs-doctor', ['symptoms', 'question'], 'Can I drive?']);
    const a: any = await alertOf(`support-checkup:${id}:doctor`);
    assert.deepEqual(
      [a.title, a.subtitle, a.category, a.priority, a.status],
      ['Check-up CU-0001 needs a doctor', 'Fever or new pain; Has a question for the doctor · Duty doctor: Dr Duty', 'Critical', 'High', 'Pending']
    );
    const [w] = await sent('support.checkup-worrying');
    assert.equal(w.summary, 'CU-0001: check-up needs a doctor');
    assert.equal(new Date(w.payload.dueAt as string).getTime(), now.getTime() + 60 * MIN);
    assert.equal((await sent('support.checkup-done'))[0].payload.outcome, 'needs-doctor');
    const clock: any = await m.Clock.findOne({ def: 'support-checkup-doctor', ref: id }).lean();
    assert.equal(clock.state, 'running');
    assert.equal(expected.length, 0);
    assert.deepEqual(
      (await svc.list('needs-doctor')).map((r) => r.id),
      [id]
    );
  });

  test('the caller can switch a general check-up to the cardiac list and record the blood-thinner answer', async () => {
    await holder();
    const id = await makeOne();
    assert.equal((await rowOf(id)).group, 'general');
    const d = await svc.submit(DESK, id, { group: 'cardiac', answers: { ...CARDIAC_FINE, antiplatelets: 'no' } });
    assert.deepEqual([d.group, d.result, d.worrying, d.answers.antiplatelets], ['cardiac', 'needs-doctor', ['antiplatelets'], 'no']);
    assert.equal((await rowOf(id)).group, 'cardiac', 'the chosen list is stored');
    const a: any = await alertOf(`support-checkup:${id}:doctor`);
    assert.equal(a.subtitle, 'Not taking both blood thinners · Duty doctor: Dr Duty');
    assert.equal(((await m.Clock.findOne({ def: 'support-checkup-doctor', ref: id }).lean()) as any).state, 'running');
    // The agent keeps the list the call was placed with.
    const id2 = await makeOne();
    await assert.rejects(svc.submit(SUPPORT_ACTOR, id2, { group: 'cardiac', answers: CARDIAC_FINE }), /other list/);
    await assert.rejects(svc.submit(DESK, id2, { group: 'paediatric' as any, answers: FINE }), BadRequestException);
    assert.deepEqual([(await rowOf(id2)).state, (await rowOf(id2)).group], ['due', 'general']);
  });

  test('a fine result is recorded with its timeline line and no alert', async () => {
    const id = await makeOne();
    const d = await svc.submit(DESK, id, { group: 'general', answers: { ...FINE, rating: '5' } });
    assert.deepEqual([d.result, d.rating, d.byName], ['fine', 5, 'Anita Desk']);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^support-checkup:/ }), 0);
    assert.ok(await m.TimelineEvent.findOne({ title: 'Check-up call CU-0001: fine' }).lean());
    assert.deepEqual(
      (await svc.list('done')).map((r) => r.id),
      [id]
    );
  });

  test('review by a doctor stops the clock; a nurse cannot review', async () => {
    await holder();
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: { ...FINE, medicines: 'no' } });
    await assert.rejects(svc.review(NURSE, id, 'Called him'), ForbiddenException);
    await assert.rejects(svc.review(DOCTOR, id, '   '), BadRequestException);
    const d = await svc.review(DOCTOR, id, 'Called him, medicines restarted');
    assert.deepEqual([d.review?.byName, d.review?.note], ['Dr Review', 'Called him, medicines restarted']);
    assert.equal(((await m.Clock.findOne({ def: 'support-checkup-doctor', ref: id }).lean()) as any).state, 'met');
    assert.equal(((await alertOf(`support-checkup:${id}:doctor`)) as any).status, 'Completed');
    const [r] = await sent('support.checkup-reviewed');
    assert.equal(r.summary, 'CU-0001: check-up reviewed');
    await assert.rejects(svc.review(DOCTOR, id, 'again'), ConflictException);
    assert.equal((await svc.list('needs-doctor')).length, 0);
    assert.equal((await svc.list('done')).length, 1);
    // A fine check-up has nothing to review.
    const fine = await makeOne();
    await svc.submit(NURSE, fine, { group: 'general', answers: FINE });
    await assert.rejects(svc.review(DOCTOR, fine, 'x'), ConflictException);
  });

  test('review of a sent-to-er check-up closes its ER alert', async () => {
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: { medicines: 'yes', symptoms: 'severe' } });
    assert.equal((await svc.list('sent-to-er')).length, 1);
    await svc.review(DOCTOR, id, 'Seen in the ER');
    assert.equal(((await alertOf(`support-checkup:${id}:er`)) as any).status, 'Completed');
  });

  test('three no-answers make not-reached', async () => {
    const id = await makeOne();
    let d = await svc.noAnswer(NURSE, id);
    assert.deepEqual([d.state, d.tries, d.dueDay], ['scheduled', 1, '2026-09-29']);
    assert.equal(((await rowOf(id)) as any).nextTryAt.getTime(), at(10, 0, 29).getTime());
    now = at(10, 0, 29);
    await svc.makeDue(now);
    d = await svc.noAnswer(NURSE, id);
    assert.deepEqual([d.state, d.tries, d.dueDay], ['scheduled', 2, '2026-09-30']);
    now = at(10, 0, 30);
    await svc.makeDue(now);
    d = await svc.noAnswer(NURSE, id);
    assert.deepEqual([d.state, d.tries], ['not-reached', 3]);
    assert.equal((await sent('support.checkup-done')).at(-1)!.payload.outcome, 'not-reached');
    assert.ok(await m.TimelineEvent.findOne({ title: 'Check-up call CU-0001: not reached' }).lean());
    assert.equal((await svc.list('not-reached')).length, 1);
    await assert.rejects(svc.noAnswer(NURSE, id), ConflictException);
  });

  test('a rating of 2 on the call opens a complaint ticket', async () => {
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: FINE, rating: 2 });
    const t: any = await m.SupportTicket.findOne().lean();
    assert.deepEqual([t.ticketType, t.source], ['complaint', 'feedback']);
    const f: any = await m.SupportFeedback.findOne().lean();
    assert.deepEqual([f.source, f.overall, String(f.checkup)], ['call', 2, id]);
  });

  test("the bridge's checkupResult maps answers onto submit", async () => {
    canCall = true;
    const id = await makeOne();
    const call = await m.AgentCall.create({
      purpose: 'checkup',
      patientName: 'Ravi Kumar',
      phone: '+919100000005',
      scheduledFor: now,
      provider: 'simulated',
      checkupId: id,
      status: 'completed',
      outcome: 'enquiry'
    });
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'calling', agentCall: call._id } });
    await bridge.handlers.checkupResult!(id, { outcome: 'enquiry', answers: { ...FINE, symptoms: 'mild' }, rating: 4, agentCallId: String(call._id) });
    const c = await rowOf(id);
    assert.deepEqual([c.state, c.result, c.rating, c.byName, String(c.agentCall)], ['completed', 'needs-doctor', 4, 'Patient Support Agent', String(call._id)]);
    // Wrong answers throw, so Calls keeps them on the call.
    const id2 = await makeOne();
    const call2 = String(oid());
    await assert.rejects(bridge.handlers.checkupResult!(id2, { outcome: 'enquiry', answers: { medicines: 'maybe' }, agentCallId: call2 }), BadRequestException);
    assert.equal((await rowOf(id2)).state, 'due');
    // No answer, wrong number, do not call.
    await bridge.handlers.checkupResult!(id2, { outcome: 'no_answer', answers: {}, agentCallId: call2 });
    assert.deepEqual([(await rowOf(id2)).state, (await rowOf(id2)).tries], ['scheduled', 1]);
    const id3 = await makeOne();
    await bridge.handlers.checkupResult!(id3, { outcome: 'wrong_number', answers: {}, agentCallId: String(oid()) });
    assert.deepEqual([(await rowOf(id3)).state, (await rowOf(id3)).skipReason], ['skipped', 'no-phone']);
    const id4 = await makeOne();
    await bridge.handlers.checkupResult!(id4, { outcome: 'do_not_call', answers: {}, agentCallId: String(oid()) });
    assert.deepEqual([(await rowOf(id4)).state, (await rowOf(id4)).skipReason], ['skipped', 'do-not-contact']);
  });

  test('the bridge ignores a result for another call or for a check-up that is not open', async () => {
    const id = await makeOne();
    const mine = oid();
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'calling', agentCall: mine } });
    await bridge.handlers.checkupResult!(id, { outcome: 'failed', answers: {}, agentCallId: String(oid()) });
    assert.deepEqual([(await rowOf(id)).state, (await rowOf(id)).tries], ['calling', 0]);
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'due' } });
    await svc.submit(NURSE, id, { group: 'general', answers: FINE });
    await bridge.handlers.checkupResult!(id, { outcome: 'no_answer', answers: {}, agentCallId: String(mine) });
    assert.equal((await rowOf(id)).state, 'completed');
    await bridge.handlers.checkupResult!(String(oid()), { outcome: 'no_answer', answers: {}, agentCallId: String(mine) });
  });

  test('syncCalls turns a call that ended silently into a no-answer try', async () => {
    const id = await makeOne();
    const call = await m.AgentCall.create({
      purpose: 'checkup',
      patientName: 'Ravi Kumar',
      phone: '+919100000005',
      scheduledFor: now,
      provider: 'simulated',
      checkupId: id,
      status: 'calling'
    });
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'calling', agentCall: call._id } });
    assert.equal(await svc.syncCalls(), 0, 'still ringing');
    await m.AgentCall.updateOne({ _id: call._id }, { $set: { status: 'completed', outcome: 'no_answer' } });
    assert.equal(await svc.syncCalls(), 1);
    const c = await rowOf(id);
    assert.deepEqual([c.state, c.tries, c.dueDay, c.agentCall ?? null], ['scheduled', 1, '2026-09-29', null]);
    assert.equal(await svc.syncCalls(), 0);
    // A scheduled call that was cancelled, with the check-up still due.
    const id2 = await makeOne();
    const call2 = await m.AgentCall.create({
      purpose: 'checkup',
      patientName: 'Ravi Kumar',
      phone: '+919100000005',
      scheduledFor: now,
      provider: 'simulated',
      checkupId: id2,
      status: 'canceled'
    });
    await m.CheckupCall.updateOne({ _id: id2 }, { $set: { agentCall: call2._id } });
    assert.equal(await svc.syncCalls(), 1);
    assert.deepEqual([(await rowOf(id2)).state, (await rowOf(id2)).tries], ['scheduled', 1]);
  });

  test('syncCalls returns an answered-but-unrecorded call to To do', async () => {
    const id = await makeOne();
    const call = await m.AgentCall.create({
      purpose: 'checkup',
      patientName: 'Ravi Kumar',
      phone: '+919100000005',
      scheduledFor: now,
      provider: 'simulated',
      checkupId: id,
      status: 'completed',
      outcome: 'enquiry'
    });
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'calling', agentCall: call._id } });
    assert.equal(await svc.syncCalls(), 1);
    const c = await rowOf(id);
    assert.deepEqual([c.state, c.tries, String(c.agentCall)], ['due', 0, String(call._id)]);
    assert.equal(await svc.syncCalls(), 0, 'left alone for a person');
    canCall = true;
    assert.equal(await svc.dialDue(at(11, 0, 28)), 0, 'not dialled again');
    assert.equal(dialed.length, 0);
  });

  test('submit validates answers, needs the question text, refuses a second save and a dead patient', async () => {
    const id = await makeOne();
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: { medicines: 'yes' } }), /Choose an answer/);
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: { ...FINE, symptoms: 'bad' } }), BadRequestException);
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: { ...FINE, extra: 'x' } }), BadRequestException);
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: { ...FINE, question: 'yes' } }), /question/);
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: FINE, rating: 6 }), /rating/);
    // The cardiac list needs its own two answers too.
    await assert.rejects(svc.submit(NURSE, id, { group: 'cardiac', answers: FINE }), /blood thinners/);
    await assert.rejects(svc.submit({ id: 'l', name: 'Lab', role: UserRole.LAB }, id, { group: 'general', answers: FINE }), ForbiddenException);
    assert.equal((await rowOf(id)).state, 'due');
    await svc.submit(NURSE, id, { group: 'general', answers: FINE });
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: FINE }), ConflictException);
    const id2 = await makeOne();
    await m.Patient.updateOne({ _id: patient._id }, { $set: { status: 'Deceased' } });
    await assert.rejects(svc.submit(NURSE, id2, { group: 'general', answers: FINE }), /has died/);
    // Not yet due.
    const early = await makeOne(false);
    await assert.rejects(svc.submit(NURSE, early, { group: 'general', answers: FINE }), ConflictException);
  });

  test('detail has both languages, the follow-up to read out and the emergency line', async () => {
    await m.Patient.updateOne({ _id: patient._id }, { $set: { preferredLanguage: 'ta' } });
    await raw(m.FollowUpItem, {
      uhid: 'MHK202600905',
      patientName: 'Ravi Kumar',
      age: 62,
      gender: 'Male',
      followUpDate: '2026-10-03',
      followUpTime: '10:30 AM',
      followUpType: 'Review',
      status: 'Scheduled',
      assignedTo: 'Dr Shajin'
    });
    const id = await makeOne();
    const d = await svc.detail(id);
    assert.equal(d.language, 'ta');
    const q = d.questions[0];
    assert.notEqual(q.en, q.ta);
    assert.equal(q.text, q.ta);
    assert.deepEqual(d.followUp, { date: '2026-10-03', time: '10:30 AM', doctor: 'Dr Shajin' });
    assert.equal(d.emergencyLine.en, 'Please come to the ER now, or call 108 for an ambulance.');
    assert.match(d.emergencyLine.text, /108/);
    assert.notEqual(d.emergencyLine.text, d.emergencyLine.en);
    await m.Patient.updateOne({ _id: patient._id }, { $set: { preferredLanguage: 'en' } });
    assert.equal((await svc.detail(id)).emergencyLine.text, d.emergencyLine.en);
  });

  const deferredCall = async (id: string, status = 'scheduled') => {
    const call = await m.AgentCall.create({
      purpose: 'checkup',
      patientName: 'Ravi Kumar',
      phone: '+919100000005',
      scheduledFor: now,
      provider: 'simulated',
      checkupId: id,
      status
    });
    await m.CheckupCall.updateOne({ _id: id }, { $set: { agentCall: call._id } });
    return call;
  };

  test("an emergency enquiry arriving after a person's no-answer is not silent (the handler throws)", async () => {
    const id = await makeOne();
    const call = await deferredCall(id);
    await svc.noAnswer(NURSE, id);
    assert.deepEqual(canceledCalls, [String(call._id)], 'the deferred call is canceled');
    await assert.rejects(
      bridge.handlers.checkupResult!(id, { outcome: 'enquiry', answers: { medicines: 'yes', symptoms: 'severe' }, agentCallId: String(call._id) }),
      ConflictException
    );
    // Another call's answer for a check-up linked elsewhere also throws; a true duplicate is quiet.
    const id2 = await makeOne();
    await m.CheckupCall.updateOne({ _id: id2 }, { $set: { state: 'calling', agentCall: oid() } });
    await assert.rejects(bridge.handlers.checkupResult!(id2, { outcome: 'enquiry', answers: FINE, agentCallId: String(oid()) }), ConflictException);
    const id3 = await makeOne();
    const c3 = await deferredCall(id3, 'completed');
    await m.CheckupCall.updateOne({ _id: id3 }, { $set: { state: 'calling' } });
    await bridge.handlers.checkupResult!(id3, { outcome: 'enquiry', answers: FINE, agentCallId: String(c3._id) });
    await bridge.handlers.checkupResult!(id3, { outcome: 'enquiry', answers: FINE, agentCallId: String(c3._id) });
    assert.equal(await m.AgentMessage.countDocuments({ type: 'support.checkup-done', 'payload.checkupId': id3 }), 1);
  });

  test('noAnswer is refused while calling, and for a dead patient', async () => {
    const id = await makeOne();
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'calling' } });
    await assert.rejects(svc.noAnswer(NURSE, id), /agent is on this call/);
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'due' } });
    await m.Patient.updateOne({ _id: patient._id }, { $set: { status: 'Deceased' } });
    await assert.rejects(svc.noAnswer(NURSE, id), /has died/);
  });

  test('submit cancels a deferred linked call', async () => {
    const id = await makeOne();
    const call = await deferredCall(id);
    await svc.submit(NURSE, id, { group: 'general', answers: FINE });
    assert.deepEqual(canceledCalls, [String(call._id)]);
    const id2 = await makeOne();
    await deferredCall(id2, 'completed');
    await svc.submit(NURSE, id2, { group: 'general', answers: FINE });
    assert.equal(canceledCalls.length, 1, 'a call already placed is not canceled');
  });

  test('a bridge result with question yes and notes records the question and raises the doctor alert', async () => {
    const id = await makeOne();
    await bridge.handlers.checkupResult!(id, {
      outcome: 'enquiry',
      answers: { ...FINE, question: 'yes' },
      notes: '  Can I take a bath?  ',
      agentCallId: String(oid())
    });
    const c = await rowOf(id);
    assert.deepEqual([c.result, c.questionText], ['needs-doctor', 'Can I take a bath?']);
    assert.ok(await alertOf(`support-checkup:${id}:doctor`));
    assert.equal((await sent('support.checkup-worrying')).length, 1);
    const id2 = await makeOne();
    await bridge.handlers.checkupResult!(id2, { outcome: 'enquiry', answers: { ...FINE, question: 'yes' }, agentCallId: String(oid()) });
    assert.match((await rowOf(id2)).questionText, /see the call transcript/);
  });

  test('a patient who dies after the check-up is due is skipped (calls off)', async () => {
    const id = await makeOne();
    await m.Patient.updateOne({ _id: patient._id }, { $set: { status: 'Deceased' } });
    await svc.makeDue(at(10, 5, 28));
    assert.deepEqual([(await rowOf(id)).state, (await rowOf(id)).skipReason], ['skipped', 'deceased']);
    assert.deepEqual(cancelled, [String(patient._id)]);
    assert.equal((await svc.list('to-do')).length, 0);
  });

  test('doNotCall set after due skips it', async () => {
    const id = await makeOne();
    await m.Patient.updateOne({ _id: patient._id }, { $set: { doNotCall: true } });
    await svc.makeDue(at(10, 5, 28));
    assert.deepEqual([(await rowOf(id)).state, (await rowOf(id)).skipReason], ['skipped', 'do-not-contact']);
  });

  test('repairEffects restores a missing ER card and alert exactly once', async () => {
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: { medicines: 'yes', symptoms: 'severe' } });
    assert.deepEqual(((await rowOf(id)).announced as string[]).sort(), ['done', 'er-alert', 'er-card']);
    later();
    assert.equal(await svc.repairEffects(), 0, 'nothing to redo when all is marked');
    // A crash left neither the alert nor the card.
    await m.TaskAlertItem.deleteMany({});
    expected.length = 0;
    await m.CheckupCall.updateOne({ _id: id }, { $pull: { announced: { $in: ['er-alert', 'er-card'] } } });
    assert.equal(await svc.repairEffects(), 2);
    assert.equal(expected.length, 1);
    assert.ok(await alertOf(`support-checkup:${id}:er`));
    assert.equal(await svc.repairEffects(), 0);
    assert.equal(expected.length, 1, 'the card is made once');
    // A lost doctor alert and announcement of a needs-doctor check-up.
    const id2 = await makeOne();
    await svc.submit(NURSE, id2, { group: 'general', answers: { ...FINE, medicines: 'no' } });
    await m.TaskAlertItem.deleteMany({ link: `support-checkup:${id2}:doctor` });
    await m.CheckupCall.updateOne({ _id: id2 }, { $pull: { announced: { $in: ['doctor-alert', 'worrying', 'done'] } } });
    later();
    assert.equal(await svc.repairEffects(), 3);
    assert.ok(await alertOf(`support-checkup:${id2}:doctor`));
    // Reviewed check-ups are left alone.
    await svc.review(DOCTOR, id, 'Seen');
    assert.equal(await svc.repairEffects(), 0);
  });

  test("a person completes the check-up while the linked call is placed; that call's emergency enquiry then throws", async () => {
    const id = await makeOne();
    const call = await deferredCall(id, 'calling');
    await svc.submit(NURSE, id, { group: 'general', answers: FINE });
    await assert.rejects(
      bridge.handlers.checkupResult!(id, { outcome: 'enquiry', answers: { medicines: 'yes', symptoms: 'severe' }, agentCallId: String(call._id) }),
      ConflictException
    );
  });

  test("a person's submit is refused while calling", async () => {
    const id = await makeOne();
    await m.CheckupCall.updateOne({ _id: id }, { $set: { state: 'calling' } });
    await assert.rejects(svc.submit(NURSE, id, { group: 'general', answers: FINE }), /agent is on this call/);
    assert.equal((await rowOf(id)).state, 'calling');
  });

  test('repairEffects leaves a result alone within its first 2 minutes', async () => {
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: { medicines: 'yes', symptoms: 'severe' } });
    await m.CheckupCall.updateOne({ _id: id }, { $pull: { announced: { $in: ['er-alert', 'er-card'] } } });
    expected.length = 0;
    later(1);
    assert.equal(await svc.repairEffects(), 0);
    later(2);
    assert.equal(await svc.repairEffects(), 2);
    assert.equal(expected.length, 1);
  });

  test('repairEffects still repairs a new emergency when many fully-marked unreviewed results exist', async () => {
    svc.repairBatch = 2;
    for (let i = 0; i < 3; i++) await svc.submit(NURSE, await makeOne(), { group: 'general', answers: { ...FINE, medicines: 'no' } });
    const id = await makeOne();
    await svc.submit(NURSE, id, { group: 'general', answers: { medicines: 'yes', symptoms: 'severe' } });
    await m.CheckupCall.updateOne({ _id: id }, { $pull: { announced: 'er-card' } });
    expected.length = 0;
    later();
    assert.equal(await svc.repairEffects(), 1);
    assert.equal(expected.length, 1);
  });

  test('coming-up lists scheduled check-ups', async () => {
    const id = await makeOne(false);
    assert.deepEqual(
      (await svc.list('coming-up')).map((r) => r.id),
      [id]
    );
  });
});
