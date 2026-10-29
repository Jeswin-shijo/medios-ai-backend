import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { Actor } from '../beds/actor';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
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
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    orders = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)), m.LabTestReport);
    new LabCoordinatorRegistration(registry, orders, messages, m.LabRequest, m.LabLine).onModuleInit();
    bench = new LabBenchService(m.LabRequest, m.LabLine, m.LabSample, orders, messages);
    results = new LabResultsService(m.LabRequest, m.LabLine, m.LabTestReport, m.TaskAlertItem, orders, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)), noAi);
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
});
