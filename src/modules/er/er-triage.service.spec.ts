import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { Actor } from '../beds/actor';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { PatientsService } from '../patients/patients.service';
import { PatientCardsService } from '../queue/patient-cards.service';
import { QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { VitalsService } from '../vitals/vitals.service';
import { ErBaysService } from './er-bays.service';
import { ErCoordinatorRegistration } from './er-coordinator.registration';
import { ErTargetsService } from './er-targets.service';
import { ErTriageService, TriageInput } from './er-triage.service';
import { ErVisitsService } from './er-visits.service';

const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const ADMIN: Actor = { id: 'user-admin', name: 'Admin', role: UserRole.ADMIN };
const MIN = 60_000;
const CALM = { bpSystolic: 130, bpDiastolic: 80, heartRate: 80, spo2: 98, respiratoryRate: 16, temperature: 37 };

describe('ErTriageService', () => {
  const m = models();
  let visits: ErVisitsService;
  let service: ErTriageService;
  let clocks: ClocksService;
  let escalations: EscalationsService;
  let patientCount: number;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    patientCount = 0;
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const patients = new PatientsService(m.Patient);
    const cards = new PatientCardsService(m.PatientCard, m.Patient, null as unknown as QueueService);
    const bays = new ErBaysService(m.ErBay, m.ErVisit);
    visits = new ErVisitsService(m.ErVisit, m.ErExpected, m.CoordinatorCounter, m.Patient, patients, cards, cases, messages, bays, m.Clock, new ErTargetsService(new SettingsService(m.HospitalSettings)));
    const settings = new SettingsService(m.HospitalSettings);
    service = new ErTriageService(m.ErVisit, new VitalsService(m.VitalsRecord, m.Patient), new RulesService(registry, settings, events), cases, messages, new ErTargetsService(settings), visits);
    new ErCoordinatorRegistration(registry, visits, bays, messages, service, m.ErVisit, m.Clock).onModuleInit();
  });

  const arrive = async (complaint: any = 'chest-pain') => {
    patientCount++;
    const p = await m.Patient.create({ uhid: `MHK2026008${String(patientCount).padStart(2, '0')}`, name: 'Ravi Kumar', age: 52, gender: 'Male', phone: `9200000${String(patientCount).padStart(3, '0')}` });
    return visits.arrive(NURSE, { uhid: p.uhid, mode: 'walk-in', complaint });
  };
  const input = (over: Partial<TriageInput> = {}): TriageInput => ({ vitals: CALM, complaint: 'chest-pain', colour: 'orange', ...over });
  const clockOf = (def: string, caseId: string) => m.Clock.findOne({ def, case: caseId }).lean().exec() as Promise<any>;
  const created = async (id: string) => new Date(((await m.ErVisit.findById(id).lean()) as any).createdAt).getTime();
  const backdate = (id: string, minutes: number) =>
    // createdAt is immutable in Mongoose, so go to the collection.
    m.ErVisit.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { createdAt: new Date(Date.now() - minutes * MIN) } });
  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1 }).lean().exec() as Promise<any[]>;

  test('triage saves vitals, the suggestion and the colour and starts the doctor clock', async () => {
    const v = await arrive('other');
    const out = await service.triage(NURSE, v.id, input({ complaint: 'other', colour: 'green', painScore: 2 }));

    assert.equal(out.status, 'waiting-doctor');
    assert.equal(out.colour, 'green');
    assert.equal(out.triage!.suggested, 'green');
    assert.equal(out.triage!.byName, 'Nurse Anita');
    assert.equal(out.painScore, 2);
    const vitals: any = await m.VitalsRecord.findById(out.vitalsId).lean();
    assert.equal(vitals.uhid, v.patientUhid);
    assert.equal(vitals.spo2, 98);
    assert.equal(vitals.bpDiastolic, 80);

    const [msg] = await sent('er.triaged');
    assert.equal(msg.payload.colour, 'green');
    assert.ok(!msg.summary.includes('Ravi'));
    assert.equal(new Date(msg.payload.doctorDueAt).getTime(), (await created(v.id)) + 240 * MIN);
    const doctor = await clockOf('er-doctor', v.caseId);
    assert.equal(doctor.state, 'running');
    assert.equal(new Date(doctor.dueAt).getTime(), (await created(v.id)) + 240 * MIN);
    assert.equal((await clockOf('er-triage', v.caseId)).state, 'met');
  });

  test('the triage readings stay on the visit even when no Vitals record is saved', async () => {
    const v = await arrive('other');
    const out = await service.triage(NURSE, v.id, input({ complaint: 'other', colour: 'green', vitals: { spo2: 97, temperature: 37.2 } }));
    assert.equal(out.vitalsId, null);
    assert.deepEqual(out.vitals, { spo2: 97, temperature: 37.2 });
    assert.equal(await m.VitalsRecord.countDocuments(), 0);
    const full = await arrive('other');
    const out2 = await service.triage(NURSE, full.id, input({ complaint: 'other', colour: 'green' }));
    assert.equal(out2.vitals!.bpDiastolic, 80);
    assert.ok(out2.vitalsId);
  });

  test('a colour lower than suggested needs a reason', async () => {
    const v = await arrive('chest-pain-severe');
    await assert.rejects(service.triage(NURSE, v.id, input({ complaint: 'chest-pain-severe', colour: 'yellow' })), (e: any) => e.status === 400 && e.message === 'Give a reason for a lower colour than suggested.');
    await assert.rejects(service.triage(NURSE, v.id, input({ complaint: 'chest-pain-severe', colour: 'yellow', reason: '   ' })), (e: any) => e.status === 400);
    assert.equal((await visits.get(v.id)).status, 'waiting-triage');
    const out = await service.triage(NURSE, v.id, input({ complaint: 'chest-pain-severe', colour: 'yellow', reason: 'Pain settled, looks well' }));
    assert.equal(out.triage!.suggested, 'red');
    assert.equal(out.triage!.changeReason, 'Pain settled, looks well');
    // Higher than suggested is fine without a reason.
    const w = await arrive('fever');
    assert.equal((await service.triage(NURSE, w.id, input({ complaint: 'fever', colour: 'red' }))).colour, 'red');
  });

  test('chest pain starts the chest-pain pathway and its ECG clock is due 10 minutes after arrival', async () => {
    const v = await arrive('chest-pain');
    const out = await service.triage(NURSE, v.id, input());
    assert.deepEqual(out.pathways.map((p) => [p.key, p.startedBy]), [['chest-pain', 'rules']]);
    assert.deepEqual(out.steps.map((s) => s.key).sort(), ['doctor', 'ecg']);
    const base = await created(v.id);
    const ecg = await clockOf('er-step-ecg', v.caseId);
    assert.equal(ecg.state, 'running');
    assert.equal(new Date(ecg.dueAt).getTime(), base + 10 * MIN);
    // The pathway's doctor step (15) beats orange (30), and the message already said so.
    const [started] = await sent('er.pathway-started');
    assert.equal(new Date(started.payload.doctorDueAt).getTime(), base + 15 * MIN);
    assert.deepEqual(Object.keys(started.payload.stepDue), ['ecg']);
    assert.equal(new Date((await sent('er.triaged'))[0].payload.doctorDueAt).getTime(), base + 15 * MIN);
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), base + 15 * MIN);
  });

  test('the view lists the live er clocks with their due times, and a done step leaves the list', async () => {
    const v = await arrive('chest-pain');
    const out = await service.triage(NURSE, v.id, input());
    const base = await created(v.id);
    assert.deepEqual(
      out.clocks.map((c) => [c.key, c.label, c.state, c.dueAt]).sort(),
      [
        ['er-doctor', 'Doctor review', 'running', new Date(base + 15 * MIN).toISOString()],
        ['er-step-ecg', 'ECG done', 'running', new Date(base + 10 * MIN).toISOString()],
      ],
    );
    assert.equal(out.overdue, false, 'only future running clocks');
    const after = await service.tickStep(NURSE, v.id, 'ecg');
    assert.deepEqual(after.clocks.map((c) => c.key), ['er-doctor']);
  });

  test('an expired clock makes the visit overdue until it is stopped', async () => {
    const v = await arrive('chest-pain');
    await service.triage(NURSE, v.id, input());
    await backdate(v.id, 12);
    await m.Clock.updateOne({ def: 'er-step-ecg', case: v.caseId }, { $set: { dueAt: new Date(Date.now() - 2 * MIN) } });
    assert.equal(await clocks.checkDue(new Date()), 1);
    const late = await visits.get(v.id);
    assert.equal(late.overdue, true);
    assert.equal(late.clocks.find((c) => c.key === 'er-step-ecg')!.state, 'expired');
    // Done late: the clock stays expired but stopped, so it no longer needs action.
    const done = await service.tickStep(NURSE, v.id, 'ecg');
    assert.equal(done.clocks.some((c) => c.key === 'er-step-ecg'), false);
    assert.equal(done.overdue, false);
  });

  test('re-triage to red after the target passed makes the doctor clock due at once', async () => {
    const v = await arrive('other');
    await service.triage(NURSE, v.id, input({ complaint: 'other', colour: 'green' }));
    await backdate(v.id, 60);
    assert.equal(await clocks.checkDue(new Date()), 0);

    const out = await service.retriage(NURSE, v.id, 'red', 'Collapsed in the waiting area');
    assert.equal(out.colour, 'red');
    assert.equal(out.triage!.history[1].reason, 'Collapsed in the waiting area');
    assert.equal(await clocks.checkDue(new Date()), 1);
    const esc: any[] = await m.Escalation.find().lean();
    assert.equal(esc.length, 1);
    assert.equal(esc[0].ladder, 'er');
    assert.equal(esc[0].reason, 'Doctor review overdue');
    assert.equal(((await m.Case.findById(v.caseId).lean()) as any).priority, 'critical');
  });

  test('cancelling a pathway stops its clocks with no escalation; ticking a step after it expired leaves the escalation', async () => {
    const a = await arrive('chest-pain');
    await service.triage(NURSE, a.id, input());
    const out = await service.cancelPathway(NURSE, a.id, 'chest-pain', 'Pain was muscular');
    assert.equal(out.pathways[0].cancelled!.reason, 'Pain was muscular');
    assert.equal((await clockOf('er-step-ecg', a.caseId)).state, 'met');
    assert.equal(await m.Escalation.countDocuments(), 0);

    const b = await arrive('chest-pain');
    await service.triage(NURSE, b.id, input());
    await m.Clock.updateOne({ def: 'er-step-ecg', case: b.caseId }, { $set: { dueAt: new Date(Date.now() - MIN) } });
    assert.equal(await clocks.checkDue(new Date()), 1);
    assert.equal((await clockOf('er-step-ecg', b.caseId)).state, 'expired');
    await service.tickStep(NURSE, b.id, 'ecg');
    const clock = await clockOf('er-step-ecg', b.caseId);
    assert.equal(clock.state, 'expired');
    assert.ok(clock.stoppedAt);
    const esc: any[] = await m.Escalation.find().lean();
    assert.equal(esc.length, 1);
    assert.equal(esc[0].state, 'open');
  });

  test('an ER escalation behaves as before: a plain reason, its own escalation alert, acknowledged directly', async () => {
    const v = await arrive('chest-pain');
    await service.triage(NURSE, v.id, input());
    await m.Clock.updateOne({ def: 'er-step-ecg', case: v.caseId }, { $set: { dueAt: new Date(Date.now() - MIN) } });
    assert.equal(await clocks.checkDue(new Date()), 1);
    const esc: any = await m.Escalation.findOne().lean();
    assert.equal(esc.reason, 'ECG done overdue');
    assert.equal(esc.closesOnStop, undefined);
    const alert: any = await m.TaskAlertItem.findById(esc.alert).lean();
    assert.equal(alert.link, `escalation:${esc._id}`);
    assert.equal(alert.title, 'Escalated to ER nurse in charge: ECG done overdue');
    await service.tickStep(NURSE, v.id, 'ecg');
    assert.equal(((await m.Escalation.findById(esc._id).lean()) as any).state, 'open', 'doing the step late leaves it open');
    await escalations.acknowledge(ADMIN, String(esc._id));
    assert.equal(((await m.Escalation.findById(esc._id).lean()) as any).state, 'acknowledged');
    assert.equal(((await m.TaskAlertItem.findById(esc.alert).lean()) as any).status, 'Completed');
  });

  test('the doctor clock uses a saved stroke.doctor override', async () => {
    const settings = new SettingsService(m.HospitalSettings);
    await new ErTargetsService(settings).saveTargets(ADMIN, { 'stroke.doctor': 5 });
    const v = await arrive('stroke-signs');
    await service.triage(NURSE, v.id, input({ complaint: 'stroke-signs', colour: 'orange' }));
    const clock = await clockOf('er-doctor', v.caseId);
    assert.equal(new Date(clock.dueAt).getTime(), (await created(v.id)) + 5 * MIN);
  });

  test('with the auto-start rule off, no pathway starts by itself', async () => {
    const settings = new SettingsService(m.HospitalSettings);
    await settings.getSettings();
    await m.HospitalSettings.updateOne({}, { $set: { 'coordinator.rules': { 'er-auto-pathways': false } } });
    const v = await arrive('chest-pain');
    const out = await service.triage(NURSE, v.id, input());
    assert.deepEqual(out.pathways, []);
    assert.equal((await sent('er.pathway-started')).length, 0);
    assert.equal(await clockOf('er-step-ecg', v.caseId), null);
    // The doctor clock follows the colour alone.
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), (await created(v.id)) + 30 * MIN);
    // A nurse can still start it by hand.
    const started = await service.startPathway(NURSE, v.id, 'chest-pain');
    assert.equal(started.pathways[0].startedBy, 'staff');
    assert.equal((await clockOf('er-step-ecg', v.caseId)).state, 'running');
  });

  test('restarting a pathway gives no new clock to a step that was already done', async () => {
    const v = await arrive('chest-pain');
    await service.triage(NURSE, v.id, input());
    await service.tickStep(NURSE, v.id, 'ecg');
    await service.cancelPathway(NURSE, v.id, 'chest-pain', 'Started in error');
    await m.Clock.deleteMany({ def: 'er-step-ecg' });
    const view = await service.startPathway(NURSE, v.id, 'chest-pain');
    await assert.rejects(service.startPathway(NURSE, v.id, 'chest-pain'), (e: any) => e.status === 409);
    const started = await sent('er.pathway-started');
    // An empty object may be dropped when the message is stored.
    assert.deepEqual(Object.keys(started[started.length - 1].payload.stepDue ?? {}), []);
    assert.equal(await m.Clock.countDocuments({ def: 'er-step-ecg' }), 0);
    assert.equal(view.steps.filter((s) => s.key === 'ecg').length, 1);
    assert.equal(view.pathways.length, 2);
  });

  test('a downgrade moves the doctor clock later', async () => {
    const v = await arrive('fever');
    await service.triage(NURSE, v.id, input({ complaint: 'fever', colour: 'orange' }));
    const base = await created(v.id);
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), base + 30 * MIN);
    await service.retriage(NURSE, v.id, 'yellow', 'Stable on review');
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), base + 120 * MIN);
    assert.equal(new Date((await sent('er.retriaged'))[0].payload.doctorDueAt).getTime(), base + 120 * MIN);
    await assert.rejects(service.retriage(NURSE, v.id, 'yellow', 'again'), (e: any) => e.status === 400 && e.message === 'That is already the colour.');
    await assert.rejects(service.retriage(NURSE, v.id, 'red', ' '), (e: any) => e.status === 400);
  });

  test('cancelling a pathway moves the doctor clock back to the colour target', async () => {
    const v = await arrive('chest-pain');
    await service.triage(NURSE, v.id, input());
    const base = await created(v.id);
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), base + 15 * MIN);
    await assert.rejects(service.cancelPathway(NURSE, v.id, 'chest-pain', ''), (e: any) => e.status === 400);
    await service.cancelPathway(NURSE, v.id, 'chest-pain', 'Not cardiac');
    assert.equal(new Date((await sent('er.pathway-cancelled'))[0].payload.doctorDueAt).getTime(), base + 30 * MIN);
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), base + 30 * MIN);
    await assert.rejects(service.cancelPathway(NURSE, v.id, 'chest-pain', 'again'), (e: any) => e.status === 409);
  });

  test('a second triage gets 409 and the visit keeps the first colour', async () => {
    const v = await arrive('fever');
    const results = await Promise.allSettled([
      service.triage(NURSE, v.id, input({ complaint: 'fever', colour: 'orange' })),
      service.triage(NURSE, v.id, input({ complaint: 'fever', colour: 'red' })),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const lost: any = results.find((r) => r.status === 'rejected');
    assert.equal(lost.reason.status, 409);
    assert.equal(lost.reason.message, 'This patient is already triaged. Use re-triage.');
    assert.equal((await sent('er.triaged')).length, 1);
  });

  test('state guards, the doctor step and doctor-seen', async () => {
    const v = await arrive('chest-pain');
    for (const call of [
      () => service.retriage(NURSE, v.id, 'red', 'x'),
      () => service.startPathway(NURSE, v.id, 'stroke'),
      () => service.cancelPathway(NURSE, v.id, 'stroke', 'x'),
      () => service.tickStep(NURSE, v.id, 'ecg'),
      () => service.doctorSeen(NURSE, v.id),
    ]) {
      await assert.rejects(call(), (e: any) => e.status === 409 && e.message === 'Triage this patient first.');
    }
    await service.triage(NURSE, v.id, input());
    await assert.rejects(service.tickStep(NURSE, v.id, 'doctor'), (e: any) => e.status === 400 && e.message === 'Use Seen by doctor.');
    await assert.rejects(service.tickStep(NURSE, v.id, 'ct'), (e: any) => e.status === 409);

    await service.tickStep(NURSE, v.id, 'ecg');
    await service.tickStep(NURSE, v.id, 'ecg');
    assert.equal((await sent('er.step-done')).length, 1);

    const seen = await service.doctorSeen(NURSE, v.id);
    assert.equal(seen.status, 'in-treatment');
    assert.ok(seen.doctorSeenAt);
    assert.ok(seen.steps.every((s) => s.doneAt));
    await service.doctorSeen(NURSE, v.id);
    assert.equal((await sent('er.doctor-seen')).length, 1);
    assert.equal((await clockOf('er-doctor', v.caseId)).state, 'met');

    await m.ErVisit.updateOne({ _id: v.id }, { $set: { status: 'left' } });
    await assert.rejects(service.doctorSeen(NURSE, v.id), (e: any) => e.status === 409 && e.message === 'This patient has left the ER.');
  });

  test('re-triage keeps the first triage and records every change in the history', async () => {
    const first: Actor = { id: 'u1', name: 'Nurse First', role: UserRole.NURSE };
    const second: Actor = { id: 'u2', name: 'Dr Second', role: UserRole.DOCTOR };
    const v = await arrive('fever');
    const t = await service.triage(first, v.id, input({ complaint: 'fever', colour: 'yellow' }));
    await service.retriage(second, v.id, 'orange', 'Getting worse');
    const out = await service.retriage(first, v.id, 'red', 'Collapsed');
    assert.equal(out.colour, 'red');
    assert.equal(out.triage!.byName, 'Nurse First');
    assert.equal(out.triage!.at, t.triage!.at);
    assert.equal(out.triage!.changeReason, undefined);
    assert.deepEqual(out.triage!.history.map((h) => [h.kind, h.colour, h.byName, h.reason]), [
      ['triage', 'yellow', 'Nurse First', undefined],
      ['retriage', 'orange', 'Dr Second', 'Getting worse'],
      ['retriage', 'red', 'Nurse First', 'Collapsed'],
    ]);
    const staff = await service.startPathway(second, v.id, 'sepsis');
    assert.equal(staff.pathways[0].startedByName, 'Dr Second');
  });

  test('red, orange, red within a second still moves the doctor clock to the red time', async () => {
    const v = await arrive('fever');
    await service.triage(NURSE, v.id, input({ complaint: 'fever', colour: 'yellow' }));
    await service.retriage(NURSE, v.id, 'red', 'Worse');
    await service.retriage(NURSE, v.id, 'orange', 'Better');
    await service.retriage(NURSE, v.id, 'red', 'Worse again');
    assert.equal((await sent('er.retriaged')).length, 3);
    assert.equal(new Date((await clockOf('er-doctor', v.caseId)).dueAt).getTime(), (await created(v.id)) + 10 * MIN);
  });

  test('start, cancel and restart gives the step clock again', async () => {
    const v = await arrive('chest-pain');
    await service.triage(NURSE, v.id, input());
    await service.cancelPathway(NURSE, v.id, 'chest-pain', 'Wrong');
    assert.equal((await clockOf('er-step-ecg', v.caseId)).state, 'met');
    await service.startPathway(NURSE, v.id, 'chest-pain');
    await service.cancelPathway(NURSE, v.id, 'chest-pain', 'Wrong again');
    await service.startPathway(NURSE, v.id, 'chest-pain');
    assert.equal((await sent('er.pathway-started')).length, 3);
    assert.equal((await sent('er.pathway-cancelled')).length, 2);
    const running = await m.Clock.find({ def: 'er-step-ecg', case: v.caseId, state: 'running' }).lean();
    assert.equal(running.length, 1);
  });

  test('a triage that reached the Coordinator is marked; a lost one is sent by reconcile', async () => {
    const v = await arrive('other');
    await service.triage(NURSE, v.id, input({ complaint: 'other', colour: 'yellow' }));
    assert.ok(((await m.ErVisit.findById(v.id).lean()) as any).triageAnnouncedAt instanceof Date);

    const w = await arrive('other');
    const messages = (service as any).messages;
    const real = messages.send.bind(messages);
    messages.send = async (msg: any) => {
      if (msg.type === 'er.triaged') throw new Error('bus down');
      return real(msg);
    };
    await assert.rejects(service.triage(NURSE, w.id, input({ complaint: 'other', colour: 'yellow' })), /bus down/);
    messages.send = real;
    assert.equal(((await m.ErVisit.findById(w.id).lean()) as any).triageAnnouncedAt, undefined);
    assert.equal(await m.Clock.countDocuments({ def: 'er-doctor', case: w.caseId }), 0);

    assert.equal((await visits.reconcile()).triaged, 1);
    const doctor = await m.Clock.findOne({ def: 'er-doctor', case: w.caseId, state: 'running' }).lean().exec();
    assert.equal(new Date((doctor as any).dueAt).getTime(), (await created(w.id)) + 120 * MIN);
    assert.ok(((await m.ErVisit.findById(w.id).lean()) as any).triageAnnouncedAt instanceof Date);
  });

  test('a disposition landing between triage and its message sends nothing: no clock on a new case', async () => {
    const v = await arrive('chest-pain');
    const cases = (service as any).cases;
    const real = cases.openOrJoin.bind(cases);
    let first = true;
    cases.openOrJoin = async (opts: any) => {
      if (first) {
        first = false;
        // The doctor sends the patient home while the triage is still being saved.
        await visits.dispose(ADMIN, v.id, 'home', 'Walked out');
      }
      return real(opts);
    };
    const out = await service.triage(NURSE, v.id, input());
    assert.equal(out.status, 'left');
    assert.equal((await sent('er.triaged')).length, 0);
    assert.equal((await sent('er.pathway-started')).length, 0);
    assert.equal(await m.Clock.countDocuments({ case: { $ne: new Types.ObjectId(v.caseId) } }), 0, 'no clock on another case');
    assert.equal(await clocks.countRunning(), 0);
  });

  test('re-triage sends to the visit\'s own case', async () => {
    const v = await arrive('fever');
    await service.triage(NURSE, v.id, input({ complaint: 'fever', colour: 'yellow' }));
    await service.retriage(NURSE, v.id, 'orange', 'Worse');
    const [msg] = await sent('er.retriaged');
    assert.equal(String(msg.case), v.caseId);
  });

  test('a pathway started after Seen by doctor has its doctor step done already', async () => {
    const DOCTOR: Actor = { id: 'user-doctor', name: 'Dr. Shajin', role: UserRole.DOCTOR };
    const v = await arrive('other');
    await service.triage(NURSE, v.id, input({ complaint: 'other', colour: 'yellow' }));
    const seen = await service.doctorSeen(DOCTOR, v.id);
    assert.ok(seen.doctorSeenAt);
    const out = await service.startPathway(NURSE, v.id, 'sepsis');
    const doctor = out.steps.find((s) => s.key === 'doctor')!;
    assert.equal(doctor.doneAt, seen.doctorSeenAt);
    assert.equal(doctor.byName, 'Dr. Shajin');
    assert.ok(out.steps.filter((s) => s.key !== 'doctor').every((s) => s.doneAt === null), 'the other steps still need doing');
    assert.equal(await m.Clock.countDocuments({ def: 'er-doctor', case: v.caseId, state: 'running' }), 0);

    // Seen before the doctor's name was kept: the step still shows as done.
    const w = await arrive('other');
    await service.triage(NURSE, w.id, input({ complaint: 'other', colour: 'yellow' }));
    const at = new Date();
    await m.ErVisit.updateOne({ _id: w.id }, { $set: { doctorSeenAt: at, status: 'in-treatment' } });
    const later = await service.startPathway(NURSE, w.id, 'stroke');
    const step = later.steps.find((s) => s.key === 'doctor')!;
    assert.equal(step.doneAt, at.toISOString());
    assert.equal(step.byName, 'Seen by doctor');
  });
});
