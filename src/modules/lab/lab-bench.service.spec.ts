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
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { LabBenchService } from './lab-bench.service';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import { LabOrdersService } from './lab-orders.service';
import { LabSettingsService } from './lab-settings.service';
import { SettingsService } from '../settings/settings.service';

const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const LAB: Actor = { id: 'user-lab', name: 'Meera', role: UserRole.LAB };
const MIN = 60_000;

describe('LabBenchService', () => {
  const m = models();
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let orders: LabOrdersService;
  let bench: LabBenchService;
  let patientId: string;

  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;
  const clockOf = (def: string, caseId: string) => m.Clock.find({ def, case: caseId }).sort({ createdAt: 1 }).lean().exec() as Promise<any[]>;
  const escalationsOn = (ladder: string) => m.Escalation.countDocuments({ ladder }).exec();
  const order = (tests: string[], priority: 'stat' | 'urgent' | 'routine' = 'stat') => orders.order(DOC, { patientId, tests, priority }).then((r) => r[0]);
  /** Real-time backdating: timestamps are immutable, so the clock and request go via the collection. */
  const backdateClock = (def: string, caseId: string, minutes: number) =>
    m.Clock.collection.updateMany({ def, case: new Types.ObjectId(caseId) }, { $set: { dueAt: new Date(Date.now() - minutes * MIN) } });

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
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    orders = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)));
    new LabCoordinatorRegistration(registry, orders, messages, m.LabRequest, m.LabLine).onModuleInit();
    bench = new LabBenchService(m.LabRequest, m.LabLine, m.LabSample, orders, messages);
    const p = await m.Patient.create({ uhid: 'MHK202600901', name: 'Ravi Kumar', age: 52, gender: 'Male', phone: '9100000001' });
    patientId = String(p._id);
  });

  test('collecting by sample number marks the sample and its lines and sends lab.collected', async () => {
    const r = await order(['cbc', 'rft', 'troponin']);
    const edta = r.samples.find((s) => s.tube === 'edta')!;
    await bench.collect(NURSE, edta.number);
    const s = (await m.LabSample.findOne({ number: edta.number }).lean()) as any;
    assert.equal(s.status, 'collected');
    assert.equal(s.collected.by, 'Nurse Anita');
    const lines = (await m.LabLine.find({ _id: { $in: s.lines } }).lean()) as any[];
    assert.ok(lines.every((l) => l.status === 'collected'));
    const [msg] = await sent('lab.collected');
    assert.deepEqual(msg.payload, { requestId: r.id, sampleId: String(s._id), sampleNumber: edta.number, tube: 'edta', tests: ['cbc'] });
    assert.ok(!msg.summary.includes('Ravi') && msg.summary.includes(edta.number) && msg.summary.length <= 140);
    assert.equal((await sent('lab.collection-done')).length, 0, 'the serum tube is still waiting');
    await bench.collect(NURSE, r.samples.find((s2) => s2.tube === 'serum')!.number);
    assert.equal((await sent('lab.collection-done')).length, 1);
    assert.ok(((await m.LabRequest.findById(r.id).lean()) as any).collectionDoneAt);
  });

  test('collecting an unknown or a non-waiting sample is refused', async () => {
    const r = await order(['cbc']);
    await assert.rejects(() => bench.collect(NURSE, 'S-000000-9999'), { status: 404 });
    await bench.collect(NURSE, r.samples[0].number);
    await assert.rejects(() => bench.collect(NURSE, r.samples[0].number), { status: 409, message: "This sample isn't waiting to be collected." });
    assert.equal((await sent('lab.collected')).length, 1);
  });

  test('a late STAT request with 3 tests in 2 tubes raises one collection escalation and no turnaround escalation before receipt', async () => {
    const r = await order(['cbc', 'rft', 'troponin']);
    assert.equal(r.samples.length, 2);
    const [collect] = await clockOf('lab-collect', r.caseId);
    assert.ok(collect);
    assert.equal((await clockOf('lab-tat', r.caseId)).length, 0, 'the turnaround clock starts at receipt');
    await m.LabRequest.collection.updateOne({ _id: new Types.ObjectId(r.id) }, { $set: { collectBy: new Date(Date.now() - 30 * MIN) } });
    await backdateClock('lab-collect', r.caseId, 30);
    await clocks.checkDue(new Date());
    await clocks.checkDue(new Date());
    assert.equal(await escalationsOn('lab'), 1);
    assert.equal(await m.Clock.countDocuments({ def: 'lab-tat' }), 0);
    assert.equal(((await clockOf('lab-collect', r.caseId))[0]).state, 'expired');
  });

  test('the first receipt starts the turnaround clock due at the order time + the earliest target; the second sample is not first', async () => {
    const before = Date.now();
    const r = await order(['cbc', 'rft', 'troponin']);
    for (const s of r.samples) await bench.collect(NURSE, s.number);
    assert.equal((await clockOf('lab-collect', r.caseId))[0].state, 'met');
    assert.equal((await clockOf('lab-tat', r.caseId)).length, 0);
    await bench.receive(LAB, r.samples[0].id);
    const [tat] = await clockOf('lab-tat', r.caseId);
    assert.ok(tat);
    assert.ok(Math.abs(new Date(tat.dueAt).getTime() - (before + 30 * MIN)) < 10_000, 'cbc STAT is the earliest, 30 min');
    await bench.receive(LAB, r.samples[1].id);
    const received = await sent('lab.received');
    assert.deepEqual(received.map((x) => x.payload.firstReceive), [true, false]);
    assert.equal((await clockOf('lab-tat', r.caseId)).length, 1);
    assert.ok(received.every((x) => !x.summary.includes('Ravi')));
    await assert.rejects(() => bench.receive(LAB, r.samples[0].id), { status: 409 });
    await assert.rejects(() => bench.receive(LAB, String(new Types.ObjectId())), { status: 404 });
    const line = (await m.LabLine.findOne({ request: r.id, test: 'cbc' }).lean()) as any;
    assert.equal(line.status, 'received');
  });

  test('receiving a sample that was not collected is refused', async () => {
    const r = await order(['cbc']);
    await assert.rejects(() => bench.receive(LAB, r.samples[0].id), { status: 409 });
  });

  test('a rejected sample is replaced on the same request with one lab-recollect clock; a second rejection does not start another; the turnaround due time is unchanged', async () => {
    const t00 = Date.now();
    const r = await order(['cbc', 'crp'], 'urgent');
    const [cbc] = r.samples.filter((s) => s.tube === 'edta');
    for (const s of r.samples) await bench.collect(NURSE, s.number);
    await bench.receive(LAB, cbc.id);
    const [tat] = await clockOf('lab-tat', r.caseId);
    const dueBefore = new Date(tat.dueAt).getTime();
    assert.ok(Math.abs(dueBefore - (t00 + 60 * MIN)) < 10_000, 'urgent cbc: 2 x 30 min from the order');

    await assert.rejects(() => bench.reject(LAB, cbc.id, 'other'), { status: 400 });
    await assert.rejects(() => bench.reject(LAB, cbc.id, 'bogus'), { status: 400 });
    const t0 = Date.now();
    await bench.reject(LAB, cbc.id, 'haemolysed');
    const old = (await m.LabSample.findById(cbc.id).lean()) as any;
    assert.equal(old.status, 'rejected');
    assert.equal(old.rejected.reason, 'haemolysed');
    const fresh = (await m.LabSample.findOne({ replaces: cbc.id }).lean()) as any;
    assert.equal(fresh.status, 'waiting');
    assert.equal(fresh.tube, 'edta');
    assert.deepEqual(fresh.lines.map(String), old.lines.map(String));
    assert.notEqual(fresh.number, old.number);
    assert.ok(Math.abs(fresh.collectBy.getTime() - (t0 + 60 * MIN)) < 10_000, 'urgent: 60 min from now');
    const line = (await m.LabLine.findById(old.lines[0]).lean()) as any;
    assert.equal(line.status, 'ordered');
    assert.equal(((await m.LabRequest.findById(r.id).lean()) as any).collectionDoneAt, undefined);

    const [rej] = await sent('lab.rejected');
    assert.equal(rej.payload.newSampleId, String(fresh._id));
    assert.equal(rej.payload.reason, 'haemolysed');
    assert.equal(new Date(rej.payload.recollectBy).getTime(), fresh.collectBy.getTime());
    assert.ok(!rej.summary.includes('Ravi'));
    assert.equal((await clockOf('lab-recollect', r.caseId)).filter((c) => c.state === 'running').length, 1);

    // The replacement is collected, then rejected again: still one running recollect clock at a time.
    await bench.collect(NURSE, fresh.number);
    assert.equal((await sent('lab.collection-done')).length, 2, 'collection finished again');
    assert.equal((await clockOf('lab-recollect', r.caseId))[0].state, 'met');
    const again = (await m.LabSample.findOne({ replaces: cbc.id }).lean()) as any;
    await bench.reject(LAB, String(again._id), 'other', 'Tube cracked');
    const recs = await clockOf('lab-recollect', r.caseId);
    assert.equal(recs.filter((c) => c.state === 'running').length, 1);
    assert.equal(recs.length, 2, 'the first is history, the second is the only one running');
    assert.equal((await clockOf('lab-tat', r.caseId)).length, 1, 'no second turnaround clock');
    assert.equal(new Date((await clockOf('lab-tat', r.caseId))[0].dueAt).getTime(), dueBefore);
    await assert.rejects(() => bench.reject(LAB, cbc.id, 'clotted'), { status: 409 });
  });

  test('a rejection after lab.collection-done re-sends it once the replacement is collected, and the lab-recollect clock stops', async () => {
    const r = await order(['crp']);
    await bench.collect(NURSE, r.samples[0].number);
    assert.equal((await sent('lab.collection-done')).length, 1);
    await bench.reject(LAB, r.samples[0].id, 'clotted');
    assert.equal((await sent('lab.collection-done')).length, 1);
    const [rc] = await clockOf('lab-recollect', r.caseId);
    assert.equal(rc.state, 'running');
    const fresh = (await m.LabSample.findOne({ replaces: r.samples[0].id }).lean()) as any;
    await bench.collect(NURSE, fresh.number);
    assert.equal((await sent('lab.collection-done')).length, 2);
    assert.equal((await clockOf('lab-recollect', r.caseId))[0].state, 'met');
    // Review: an overdue recollection escalates once, on ladder lab.
    const r2 = await order(['glucose']);
    await bench.collect(NURSE, r2.samples[0].number);
    await bench.reject(LAB, r2.samples[0].id, 'unlabelled');
    await backdateClock('lab-recollect', r2.caseId, 5);
    await clocks.checkDue(new Date());
    assert.equal(await escalationsOn('lab'), 1);
  });

  test('the collection list shows waiting samples, STAT first, filtered by location, with the overdue flag', async () => {
    const r1 = await order(['cbc'], 'routine');
    const r2 = await order(['crp'], 'stat'); // same patient, same case
    assert.equal(r1.caseId, r2.caseId);
    const list = await bench.collectionList();
    assert.deepEqual(list.map((i) => i.requestNumber), ['LR-0002', 'LR-0001']);
    assert.equal(list[0].tubeLabel, 'Serum (gold)');
    assert.deepEqual(list[0].tests, ['CRP']);
    assert.equal(list[0].patientName, 'Ravi Kumar');
    assert.equal(list[0].patientUhid, 'MHK202600901');
    assert.deepEqual(list[0].location, { area: 'OPD' });
    assert.equal(list[0].overdue, false);
    assert.equal((await bench.collectionList('ER')).length, 0);
    assert.equal((await bench.collectionList('OPD')).length, 2);
    await m.LabSample.collection.updateOne({ number: list[0].sampleNumber }, { $set: { collectBy: new Date(Date.now() - MIN) } });
    assert.equal((await bench.collectionList())[0].overdue, true);
    await bench.collect(NURSE, list[0].sampleNumber);
    assert.deepEqual((await bench.collectionList()).map((i) => i.requestNumber), ['LR-0001']);
  });

  test('two concurrent collects of the last two samples send one lab.collection-done and stop lab-collect', async () => {
    const r = await order(['cbc', 'rft']);
    assert.equal(r.samples.length, 2);
    await Promise.all(r.samples.map((x) => bench.collect(NURSE, x.number)));
    assert.equal((await sent('lab.collection-done')).length, 1);
    assert.equal((await clockOf('lab-collect', r.caseId))[0].state, 'met');
  });

  test('two concurrent cancels of the last two lines send one lab.request-done', async () => {
    const r = await order(['cbc', 'rft']);
    await Promise.all(r.lines.map((l) => orders.cancelLine(DOC, l.id, 'Not needed')));
    assert.equal((await sent('lab.request-done')).length, 1);
    assert.equal((await sent('lab.collection-done')).length, 1);
  });

  test('two concurrent receives give one firstReceive and one running lab-tat', async () => {
    const r = await order(['cbc', 'rft']);
    for (const x of r.samples) await bench.collect(NURSE, x.number);
    await Promise.all(r.samples.map((x) => bench.receive(LAB, x.id)));
    const received = await sent('lab.received');
    assert.equal(received.filter((x) => x.payload.firstReceive === true).length, 1);
    assert.equal((await clockOf('lab-tat', r.caseId)).filter((c) => c.state === 'running').length, 1);
  });

  test('rejecting a sample with nothing left to recollect is refused', async () => {
    const r = await order(['cbc']);
    await bench.collect(NURSE, r.samples[0].number);
    await m.LabLine.updateMany({ request: r.id }, { status: 'released' });
    await assert.rejects(() => bench.reject(LAB, r.samples[0].id, 'clotted'), { status: 409, message: 'Nothing left to recollect on this sample.' });
    assert.equal(await m.LabSample.countDocuments({ request: r.id }), 1);
  });
});
