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
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { LabBenchService } from './lab-bench.service';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import type { LabAiService } from './lab-ai';
import { LabOrdersService } from './lab-orders.service';
import { LabOverviewService } from './lab-overview.service';
import { LabResultsService } from './lab-results.service';
import { LabSettingsService } from './lab-settings.service';

const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const LAB: Actor = { id: 'user-lab', name: 'Meera', role: UserRole.LAB };
const PATH: Actor = { id: 'user-path', name: 'Dr. Meera Nair', role: UserRole.LAB };
const ADMIN: Actor = { id: 'user-admin', name: 'Admin', role: UserRole.ADMIN };
const MIN = 60_000;
const HOUR = 60 * MIN;

/** The AI never answers here, so nothing writes after a test ends. */
const noAi = { summarise: () => new Promise(() => {}) } as unknown as LabAiService;

describe('Lab close check, status, overview and settings', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let clocks: ClocksService;
  let orders: LabOrdersService;
  let bench: LabBenchService;
  let results: LabResultsService;
  let settings: LabSettingsService;
  let overview: LabOverviewService;
  let patientId: string;
  let caseId: string;

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
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    settings = new LabSettingsService(new SettingsService(m.HospitalSettings));
    orders = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages, settings, m.LabTestReport);
    new LabCoordinatorRegistration(registry, orders, messages, m.LabRequest, m.LabLine).onModuleInit();
    bench = new LabBenchService(m.LabRequest, m.LabLine, m.LabSample, orders, messages);
    results = new LabResultsService(m.LabRequest, m.LabLine, m.LabTestReport, m.TaskAlertItem, orders, messages, settings, noAi);
    overview = new LabOverviewService(m.LabSnapshot, m.LabRequest, m.LabLine, m.LabSample, m.Clock, settings);
    const p = await m.Patient.create({ uhid: 'MHK202600902', name: 'Ravi Kumar', age: 52, gender: 'Male', phone: '9100000002' });
    patientId = String(p._id);
  });

  const order = (tests: string[], priority: 'stat' | 'urgent' | 'routine' = 'stat') =>
    orders.order(DOC, { patientId, tests, priority }).then((r) => {
      caseId = r[0].caseId;
      return r[0];
    });
  const receive = async (r: Awaited<ReturnType<typeof order>>) => {
    for (const s of r.samples) {
      await bench.collect(NURSE, s.number);
      await bench.receive(LAB, s.id);
    }
  };
  const release = async (lineId: string, values: Record<string, number | string>) => {
    await results.enterResults(LAB, lineId, values);
    await results.release(PATH, lineId);
  };
  const agentStatus = () => registry.definitions().find((d) => d.key === 'lab')!.status();
  const closeCheck = (id: string) => registry.definitions().find((d) => d.key === 'lab')!.closeChecks![0].check(id);
  const backdate = (lineId: string, set: Record<string, unknown>) => m.LabLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $set: set });

  test('a case with a released but unacknowledged critical result stays open; acknowledging lets it close', async () => {
    const r = await order(['electrolytes']);
    await receive(r);
    await release(r.lines[0].id, { Sodium: 140, Potassium: 6.4 });
    assert.equal(await closeCheck(caseId), 'fail');
    await results.acknowledge(DOC, r.lines[0].id, 'called the ward');
    assert.equal(await closeCheck(caseId), 'pass');
  });

  test('a case whose lines are all released or cancelled closes; a case with no lines is n/a', async () => {
    assert.equal(await closeCheck(String(new Types.ObjectId())), 'n/a');
    const r = await order(['cbc', 'crp'], 'routine');
    assert.equal(await closeCheck(caseId), 'fail');
    await orders.cancelLine(ADMIN, r.lines[1].id, 'not needed');
    assert.equal(await closeCheck(caseId), 'fail', 'cbc is still open');
    await receive({ ...r, samples: r.samples.filter((s) => s.lines.includes(r.lines[0].id)) });
    await release(r.lines[0].id, { Haemoglobin: 14, WBC: 7, Platelets: 250 });
    assert.equal(await closeCheck(caseId), 'pass');
  });

  test('the status counts open lines and the on-time share of the last 24 hours', async () => {
    assert.deepEqual(await agentStatus(), { open: 0, capacity: 0, onTimePct: null });
    const r = await order(['cbc', 'crp', 'glucose'], 'stat');
    await receive(r);
    const [cbc, crp] = r.lines;
    await release(cbc.id, { Haemoglobin: 14, WBC: 7, Platelets: 250 });
    await release(crp.id, { CRP: 2 });
    // cbc on time (released before due); crp late (released after its due).
    await backdate(cbc.id, { tatDueAt: new Date(Date.now() + 10 * MIN) });
    await backdate(crp.id, { tatDueAt: new Date(Date.now() - 10 * MIN) });
    assert.deepEqual(await agentStatus(), { open: 1, capacity: 0, onTimePct: 50 });
    // A release older than a day is outside the window.
    await backdate(crp.id, { releasedRealAt: new Date(Date.now() - 30 * HOUR) });
    assert.deepEqual(await agentStatus(), { open: 1, capacity: 0, onTimePct: 100 });
  });

  test("cards and TAT rows count today's lines", async () => {
    const a = await order(['cbc', 'electrolytes'], 'stat');
    await receive(a);
    await release(a.lines[0].id, { Haemoglobin: 14, WBC: 7, Platelets: 250 });
    await results.enterResults(LAB, a.lines[1].id, { Sodium: 140, Potassium: 6.4 }); // awaiting validation
    const b = await order(['cbc'], 'routine');
    await bench.collect(NURSE, b.samples[0].number); // collected, not received
    const c = await order(['crp'], 'routine');
    await receive(c);
    await release(c.lines[0].id, { CRP: 12 });
    const o = await overview.overview();
    assert.equal(o.cards.ordersToday.value, 3);
    assert.equal(o.cards.samplesCollected.value, 4);
    assert.equal(o.cards.inProcessing.value, 1);
    assert.equal(o.cards.resultsCompleted.value, 2);
    assert.equal(o.cards.criticalResults.value, 0);
    assert.equal(o.cards.ordersToday.spark.length, 24);
    // tatByTest shows the routine target (cbc 120 min) whatever the line's priority.
    const cbc = o.tatByTest.find((t) => t.test === 'cbc')!;
    assert.deepEqual([cbc.label, cbc.count, cbc.targetMin, cbc.onTime], ['Complete blood count', 1, 120, true]);
    assert.equal(o.tatByTest.find((t) => t.test === 'crp')!.count, 1);
    assert.equal(o.tatByTest.some((t) => t.test === 'electrolytes'), false);
    assert.equal(o.performance.onTimePct, 100);
    assert.equal(o.performance.collectionOnTimePct, 100);
    assert.equal(o.performance.ordersByHour.length, 24);
    assert.equal(o.performance.ordersByHour.reduce((x, y) => x + y, 0), 3);
    assert.ok(typeof o.performance.avgTatMin === 'number');
  });

  test('critical results list who was told and the running clock', async () => {
    const r = await order(['electrolytes']);
    await receive(r);
    await release(r.lines[0].id, { Sodium: 140, Potassium: 6.4 });
    let o = await overview.overview();
    assert.equal(o.cards.criticalResults.value, 1);
    assert.equal(o.critical.length, 1);
    const row = o.critical[0];
    assert.deepEqual([row.requestNumber, row.test, row.label, row.parameter, row.value, row.orderedBy, row.ackBy], ['LR-0001', 'electrolytes', 'Electrolytes', 'Potassium', '6.4', 'Dr. Shajin', null]);
    assert.ok(row.releasedAt);
    assert.ok(row.dueAt, 'the running lab-critical clock gives the due time');
    await results.acknowledge(DOC, r.lines[0].id, 'ok');
    o = await overview.overview();
    assert.equal(o.critical[0].ackBy, 'Dr. Shajin');
    assert.ok(o.critical[0].ackAt);
    assert.equal(o.critical[0].dueAt, null, 'the clock stopped');
  });

  test('the rejection rate is rejected samples over samples collected today', async () => {
    assert.equal((await overview.overview()).performance.rejectionRate, null);
    const r = await order(['cbc', 'crp', 'glucose', 'abg'], 'routine'); // four tubes
    for (const s of r.samples) await bench.collect(NURSE, s.number);
    assert.equal(r.samples.length, 4);
    await bench.receive(LAB, r.samples[0].id);
    await bench.reject(LAB, r.samples[0].id, 'clotted');
    assert.equal((await overview.overview()).performance.rejectionRate, 25);
  });

  test('an on-time release and a late release give the right percentage; collections compare real times', async () => {
    const r = await order(['cbc', 'crp'], 'stat');
    for (const s of r.samples) await bench.collect(NURSE, s.number);
    // One sample was collected late.
    await m.LabSample.collection.updateOne({ _id: new Types.ObjectId(r.samples[0].id) }, { $set: { collectBy: new Date(Date.now() - MIN) } });
    for (const s of r.samples) await bench.receive(LAB, s.id);
    await release(r.lines[0].id, { Haemoglobin: 14, WBC: 7, Platelets: 250 });
    await release(r.lines[1].id, { CRP: 2 });
    await backdate(r.lines[0].id, { tatDueAt: new Date(Date.now() + HOUR) });
    await backdate(r.lines[1].id, { tatDueAt: new Date(Date.now() - HOUR) });
    const o = await overview.overview();
    assert.equal(o.performance.onTimePct, 50);
    assert.equal(o.performance.collectionOnTimePct, 50);
    assert.equal(o.tatByTest.find((t) => t.test === 'cbc')!.onTime, true);
    assert.equal(o.tatByTest.find((t) => t.test === 'crp')!.onTime, false);
  });

  test('the snapshot upserts one record per hour and the series reads them', async () => {
    await order(['cbc']);
    await overview.snapshot();
    await order(['crp']);
    await overview.snapshot();
    assert.equal(await m.LabSnapshot.countDocuments({}), 1);
    const snap = (await m.LabSnapshot.findOne().lean())!;
    assert.equal(snap.ordersToday, 2);
    const day = await overview.series('24h');
    assert.equal(day.points.length, 24);
    assert.equal(day.points[23].ordersToday, 2);
    assert.equal(day.points[0].ordersToday, null);
    assert.equal((await overview.series('7d')).points.length, 168);
  });

  test('only an admin saves targets and limits; a saved potassium limit changes the flag', async () => {
    await assert.rejects(settings.saveTargets(DOC, { cbc: { stat: 20 } }), { status: 403 });
    await assert.rejects(settings.saveLimits(DOC, { 'electrolytes.Potassium': { high: 6.5 } }), { status: 403 });
    await assert.rejects(settings.saveTargets(ADMIN, { nope: { stat: 20 } }), { status: 400 });
    await assert.rejects(settings.saveTargets(ADMIN, { cbc: { stat: 0 } }), { status: 400 });
    await assert.rejects(settings.saveTargets(ADMIN, { cbc: { stat: 4321 } }), { status: 400 });
    await assert.rejects(settings.saveTargets(ADMIN, { cbc: { stat: 1.5 } }), { status: 400 });
    await assert.rejects(settings.saveLimits(ADMIN, { 'nope.x': { low: 1 } }), { status: 400 });
    await assert.rejects(settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 'x' } }), { status: 400 });
    // Settings can't be patched around the service either.
    await assert.rejects(new SettingsService(m.HospitalSettings).updateSettings({ lab: { targets: { cbc: { stat: 5 } } } } as any, { role: UserRole.DOCTOR }), { status: 403 });

    await settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 6.5 } });
    const r = await order(['electrolytes']);
    await receive(r);
    await results.enterResults(LAB, r.lines[0].id, { Sodium: 140, Potassium: 6.4 });
    const row = ((await m.LabLine.findById(r.lines[0].id).lean())!.results as any[]).find((x) => x.param === 'Potassium');
    assert.deepEqual([row.flag, row.critical], ['high', false]);
  });

  test("saveLimits refuses a critical limit inside the normal range", async () => {
    await assert.rejects(settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 5 } }), { status: 400, message: "A critical limit can't sit inside the normal range." });
    await assert.rejects(settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { low: 4 } }), { status: 400 });
    await settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 5.1 } }); // equal to the reference high is fine
    // Troponin has a reference high of 0.04: a critical high of 0.04 is the default and stays valid.
    await settings.saveLimits(ADMIN, { 'troponin.Troponin I': { high: 0.04 } });
  });

  test('the limits history records who changed what, keeping the last 50', async () => {
    await settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 6.5 } });
    await settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 6.5 } }); // no change: nothing recorded
    const { limits, history } = await settings.getLimits();
    assert.equal(limits['electrolytes.Potassium'].high, 6.5);
    assert.equal(limits['electrolytes.Potassium'].low, 2.8);
    assert.equal(history.length, 1);
    assert.equal(history[0].by, 'Admin');
    assert.deepEqual(history[0].changes, [{ key: 'electrolytes.Potassium.high', from: 6.2, to: 6.5 }]);
    for (let i = 0; i < 55; i++) await settings.saveLimits(ADMIN, { 'glucose.Glucose': { high: 400 + (i % 2 === 0 ? 1 : 0) } });
    assert.equal((await settings.getLimits()).history.length, 50);
  });

  test("a saved troponin STAT target changes a new order's due time", async () => {
    const t0 = Date.now();
    const a = await order(['troponin'], 'stat');
    assert.ok(Math.abs(new Date(a.lines[0].tatDueAt).getTime() - (t0 + 60 * MIN)) < 5_000);
    const saved = await settings.saveTargets(ADMIN, { troponin: { stat: 45 } });
    assert.deepEqual(saved.troponin, { stat: 45, routine: 120 });
    await settings.saveTargets(ADMIN, { troponin: { routine: 90 } });
    assert.deepEqual((await settings.getTargets()).troponin, { stat: 45, routine: 90 }, 'a second save merges');
    assert.deepEqual((await settings.getTargets()).cbc, { stat: 30, routine: 120 });
    const t1 = Date.now();
    const b = await order(['troponin'], 'stat');
    assert.ok(Math.abs(new Date(b.lines[0].tatDueAt).getTime() - (t1 + 45 * MIN)) < 5_000);
  });

  test('an amendment keeps the first release time: today figures and turnaround do not change', async () => {
    const r = await order(['crp'], 'routine');
    await receive(r);
    await release(r.lines[0].id, { CRP: 2 });
    const yesterday = new Date(Date.now() - 26 * HOUR);
    await backdate(r.lines[0].id, { releasedRealAt: yesterday });
    const tat0 = (await overview.overview()).performance.avgTatMin;
    assert.equal((await overview.overview()).cards.resultsCompleted.value, 0);
    await results.amend(LAB, r.lines[0].id, { CRP: 3 }, 'typo');
    await results.release(PATH, r.lines[0].id);
    const l = (await m.LabLine.findById(r.lines[0].id).lean())!;
    assert.equal(l.version, 2);
    assert.equal(new Date(l.releasedRealAt!).getTime(), yesterday.getTime());
    assert.ok(new Date(l.lastReleasedRealAt!).getTime() > Date.now() - MIN);
    const o = await overview.overview();
    assert.equal(o.cards.resultsCompleted.value, 0);
    assert.equal(o.performance.avgTatMin, tat0);
    assert.equal(await agentStatus().then((s) => s.onTimePct), null);
  });

  test('limitsHistory is server-only: a round-tripped settings object passes, a fake history is ignored', async () => {
    const svc = new SettingsService(m.HospitalSettings);
    await settings.saveLimits(ADMIN, { 'electrolytes.Potassium': { high: 6.5 } });
    const whole = JSON.parse(JSON.stringify(await svc.getSettings()));
    await svc.updateSettings(whole, { role: UserRole.DOCTOR }); // does not throw
    await svc.updateSettings({ lab: { limitsHistory: [{ by: 'x', at: new Date(), changes: [] }] } } as any, { role: UserRole.ADMIN });
    const { history } = await settings.getLimits();
    assert.equal(history.length, 1);
    assert.equal(history[0].by, 'Admin');
  });

  test('text parameters have no numeric limits; a one-sided parameter saves', async () => {
    await assert.rejects(settings.saveLimits(ADMIN, { 'blood-culture.Result': { high: 1 } }), { status: 400, message: 'Text results have no numeric limits.' });
    await settings.saveLimits(ADMIN, { 'cbc.Haemoglobin': { low: 6 } });
    assert.deepEqual((await settings.getLimits()).limits['cbc.Haemoglobin'], { low: 6 });
  });
});
