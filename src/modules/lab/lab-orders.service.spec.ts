import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { Actor } from '../beds/actor';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import { LabOrdersService, orderSummary } from './lab-orders.service';

const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const OTHER_DOC: Actor = { id: 'user-doc-2', name: 'Dr. Priya', role: UserRole.DOCTOR };
const ADMIN: Actor = { id: 'user-admin', name: 'Admin', role: UserRole.ADMIN };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const MIN = 60_000;

describe('LabOrdersService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let cases: CasesService;
  let service: LabOrdersService;
  let registration: LabCoordinatorRegistration;
  let patientId: string;

  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    service = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages);
    registration = new LabCoordinatorRegistration(registry, service, messages, m.LabRequest, m.LabLine);
    registration.onModuleInit();
    const p = await m.Patient.create({ uhid: 'MHK202600901', name: 'Ravi Kumar', age: 52, gender: 'Male', phone: '9100000001' });
    patientId = String(p._id);
  });

  test('ordering CBC, RFT and troponin STAT makes 3 lines, 2 samples (EDTA, serum) and one lab.ordered with collectBy 15 min after the order', async () => {
    const before = Date.now();
    const [view] = await service.order(DOC, { patientId, tests: ['cbc', 'rft', 'troponin'], priority: 'stat' });
    const after = Date.now();

    assert.equal(view.number, 'LR-0001');
    assert.equal(view.lines.length, 3);
    assert.deepEqual(view.samples.map((s) => s.tube).sort(), ['edta', 'serum']);
    assert.match(view.samples[0].number, /^S-\d{6}-0001$/);
    assert.equal(view.samples[1].number.slice(-4), '0002');
    const collect = new Date(view.collectBy).getTime();
    assert.ok(collect >= before + 15 * MIN && collect <= after + 15 * MIN);
    const tat = view.lines.map((l) => new Date(l.tatDueAt).getTime());
    assert.ok(Math.abs(tat[0] - (before + 30 * MIN)) < 5_000, 'cbc STAT is 30 min');

    const ordered = await sent('lab.ordered');
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0].payload.requestNumber, 'LR-0001');
    assert.deepEqual(ordered[0].payload.tests, ['cbc', 'rft', 'troponin']);
    assert.equal(new Date(ordered[0].payload.collectBy).getTime(), collect);
    assert.equal(new Date(ordered[0].payload.tatDueAt).getTime(), Math.min(...tat), 'earliest line');
    assert.ok(ordered[0].summary.length <= 140);
    assert.ok(!ordered[0].summary.includes('Ravi'));
    assert.match(ordered[0].summary, /^LR-0001: Complete blood count, Kidney function, Troponin I \(STAT\)$/);
    const row = await m.LabRequest.findById(view.id).lean();
    assert.ok(row!.announcedAt);
  });

  test('an order for a patient with no open case opens an opd case; with an open ER case it joins it', async () => {
    const [first] = await service.order(DOC, { patientId, tests: ['cbc'], priority: 'routine' });
    const c: any = await m.Case.findById(first.caseId).lean();
    assert.equal(c.kind, 'opd');
    assert.equal(c.openedBy, 'lab');
    assert.equal(c.priority, 'low');
    assert.deepEqual(first.location, { area: 'OPD' });
    const rows: any[] = await m.TimelineEvent.find({ uhid: 'MHK202600901' }).lean();
    assert.equal(rows[0].category, 'Outpatient');

    await resetTestDb();
    const p2 = await m.Patient.create({ uhid: 'MHK202600902', name: 'Sita Devi', age: 40, gender: 'Female', phone: '9100000002' });
    const { case: erCase } = await cases.openOrJoin({ patientId: String(p2._id), patientUhid: p2.uhid, patientName: p2.name, kind: 'er', priority: 'high', openedBy: 'er' });
    const [joined] = await service.order(DOC, { patientId: String(p2._id), tests: ['troponin'], priority: 'urgent' });
    assert.equal(joined.caseId, String(erCase._id));
    assert.equal(await m.Case.countDocuments({}), 1);
    assert.deepEqual(joined.location, { area: 'ER' });
  });

  test('an unknown patient or bad input is refused', async () => {
    await assert.rejects(service.order(DOC, { patientId: '64b000000000000000000000', tests: ['cbc'], priority: 'stat' }), { status: 404 });
    for (const bad of [
      { tests: [] },
      { tests: ['cbc', 'cbc'] },
      { tests: ['nope'] },
      { tests: Array.from({ length: 11 }, (_, i) => (i < 10 ? 'cbc' : 'crp')) },
      { tests: ['cbc'], priority: 'now' },
      { tests: ['cbc'], repeatAfterHours: 0 },
      { tests: ['cbc'], repeatAfterHours: 73 },
      { tests: ['cbc'], repeatAfterHours: 1.5 },
    ]) {
      await assert.rejects(service.order(DOC, { patientId, priority: 'stat', ...bad } as any), { status: 400 }, JSON.stringify(bad));
    }
    assert.equal(await m.LabRequest.countDocuments({}), 0);
  });

  test('a repeat troponin is its own request due at the scheduled time', async () => {
    const before = Date.now();
    const out = await service.order(DOC, { patientId, tests: ['troponin'], priority: 'stat', repeatAfterHours: 3 });
    assert.equal(out.length, 2);
    const [a, b] = out;
    assert.equal(b.number, 'LR-0002');
    assert.equal(b.repeatOf, a.id);
    const sched = new Date(b.scheduledFor!).getTime();
    assert.ok(Math.abs(sched - (before + 3 * 3_600_000)) < 5_000);
    assert.equal(b.collectBy, b.scheduledFor);
    assert.ok(Math.abs(new Date(b.lines[0].tatDueAt).getTime() - (sched + 60 * MIN)) < 1);
    const ordered = await sent('lab.ordered');
    assert.equal(ordered.length, 2, 'the repeat is sent at once');
    assert.equal(new Date(ordered[1].payload.collectBy).getTime(), sched);
    assert.equal(new Date(ordered[1].payload.tatDueAt).getTime(), sched + 60 * MIN);
  });

  test('a doctor can\'t cancel another doctor\'s line; an admin can', async () => {
    const [v] = await service.order(DOC, { patientId, tests: ['cbc', 'crp'], priority: 'routine' });
    await assert.rejects(service.cancelLine(OTHER_DOC, v.lines[0].id, 'not needed'), { status: 403 });
    await assert.rejects(service.cancelLine(DOC, v.lines[0].id, '  '), { status: 400 });
    const after = await service.cancelLine(ADMIN, v.lines[0].id, ' duplicate ');
    assert.equal(after.lines[0].status, 'cancelled');
    assert.equal(after.lines[0].cancelled!.reason, 'duplicate');
    const own = await service.cancelLine(DOC, v.lines[1].id, 'changed plan');
    assert.equal(own.lines[1].status, 'cancelled');
    await assert.rejects(service.cancelLine(DOC, v.lines[1].id, 'again'), { status: 409 });
  });

  test('cancelling a released line is refused', async () => {
    const [v] = await service.order(DOC, { patientId, tests: ['cbc', 'crp'], priority: 'routine' });
    await m.LabLine.updateOne({ _id: v.lines[0].id }, { status: 'released' });
    await assert.rejects(service.cancelLine(DOC, v.lines[0].id, 'late'), { status: 409 });
  });

  test('cancelling one of several lines sends lab.cancelled with the earliest due of the open lines', async () => {
    const [v] = await service.order(DOC, { patientId, tests: ['cbc', 'rft'], priority: 'stat' }); // cbc 30, rft 60
    await service.cancelLine(DOC, v.lines[0].id, 'not needed');
    const [msg] = await sent('lab.cancelled');
    assert.equal(msg.payload.test, 'cbc');
    assert.equal(new Date(msg.payload.tatDueAt).getTime(), new Date(v.lines[1].tatDueAt).getTime());
    assert.equal((await sent('lab.collection-done')).length, 0);
    const s = await m.LabSample.find({ request: v.id }).lean();
    assert.deepEqual(s.map((x) => x.status).sort(), ['cancelled', 'waiting']);
  });

  test('cancelling the last open line sends lab.collection-done and lab.request-done', async () => {
    const [v] = await service.order(DOC, { patientId, tests: ['cbc'], priority: 'stat' });
    await service.cancelLine(DOC, v.lines[0].id, 'wrong patient');
    const [cancelled] = await sent('lab.cancelled');
    assert.equal(new Date(cancelled.payload.tatDueAt).getTime(), new Date(v.lines[0].tatDueAt).getTime(), 'own due when none remain');
    assert.equal((await sent('lab.collection-done')).length, 1);
    assert.equal((await sent('lab.request-done')).length, 1);
    const row: any = await m.LabRequest.findById(v.id).lean();
    assert.ok(row.collectionDoneAt && row.doneAt);
  });

  test('not collected cancels the waiting lines with the reason', async () => {
    const [v] = await service.order(DOC, { patientId, tests: ['cbc', 'rft'], priority: 'routine' });
    const sample = v.samples.find((s) => s.tube === 'edta')!;
    await m.LabSample.updateOne({ _id: sample.id }, { status: 'collected' });
    await m.LabLine.updateOne({ _id: sample.lines[0] }, { status: 'collected' });

    const after = await service.notCollected(NURSE, v.id, 'patient refused');
    const rft = after.lines.find((l) => l.test === 'rft')!;
    const cbc = after.lines.find((l) => l.test === 'cbc')!;
    assert.equal(rft.status, 'cancelled');
    assert.equal(rft.cancelled!.reason, 'patient refused');
    assert.equal(rft.cancelled!.by, 'Nurse Anita');
    assert.equal(cbc.status, 'collected');
    assert.equal((await sent('lab.cancelled')).length, 1);
    assert.equal((await sent('lab.collection-done')).length, 1, 'nothing is waiting any more');
    assert.equal((await sent('lab.request-done')).length, 0);
    await assert.rejects(service.notCollected(NURSE, v.id, 'again'), { status: 409 });
    await assert.rejects(service.notCollected(NURSE, v.id, ''), { status: 400 });
  });

  test('two lab.collection-done sends for one request within a second are both stored', async () => {
    const [v] = await service.order(DOC, { patientId, tests: ['cbc'], priority: 'stat' });
    await service.announceDone(v.id, 'lab.collection-done');
    await service.announceDone(v.id, 'lab.collection-done');
    await service.announceDone(v.id, 'lab.request-done');
    await service.announceDone(v.id, 'lab.request-done');
    assert.equal((await sent('lab.collection-done')).length, 2);
    assert.equal((await sent('lab.request-done')).length, 2);
  });

  test('a repeat troponin ordered in the ER shows under the ward after bed.assigned arrives for the case', async () => {
    const { case: erCase } = await cases.openOrJoin({ patientId, patientUhid: 'MHK202600901', patientName: 'Ravi Kumar', kind: 'er', priority: 'high', openedBy: 'er' });
    const out = await service.order(DOC, { patientId, tests: ['troponin'], priority: 'stat', repeatAfterHours: 3 });
    assert.equal(out[1].location.area, 'ER');

    const handler = (type: string) => registry.subscribers(type).find((s) => s.agent === 'lab')!.handler;
    const send = async (type: string, payload: Record<string, unknown>, from: 'er' | 'bed') => {
      const msg = await messages.send({ case: String(erCase._id), from, to: ['coordinator'], type, priority: 'medium', summary: type, payload });
      await handler(type)(String(msg!._id));
    };
    // the bed bridge registers its own types in the app; here they are stubbed on a throwaway agent
    registry.register({
      key: 'bed',
      messageTypes: [
        { type: 'bed.assigned', agent: 'bed', description: 'x', payload: { bedId: 'string', bedLabel: 'string', admissionId: 'string', ward: 'string' } },
        { type: 'bed.discharged', agent: 'bed', description: 'x', payload: { bedId: 'string', bedLabel: 'string' } },
      ],
      status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
    });
    await send('bed.assigned', { bedId: 'b1', bedLabel: 'W2-04', admissionId: 'a1', ward: 'Ward 2' }, 'bed');

    const repeat = await service.get(out[1].id);
    assert.deepEqual(repeat.location, { area: 'Ward', ward: 'Ward 2' });
    assert.deepEqual(await service.location(String(erCase._id)), { area: 'Ward', ward: 'Ward 2' });

    await send('bed.discharged', { bedId: 'b1', bedLabel: 'W2-04' }, 'bed');
    assert.deepEqual(await service.location(String(erCase._id)), { area: 'OPD' });
  });

  test('summary stays within 140 characters and never grows past the list', () => {
    const labels = ['Complete blood count', 'Kidney function', 'Liver function', 'Lipid profile', 'Thyroid profile', 'Clotting (PT/INR)', 'Blood culture', 'Urine routine'];
    const s = orderSummary('LR-0001', labels, 'routine');
    assert.ok(s.length <= 140, s);
    assert.match(s, /\+\d+ more \(ROUTINE\)$/);
  });
});
