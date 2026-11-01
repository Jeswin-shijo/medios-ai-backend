import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { TimelineService } from '../timeline/timeline.service';
import {
  SCHEDULING_CLOCKS,
  SCHEDULING_MESSAGE_TYPES,
  SchedulingCoordinatorRegistration,
} from './scheduling-coordinator.registration';

describe('SchedulingCoordinatorRegistration', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let caseId: string;
  const patient = new Types.ObjectId();

  const consult = (status: string, extra: Record<string, unknown> = {}) =>
    m.ConsultRequest.create({
      number: `CO-${Math.random().toString().slice(2, 8)}`, patient, patientUhid: 'MHK1', patientName: 'Ravi', case: caseId,
      departmentCode: 'CARD', priority: 'urgent', status, requestedBy: { id: 'u', name: 'Dr' }, requestedAt: new Date(), ...extra,
    });
  const booking = (status: string, extra: Record<string, unknown> = {}) =>
    m.ProcedureBooking.create({
      number: `PR-${Math.random().toString().slice(2, 8)}`, patient, patientUhid: 'MHK1', patientName: 'Ravi', case: caseId,
      procedure: 'chest-xray', priority: 'routine', status, requestedBy: { id: 'u', name: 'Dr' }, earliest: new Date(), ...extra,
    });
  const closeCheck = () => registry.closeChecks().find((c) => c.agent === 'scheduling')!.check(caseId);

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
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock).onModuleInit();
    const p = await m.Patient.create({ uhid: 'MHK202600902', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000002' });
    caseId = String(
      (await cases.openOrJoin({ patientId: String(p._id), patientUhid: p.uhid, patientName: 'Ravi Kumar', kind: 'er', priority: 'high', openedBy: 'er' })).case._id,
    );
  });

  test('registration: the agent is built; the close check fails on an open consult and passes once it is seen', async () => {
    assert.equal(SCHEDULING_MESSAGE_TYPES.length, 13);
    for (const t of ['requested', 'booked', 'bumped', 'started', 'done', 'cancelled', 'cant-book']) assert.equal(registry.messageType(`scheduling.procedure-${t}`)?.agent, 'scheduling', t);
    for (const t of ['requested', 'paged', 'accepted', 'seen', 'cancelled']) assert.equal(registry.messageType(`scheduling.consult-${t}`)?.agent, 'scheduling', t);
    assert.deepEqual(registry.messageType('scheduling.procedure-booked')!.payload, {
      bookingId: 'string', number: 'string', procedure: 'string', priority: 'string', status: 'string', room: 'string', start: 'date', contrast: 'boolean',
    });
    assert.deepEqual(registry.messageType('scheduling.procedure-cant-book')!.payload.dueAt, 'date');
    assert.deepEqual(registry.messageType('scheduling.consult-paged')!.payload, { consultId: 'string', number: 'string', department: 'string', priority: 'string', dueAt: 'date' });
    assert.deepEqual(registry.messageType('scheduling.followup-booked')!.payload, { appointmentId: 'string', date: 'string', time: 'string', doctor: 'string' });

    const rule = registry.rules().find((r) => r.key === 'emergency-bump')!;
    assert.deepEqual([rule.agent, rule.label, rule.default, rule.locked], ['scheduling', 'Emergencies may bump planned procedures', true, undefined]);
    const def = registry.definitions().find((d) => d.key === 'scheduling')!;
    assert.deepEqual(await def.status(), { open: 0, capacity: 0, onTimePct: null });
    assert.equal(def.closeChecks![0].label, 'Procedures and consults finished');

    assert.equal(await closeCheck(), 'n/a');
    const c = await consult('paged');
    assert.equal(await closeCheck(), 'fail');
    await m.ConsultRequest.updateOne({ _id: c._id }, { status: 'accepted' });
    assert.equal(await closeCheck(), 'fail');
    await m.ConsultRequest.updateOne({ _id: c._id }, { status: 'seen', seenAt: new Date() });
    assert.equal(await closeCheck(), 'pass');

    const b = await booking('booked');
    assert.equal(await closeCheck(), 'fail');
    await m.ProcedureBooking.updateOne({ _id: b._id }, { status: 'in-progress' });
    assert.equal(await closeCheck(), 'fail');
    await m.ProcedureBooking.updateOne({ _id: b._id }, { status: 'done' });
    assert.equal(await closeCheck(), 'pass');
    await m.ProcedureBooking.deleteMany({});
    await m.ConsultRequest.deleteMany({});
    await booking('cancelled');
    await consult('cancelled');
    assert.equal(await closeCheck(), 'n/a', 'only cancelled work is nothing to wait for');
    await booking('cant-book');
    assert.equal(await closeCheck(), 'n/a', "can't-book is not booked yet, so it does not block");
    // Other cases are not counted.
    await consult('paged', { case: new Types.ObjectId() });
    assert.equal(await closeCheck(), 'n/a');
  });

  test('the status counts open consults, today\'s booked and in-progress procedures, and can\'t-book ones', async () => {
    const def = registry.definitions().find((d) => d.key === 'scheduling')!;
    await consult('paged');
    await consult('accepted');
    await consult('seen');
    const now = new Date();
    await booking('booked', { start: now, end: now });
    await booking('in-progress', { start: now, end: now });
    await booking('booked', { start: new Date(now.getTime() + 5 * 86_400_000) });
    await booking('done', { start: now });
    await booking('cant-book');
    assert.equal((await def.status()).open, 2 + 2 + 1);
  });

  test('the clocks: the consult clock follows dueAt on the consult ladder; the booking clock starts only for STAT or urgent', async () => {
    assert.equal(SCHEDULING_CLOCKS.length, 2);
    const consultClock = registry.clock('scheduling-consult')!;
    const bookingClock = registry.clock('scheduling-booking')!;
    assert.deepEqual([consultClock.ladder, consultClock.startOn, consultClock.stopOn], ['consult', 'scheduling.consult-requested', ['scheduling.consult-seen', 'scheduling.consult-cancelled']]);
    assert.deepEqual([bookingClock.ladder, bookingClock.startOn, bookingClock.stopOn], ['default', 'scheduling.procedure-cant-book', ['scheduling.procedure-booked', 'scheduling.procedure-cancelled']]);
    assert.equal(consultClock.resolveEscalationOnStop, true);
    assert.equal(consultClock.resolvedBy, 'Consult seen');
    assert.equal(consultClock.alertLink!('abc'), 'scheduling-consult:abc');
    assert.equal(consultClock.detailFrom!({ number: 'CO-0001', department: 'Cardiology' }), 'CO-0001 Cardiology');

    const dueAt = new Date(Date.now() + 30 * 60_000);
    const payload = { consultId: 'c1', number: 'CO-0001', department: 'Cardiology', priority: 'urgent', dueAt };
    await messages.send({ case: caseId, from: 'scheduling', to: ['coordinator'], type: 'scheduling.consult-requested', priority: 'high', summary: 'CO-0001: Cardiology consult requested (URGENT)', payload });
    const running = await m.Clock.find({ def: 'scheduling-consult' }).lean();
    assert.equal(running.length, 1);
    assert.equal(running[0].ref, 'c1');
    assert.equal(running[0].dueAt.getTime(), dueAt.getTime());
    await messages.send({ case: caseId, from: 'scheduling', to: ['coordinator'], type: 'scheduling.consult-seen', priority: 'medium', summary: 'CO-0001: Cardiology consult seen (URGENT)', payload });
    assert.equal((await m.Clock.findOne({ def: 'scheduling-consult' }).lean())!.state, 'met');

    const cant = (priority: string, id: string) => ({ bookingId: id, number: 'PR-0001', procedure: 'chest-xray', priority, status: 'cant-book', dueAt });
    await messages.send({ case: caseId, from: 'scheduling', to: ['coordinator'], type: 'scheduling.procedure-cant-book', priority: 'high', summary: 'x', payload: cant('routine', 'b1') });
    assert.equal(await m.Clock.countDocuments({ def: 'scheduling-booking' }), 0);
    await messages.send({ case: caseId, from: 'scheduling', to: ['coordinator'], type: 'scheduling.procedure-cant-book', priority: 'high', summary: 'x', payload: cant('stat', 'b2') });
    assert.equal(await m.Clock.countDocuments({ def: 'scheduling-booking', ref: 'b2', state: 'running' }), 1);
    await messages.send({ case: caseId, from: 'scheduling', to: ['coordinator'], type: 'scheduling.procedure-booked', priority: 'high', summary: 'x', payload: { ...cant('stat', 'b2'), status: 'booked', room: 'xray', start: dueAt, contrast: false } });
    assert.equal(await m.Clock.countDocuments({ def: 'scheduling-booking', ref: 'b2', state: 'running' }), 0);
  });
});
