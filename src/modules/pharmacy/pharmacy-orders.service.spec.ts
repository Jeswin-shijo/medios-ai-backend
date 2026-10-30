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
import { PharmacyCoordinatorRegistration } from './pharmacy-coordinator.registration';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { LineInput, PharmacyOrdersService, RecheckResult } from './pharmacy-orders.service';
import { PharmacyPatientsService } from './pharmacy-patients.service';
import { startKey } from './pharmacy-rounds';
import { PharmacySettingsService } from './pharmacy-settings.service';

const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const MIN = 60_000;
const HOUR = 3_600_000;

const aspirin300: LineInput = { medicine: 'aspirin', product: 'aspirin-tab-300', dose: 300, route: 'oral', frequency: 'STAT' };
const clopidogrel300: LineInput = { medicine: 'clopidogrel', product: 'clopidogrel-tab-75', dose: 300, route: 'oral', frequency: 'STAT' };
const enoxaparin60: LineInput = { medicine: 'enoxaparin', product: 'enoxaparin-syringe-60', dose: 60, route: 'sc', frequency: 'BD', durationDays: 5 };

describe('PharmacyOrdersService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let service: PharmacyOrdersService;
  let patientId: string;
  let patientUhid: string;

  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;
  const clocksOf = (def: string) => m.Clock.find({ def }).sort({ startedAt: 1 }).lean().exec() as Promise<any[]>;
  const openEr = (id = patientId, uhid = patientUhid, name = 'Ravi Kumar') =>
    cases.openOrJoin({ patientId: id, patientUhid: uhid, patientName: name, kind: 'er', priority: 'high', openedBy: 'er' });
  const kidneyReport = (creatinine: number, extra: Record<string, unknown> = {}) =>
    m.LabTestReport.create({
      uhid: patientUhid,
      testName: 'Kidney function',
      category: 'Biochemistry',
      groups: [{ category: 'Kidney function', parameters: [{ name: 'Creatinine', result: creatinine, referenceRange: '0.7-1.3', unit: 'mg/dL', status: 'High' }] }],
      ...extra,
    });

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
    const settings = new PharmacySettingsService(new SettingsService(m.HospitalSettings));
    service = new PharmacyOrdersService(
      m.PharmacyOrder, m.PharmacyLine, m.PharmacyLocation, m.CoordinatorCounter,
      new PatientsService(m.Patient), cases, messages, settings, new PharmacyPatientsService(m.Patient, m.LabTestReport),
    );
    new PharmacyCoordinatorRegistration(registry, service, messages, new PharmacyChecksService(m.PharmacyLine, m.PharmacyOrder, m.TaskAlertItem, service, cases, messages, settings), m.PharmacyOrder, m.PharmacyLine, m.Clock).onModuleInit();
    const p = await m.Patient.create({ uhid: 'MHK202600901', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000001', vitals: { weightKg: 64 } });
    patientId = String(p._id);
    patientUhid = p.uhid;
  });

  test('ordering aspirin 300 mg STAT and clopidogrel 300 mg STAT for an ER patient makes MO-0001', async () => {
    await openEr();
    const before = Date.now();
    const view = await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300, clopidogrel300] });
    const after = Date.now();

    assert.equal(view.number, 'MO-0001');
    assert.equal(view.setting, 'ER');
    assert.equal(view.lines.length, 2);
    assert.deepEqual(view.lines.map((l) => [l.status, l.quantity]), [['to-check', 1], ['to-check', 4]]);
    assert.equal(view.lines[0].defaultStore, 'er');
    assert.equal((await sent('pharmacy.ordered')).length, 1);
    assert.equal((await sent('pharmacy.to-check')).length, 2);

    const [clock] = await clocksOf('pharmacy-check');
    assert.equal(clock.ref, `${view.id}:c1`);
    assert.equal(clock.state, 'running');
    const due = new Date(clock.dueAt).getTime();
    assert.ok(due >= before + 15 * MIN - 1000 && due <= after + 15 * MIN + 1000, 'due 15 min after the order');
    assert.equal((await clocksOf('pharmacy-check')).length, 1, 'one clock for the whole order');
    const order = await m.PharmacyOrder.findById(view.id).lean();
    assert.deepEqual([order!.checkRound, order!.checkOpen], [1, true]);
    assert.ok(order!.announcedAt);
  });

  test('message summaries carry the order number, medicine and priority, never the patient name', async () => {
    await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300, clopidogrel300] });
    const all = await m.AgentMessage.find({ from: 'pharmacy' }).lean();
    assert.ok(all.length >= 3);
    for (const msg of all) {
      assert.ok(msg.summary.length <= 140, msg.summary);
      assert.ok(!/Ravi|Kumar|MHK2026/i.test(msg.summary + JSON.stringify(msg.payload)), msg.summary);
    }
    assert.equal((await sent('pharmacy.ordered'))[0].summary, 'MO-0001: Aspirin, Clopidogrel ordered (STAT)');
    assert.equal((await sent('pharmacy.to-check'))[0].summary, 'MO-0001: Aspirin 300 mg to check (STAT)');
  });

  test('an order opens an opd case for a patient without one and joins an open ER case', async () => {
    const v1 = await service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 3 }] });
    assert.equal(v1.setting, 'OPD');
    const c1: any = await m.Case.findById(v1.caseId).lean();
    assert.equal(c1.kind, 'opd');
    assert.equal(c1.openedBy, 'pharmacy');
    assert.equal(c1.priority, 'low');

    const p2 = await m.Patient.create({ uhid: 'MHK202600902', name: 'Asha Devi', age: 40, gender: 'Female', phone: '9100000002' });
    const { case: er } = await openEr(String(p2._id), p2.uhid, p2.name);
    const v2 = await service.order(DOC, { patientId: String(p2._id), priority: 'urgent', lines: [aspirin300] });
    assert.equal(v2.caseId, String(er._id));
    assert.equal(v2.setting, 'ER');
    assert.equal(await m.Case.countDocuments({ patient: p2._id }), 1);
  });

  test('a line with an unconfirmed red allergy is refused (400); with confirm it is accepted and its flag reads confirmed with the reason', async () => {
    await m.Patient.updateOne({ _id: patientId }, { allergies: ['Penicillin'] });
    const augmentin: LineInput = { medicine: 'amoxicillin-clavulanate', product: 'amoxicillin-clavulanate-tab-625', dose: 625, route: 'oral', frequency: 'BD', durationDays: 5 };
    await assert.rejects(() => service.order(DOC, { patientId, priority: 'routine', lines: [augmentin] }), {
      status: 400,
      message: 'Confirm the allergy for Amoxicillin-clavulanate with a reason, or remove it',
    });
    assert.equal(await m.PharmacyOrder.countDocuments(), 0, 'nothing was created');
    assert.equal(await m.Case.countDocuments(), 0);

    const v = await service.order(DOC, { patientId, priority: 'routine', lines: [{ ...augmentin, confirm: { reason: 'Tolerated before, reaction was a rash' } }] });
    const flag = v.lines[0].flags.find((f) => f.key === 'allergy.amoxicillin-clavulanate')!;
    assert.equal(flag.severity, 'red');
    assert.equal(flag.confirmed!.reason, 'Tolerated before, reaction was a rash');
    assert.equal(flag.confirmed!.by, 'Dr. Shajin');
  });

  test('the doctor input is validated against the list, and a duration is needed except for STAT', async () => {
    const bad = (line: Record<string, unknown>) => assert.rejects(() => service.order(DOC, { patientId, priority: 'routine', lines: [{ ...enoxaparin60, ...line } as LineInput] }), { status: 400 });
    await bad({ medicine: 'nope' });
    await bad({ product: 'aspirin-tab-300' }); // another medicine's product
    await bad({ route: 'oral' }); // not an enoxaparin route
    await bad({ dose: 0 });
    await bad({ frequency: 'WEEKLY' });
    await bad({ durationDays: undefined });
    await bad({ durationDays: 0 });
    await bad({ durationDays: 91 });
    await bad({ durationDays: 2.5 });
    await assert.rejects(() => service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, durationDays: 3 }] }), { status: 400 });
    await assert.rejects(() => service.order(DOC, { patientId, priority: 'routine', lines: [] }), { status: 400 });
    await assert.rejects(() => service.order(DOC, { patientId, priority: 'routine', lines: Array(11).fill(aspirin300) }), { status: 400 });
    await assert.rejects(() => service.order(DOC, { patientId, priority: 'asap' as never, lines: [aspirin300] }), { status: 400 });
    assert.equal(await m.PharmacyOrder.countDocuments(), 0);
  });

  test("preview shows a clash between two preview lines and against an active line, and the patient's allergies, weight, age and eGFR", async () => {
    await m.Patient.updateOne({ _id: patientId }, { allergies: ['Sulpha drugs'] });
    await kidneyReport(2.5, { labLine: 'line-1' });
    await service.order(DOC, { patientId, priority: 'routine', lines: [{ medicine: 'warfarin', product: 'warfarin-tab-5', dose: 5, route: 'oral', frequency: 'OD', durationDays: 7 }] });

    const ibuprofen: LineInput = { medicine: 'ibuprofen', product: 'ibuprofen-tab-400', dose: 400, route: 'oral', frequency: 'TDS', durationDays: 5 };
    const metronidazole: LineInput = { medicine: 'metronidazole', product: 'metronidazole-tab-400', dose: 400, route: 'oral', frequency: 'TDS', durationDays: 5 };
    const p = await service.preview({ patientId, lines: [ibuprofen, enoxaparin60, metronidazole] });

    assert.deepEqual([p.patient.allergies, p.patient.weightKg, p.patient.age, p.patient.sex, p.patient.egfr], [['Sulpha drugs'], 64, 62, 'M', 28]);
    const keys = (i: number) => p.lines[i].flags.map((f) => `${f.severity}:${f.key}`);
    assert.ok(keys(0).includes('red:clash.enoxaparin'), 'between two preview lines');
    assert.ok(keys(1).includes('red:clash.ibuprofen'));
    assert.ok(keys(2).includes('red:clash.warfarin'), 'against an active line');
    assert.deepEqual(p.lines.map((l) => l.quantity), [15, 10, 15]);
    assert.equal(await m.PharmacyLine.countDocuments(), 1, 'a preview saves nothing');
  });

  test('facts take creatinine 2.5 for a man of 62 from the latest Lab Agent kidney report (eGFR 28) and ignore a report older than 72 h or one without labLine', async () => {
    const facts = new PharmacyPatientsService(m.Patient, m.LabTestReport);
    await kidneyReport(2.5); // no labLine: entered by hand, not the Lab Agent
    assert.deepEqual([(await facts.facts(patientId)).egfr, (await facts.facts(patientId)).kidneyStatus], [null, 'unknown']);

    const old = await kidneyReport(1.0, { labLine: 'old' });
    await m.LabTestReport.collection.updateOne({ _id: old._id }, { $set: { updatedAt: new Date(Date.now() - 73 * HOUR) } });
    assert.equal((await facts.facts(patientId)).kidneyStatus, 'unknown', 'older than 72 h');

    await kidneyReport(2.5, { labLine: 'new' });
    const f = await facts.facts(patientId);
    assert.deepEqual([f.egfr, f.kidneyStatus, f.creatinine, f.age, f.sex, f.weightKg], [28, 'known', 2.5, 62, 'M', 64]);
    assert.ok(f.egfrAt);

    // A child, or a missing record, cannot be calculated.
    const kid = await m.Patient.create({ uhid: 'MHK202600903', name: 'Kid', age: 9, gender: 'Female', phone: '9100000003' });
    assert.equal((await facts.facts(String(kid._id))).kidneyStatus, 'not-calculated');
    const none = await facts.facts(String(new Types.ObjectId()));
    assert.deepEqual(none, { age: null, sex: null, weightKg: null, allergies: [], egfr: null, kidneyStatus: 'not-calculated', creatinine: null, egfrAt: null });
  });

  test("a new order re-runs the checks on the patient's other active lines: the earlier enoxaparin gains the amber clash with the new aspirin, and onRechecked is called once with it", async () => {
    const first = await service.order(DOC, { patientId, priority: 'routine', lines: [enoxaparin60] });
    const calls: RecheckResult[][] = [];
    service.onRechecked(async (r) => void calls.push(r));
    assert.equal(first.lines[0].flags.some((f) => f.key === 'clash.aspirin'), false);

    const second = await service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 5 }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(String(calls[0][0].line._id), first.lines[0].id);
    assert.equal(calls[0][0].reason, 'order');
    const stored: any = await m.PharmacyLine.findById(first.lines[0].id).lean();
    assert.deepEqual(stored.flags.filter((f: any) => f.kind === 'clash').map((f: any) => [f.key, f.severity]), [['clash.aspirin', 'amber']]);
    // The new line was checked as it was added: it carries the same pair.
    assert.ok(second.lines[0].flags.some((f) => f.key === 'clash.enoxaparin'));
  });

  test('a recheck that changes nothing calls no listener, and a failing listener is logged, not thrown', async () => {
    await service.order(DOC, { patientId, priority: 'routine', lines: [enoxaparin60] });
    let n = 0;
    service.onRechecked(async () => {
      n += 1;
      throw new Error('boom');
    });
    assert.deepEqual(await service.recheckPatient(patientId, 'prescription'), []);
    assert.equal(n, 0);
    await service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 5 }] });
    assert.equal(n, 1);
  });

  test('a kidney-only recheck touches only kidney flags', async () => {
    const v = await service.order(DOC, { patientId, priority: 'routine', lines: [{ medicine: 'metformin', product: 'metformin-tab-500', dose: 500, route: 'oral', frequency: 'BD', durationDays: 10 }] });
    assert.deepEqual(v.lines[0].flags.map((f) => f.key), ['kidney.unknown']);
    await kidneyReport(2.5, { labLine: 'k1' });
    const results = await service.recheckPatient(patientId, 'kidney', { kinds: ['kidney'] });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].newRed.map((f) => f.key), ['kidney.0-30']);
    const stored: any = await m.PharmacyLine.findById(v.lines[0].id).lean();
    assert.deepEqual(stored.flags.map((f: any) => f.key), ['kidney.0-30']);
  });

  test('an OPD order never starts an issue clock', async () => {
    const v = await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300] });
    assert.equal(v.setting, 'OPD');
    const id = v.lines[0].id;
    await m.PharmacyLine.updateOne({ _id: id }, { status: 'approved', checkedAt: new Date(), issueFrom: new Date() });
    const line: any = await m.PharmacyLine.findById(id).lean();
    await service.publish(v.id, [{ type: 'pharmacy.to-issue', lineId: id, dedupeKey: startKey('pharmacy.to-issue', line) }]);
    assert.equal((await sent('pharmacy.to-issue')).length, 1);
    assert.equal((await sent('pharmacy.to-issue'))[0].payload.setting, 'OPD');
    assert.equal(await m.Clock.countDocuments({ def: 'pharmacy-issue' }), 0);
    const order: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([order.issueRound, order.issueOpen, order.checkOpen], [0, false, false]);
    assert.equal((await sent('pharmacy.check-done')).length, 1, 'the check round closed');
    assert.equal((await clocksOf('pharmacy-check'))[0].state, 'met');
  });

  test('an ER order starts the issue clock when a line is approved, and closes it when nothing waits', async () => {
    await openEr();
    const v = await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300] });
    const id = v.lines[0].id;
    await m.PharmacyLine.updateOne({ _id: id }, { status: 'approved', checkedAt: new Date(), issueFrom: new Date() });
    const line: any = await m.PharmacyLine.findById(id).lean();
    await service.publish(v.id, [{ type: 'pharmacy.to-issue', lineId: id, dedupeKey: startKey('pharmacy.to-issue', line) }]);
    const [issue] = await clocksOf('pharmacy-issue');
    assert.equal(issue.ref, `${v.id}:i1`);
    assert.ok(Math.abs(new Date(issue.dueAt).getTime() - (Date.now() + 15 * MIN)) < 5_000);
    await m.PharmacyLine.updateOne({ _id: id }, { status: 'issued' });
    await service.publish(v.id, []);
    assert.equal((await sent('pharmacy.issue-done')).length, 1);
    assert.equal((await clocksOf('pharmacy-issue'))[0].state, 'met');
  });

  test('one late STAT order with three lines raises exactly one check escalation', async () => {
    await openEr();
    const v = await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300, clopidogrel300, { ...enoxaparin60, frequency: 'STAT', durationDays: undefined }] });
    assert.equal((await sent('pharmacy.to-check')).length, 3);
    assert.equal(await m.Clock.countDocuments({ def: 'pharmacy-check' }), 1);
    const back = new Date(Date.now() - 20 * MIN);
    await m.PharmacyLine.collection.updateMany({ order: new Types.ObjectId(v.id) }, { $set: { enteredCheckAt: back } });
    await m.Clock.collection.updateMany({ def: 'pharmacy-check' }, { $set: { startedAt: back, dueAt: new Date(back.getTime() + 15 * MIN) } });
    await clocks.checkDue(new Date());
    await clocks.checkDue(new Date());
    assert.equal(await m.Escalation.countDocuments({ ladder: 'pharmacy' }), 1);
    assert.equal((await clocksOf('pharmacy-check'))[0].state, 'expired');
  });

  test('a check-done for round 1 never stops the running clock of round 2', async () => {
    await openEr();
    const v = await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300] });
    const id = v.lines[0].id;
    // Round 1 closes: the line is approved.
    await m.PharmacyLine.updateOne({ _id: id }, { status: 'approved', checkedAt: new Date(), issueFrom: new Date() });
    await service.publish(v.id, []);
    let order: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([order.checkRound, order.checkOpen], [1, false]);
    assert.equal((await clocksOf('pharmacy-check'))[0].state, 'met');
    // Round 2 opens: the line goes back to To check.
    await m.PharmacyLine.updateOne({ _id: id }, { status: 'to-check', enteredCheckAt: new Date(Date.now() + 1000) });
    const line: any = await m.PharmacyLine.findById(id).lean();
    await service.publish(v.id, [{ type: 'pharmacy.to-check', lineId: id, dedupeKey: startKey('pharmacy.to-check', line) }]);
    order = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([order.checkRound, order.checkOpen], [2, true]);
    const [c1, c2] = await clocksOf('pharmacy-check');
    assert.deepEqual([c1.ref, c1.state, c2.ref, c2.state], [`${v.id}:c1`, 'met', `${v.id}:c2`, 'running']);

    // A fresh done message for round 1, and a late line message of round 1 with a far due, change nothing of round 2.
    await messages.send({ case: v.caseId, from: 'pharmacy', to: ['coordinator'], type: 'pharmacy.check-done', priority: 'high', summary: 'late', payload: { orderId: v.id, orderNumber: v.number, checkRound: 1 }, dedupeKey: `late:${new Types.ObjectId()}` });
    await messages.send({
      case: v.caseId, from: 'pharmacy', to: ['coordinator'], type: 'pharmacy.approved', priority: 'high', summary: 'late',
      payload: { orderId: v.id, orderNumber: v.number, lineId: id, medicine: 'aspirin', priority: 'stat', setting: 'ER', version: 1, checkRound: 1, checkDueAt: new Date(Date.now() + 99 * HOUR), issueRound: 0, issueDueAt: new Date() },
      dedupeKey: `late2:${new Types.ObjectId()}`,
    });
    const after = (await clocksOf('pharmacy-check'))[1];
    assert.equal(after.state, 'running');
    assert.equal(new Date(after.dueAt).getTime(), new Date(c2.dueAt).getTime());
  });

  test('the location record follows er.arrived, bed.assigned (ward name) and bed.discharged, and a new order\'s setting comes from it', async () => {
    const { case: theCase } = await cases.openOrJoin({ patientId, patientUhid, patientName: 'Ravi Kumar', kind: 'opd', priority: 'low', openedBy: 'lab' });
    const caseId = String(theCase._id);
    registry.register({
      key: 'er',
      messageTypes: [
        { type: 'er.arrived', agent: 'er', description: 'x', payload: {} },
        { type: 'er.left', agent: 'er', description: 'x', payload: {} },
      ],
      status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
    });
    registry.register({
      key: 'bed',
      messageTypes: [
        { type: 'bed.assigned', agent: 'bed', description: 'x', payload: {} },
        { type: 'bed.transferred', agent: 'bed', description: 'x', payload: {} },
        { type: 'bed.discharged', agent: 'bed', description: 'x', payload: {} },
      ],
      status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
    });
    const send = async (type: string, from: 'er' | 'bed', payload: Record<string, unknown> = {}) => {
      const msg = await messages.send({ case: caseId, from, to: ['coordinator'], type, priority: 'medium', summary: type, payload, dedupeKey: `${type}:${new Types.ObjectId()}` });
      for (const s of registry.subscribers(type).filter((x) => x.agent === 'pharmacy')) await s.handler(String(msg!._id));
    };
    const order = () => service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 1 }] });

    assert.equal((await order()).setting, 'OPD');
    await send('er.arrived', 'er');
    assert.deepEqual(await service.location(caseId), { area: 'ER' });
    assert.equal((await order()).setting, 'ER');
    await send('bed.assigned', 'bed', { ward: 'Ward 2' });
    assert.deepEqual(await service.location(caseId), { area: 'Ward', ward: 'Ward 2' });
    const ward = await order();
    assert.deepEqual([ward.setting, ward.ward], ['Ward', 'Ward 2']);
    assert.equal(ward.lines[0].defaultStore, 'main');
    await send('er.left', 'er', { reason: 'admitted' });
    assert.deepEqual(await service.location(caseId), { area: 'Ward', ward: 'Ward 2' }, 'admitted is not a move home');
    await send('bed.discharged', 'bed');
    assert.deepEqual(await service.location(caseId), { area: 'OPD' });
  });

  test('reads: worklists, lines for a patient and the order list', async () => {
    const v = await service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 2 }] });
    const stat = await service.order(DOC, { patientId, priority: 'stat', lines: [clopidogrel300] });
    const check = await service.worklist('check');
    assert.deepEqual(check.map((l) => l.orderNumber), [stat.number, v.number], 'STAT first');
    assert.equal(check[0].patient.name, 'Ravi Kumar');
    assert.equal(check[0].medicineLabel, 'Clopidogrel');
    assert.equal(check[0].productLabel, 'Clopidogrel tab 75 mg');
    assert.ok(check[0].checkDueAt && check[0].issueDueAt === null);
    assert.deepEqual(await service.worklist('issue'), []);
    assert.deepEqual(await service.worklist('queries'), []);
    assert.equal((await service.linesForPatient(patientId)).length, 2);
    assert.equal((await service.linesForPatient(patientId, new Date(Date.now() + HOUR).toISOString())).length, 0);
    assert.equal((await service.list({ search: 'mo-0002' })).length, 1);
    assert.equal((await service.list({ search: 'Ravi' })).length, 2);
    assert.equal((await service.list({ status: 'approved' })).length, 0);
    assert.equal((await service.list({ setting: 'ER' })).length, 0);
    assert.equal((await service.line(check[0].id)).id, check[0].id);
    await assert.rejects(() => service.line('nope'), { status: 404 });
    await assert.rejects(() => service.get(String(new Types.ObjectId())), { status: 404 });
  });

  test('a publish that loses the round guard to a concurrent close re-reads and opens round 2 in the same call', async () => {
    await openEr();
    const v = await service.order(DOC, { patientId, priority: 'stat', lines: [aspirin300] });
    const first: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([first.checkRound, first.checkOpen], [1, true]);
    // A due that differs, so publish tries to move round 1's due ...
    await m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(v.id) }, { $set: { checkDueAt: new Date(Date.now() + 5 * MIN) } });
    // ... and a concurrent caller closes the round between the read and that write.
    const model: any = m.PharmacyOrder;
    const original = model.updateOne;
    model.updateOne = (...args: unknown[]) => {
      model.updateOne = original;
      return { exec: () => m.PharmacyOrder.collection.updateOne({ _id: new Types.ObjectId(v.id) }, { $set: { checkOpen: false } }).then(() => original.apply(model, args).exec()) };
    };
    try {
      await m.PharmacyLine.updateOne({ _id: v.lines[0].id }, { enteredCheckAt: new Date(Date.now() + 1000) });
      const fresh: any = await m.PharmacyLine.findById(v.lines[0].id).lean();
      await service.publish(v.id, [{ type: 'pharmacy.to-check', lineId: v.lines[0].id, dedupeKey: startKey('pharmacy.to-check', fresh) }]);
    } finally {
      model.updateOne = original;
    }
    const order: any = await m.PharmacyOrder.findById(v.id).lean();
    assert.deepEqual([order.checkRound, order.checkOpen], [2, true], 'the waiting line has an open round');
    const msgs = await sent('pharmacy.to-check');
    assert.equal(msgs[msgs.length - 1].payload.checkRound, 2);
    assert.ok((await clocksOf('pharmacy-check')).some((c) => c.ref === `${v.id}:c2` && c.state === 'running'));
  });

  test('the check worklist sorts STAT first, then red, then oldest, in the database: a STAT line is never dropped past the limit', async () => {
    const routine = await service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 1 }] });
    const old = new Date(Date.now() - 5 * HOUR);
    await m.PharmacyLine.insertMany(
      Array.from({ length: 301 }, () => ({ order: routine.id, patient: patientId, medicine: 'aspirin', product: 'aspirin-tab-300', dose: 300, unit: 'mg', route: 'oral', frequency: 'OD', durationDays: 1, status: 'to-check', enteredCheckAt: old, flags: [] })),
    );
    const stat = await service.order(DOC, { patientId, priority: 'stat', lines: [clopidogrel300] });
    const list = await service.worklist('check');
    assert.equal(list.length, 300);
    assert.equal(list[0].orderNumber, stat.number);
    // Red before non-red among the rest.
    await m.PharmacyLine.updateOne({ order: routine.id, status: 'to-check', _id: { $ne: routine.lines[0].id } }, { flags: [{ key: 'dose.single', kind: 'dose', severity: 'red', text: 'x', version: 1 }] });
    const again = await service.worklist('check');
    assert.equal(again[0].orderNumber, stat.number);
    assert.ok(again[1].flags.some((f) => f.severity === 'red'));
  });

  test('order() leaves no empty order behind when adding the lines fails', async () => {
    const model: any = m.PharmacyLine;
    const original = model.create;
    model.create = async () => {
      throw new Error('disk full');
    };
    try {
      await assert.rejects(() => service.order(DOC, { patientId, priority: 'routine', lines: [{ ...aspirin300, frequency: 'OD', durationDays: 1 }] }), /disk full/);
    } finally {
      model.create = original;
    }
    assert.equal(await m.PharmacyOrder.countDocuments(), 0);
    assert.equal(await m.PharmacyLine.countDocuments(), 0);
    assert.equal((await sent('pharmacy.ordered')).length, 0);
  });
});
