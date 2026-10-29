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
import { ErCoordinatorRegistration } from './er-coordinator.registration';
import { ErTriageService, TriageInput } from './er-triage.service';
import { ErVisitsService } from './er-visits.service';

const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const MIN = 60_000;
const CALM = { bpSystolic: 130, bpDiastolic: 80, heartRate: 80, spo2: 98, respiratoryRate: 16, temperature: 37 };

describe('ErTriageService', () => {
  const m = models();
  let visits: ErVisitsService;
  let service: ErTriageService;
  let clocks: ClocksService;
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
    new ErCoordinatorRegistration(registry).onModuleInit();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const patients = new PatientsService(m.Patient);
    const cards = new PatientCardsService(m.PatientCard, m.Patient, null as unknown as QueueService);
    visits = new ErVisitsService(m.ErVisit, m.ErExpected, m.CoordinatorCounter, m.Patient, patients, cards, cases, messages);
    const settings = new SettingsService(m.HospitalSettings);
    service = new ErTriageService(m.ErVisit, new VitalsService(m.VitalsRecord, m.Patient), new RulesService(registry, settings, events), cases, messages, settings);
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

  test('re-triage to red after the target passed makes the doctor clock due at once', async () => {
    const v = await arrive('other');
    await service.triage(NURSE, v.id, input({ complaint: 'other', colour: 'green' }));
    await backdate(v.id, 60);
    assert.equal(await clocks.checkDue(new Date()), 0);

    const out = await service.retriage(NURSE, v.id, 'red', 'Collapsed in the waiting area');
    assert.equal(out.colour, 'red');
    assert.equal(out.triage!.changeReason, 'Collapsed in the waiting area');
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
});
