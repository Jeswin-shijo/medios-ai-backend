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
import type { LabAiService, LabSummaryResult } from './lab-ai';
import { LabBenchService } from './lab-bench.service';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import { LabOrdersService } from './lab-orders.service';
import { LabResultsService } from './lab-results.service';
import { LabSettingsService } from './lab-settings.service';

const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const LAB: Actor = { id: 'user-lab', name: 'Meera', role: UserRole.LAB };
const PATH: Actor = { id: 'user-path', name: 'Dr. Meera Nair', role: UserRole.LAB };
const noAi = { summarise: (_id: string): Promise<LabSummaryResult> => new Promise(() => {}) } as unknown as LabAiService;

describe('LabOrdersService.reconcile', () => {
  const m = models();
  let messages: MessagesService;
  let orders: LabOrdersService;
  let bench: LabBenchService;
  let results: LabResultsService;
  let clocks: ClocksService;
  let patientId: string;

  const count = (type: string) => m.AgentMessage.countDocuments({ type }).exec();
  const order = (tests: string[]) => orders.order(DOC, { patientId, tests, priority: 'stat' }).then((r) => r[0]);
  /** Timestamps are immutable through the model, so backdate through the collection. */
  const age = (requestId: string) => m.LabRequest.collection.updateOne({ _id: new Types.ObjectId(requestId) }, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
  const unset = (requestId: string, field: string) => m.LabRequest.collection.updateOne({ _id: new Types.ObjectId(requestId) }, { $unset: { [field]: '' } });
  const request = (id: string) => m.LabRequest.findById(id).lean().exec() as Promise<any>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    orders = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)), m.LabTestReport);
    new LabCoordinatorRegistration(registry, orders, messages, m.LabRequest, m.LabLine).onModuleInit();
    bench = new LabBenchService(m.LabRequest, m.LabLine, m.LabSample, orders, messages);
    results = new LabResultsService(m.LabRequest, m.LabLine, m.LabTestReport, m.TaskAlertItem, orders, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)), noAi, m.Clock);
    const p = await m.Patient.create({ uhid: 'MHK202600901', name: 'Ravi Kumar', age: 52, gender: 'Male', phone: '9100000001' });
    patientId = String(p._id);
  });

  test('(a) resends lab.ordered for an old request that was never announced, and records it', async () => {
    const r = await order(['crp']);
    await unset(r.id, 'announcedAt');
    await m.AgentMessage.deleteMany({ type: 'lab.ordered' });
    const fresh = await orders.reconcile();
    assert.equal(fresh.ordered, 0, 'a request younger than the grace period is left alone');
    await age(r.id);
    const out = await orders.reconcile();
    assert.equal(out.ordered, 1);
    assert.equal(await count('lab.ordered'), 1);
    assert.ok((await request(r.id)).announcedAt);
    assert.equal((await orders.reconcile()).ordered, 0);
  });

  test('(b) sends lab.collection-done when every sample is collected but no done message was recorded', async () => {
    const r = await order(['cbc', 'rft']);
    for (const s of r.samples) await bench.collect(NURSE, s.number);
    assert.equal(await count('lab.collection-done'), 1);
    await unset(r.id, 'collectionDoneAt');
    const out = await orders.reconcile();
    assert.equal(out.collectionDone, 1);
    assert.equal(await count('lab.collection-done'), 2);
    assert.ok((await request(r.id)).collectionDoneAt);
    assert.equal((await orders.reconcile()).collectionDone, 0);
  });

  test('(b) does nothing while a sample is still waiting', async () => {
    const r = await order(['cbc', 'rft']);
    await bench.collect(NURSE, r.samples[0].number);
    assert.equal((await orders.reconcile()).collectionDone, 0);
    assert.equal(await count('lab.collection-done'), 0);
  });

  test('(c) sends lab.request-done when no line is open but no done message was recorded', async () => {
    const r = await order(['crp']);
    await orders.cancelLine(DOC, r.lines[0].id, 'Not needed');
    await unset(r.id, 'doneAt');
    const before = await count('lab.request-done');
    const out = await orders.reconcile();
    assert.equal(out.requestDone, 1);
    assert.equal(await count('lab.request-done'), before + 1);
    assert.ok((await request(r.id)).doneAt);
    assert.equal((await orders.reconcile()).requestDone, 0);
  });

  test('(c) does nothing while a line is still open', async () => {
    await order(['crp', 'cbc']);
    assert.equal((await orders.reconcile()).requestDone, 0);
  });

  test('(d) writes the missing report for a released line and stores its reportId', async () => {
    const r = await order(['electrolytes']);
    for (const s of r.samples) {
      await bench.collect(NURSE, s.number);
      await bench.receive(LAB, s.id);
    }
    const lineId = r.lines[0].id;
    await results.enterResults(LAB, lineId, { Sodium: 140, Potassium: 4.2 });
    await results.release(PATH, lineId);
    await m.LabTestReport.deleteMany({});
    await m.LabLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $unset: { reportId: '' } });
    const out = await orders.reconcile();
    assert.equal(out.reports, 1);
    const l = (await m.LabLine.findById(lineId).lean().exec()) as any;
    assert.ok(l.reportId);
    const report = (await m.LabTestReport.findById(l.reportId).lean().exec()) as any;
    assert.equal(report.labLine, lineId);
    assert.equal((await orders.reconcile()).reports, 0);
  });

  // ---------- critical results ----------

  /** A received electrolytes line for a fresh STAT request. */
  const receivedLine = async () => {
    const r = await order(['electrolytes']);
    for (const s of r.samples) {
      await bench.collect(NURSE, s.number);
      await bench.receive(LAB, s.id);
    }
    return { r, lineId: r.lines[0].id };
  };
  const releaseCritical = async () => {
    const { r, lineId } = await receivedLine();
    await results.enterResults(LAB, lineId, { Sodium: 140, Potassium: 6.4 });
    await results.release(PATH, lineId);
    return { r, lineId };
  };
  /** Past the grace period: the line was last touched a minute ago. */
  const settle = (lineId: string) => m.LabLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $set: { updatedAt: new Date(Date.now() - 60_000) } });
  /** Messages older than the duplicate window, so a resend with the same key goes out. */
  const ageMessages = () => m.AgentMessage.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * 60_000) } });
  const criticalClocks = (lineId: string) => m.Clock.find({ def: 'lab-critical', ref: lineId }).lean().exec() as Promise<any[]>;

  test('(e) a critical released but never announced gets lab.critical again (same key), its clock and its alert', async () => {
    const { r, lineId } = await releaseCritical();
    // The crash: the line flipped, but neither the message, the clock nor the alert survived.
    await m.AgentMessage.deleteMany({ type: 'lab.critical' });
    await m.Clock.deleteMany({ def: 'lab-critical' });
    await m.TaskAlertItem.deleteMany({});
    assert.deepEqual(await results.reconcileCriticals(), { critical: 0, acked: 0 }, 'a line touched moments ago is left alone');
    await settle(lineId);
    assert.deepEqual(await results.reconcileCriticals(), { critical: 1, acked: 0 });
    const [crit] = await m.AgentMessage.find({ type: 'lab.critical' }).lean<any[]>().exec();
    assert.equal(crit.dedupeKey, `lab.critical:${lineId}:1:Potassium`);
    assert.deepEqual(crit.payload, { requestId: r.id, requestNumber: r.number, lineId, test: 'electrolytes', parameter: 'Potassium', value: '6.4', unit: 'mmol/L', version: 1 });
    const running = (await criticalClocks(lineId)).filter((c) => c.state === 'running');
    assert.equal(running.length, 1);
    const alerts = (await m.TaskAlertItem.find({ link: `lab-line:${lineId}` }).lean()) as any[];
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].status, 'Pending');
    assert.equal(alerts[0].title, 'Critical: Electrolytes Potassium 6.4 mmol/L');
    // Repaired: the next pass finds nothing.
    await settle(lineId);
    assert.deepEqual(await results.reconcileCriticals(), { critical: 0, acked: 0 });
  });

  test('(e) leaves a critical alone while its clock runs, is escalating, or was met for this release', async () => {
    const { lineId } = await releaseCritical();
    await settle(lineId);
    assert.equal((await results.reconcileCriticals()).critical, 0, 'running');
    await m.Clock.collection.updateMany({ def: 'lab-critical' }, { $set: { dueAt: new Date(Date.now() - 60_000) } });
    await clocks.checkDue(new Date());
    assert.equal((await criticalClocks(lineId))[0].state, 'expired');
    await settle(lineId);
    assert.equal((await results.reconcileCriticals()).critical, 0, 'expired and escalating');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'lab.critical' }), 1);
  });

  test('(f) an acknowledged critical whose clock still runs or escalates gets lab.critical-acked again', async () => {
    const { lineId } = await releaseCritical();
    // The crash: the acknowledgement was saved, the message was not.
    await m.LabLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $set: { 'critical.ackAt': new Date(), 'critical.ackBy': 'Dr. Shajin', 'critical.ackById': DOC.id } });
    assert.deepEqual(await results.reconcileCriticals(), { critical: 0, acked: 0 }, 'a line touched moments ago is left alone');
    await settle(lineId);
    assert.deepEqual(await results.reconcileCriticals(), { critical: 0, acked: 1 });
    assert.equal((await criticalClocks(lineId))[0].state, 'met');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'lab.critical-acked' }), 1);
    assert.deepEqual(await results.reconcileCriticals(), { critical: 0, acked: 0 });

    // Same, after the clock expired and escalated: the resend closes the escalation.
    const second = await releaseCritical();
    await m.Clock.collection.updateMany({ def: 'lab-critical', ref: second.lineId }, { $set: { dueAt: new Date(Date.now() - 60_000) } });
    await clocks.checkDue(new Date());
    const esc = (await m.Escalation.findOne({ ladder: 'lab-critical' }).lean()) as any;
    assert.equal(esc.state, 'open');
    await m.LabLine.collection.updateOne({ _id: new Types.ObjectId(second.lineId) }, { $set: { 'critical.ackAt': new Date(), 'critical.ackBy': 'Dr. Shajin' } });
    await settle(second.lineId);
    assert.deepEqual(await results.reconcileCriticals(), { critical: 0, acked: 1 });
    assert.equal(((await m.Escalation.findById(esc._id).lean()) as any).state, 'acknowledged');
  });

  test('one broken item never stops the pass: the other items and branches still run', async () => {
    // (a): one request whose case id is unusable, one fine.
    const bad = await order(['crp']);
    const good = await order(['cbc']);
    for (const r of [bad, good]) {
      await unset(r.id, 'announcedAt');
      await age(r.id);
    }
    await m.AgentMessage.deleteMany({ type: 'lab.ordered' });
    await m.LabRequest.collection.updateOne({ _id: new Types.ObjectId(bad.id) }, { $set: { case: 'not-a-case' } });
    // (d): a released line that lost its report.
    const { lineId } = await receivedLine();
    await results.enterResults(LAB, lineId, { Sodium: 140, Potassium: 4.2 });
    await results.release(PATH, lineId);
    await m.LabTestReport.deleteMany({});
    await m.LabLine.collection.updateOne({ _id: new Types.ObjectId(lineId) }, { $unset: { reportId: '' } });
    const out = await orders.reconcile();
    assert.equal(out.ordered, 1);
    assert.ok((await request(good.id)).announcedAt);
    assert.equal((await request(bad.id)).announcedAt, undefined);
    assert.equal(out.reports, 1);

    // (e): a critical whose request is broken, and one that is fine.
    const one = await releaseCritical();
    const two = await releaseCritical();
    await m.AgentMessage.deleteMany({ type: 'lab.critical' });
    await m.Clock.deleteMany({ def: 'lab-critical' });
    await m.LabRequest.collection.updateOne({ _id: new Types.ObjectId(one.r.id) }, { $set: { case: 'not-a-case' } });
    await settle(one.lineId);
    await settle(two.lineId);
    await ageMessages();
    assert.deepEqual(await results.reconcileCriticals(), { critical: 1, acked: 0 });
    assert.equal((await criticalClocks(two.lineId)).length, 1);
  });

  test('(a) lab.ordered goes out only after announcedAt is claimed, and a failed send releases the claim', async () => {
    const seen: unknown[] = [];
    const send = messages.send.bind(messages);
    messages.send = async (x) => {
      if (x.type === 'lab.ordered') seen.push((await m.LabRequest.findById((x.payload as any).requestId).lean<any>().exec()).announcedAt);
      return send(x);
    };
    await order(['crp']);
    assert.equal(seen.length, 1);
    assert.ok(seen[0], 'announcedAt was claimed before the message was sent');

    messages.send = async (x) => {
      if (x.type === 'lab.ordered') throw new Error('bus down');
      return send(x);
    };
    await assert.rejects(() => order(['cbc']));
    const left = (await m.LabRequest.find().sort({ _id: -1 }).limit(1).lean<any[]>().exec())[0];
    assert.equal(left.announcedAt, undefined, 'the claim was released, so reconcile sends it later');
    messages.send = send;
  });
});
