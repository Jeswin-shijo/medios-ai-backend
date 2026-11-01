import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingConsultsService } from './scheduling-consults.service';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';

const ER_DOC = { id: 'user-er-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const ADMIN = { id: 'user-admin', name: 'Admin', role: UserRole.ADMIN };
const MIN = 60_000;
/** Tuesday 20 Oct 2026, 10:00 local; CLINIC_DATE unset, so the clinic clock is this clock. */
const NOW = () => new Date(2026, 9, 20, 10, 0, 0, 0);
const D = '2026-10-20';

describe('SchedulingConsultsService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let consults: SchedulingConsultsService;
  let roster: SchedulingRosterService;
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let registry: AgentRegistry;
  let patientId: string;
  let erCase: string;
  let arun: any;
  let arunUser: string;

  const login = async (name: string, role = 'doctor') => String((await m.User.create({ email: `${name.replace(/\W/g, '').toLowerCase()}@x.in`, passwordHash: 'x', name, role }))._id);
  const staff = (name: string, skills: string[], departmentCode: string, userId?: string) => roster.upsertStaff(ADMIN, { name, skills, departmentCode, userId });
  const entry = (staffId: unknown, shift: any, extra: Record<string, unknown> = {}) => roster.setEntry(ADMIN, { date: D, shift, staffId: String(staffId), ...extra });
  const ask = (priority: 'stat' | 'urgent' | 'routine' = 'stat', departmentCode = 'CARD') =>
    consults.request(ER_DOC, { patientId, departmentCode, priority, reason: 'Chest pain, ST changes' });
  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;
  const alert = (link: string) => m.TaskAlertItem.findOne({ link }).lean().exec() as Promise<any>;
  const clockOf = (id: string) => m.Clock.findOne({ def: 'scheduling-consult', ref: id }).lean().exec() as Promise<any>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    mock.timers.enable({ apis: ['Date'], now: NOW() });
    await resetTestDb();
    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new SchedulingSettingsService(settingsService);
    roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, settings, escalations);
    roster.onModuleInit();
    consults = new SchedulingConsultsService(
      m.ConsultRequest, m.StaffMember, m.OpDoctor, m.Department, m.CoordinatorCounter, m.TaskAlertItem,
      new PatientsService(m.Patient), cases, messages, settings, roster, escalations,
    );
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock, consults, messages).onModuleInit();
    // The ER and Bed agents' message types, as the real registrations declare them.
    registry.register({ key: 'er', messageTypes: [{ type: 'er.disposition', agent: 'er', description: 'd', payload: { visitId: 'string', kind: 'string' } }], status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    registry.register({ key: 'bed', messageTypes: [{ type: 'bed.discharged', agent: 'bed', description: 'd', payload: { bedId: 'string', bedLabel: 'string' } }], status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    await m.Department.create({ code: 'CARD', name: 'Cardiology', tokenPrefix: 'C' });
    const p = await m.Patient.create({ uhid: 'MHK202600960', name: 'Mohan Raj', age: 58, gender: 'Male', phone: '9100000060' });
    patientId = String(p._id);
    erCase = String((await cases.openOrJoin({ patientId, patientUhid: p.uhid, patientName: 'Mohan Raj', kind: 'er', priority: 'high', openedBy: 'er' })).case._id);
    arunUser = await login('Dr. Arun');
    arun = await staff('Dr. Arun', ['cardiologist'], 'CARD', arunUser);
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test('a STAT cardiology consult pages the on-call cardiologist with a High alert and a 30-minute clock', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    assert.equal(v.number, 'CO-0001');
    assert.equal(v.status, 'paged');
    assert.deepEqual(v.pagedTo, { id: arunUser, name: 'Dr. Arun' });
    assert.equal(v.caseId, erCase, 'it joins the open ER case');

    const a = await alert(`scheduling-consult:${v.id}`);
    assert.equal(a.title, 'Consult: Cardiology (STAT)');
    assert.equal(a.subtitle, 'For Dr. Arun · CO-0001 · see within 30 min');
    assert.deepEqual([a.type, a.category, a.priority, a.status], ['System', 'Critical', 'High', 'Pending']);
    assert.equal(a.uhid, 'MHK202600960');

    const clock = await clockOf(v.id);
    assert.equal(clock.state, 'running');
    assert.equal(clock.dueAt.getTime(), Date.now() + 30 * MIN);
    const [req] = await sent('scheduling.consult-requested');
    assert.deepEqual(req.payload, { consultId: v.id, number: 'CO-0001', department: 'Cardiology', priority: 'stat', dueAt: new Date(Date.now() + 30 * MIN) });
    assert.equal(req.summary, 'CO-0001: Cardiology consult requested (STAT)');
    assert.ok(!JSON.stringify(req).includes('Mohan'), 'no name in the message');
    const [paged] = await sent('scheduling.consult-paged');
    assert.equal(paged.payload.dueAt.getTime(), Date.now() + 30 * MIN);
  });

  test('an on-call doctor without a login → the Duty doctor holders are paged with the department named', async () => {
    const nologin = await staff('Dr. Nologin', ['cardiologist'], 'CARD');
    await entry(nologin._id, 'on-call');
    const dutyUser = await login('Dr. Duty');
    const duty = await staff('Dr. Duty', ['physician'], 'GM', dutyUser);
    await entry(duty._id, 'on-call', { titles: ['duty-doctor'] });

    const v = await ask('urgent');
    assert.deepEqual(v.pagedTo, { id: dutyUser, name: 'Dr. Duty' });
    const a = await alert(`scheduling-consult:${v.id}`);
    assert.equal(a.title, 'Consult: Cardiology (URGENT)');
    assert.equal(a.subtitle, 'For Dr. Duty (Duty doctor) · CO-0001 · see within 120 min');
    assert.equal((await clockOf(v.id)).dueAt.getTime(), Date.now() + 120 * MIN);
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.pagedIds.join(), dutyUser);
  });

  test('it checks the reason and the department, and a missing patient is refused', async () => {
    await assert.rejects(consults.request(ER_DOC, { patientId, departmentCode: 'CARD', priority: 'stat', reason: '' }), BadRequestException);
    await assert.rejects(consults.request(ER_DOC, { patientId, departmentCode: 'CARD', priority: 'stat', reason: 'x'.repeat(501) }), BadRequestException);
    await assert.rejects(consults.request(ER_DOC, { patientId, departmentCode: '', priority: 'stat', reason: 'x' }), BadRequestException);
    await assert.rejects(consults.request(ER_DOC, { patientId, departmentCode: 'CARD', priority: 'later' as any, reason: 'x' }), BadRequestException);
  });

  test('only the paged doctor, a doctor of the department or an admin may accept or complete it', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('urgent');
    const otherUser = await login('Dr. Other');
    await staff('Dr. Other', ['physician'], 'GM', otherUser);
    const cardUser = await login('Dr. Cardio2');
    await staff('Dr. Cardio2', ['cardiologist'], 'CARD', cardUser);
    const opUser = await login('Dr. Op');
    await m.OpDoctor.create({ name: 'Dr. Op', departmentCode: 'CARD', room: 'Room 1', tokenPrefix: 'O', userId: opUser });

    await assert.rejects(consults.accept({ id: otherUser, name: 'Dr. Other', role: UserRole.DOCTOR }, v.id), ForbiddenException);
    await assert.rejects(consults.accept({ id: 'nurse', name: 'Nurse', role: UserRole.NURSE }, v.id), ForbiddenException);
    await assert.rejects(consults.seen({ id: otherUser, name: 'Dr. Other', role: UserRole.DOCTOR }, v.id), ForbiddenException);
    // Seen needs an accept or a page: a paged consult can be seen directly by the paged doctor.
    const accepted = await consults.accept({ id: cardUser, name: 'Dr. Cardio2', role: UserRole.DOCTOR }, v.id);
    assert.equal(accepted.status, 'accepted');
    await assert.rejects(consults.accept({ id: arunUser, name: 'Dr. Arun', role: UserRole.DOCTOR }, v.id), ConflictException);
    const [acc] = await sent('scheduling.consult-accepted');
    assert.equal(acc.payload.number, 'CO-0001');
    const seen = await consults.seen({ id: opUser, name: 'Dr. Op', role: UserRole.DOCTOR }, v.id);
    assert.equal(seen.status, 'seen');
    await assert.rejects(consults.seen(ADMIN, v.id), ConflictException);

    const w = await ask('routine');
    assert.equal((await consults.seen(ADMIN, w.id)).status, 'seen', 'an admin may complete it, straight from paged');
    const x = await ask('routine');
    assert.equal((await consults.accept({ id: arunUser, name: 'Dr. Arun', role: UserRole.DOCTOR }, x.id)).status, 'accepted');
  });

  test('Seen stops the clock and completes the alert', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    mock.timers.tick(10 * MIN);
    const done = await consults.seen({ id: arunUser, name: 'Dr. Arun', role: UserRole.DOCTOR }, v.id);
    assert.equal(done.status, 'seen');
    assert.ok(done.seenAt);
    assert.equal((await clockOf(v.id)).state, 'met');
    assert.equal((await alert(`scheduling-consult:${v.id}`)).status, 'Completed');
    const [msg] = await sent('scheduling.consult-seen');
    assert.equal(msg.priority, 'high');
    mock.timers.tick(60 * MIN);
    assert.equal(await clocks.checkDue(new Date()), 0);
    assert.equal(await m.Escalation.countDocuments({}), 0);
  });

  test('an unseen consult escalates on the consult ladder once the target passes', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    mock.timers.tick(31 * MIN);
    assert.equal(await clocks.checkDue(new Date()), 1);
    const esc = await m.Escalation.find({}).lean();
    assert.equal(esc.length, 1);
    assert.equal(esc[0].alertLink, `scheduling-consult:${v.id}`);
  });

  test('re-page needs a department doctor with a login, keeps the clock and updates the alert', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    const dueBefore = (await clockOf(v.id)).dueAt.getTime();
    const cardUser = await login('Dr. Cardio2');
    await staff('Dr. Cardio2', ['cardiologist'], 'CARD', cardUser);
    const otherUser = await login('Dr. Other');
    await staff('Dr. Other', ['physician'], 'GM', otherUser);

    await assert.rejects(consults.repage(ADMIN, v.id, otherUser), BadRequestException);
    await assert.rejects(consults.repage(ADMIN, v.id, String(new Types.ObjectId())), BadRequestException);
    await assert.rejects(consults.repage({ id: 'someone', name: 'Someone', role: UserRole.DOCTOR }, v.id, cardUser), ForbiddenException);
    const r = await consults.repage(ER_DOC, v.id, cardUser);
    assert.deepEqual(r.pagedTo, { id: cardUser, name: 'Dr. Cardio2' });
    assert.equal((await clockOf(v.id)).dueAt.getTime(), dueBefore);
    const a = await alert(`scheduling-consult:${v.id}`);
    assert.equal(a.subtitle, 'For Dr. Cardio2 · CO-0001 · see within 30 min');
    assert.equal((await sent('scheduling.consult-paged')).length, 2);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `scheduling-consult:${v.id}` }), 1);
  });

  test('cancel is for the requester or an admin, needs a reason, stops the clock and completes the alert', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    await assert.rejects(consults.cancel({ id: arunUser, name: 'Dr. Arun', role: UserRole.DOCTOR }, v.id, 'no'), ForbiddenException);
    await assert.rejects(consults.cancel(ER_DOC, v.id, '  '), BadRequestException);
    const c = await consults.cancel(ER_DOC, v.id, 'Patient improved');
    assert.equal(c.status, 'cancelled');
    assert.equal(c.cancelled!.reason, 'Patient improved');
    assert.equal((await clockOf(v.id)).state, 'met');
    assert.equal((await alert(`scheduling-consult:${v.id}`)).status, 'Completed');
    assert.equal((await sent('scheduling.consult-cancelled')).length, 1);
    await assert.rejects(consults.cancel(ADMIN, v.id, 'again'), ConflictException);
  });

  test('er.disposition home with an open consult → cancelled, clock stopped, alert completed, no escalation after the target', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    const pending = await ask('routine');
    await messages.send({ case: erCase, from: 'er', to: ['coordinator'], type: 'er.disposition', priority: 'medium', summary: 'ER-0001: decision is home', payload: { visitId: 'v1', kind: 'home' } });

    for (const id of [v.id, pending.id]) {
      const c = (await m.ConsultRequest.findById(id).lean())!;
      assert.equal(c.status, 'cancelled');
      assert.equal(c.cancelled!.reason, 'Patient left');
      assert.equal(c.cancelled!.by, 'Scheduling Agent');
      assert.equal((await clockOf(id)).state, 'met');
      assert.equal((await alert(`scheduling-consult:${id}`)).status, 'Completed');
    }
    mock.timers.tick(25 * 60 * MIN);
    assert.equal(await clocks.checkDue(new Date()), 0);
    assert.equal(await m.Escalation.countDocuments({}), 0, 'no escalation');
    const open = await m.TaskAlertItem.find({ link: /^scheduling-consult:/, status: { $ne: 'Completed' } }).lean();
    assert.equal(open.length, 0, 'no new or open alert');
  });

  test('er.disposition admit leaves the consult open; transfer, left-against-advice and died cancel it', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('urgent');
    const send = (kind: string) => messages.send({ case: erCase, from: 'er', to: ['coordinator'], type: 'er.disposition', priority: 'medium', summary: `ER-0001: decision is ${kind}`, payload: { visitId: 'v1', kind } });
    await send('admit');
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.status, 'paged');
    await send('died');
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.status, 'cancelled');
    const w = await ask('urgent');
    await send('transfer');
    assert.equal((await m.ConsultRequest.findById(w.id).lean())!.status, 'cancelled');
    const x = await ask('urgent');
    await send('left-against-advice');
    assert.equal((await m.ConsultRequest.findById(x.id).lean())!.status, 'cancelled');
  });

  test('bed.discharged cancels the case\'s open consults; one with no case is skipped; a seen consult stays seen', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('urgent');
    const seen = await ask('routine');
    await consults.seen(ADMIN, seen.id);
    await messages.send({ case: null, from: 'bed', to: ['coordinator'], type: 'bed.discharged', priority: 'low', summary: 'x left', payload: { bedId: 'b', bedLabel: 'A-1' } });
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.status, 'paged');
    await messages.send({ case: erCase, from: 'bed', to: ['coordinator'], type: 'bed.discharged', priority: 'low', summary: 'x left', payload: { bedId: 'b', bedLabel: 'A-1' } });
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.status, 'cancelled');
    assert.equal((await m.ConsultRequest.findById(seen.id).lean())!.status, 'seen');
  });

  test('a failed consult-requested send never strands the consult: it is paged, the alert exists, announcedAt is unset', async () => {
    await entry(arun._id, 'on-call');
    const real = messages.send.bind(messages);
    const send = mock.method(messages, 'send', (input: any) => {
      if (input.type === 'scheduling.consult-requested') throw new Error('boom');
      return real(input);
    });
    const v = await ask('stat');
    assert.equal(v.status, 'paged');
    assert.equal(v.number, 'CO-0001');
    assert.ok(await alert(`scheduling-consult:${v.id}`), 'the page alert exists');
    assert.equal(await clockOf(v.id), null, 'no clock yet');
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.announcedAt, undefined);
    assert.equal(await m.ConsultRequest.countDocuments({}), 1, 'no duplicate');
    send.mock.restore();

    // The reconcile pass re-announces: the clock starts and announcedAt is set.
    assert.equal(await consults.announce(v.id), true);
    assert.equal((await clockOf(v.id)).state, 'running');
    assert.ok((await m.ConsultRequest.findById(v.id).lean())!.announcedAt);
    assert.equal((await sent('scheduling.consult-requested')).length, 1);
    assert.equal((await sent('scheduling.consult-paged')).length, 1);
  });

  test('a status change unsets announcedAt until its message is sent', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('urgent');
    assert.ok((await m.ConsultRequest.findById(v.id).lean())!.announcedAt);
    const real = messages.send.bind(messages);
    const send = mock.method(messages, 'send', () => {
      throw new Error('boom');
    });
    await consults.accept(ADMIN, v.id);
    assert.equal((await m.ConsultRequest.findById(v.id).lean())!.announcedAt, undefined);
    send.mock.restore();
    assert.equal(await consults.announce(v.id), true);
    assert.ok((await m.ConsultRequest.findById(v.id).lean())!.announcedAt);
  });

  test('escalate, then Seen: the escalation is resolved with "Consult seen" and the alert is completed', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    mock.timers.tick(31 * MIN);
    assert.equal(await clocks.checkDue(new Date()), 1);
    const link = `scheduling-consult:${v.id}`;
    assert.equal(await m.TaskAlertItem.countDocuments({ link }), 1, 'the escalation took over the one alert');
    assert.ok((await alert(link)).escalation, 'the alert carries the escalation');
    await consults.seen({ id: arunUser, name: 'Dr. Arun', role: UserRole.DOCTOR }, v.id);
    const e = (await m.Escalation.findOne({ alertLink: link }).lean()) as any;
    assert.equal(e.state, 'acknowledged');
    assert.equal(e.ackByName, 'Consult seen');
    assert.equal((await alert(link)).status, 'Completed');
  });

  test('a re-page after an escalation changes only the subtitle and who is paged', async () => {
    await entry(arun._id, 'on-call');
    const v = await ask('stat');
    mock.timers.tick(31 * MIN);
    await clocks.checkDue(new Date());
    const before = await alert(`scheduling-consult:${v.id}`);
    const cardUser = await login('Dr. Cardio2');
    await staff('Dr. Cardio2', ['cardiologist'], 'CARD', cardUser);
    const r = await consults.repage(ER_DOC, v.id, cardUser);
    const after = await alert(`scheduling-consult:${v.id}`);
    assert.equal(after.title, before.title);
    assert.match(after.title, /^Escalated to/);
    assert.deepEqual([after.status, after.priority, after.category], [before.status, before.priority, before.category]);
    assert.deepEqual(after.escalation, before.escalation);
    assert.match(after.subtitle, /^For Dr\. Cardio2 · CO-0001 · see within /);
    assert.equal(r.status, 'paged');
    assert.deepEqual(r.pagedTo, { id: cardUser, name: 'Dr. Cardio2' });
    assert.equal(await m.Escalation.countDocuments({}), 1);
  });
});
