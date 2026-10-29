import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiService } from '../ai/ai.service';
import { AiProviderName, AiResult, StructuredTask } from '../ai/ai-types';
import { Actor } from '../beds/actor';
import { BedAgentService } from '../beds/bed-agent.service';
import { BedAlerts } from '../beds/bed-alerts';
import { BedCoordinatorBridge } from '../beds/bed-coordinator.bridge';
import { BedEvents } from '../beds/bed-events';
import { buildBedSeed } from '../beds/bed-layout';
import { BedRequestsService } from '../beds/bed-requests.service';
import { BedsService } from '../beds/beds.service';
import { SuggestionsService } from '../beds/suggestions.service';
import { AgentRegistry } from '../coordinator/agent-registry';
import { ApprovalsService } from '../coordinator/approvals.service';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { PatientCardsService } from '../queue/patient-cards.service';
import { QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { ErBaysService } from './er-bays.service';
import { ErCoordinatorRegistration, erOnTimePct } from './er-coordinator.registration';
import { ErTargetsService } from './er-targets.service';
import { ErVisitsService } from './er-visits.service';

const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const DOCTOR: Actor = { id: 'user-doctor', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const MIN = 60_000;
const NOTHING = { arrived: 0, triaged: 0, admitted: 0, bays: 0, left: 0 };

function fakeAi() {
  return {
    provider: 'sample' as AiProviderName,
    async status() {
      return { provider: 'sample' as AiProviderName, model: 'sample', features: { bedSuggestions: true } };
    },
    async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
      const value = task.validate(task.sample());
      const base = { provider: 'sample' as AiProviderName, model: 'sample', latencyMs: 0 };
      return value === null ? { ok: false, failure: 'invalid', ...base } : { ok: true, value, sample: true, ...base };
    },
  };
}

describe('ErCoordinatorRegistration', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let bays: ErBaysService;
  let visits: ErVisitsService;
  let beds: BedsService;
  let requests: BedRequestsService;
  let agent: BedAgentService;
  let bridge: BedCoordinatorBridge;
  let patientCount: number;

  const patient = async (name = 'Ravi Kumar') => {
    patientCount++;
    const p = await m.Patient.create({ uhid: `MHK2026008${String(patientCount).padStart(2, '0')}`, name, age: 52, gender: 'Male', phone: `9200000${String(patientCount).padStart(3, '0')}` });
    return { id: String(p._id), uhid: p.uhid, name };
  };
  const arrive = async (name?: string) => {
    const p = await patient(name);
    return { p, v: await visits.arrive(NURSE, { patientId: p.id, mode: 'walk-in', complaint: 'chest-pain' }) };
  };
  const set = (id: string, update: Record<string, unknown>) => m.ErVisit.updateOne({ _id: id }, update).exec();
  const triaged = (id: string) => set(id, { status: 'waiting-doctor', triage: { suggested: 'orange', reasons: [], colour: 'orange', byName: 'Nurse Anita', at: new Date(), history: [] } });
  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1 }).lean().exec() as Promise<any[]>;
  const caseState = async (id: string) => ((await m.Case.findById(id).lean()) as any).state;
  const bayId = async (name: string) => String(((await m.ErBay.findOne({ name }).lean()) as any)._id);

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    patientCount = 0;
    const seed = buildBedSeed();
    const wards = await m.Ward.insertMany(seed.wards);
    const wardId = new Map(wards.map((w) => [w.code, w._id]));
    await m.Bed.insertMany(seed.beds.map(({ wardCode, namedPatientUhid: _uhid, ...b }) => ({ ...b, ward: wardId.get(wardCode) })));

    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, events);

    bays = new ErBaysService(m.ErBay, m.ErVisit);
    await bays.ensureDefaults();
    const patients = new PatientsService(m.Patient);
    const cards = new PatientCardsService(m.PatientCard, m.Patient, null as unknown as QueueService);
    visits = new ErVisitsService(m.ErVisit, m.ErExpected, m.CoordinatorCounter, m.Patient, patients, cards, cases, messages, bays, m.Clock, new ErTargetsService(new SettingsService(m.HospitalSettings)));
    new ErCoordinatorRegistration(registry, visits, bays, messages, m.ErVisit, m.Clock).onModuleInit();

    const bedEvents = new BedEvents();
    beds = new BedsService(m.Ward, m.Bed, m.Admission, patients, bedEvents);
    requests = new BedRequestsService(m.BedRequest, patients, beds, new BedAlerts(m.TaskAlertItem), bedEvents);
    const suggestions = new SuggestionsService(m.BedSuggestion, beds, patients, fakeAi() as unknown as AiService);
    agent = new BedAgentService(requests, suggestions, beds, new SettingsService(m.HospitalSettings), bedEvents);
    bridge = new BedCoordinatorBridge(bedEvents, requests, registry, messages, cases, approvals, m.Admission, m.BedRequest, m.Bed, m.Ward);
    bridge.onModuleInit();
  });

  const ask = async (patientId: string) =>
    String(
      (
        await requests.create(DOCTOR, {
          type: 'admission',
          roomClass: 'general',
          needs: [],
          notes: 'Chest pain, observation',
          department: 'Emergency',
          doctor: 'Dr. Shajin',
          expectedStayDays: 2,
          priority: 'high',
          patientId,
        })
      )._id,
    );

  test('the ER agent registers its types, clocks, rule and close check', async () => {
    const def = registry.get('er')!;
    assert.ok(def.messageTypes.some((t) => t.type === 'er.left'));
    assert.ok(registry.clock('er-triage') && registry.clock('er-doctor'));
    assert.ok(registry.rules().some((r) => r.key === 'er-auto-pathways'));
    assert.deepEqual(def.handles?.map((h) => h.type), ['bed.assigned', 'bed.cancelled']);
    assert.deepEqual(registry.get('bed')!.handles?.map((h) => h.type), ['er.left']);
    const check = registry.closeChecks().find((c) => c.agent === 'er')!;
    assert.equal(check.label, 'ER visit finished');
    // A case with no ER visit: the ER agent has no say.
    const { case: c } = await cases.openOrJoin({ patientId: (await patient()).id, patientUhid: 'U', patientName: 'N', kind: 'ipd', priority: 'medium', openedBy: 'bed' });
    assert.equal(await check.check(String(c._id)), 'n/a');
  });

  test('sent home closes the ER visit and the case', async () => {
    const { v } = await arrive();
    await triaged(v.id);
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    assert.equal(await caseState(v.caseId), 'open');
    const check = registry.closeChecks().find((c) => c.agent === 'er')!;
    assert.equal(await check.check(v.caseId), 'fail');

    const out = await visits.dispose(DOCTOR, v.id, 'home', 'Advice given');
    assert.equal(out.status, 'left');
    assert.equal(out.leftReason, 'home');
    assert.equal(out.disposition?.kind, 'home');
    assert.equal(out.disposition?.byName, 'Dr. Shajin');
    assert.equal(out.disposition?.notes, 'Advice given');
    assert.ok(out.leftAt);
    assert.equal(out.bayId, null);
    assert.equal(await m.ErBay.countDocuments({ visit: { $exists: true } }), 0);

    assert.equal(await check.check(v.caseId), 'pass');
    assert.equal(await caseState(v.caseId), 'closed');
    const disposition = await sent('er.disposition');
    const left = await sent('er.left');
    assert.equal(disposition.length, 1);
    assert.equal(left.length, 1);
    assert.deepEqual(left[0].payload, { visitId: v.id, reason: 'home' });
    for (const msg of [...disposition, ...left]) assert.ok(!JSON.stringify(msg).includes('Ravi Kumar'));
    assert.ok(disposition[0].summary.includes('ER-0001') && disposition[0].summary.includes('home'));
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'home', ''), { status: 409, message: 'This patient has left the ER.' });
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'admit', ''), { status: 409, message: 'This patient has left the ER.' });
  });

  test('admit needs a triaged visit, keeps the bay, and a second admit is refused', async () => {
    const { v } = await arrive();
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'admit', ''), { status: 409, message: 'Triage this patient first.' });
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'sideways' as any, ''), { status: 400 });
    await triaged(v.id);
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    const admitted = await visits.dispose(DOCTOR, v.id, 'admit', 'Needs monitoring');
    assert.equal(admitted.status, 'waiting-bed');
    assert.equal(admitted.disposition?.kind, 'admit');
    assert.equal(admitted.bayName, 'Bay 3', 'the bay is kept until the patient leaves');
    assert.equal(admitted.leftAt, null);
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'admit', ''), { status: 409 });
    assert.equal((await sent('er.disposition')).length, 1);
    assert.equal((await sent('er.left')).length, 0);
    assert.equal(await caseState(v.caseId), 'open');

    // Waiting for a bed with none free: the patient is transferred out instead, and the admit is overwritten.
    const out = await visits.dispose(DOCTOR, v.id, 'transfer', 'No bed here');
    assert.equal(out.status, 'left');
    assert.equal(out.disposition?.kind, 'transfer');
    assert.equal(await m.ErBay.countDocuments({ visit: { $exists: true } }), 0);
    assert.equal((await sent('er.disposition')).length, 2, 'admit then transfer are both logged');
    assert.equal((await sent('er.left')).length, 1);
  });

  test('a patient can walk out before triage: the triage clock stops with no escalation', async () => {
    const { v } = await arrive();
    assert.equal(await clocks.countRunning(), 1);
    const out = await visits.dispose(DOCTOR, v.id, 'left-against-advice', 'Walked out');
    assert.equal(out.status, 'left');
    assert.equal(out.leftReason, 'left-against-advice');
    assert.equal(await clocks.countRunning(), 0);
    const [clock]: any[] = await m.Clock.find().lean();
    assert.equal(clock.def, 'er-triage');
    assert.equal(clock.state, 'met');
    assert.equal(await clocks.checkDue(new Date(Date.now() + 60 * MIN)), 0);
    assert.equal(await m.Escalation.countDocuments(), 0);
    assert.equal(await caseState(v.caseId), 'closed');
  });

  test('admitted: the ER visit leaves when the Bed Agent assigns a bed and the case stays open until discharge', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    const request: any = await m.BedRequest.findById(requestId).lean();
    assert.equal(request.state, 'assigned');

    const visit: any = await m.ErVisit.findById(v.id).lean();
    assert.equal(visit.status, 'left');
    assert.equal(visit.leftReason, 'admitted');
    assert.ok(visit.leftAt);
    assert.equal(visit.bay, undefined);
    assert.equal(await m.ErBay.countDocuments({ visit: { $exists: true } }), 0);
    const [left] = await sent('er.left');
    assert.deepEqual(left.payload, { visitId: v.id, reason: 'admitted' });
    assert.equal(String(left.case), v.caseId);
    assert.equal(await clocks.countRunning(), 0);
    // The Bed Agent's admission keeps the case open.
    assert.equal(await caseState(v.caseId), 'open');

    // Discharge the bed patient and the case closes.
    await beds.discharge(String(request.assignedBed), DOCTOR, String(request.admission));
    await bridge.idle();
    assert.equal(await caseState(v.caseId), 'closed');
  });

  test('a bed assigned before the admit lands: the admit leaves at once and the case stays open until discharge', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    assert.equal(((await m.BedRequest.findById(requestId).lean()) as any).state, 'assigned');
    assert.equal(((await m.ErVisit.findById(v.id).lean()) as any).status, 'waiting-doctor', 'nothing to leave yet');

    const out = await visits.dispose(DOCTOR, v.id, 'admit', '');
    assert.equal(out.status, 'left');
    assert.equal(out.leftReason, 'admitted');
    assert.equal(out.bayId, null);
    assert.equal(await m.ErBay.countDocuments({ visit: { $exists: true } }), 0);
    const left = await sent('er.left');
    assert.equal(left.length, 1);
    assert.deepEqual(left[0].payload, { visitId: v.id, reason: 'admitted' });
    assert.equal(await caseState(v.caseId), 'open');

    const request: any = await m.BedRequest.findById(requestId).lean();
    await beds.discharge(String(request.assignedBed), DOCTOR, String(request.admission));
    await bridge.idle();
    assert.equal(await caseState(v.caseId), 'closed');
  });

  test('a bed.assigned from before this visit does not make an admit leave', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    const [assigned] = await sent('bed.assigned');
    assert.ok(assigned);
    // Make that message older than the visit.
    await m.AgentMessage.collection.updateOne({ _id: assigned._id }, { $set: { createdAt: new Date(Date.now() - 24 * 60 * MIN) } });
    const out = await visits.dispose(DOCTOR, v.id, 'admit', '');
    assert.equal(out.status, 'waiting-bed');
    assert.equal((await sent('er.left')).length, 0);
  });

  test('a redelivered bed.assigned does nothing the second time', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    const [assigned] = await sent('bed.assigned');
    const before = (await m.ErVisit.findById(v.id).lean()) as any;
    const handler = registry.get('er')!.handles![0].handler;
    await handler(String(assigned._id));
    await handler(String(assigned._id));
    const after = (await m.ErVisit.findById(v.id).lean()) as any;
    assert.equal(after.leftAt.getTime(), before.leftAt.getTime());
    assert.equal((await sent('er.left')).length, 1);
  });

  /** Makes the next `er.left` send fail once, as a lost message would. */
  const failNextLeft = (times = 1) => {
    const real = messages.send.bind(messages);
    let failed = 0;
    (messages as any).send = async (input: any) => {
      if (input.type === 'er.left' && failed < times) {
        failed += 1;
        throw new Error('bus down');
      }
      return real(input);
    };
  };

  test('a lost er.left is sent again by reconcile, and the case closes', async () => {
    const { v } = await arrive();
    await triaged(v.id);
    failNextLeft();
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'home', ''), /bus down/);
    assert.equal(((await m.ErVisit.findById(v.id).lean()) as any).status, 'left');
    assert.equal((await sent('er.left')).length, 0);
    assert.equal(await clocks.countRunning(), 1);
    assert.deepEqual(await visits.reconcile(), { ...NOTHING, left: 1 });
    assert.equal((await sent('er.left')).length, 1);
    assert.equal(await clocks.countRunning(), 0);
    assert.equal(await caseState(v.caseId), 'closed');
    assert.deepEqual(await visits.reconcile(), NOTHING);
    // Announced: a repeat is a 409 again.
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'home', ''), { status: 409 });
  });

  test('a repeated dispose after a lost er.left sends it and returns the visit', async () => {
    const { v } = await arrive();
    failNextLeft();
    await assert.rejects(() => visits.dispose(DOCTOR, v.id, 'home', ''), /bus down/);
    const again = await visits.dispose(DOCTOR, v.id, 'home', '');
    assert.equal(again.status, 'left');
    assert.equal((await sent('er.left')).length, 1);
    assert.equal(await caseState(v.caseId), 'closed');
  });

  test('a lost er.left after bed.assigned is sent by a redelivered bed.assigned', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(p.id);
    failNextLeft(3); // the bus's own three delivery tries all fail
    await agent.process(requestId);
    await bridge.idle();
    assert.equal(((await m.ErVisit.findById(v.id).lean()) as any).status, 'left');
    assert.equal((await sent('er.left')).length, 0);
    const [assigned] = await sent('bed.assigned');
    await registry.get('er')!.handles![0].handler(String(assigned._id));
    assert.equal((await sent('er.left')).length, 1);
    assert.equal(((await m.ErVisit.findById(v.id).lean()) as any).leftAnnouncedAt instanceof Date, true);
    await registry.get('er')!.handles![0].handler(String(assigned._id));
    assert.equal((await sent('er.left')).length, 1);
  });

  test('reconcile announces an untriaged arrival, and only marks an unannounced visit that is already triaged', async () => {
    const a = await arrive();
    const b = await arrive();
    await triaged(b.v.id);
    await set(b.v.id, { triageAnnouncedAt: new Date() });
    // Neither arrival reached the Coordinator.
    await m.AgentMessage.deleteMany({ type: 'er.arrived' });
    await m.Clock.deleteMany({ def: 'er-triage' });
    await m.ErVisit.updateMany({}, { $unset: { announcedAt: 1 } });

    assert.deepEqual(await visits.reconcile(), { ...NOTHING, arrived: 1 });
    const arrived = await sent('er.arrived');
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0].payload.visitId, a.v.id);
    const triageClocks = await m.Clock.find({ def: 'er-triage', state: 'running' }).lean();
    assert.deepEqual(triageClocks.map((c: any) => String(c.case)), [a.v.caseId], 'no triage clock for the visit already triaged');
    for (const id of [a.v.id, b.v.id]) assert.ok(((await m.ErVisit.findById(id).lean()) as any).announcedAt instanceof Date);
    assert.deepEqual(await visits.reconcile(), NOTHING);
  });

  test('reconcile resends a lost er.triaged once, with the doctor due time worked out again', async () => {
    const { v } = await arrive();
    await triaged(v.id); // orange, with no er.triaged in the log
    await set(v.id, { pathways: [{ key: 'chest-pain', startedBy: 'rules' }], steps: [{ key: 'ecg' }, { key: 'doctor' }] });
    const created = (((await m.ErVisit.findById(v.id).lean()) as any).createdAt as Date).getTime();

    assert.deepEqual(await visits.reconcile(), { ...NOTHING, triaged: 1 });
    const [msg] = await sent('er.triaged');
    assert.equal(String(msg.case), v.caseId);
    assert.deepEqual(Object.keys(msg.payload).sort(), ['colour', 'doctorDueAt', 'visitId']);
    assert.equal(msg.payload.colour, 'orange');
    // The chest-pain doctor step (15 minutes) beats orange (30).
    assert.equal(new Date(msg.payload.doctorDueAt).getTime(), created + 15 * MIN);
    assert.match(msg.summary, /^ER-0001 triaged orange/);
    assert.ok(!JSON.stringify(msg).includes('Ravi Kumar'));
    const clock: any = await m.Clock.findOne({ def: 'er-doctor', case: v.caseId, state: 'running' }).lean();
    assert.equal(clock.dueAt.getTime(), created + 15 * MIN);
    assert.ok(((await m.ErVisit.findById(v.id).lean()) as any).triageAnnouncedAt instanceof Date);

    assert.deepEqual(await visits.reconcile(), NOTHING);
    assert.equal((await sent('er.triaged')).length, 1);
  });

  test('reconcile only marks a triage the log already has, or one a doctor has since seen', async () => {
    const a = await arrive();
    await triaged(a.v.id);
    await messages.send({ case: a.v.caseId, from: 'er', to: ['coordinator'], type: 'er.triaged', priority: 'high', summary: 'ER-0001 triaged orange: Chest pain', payload: { visitId: a.v.id, colour: 'orange', doctorDueAt: new Date(Date.now() + 30 * MIN) } });
    const b = await arrive();
    await triaged(b.v.id);
    await set(b.v.id, { status: 'in-treatment', doctorSeenAt: new Date() });

    assert.deepEqual(await visits.reconcile(), NOTHING);
    assert.equal((await sent('er.triaged')).length, 1);
    assert.equal(await m.Clock.countDocuments({ def: 'er-doctor', case: b.v.caseId }), 0, 'no doctor clock that nothing would stop');
    for (const id of [a.v.id, b.v.id]) assert.ok(((await m.ErVisit.findById(id).lean()) as any).triageAnnouncedAt instanceof Date);
  });

  test('reconcile lets a waiting-bed visit leave when its bed was already assigned', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await set(v.id, { triageAnnouncedAt: new Date() });
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    // The bed came first and the admit's own check was lost: the visit still waits.
    await set(v.id, { status: 'waiting-bed', disposition: { kind: 'admit', byName: 'Dr. Shajin', at: new Date(), notes: '' } });

    assert.deepEqual(await visits.reconcile(), { ...NOTHING, admitted: 1 });
    const visit: any = await m.ErVisit.findById(v.id).lean();
    assert.equal(visit.status, 'left');
    assert.equal(visit.leftReason, 'admitted');
    assert.equal(await m.ErBay.countDocuments({ visit: { $exists: true } }), 0);
    const left = await sent('er.left');
    assert.equal(left.length, 1);
    assert.deepEqual(left[0].payload, { visitId: v.id, reason: 'admitted' });
    assert.deepEqual(await visits.reconcile(), NOTHING);
  });

  test('reconcile frees a bay still held by a visit that left, and keeps an open visit\'s bay', async () => {
    const a = await arrive();
    const b = await arrive();
    await bays.assign(DOCTOR, a.v.id, await bayId('Bay 3'));
    await bays.assign(DOCTOR, b.v.id, await bayId('Bay 4'));
    await visits.dispose(DOCTOR, a.v.id, 'home', '');
    // A leave that stopped before freeing its bay.
    await m.ErBay.updateOne({ name: 'Bay 3' }, { visit: a.v.id });

    assert.deepEqual(await visits.reconcile(), { ...NOTHING, bays: 1 });
    assert.equal(((await m.ErBay.findOne({ name: 'Bay 3' }).lean()) as any).visit, undefined);
    assert.equal(String(((await m.ErBay.findOne({ name: 'Bay 4' }).lean()) as any).visit), b.v.id);
    assert.deepEqual(await visits.reconcile(), NOTHING);
  });

  const handlerOf = (agent: 'er' | 'bed', type: string) => registry.get(agent)!.handles!.find((h) => h.type === type)!.handler;
  /** The demo has free beds: block them all so the Bed Agent leaves the request waiting. */
  const noBedFree = () => m.Bed.updateMany({}, { state: 'blocked' }).exec();

  test('a cancelled bed request puts a waiting-bed visit back in treatment, with the bay kept', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    await noBedFree();
    await visits.dispose(DOCTOR, v.id, 'admit', 'Needs a ward');
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    assert.equal(((await m.BedRequest.findById(requestId).lean()) as any).state, 'waiting');
    const erBefore = await m.AgentMessage.countDocuments({ from: 'er' });

    await requests.cancel(DOCTOR, requestId);
    await bridge.idle();
    const out = await visits.get(v.id);
    assert.equal(out.status, 'in-treatment');
    assert.equal(out.disposition, null);
    assert.ok(out.admitCancelledAt, 'the cancel time is recorded');
    assert.equal(out.bayName, 'Bay 3', 'the bay is kept');
    assert.equal(await m.ErBay.countDocuments({ visit: v.id }), 1);
    assert.equal((await sent('bed.cancelled')).length, 1);
    assert.equal(await m.AgentMessage.countDocuments({ from: 'er' }), erBefore, 'the ER sends nothing new');
    assert.equal(await caseState(v.caseId), 'open');

    // A redelivered bed.cancelled does nothing.
    const [cancelled] = await sent('bed.cancelled');
    const stored: any = await m.ErVisit.findById(v.id).lean();
    await handlerOf('er', 'bed.cancelled')(String(cancelled._id));
    const again: any = await m.ErVisit.findById(v.id).lean();
    assert.equal(again.status, 'in-treatment');
    assert.equal(again.admitCancelledAt.getTime(), stored.admitCancelledAt.getTime());

    // The doctor can decide again.
    assert.equal((await visits.dispose(DOCTOR, v.id, 'admit', '')).status, 'waiting-bed');
  });

  test('admitted with no bed free, then transferred: the bed request is cancelled, never placed, and the case closes', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await bays.assign(DOCTOR, v.id, await bayId('Bay 3'));
    await noBedFree();
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    assert.equal(((await m.BedRequest.findById(requestId).lean()) as any).state, 'waiting');

    const out = await visits.dispose(DOCTOR, v.id, 'transfer', 'Sent to a cardiac centre');
    await bridge.idle();
    assert.equal(out.status, 'left');
    const request: any = await m.BedRequest.findById(requestId).lean();
    assert.equal(request.state, 'cancelled');
    assert.equal(request.open, false);
    assert.equal(request.stateReason, 'Patient left the ER: transfer');
    assert.equal(request.closedByName, 'ER Agent');
    assert.equal((await sent('bed.cancelled')).length, 1);
    assert.equal(((await m.ErVisit.findById(v.id).lean()) as any).status, 'left', 'bed.cancelled does not bring a left visit back');

    // A bed frees up: the Bed Agent does not place a patient who has gone.
    await m.Bed.updateMany({}, { state: 'free' }).exec();
    await agent.retryWaiting();
    await agent.process(requestId);
    await agent.idle();
    await bridge.idle();
    assert.equal(((await m.BedRequest.findById(requestId).lean()) as any).state, 'cancelled');
    assert.equal(await m.Admission.countDocuments({ patient: p.id }), 0);
    assert.equal((await sent('bed.assigned')).length, 0);
    assert.equal(await clocks.countRunning(), 0);
    assert.equal(await caseState(v.caseId), 'closed');
    assert.equal(await m.Case.countDocuments(), 1, 'no second case for the cancel');

    // A redelivered er.left cancels nothing more.
    const [left] = await sent('er.left');
    await handlerOf('bed', 'er.left')(String(left._id));
    await bridge.idle();
    assert.equal((await sent('bed.cancelled')).length, 1);
  });

  test('a seeded ICU request that never places is cancelled when the patient dies, and the case closes', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    // As the demo seed writes it: a waiting ICU request on the visit's case, with its messages.
    const [r] = await m.BedRequest.insertMany([
      {
        type: 'admission', patient: p.id, patientName: p.name, patientUhid: p.uhid, patientAge: 52, patientGender: 'Male', stepDown: false,
        roomClass: 'icu', needs: ['oxygen', 'monitor', 'ventilator'], notes: 'Breathless. Needs oxygen and a ventilator bed.', department: 'General Medicine',
        doctor: 'Dr. Shajin', expectedStayDays: 3, priority: 'high', priorityRank: 1, state: 'waiting', stateReason: 'No free bed has what this patient needs yet.',
        open: true, attempts: 0, requestedBy: 'ER Seed', requestedByName: 'Dr. Shajin', requestedAt: new Date(), stateSince: new Date(),
      },
    ]);
    const requestId = String(r._id);
    await m.Case.updateOne({ _id: v.caseId }, { $addToSet: { 'refs.bedRequestIds': requestId, agents: 'bed' } });
    await messages.send({ case: v.caseId, from: 'bed', to: ['coordinator'], type: 'bed.request', priority: 'high', summary: `${p.uhid}: admission bed requested (high)`, payload: { requestId, requestType: 'admission', priority: 'high' }, opensWork: true });
    await messages.send({ case: v.caseId, from: 'bed', to: ['coordinator'], type: 'bed.waiting', priority: 'high', summary: `${p.uhid} is waiting for a bed`, payload: { requestId } });

    const out = await visits.dispose(DOCTOR, v.id, 'died', '');
    await bridge.idle();
    assert.equal(out.status, 'left');
    const request: any = await m.BedRequest.findById(requestId).lean();
    assert.equal(request.state, 'cancelled');
    assert.equal(request.stateReason, 'Patient left the ER: died');
    assert.equal((await messages.list({ case: v.caseId, openWork: true })).length, 0, 'the bed.request work is resolved');

    await agent.retryWaiting();
    await agent.process(requestId);
    await agent.idle();
    await bridge.idle();
    assert.equal(await m.Admission.countDocuments({ patient: p.id }), 0);
    assert.equal(await clocks.countRunning(), 0);
    assert.equal(await caseState(v.caseId), 'closed');
    assert.equal(await m.Case.countDocuments(), 1, 'no second case for the cancel');
    for (const msg of await m.AgentMessage.find().lean()) assert.ok(!JSON.stringify(msg).includes(p.name));
  });

  test('a request an agent pass is holding is cancelled once the pass lets go', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await noBedFree();
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    // A pass holds the request for a moment.
    await m.BedRequest.updateOne({ _id: requestId }, { lockedUntil: new Date(Date.now() + 60_000) });
    const release = setTimeout(() => void m.BedRequest.updateOne({ _id: requestId }, { $unset: { lockedUntil: '' } }).exec(), 300);
    await visits.dispose(DOCTOR, v.id, 'home', '');
    clearTimeout(release);
    await bridge.idle();
    assert.equal(((await m.BedRequest.findById(requestId).lean()) as any).state, 'cancelled');
    assert.equal(await caseState(v.caseId), 'closed');
  });

  test('er.left for an admitted patient never cancels a bed request', async () => {
    const { p, v } = await arrive();
    await triaged(v.id);
    await noBedFree();
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    await messages.send({ case: v.caseId, from: 'er', to: ['coordinator'], type: 'er.left', priority: 'medium', summary: 'ER-0001 left the ER (admitted)', payload: { visitId: v.id, reason: 'admitted' } });
    await bridge.idle();
    assert.equal(((await m.BedRequest.findById(requestId).lean()) as any).state, 'waiting');
    assert.equal((await sent('bed.cancelled')).length, 0);
  });

  test('a ward admission with no ER visit is left alone', async () => {
    const p = await patient();
    const requestId = await ask(p.id);
    await agent.process(requestId);
    await bridge.idle();
    assert.equal((await sent('bed.assigned')).length, 1);
    assert.equal((await sent('er.left')).length, 0);
    assert.equal(await m.ErVisit.countDocuments(), 0);
  });

  test('a placeholder patient can be admitted through a bed request', async () => {
    const v = await visits.arrive(NURSE, { emergency: { gender: 'Male', approxAge: 40, description: 'Blue jacket, found at the gate' }, mode: 'ambulance', complaint: 'unresponsive' });
    const placeholder: any = await m.Patient.findOne({ detailsPending: true }).lean();
    assert.equal(placeholder.phone, '');
    await triaged(v.id);
    await visits.dispose(DOCTOR, v.id, 'admit', '');
    const requestId = await ask(String(placeholder._id));
    await agent.process(requestId);
    await bridge.idle();
    const request: any = await m.BedRequest.findById(requestId).lean();
    assert.equal(request.state, 'assigned');
    assert.equal(((await m.ErVisit.findById(v.id).lean()) as any).status, 'left');
    const all = JSON.stringify(await m.AgentMessage.find().lean());
    assert.ok(!all.includes(placeholder.name), 'the placeholder name must not be in a message');
  });

  test('status counts patients, bays and on-time doctor reviews', async () => {
    const status = registry.get('er')!.status;
    assert.deepEqual(await status(), { open: 0, capacity: 20, onTimePct: null });
    const a = await arrive();
    const b = await arrive();
    const c = await arrive();
    await visits.dispose(DOCTOR, b.v.id, 'home', '');
    await m.ErBay.updateOne({ name: 'Stretcher 1' }, { outOfUse: true });
    assert.deepEqual(await status(), { open: 2, capacity: 19, onTimePct: null });

    // a and c were seen by a doctor; b left without being seen, so its review clock was closed by er.left.
    const now = Date.now();
    for (const x of [a, b, c]) await m.ErVisit.collection.updateOne({ _id: new Types.ObjectId(x.v.id) }, { $set: { createdAt: new Date(now - 4 * 60 * MIN) } });
    await set(a.v.id, { doctorSeenAt: new Date() });
    await set(c.v.id, { doctorSeenAt: new Date() });
    const clock = (x: typeof a, due: number, stopped: number | null, def = 'er-doctor') => ({
      def,
      case: new Types.ObjectId(x.v.caseId),
      startedBy: new Types.ObjectId(),
      startedAt: new Date(now - 3 * 60 * MIN),
      dueAt: new Date(due),
      state: stopped ? 'met' : 'running',
      ...(stopped ? { stoppedAt: new Date(stopped) } : {}),
    });
    await m.Clock.collection.insertMany([
      clock(a, now - 60 * MIN, now - 90 * MIN), // on time
      clock(c, now - 60 * MIN, now - 30 * MIN), // late
      clock(b, now - 60 * MIN, now - 10 * MIN), // closed by the patient leaving: not a review
      clock(a, now - 60 * MIN, now - 25 * 60 * MIN), // older than a day: not counted
      clock(a, now + 60 * MIN, null),
      clock(a, now - 60 * MIN, now - 10 * MIN, 'er-triage'),
    ] as any[]);
    assert.equal((await status()).onTimePct, 50);
    assert.equal(await erOnTimePct(m.Clock, m.ErVisit, new Date(now - 26 * 60 * MIN)), 67);
    assert.equal(await erOnTimePct(m.Clock, m.ErVisit, new Date(now + MIN)), null);
  });
});
