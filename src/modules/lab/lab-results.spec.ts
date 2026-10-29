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
import type { LabAiService, LabSummaryResult } from './lab-ai';
import { LabBenchService } from './lab-bench.service';
import { LabResultsService } from './lab-results.service';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import { LabOrdersService } from './lab-orders.service';
import { LabSettingsService } from './lab-settings.service';
import { SettingsService } from '../settings/settings.service';

const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Anita', role: UserRole.NURSE };
const LAB: Actor = { id: 'user-lab', name: 'Meera', role: UserRole.LAB };
const PATH: Actor = { id: 'user-path', name: 'Dr. Meera Nair', role: UserRole.LAB };
const ADMIN: Actor = { id: 'user-admin', name: 'Admin', role: UserRole.ADMIN };
const MIN = 60_000;
/** Each test sets what the AI does; by default it never answers. */
let aiImpl: (lineId: string) => Promise<LabSummaryResult> = () => new Promise(() => {});
const noAi = { summarise: (id: string) => aiImpl(id) } as unknown as LabAiService;

describe('LabResultsService', () => {
  const m = models();
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let escalations: EscalationsService;
  let orders: LabOrdersService;
  let bench: LabBenchService;
  let results: LabResultsService;
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
    aiImpl = () => new Promise(() => {});
    await resetTestDb();
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    orders = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)), m.LabTestReport);
    new LabCoordinatorRegistration(registry, orders, messages, m.LabRequest, m.LabLine).onModuleInit();
    bench = new LabBenchService(m.LabRequest, m.LabLine, m.LabSample, orders, messages);
    results = new LabResultsService(m.LabRequest, m.LabLine, m.LabTestReport, m.TaskAlertItem, orders, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)), noAi, m.Clock);
    const p = await m.Patient.create({ uhid: 'MHK202600901', name: 'Ravi Kumar', age: 52, gender: 'Male', phone: '9100000001' });
    patientId = String(p._id);
  });

  /** Order, collect and receive every sample; returns the request view and a line lookup. */
  const received = async (tests: string[], priority: 'stat' | 'urgent' | 'routine' = 'stat') => {
    const r = await order(tests, priority);
    for (const s of r.samples) {
      await bench.collect(NURSE, s.number);
      await bench.receive(LAB, s.id);
    }
    const lineId = (test: string) => r.lines.find((l) => l.test === test)!.id;
    return { r, lineId };
  };
  const line = (id: string) => m.LabLine.findById(id).lean().exec() as Promise<any>;
  const alerts = () => m.TaskAlertItem.find({ type: 'Lab Alert' }).lean().exec() as Promise<any[]>;
  const K = { Sodium: 140, Potassium: 6.4 };
  const NORMAL = { Sodium: 140, Potassium: 4.2 };

  test('entering potassium 6.4 flags it high and critical', async () => {
    const { lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), K);
    const l = await line(lineId('electrolytes'));
    assert.equal(l.status, 'awaiting-validation');
    assert.deepEqual(l.enteredBy, { id: 'user-lab', name: 'Meera' });
    assert.ok(l.enteredAt);
    const k = l.results.find((x: any) => x.param === 'Potassium');
    assert.deepEqual(k, { param: 'Potassium', value: 6.4, unit: 'mmol/L', flag: 'high', critical: true });
    assert.equal(l.results.find((x: any) => x.param === 'Sodium').flag, 'normal');
    assert.equal((await sent('lab.resulted')).length, 0, 'nothing is announced before release');
  });

  test('entering needs every parameter, no unknown ones, and a received line', async () => {
    const { lineId } = await received(['electrolytes']);
    await assert.rejects(() => results.enterResults(LAB, lineId('electrolytes'), { Sodium: 140 }), { status: 400 });
    await assert.rejects(() => results.enterResults(LAB, lineId('electrolytes'), { ...NORMAL, Calcium: 9 }), { status: 400 });
    await assert.rejects(() => results.enterResults(LAB, lineId('electrolytes'), { Sodium: 'x', Potassium: 4 }), { status: 400 });
    await results.enterResults(LAB, lineId('electrolytes'), NORMAL);
    await assert.rejects(() => results.enterResults(LAB, lineId('electrolytes'), NORMAL), { status: 409 });
    const fresh = await order(['crp']);
    await assert.rejects(() => results.enterResults(LAB, fresh.lines[0].id, { CRP: 2 }), { status: 409 });
  });

  test("the person who entered can't release; the pathologist can", async () => {
    const { lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), NORMAL);
    await assert.rejects(() => results.release(LAB, lineId('electrolytes')), { status: 403, message: 'Someone else must validate this result.' });
    assert.equal((await line(lineId('electrolytes'))).status, 'awaiting-validation');
    await results.release(PATH, lineId('electrolytes'));
    const l = await line(lineId('electrolytes'));
    assert.equal(l.status, 'released');
    assert.equal(l.version, 1);
    assert.deepEqual(l.validatedBy, { id: 'user-path', name: 'Dr. Meera Nair' });
    assert.equal(l.history.length, 1);
    // an admin who entered the result is bound too
    const b = await received(['crp']);
    await results.enterResults(ADMIN, b.lineId('crp'), { CRP: 3 });
    await assert.rejects(() => results.release(ADMIN, b.lineId('crp')), { status: 403 });
  });

  test('release writes a LabTestReport the Lab Reports list returns', async () => {
    const { r, lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), K);
    assert.equal(await m.LabTestReport.countDocuments(), 0, 'nothing reaches the report before release');
    await results.release(PATH, lineId('electrolytes'));
    const reports = (await m.LabTestReport.find({ uhid: 'MHK202600901' }).lean()) as any[];
    assert.equal(reports.length, 1);
    const rep = reports[0];
    assert.equal(rep.testName, 'Electrolytes');
    assert.equal(rep.category, 'Biochemistry');
    assert.equal(rep.status, 'Abnormal');
    assert.equal(rep.labLine, lineId('electrolytes'));
    assert.ok(!rep.amended);
    assert.ok(rep.date && rep.time);
    const k = rep.groups[0].parameters.find((p: any) => p.name === 'Potassium');
    assert.deepEqual({ ...k, _id: undefined }, { _id: undefined, name: 'Potassium', result: 6.4, referenceRange: '3.5–5.1', unit: 'mmol/L', status: 'High', critical: true });
    assert.equal(String((await line(lineId('electrolytes'))).reportId), String(rep._id));
    const [msg] = await sent('lab.resulted');
    assert.equal(msg.payload.flag, 'critical');
    assert.equal(msg.payload.version, 1);
    assert.equal(msg.payload.lineId, lineId('electrolytes'));
    assert.ok(!msg.summary.includes('Ravi') && msg.summary.includes(r.number));
    const { LabReportsService } = await import('../lab-reports/lab-reports.service');
    const listed = await new LabReportsService(m.LabTestReport).findAll({ uhid: 'MHK202600901' });
    assert.equal(listed.length, 1);
  });

  test('a released normal result has no critical flag and no alert', async () => {
    const { lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), NORMAL);
    await results.release(PATH, lineId('electrolytes'));
    assert.equal((await line(lineId('electrolytes'))).critical.active, false);
    assert.equal((await alerts()).length, 0);
    assert.equal((await sent('lab.critical')).length, 0);
    assert.equal(((await m.LabTestReport.findOne().lean()) as any).status, 'Completed');
    assert.equal((await sent('lab.resulted'))[0].payload.flag, 'normal');
  });

  test('a critical release starts the 15-minute acknowledgement clock and makes one alert; acknowledging stops it', async () => {
    const { r, lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    await results.enterResults(LAB, id, { Sodium: 118, Potassium: 6.4 });
    await results.release(PATH, id);
    const crit = await sent('lab.critical');
    assert.equal(crit.length, 2, 'one per critical parameter');
    const k = crit.find((c) => c.payload.parameter === 'Potassium');
    assert.deepEqual(k.payload, { requestId: r.id, requestNumber: r.number, lineId: id, test: 'electrolytes', parameter: 'Potassium', value: '6.4', unit: 'mmol/L', version: 1 });
    assert.ok(!k.summary.includes('Ravi'));
    const clocks1 = await clockOf('lab-critical', String((await m.LabRequest.findById(r.id).lean() as any).case));
    assert.equal(clocks1.length, 1, 'one clock for the line');
    assert.equal(clocks1[0].state, 'running');
    const mins = (clocks1[0].dueAt.getTime() - clocks1[0].startedAt.getTime()) / MIN;
    assert.ok(Math.abs(mins - 15) < 1);
    const a = await alerts();
    assert.equal(a.length, 1);
    assert.equal(a[0].category, 'Critical');
    assert.equal(a[0].priority, 'High');
    assert.equal(a[0].link, `lab-line:${id}`);
    assert.equal(a[0].title, 'Critical: Electrolytes Sodium 118 mmol/L');
    assert.equal(a[0].subtitle, 'For Dr. Shajin · acknowledge within 15 min');
    assert.equal(a[0].uhid, 'MHK202600901');
    assert.equal(a[0].patientName, 'Ravi Kumar');

    await results.acknowledge(DOC, id, 'Informed ward, repeating');
    const l = await line(id);
    assert.equal(l.critical.ackBy, 'Dr. Shajin');
    assert.ok(l.critical.ackAt);
    assert.equal(l.critical.ackNote, 'Informed ward, repeating');
    assert.equal((await alerts())[0].status, 'Completed');
    assert.deepEqual((await sent('lab.critical-acked'))[0].payload, { lineId: id });
    const after = await clockOf('lab-critical', String((await m.LabRequest.findById(r.id).lean() as any).case));
    assert.notEqual(after[0].state, 'running');
    await assert.rejects(() => results.acknowledge(DOC, id), { status: 409, message: 'Nothing to acknowledge.' });
  });

  test('nobody acknowledging escalates on lab-critical to the duty doctor', async () => {
    const { r, lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), K);
    await results.release(PATH, lineId('electrolytes'));
    const caseId = String(((await m.LabRequest.findById(r.id).lean()) as any).case);
    await backdateClock('lab-critical', caseId, 1);
    assert.equal(await escalationsOn('lab-critical'), 0);
    await clocks.checkDue(new Date());
    assert.equal(await escalationsOn('lab-critical'), 1);
    const e = (await m.Escalation.findOne({ ladder: 'lab-critical' }).lean()) as any;
    assert.equal(e.step, 0);
  });

  test('an overdue critical escalates on its own alert with the result in the text; only acknowledging the result closes it', async () => {
    const { r, lineId } = await received(['troponin']);
    const id = lineId('troponin');
    await results.enterResults(LAB, id, { 'Troponin I': 0.5 });
    await results.release(PATH, id);
    const caseId = String(((await m.LabRequest.findById(r.id).lean()) as any).case);
    assert.equal((await clockOf('lab-critical', caseId))[0].detail, `${r.number} · Troponin I`);
    await backdateClock('lab-critical', caseId, 1);
    await clocks.checkDue(new Date());
    const e = (await m.Escalation.findOne({ ladder: 'lab-critical' }).lean()) as any;
    assert.equal(e.reason, `Critical result acknowledgement overdue — ${r.number} · Troponin I`);
    assert.ok(!e.reason.includes('Ravi'));
    // One alert for the line: the escalation takes over the critical result's alert.
    const all = (await m.TaskAlertItem.find().lean()) as any[];
    assert.equal(all.length, 1);
    assert.equal(String(all[0]._id), String(e.alert));
    assert.equal(all[0].link, `lab-line:${id}`);
    assert.equal(all[0].title, `Escalated to Duty doctor: Critical result acknowledgement overdue — ${r.number} · Troponin I`);
    assert.equal(all[0].escalation.id, String(e._id));
    assert.equal(all[0].status, 'Pending');
    // Acknowledging the escalation itself is refused, for an admin too.
    await assert.rejects(() => escalations.acknowledge(ADMIN, String(e._id)), {
      status: 409,
      message: 'Acknowledge the result on the Lab page; this alert closes when it is acknowledged.',
    });
    assert.equal(((await m.Escalation.findById(e._id).lean()) as any).state, 'open');
    // Acknowledging the result closes the escalation and completes its alert.
    await results.acknowledge(DOC, id, 'Seen');
    const closed = (await m.Escalation.findById(e._id).lean()) as any;
    assert.equal(closed.state, 'acknowledged');
    assert.equal(closed.ackByName, 'Result acknowledged');
    assert.equal(((await m.TaskAlertItem.findById(e.alert).lean()) as any).status, 'Completed');
    const clock = (await clockOf('lab-critical', caseId))[0];
    assert.equal(clock.state, 'expired');
    assert.ok(clock.stoppedAt);
  });

  test('lab clocks carry a short detail: the request number and tests (and the critical parameter), never a name', async () => {
    const { r, lineId } = await received(['cbc', 'rft'], 'urgent');
    const caseId = String(((await m.LabRequest.findById(r.id).lean()) as any).case);
    assert.equal((await clockOf('lab-collect', caseId))[0].detail, `${r.number} · Complete blood count, Kidney function`);
    assert.equal((await clockOf('lab-tat', caseId))[0].detail, `${r.number} · Complete blood count, Kidney function`);
    await results.enterResults(LAB, lineId('cbc'), { Haemoglobin: 6.1, WBC: 7, Platelets: 250 });
    await results.release(PATH, lineId('cbc'));
    assert.equal((await clockOf('lab-critical', caseId))[0].detail, `${r.number} · Complete blood count · Haemoglobin`);
    const edta = r.samples.find((s) => s.tube === 'edta')!;
    const serum = r.samples.find((s) => s.tube === 'serum')!;
    await bench.reject(LAB, serum.id, 'haemolysed');
    assert.equal((await clockOf('lab-recollect', caseId))[0].detail, `${r.number} · Kidney function`);
    assert.ok(edta);
    const details = (await m.Clock.find().lean()).map((c: any) => c.detail ?? '').join(' ');
    assert.ok(!details.includes('Ravi'));
  });

  test('release raises the critical before writing the report: a report failure leaves the critical announced and alerted', async () => {
    const { lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    await results.enterResults(LAB, id, K);
    const real = (results as any).reports;
    (results as any).reports = { findByIdAndUpdate: real.findByIdAndUpdate.bind(real), create: async () => { throw new Error('disk full'); } };
    await assert.rejects(() => results.release(PATH, id), /disk full/);
    (results as any).reports = real;
    assert.equal((await line(id)).status, 'released');
    assert.equal((await sent('lab.critical')).length, 1);
    assert.equal((await alerts()).length, 1);
    assert.equal((await sent('lab.resulted')).length, 0, 'the report and lab.resulted come after');
  });

  test('blood culture: "No growth" is normal, "Growth" is critical, and free text is refused with the options', async () => {
    const { lineId } = await received(['blood-culture']);
    const id = lineId('blood-culture');
    await assert.rejects(() => results.enterResults(LAB, id, { Result: 'No growth after 48 hours' }), {
      status: 400,
      message: 'Result must be one of: No growth, Growth',
    });
    await assert.rejects(() => results.enterResults(LAB, id, { Result: 'Growth' }, { Result: 'x'.repeat(201) }), { status: 400 });
    await results.enterResults(LAB, id, { Result: 'growth' }, { Result: '  E. coli ' });
    const row = (await line(id)).results[0];
    assert.deepEqual(row, { param: 'Result', value: 'Growth', unit: '', flag: 'abnormal', critical: true, comment: 'E. coli' });
    await results.release(PATH, id);
    const [crit] = await sent('lab.critical');
    assert.equal(crit.payload.value, 'Growth');
    // The organism is on the report next to the value, and in no message.
    const report: any = await m.LabTestReport.findOne({ labLine: id }).lean();
    assert.equal(report.groups[0].parameters[0].result, 'Growth');
    assert.equal(report.groups[0].parameters[0].comment, 'E. coli');
    assert.equal(report.groups[0].parameters[0].referenceRange, 'No growth');
    const all = JSON.stringify(await m.AgentMessage.find().lean());
    assert.ok(!all.includes('E. coli'));

    const other = await received(['blood-culture']);
    await results.enterResults(LAB, other.lineId('blood-culture'), { Result: 'No growth' });
    assert.deepEqual((await line(other.lineId('blood-culture'))).results[0], { param: 'Result', value: 'No growth', unit: '', flag: 'normal', critical: false });
  });

  test('urine "Absent" is stored as Nil and is normal; a comment goes only on a text parameter', async () => {
    const { lineId } = await received(['urine']);
    const id = lineId('urine');
    const values = { Protein: 'Absent', Sugar: 'negative', 'Pus cells': 2, RBC: 1 };
    await assert.rejects(() => results.enterResults(LAB, id, values, { 'Pus cells': 'clumps' }), { status: 400 });
    await assert.rejects(() => results.enterResults(LAB, id, values, { Result: 'x' }), { status: 400 });
    await results.enterResults(LAB, id, values, { Protein: '' });
    const rows = (await line(id)).results;
    assert.deepEqual(rows.slice(0, 2), [
      { param: 'Protein', value: 'Nil', unit: '', flag: 'normal', critical: false },
      { param: 'Sugar', value: 'Nil', unit: '', flag: 'normal', critical: false },
    ]);
    await results.release(PATH, id);
    // An amendment takes options and comments too.
    await assert.rejects(() => results.amend(LAB, id, { ...values, Protein: 'some' }, 'recheck'), { status: 400, message: 'Protein must be one of: Nil, Trace, 1+, 2+, 3+, 4+' });
    await results.amend(LAB, id, { ...values, Protein: '2+' }, 'recheck', { Protein: 'Repeat on a fresh sample' });
    const amended = (await line(id)).results[0];
    assert.deepEqual(amended, { param: 'Protein', value: '2+', unit: '', flag: 'abnormal', critical: false, comment: 'Repeat on a fresh sample' });
  });

  test('acknowledging a non-critical line is refused', async () => {
    const { lineId } = await received(['crp']);
    await results.enterResults(LAB, lineId('crp'), { CRP: 2 });
    await results.release(PATH, lineId('crp'));
    await assert.rejects(() => results.acknowledge(DOC, lineId('crp')), { status: 409 });
  });

  test('send back returns the line for re-entry with the reason', async () => {
    const { lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    await results.enterResults(LAB, id, K);
    await assert.rejects(() => results.sendBack(PATH, id, '  '), { status: 400 });
    await results.sendBack(PATH, id, 'Potassium looks haemolysed, recheck');
    const l = await line(id);
    assert.equal(l.status, 'received');
    assert.deepEqual(l.results, []);
    assert.equal(l.sentBack.reason, 'Potassium looks haemolysed, recheck');
    assert.equal(l.sentBack.by, 'Dr. Meera Nair');
    await assert.rejects(() => results.sendBack(PATH, id, 'again'), { status: 409 });
    await results.enterResults(LAB, id, NORMAL);
    const again = await line(id);
    assert.equal(again.status, 'awaiting-validation');
    assert.equal(again.sentBack, undefined, 're-entry clears the send-back note');
  });

  test('amending a released normal result to a critical one starts a new acknowledgement and the report is marked amended', async () => {
    const { r, lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    await results.enterResults(LAB, id, NORMAL);
    await results.release(PATH, id);
    const caseId = String(((await m.LabRequest.findById(r.id).lean()) as any).case);
    await assert.rejects(() => results.amend(LAB, id, K, ' '), { status: 400 });
    const other = await received(['crp']);
    await assert.rejects(() => results.amend(LAB, other.lineId('crp'), { CRP: 1 }, 'typo'), { status: 409 });
    await results.amend(LAB, id, K, 'Transcription error');
    let l = await line(id);
    assert.equal(l.status, 'awaiting-validation');
    assert.equal(l.version, 1);
    assert.equal((await sent('lab.critical')).length, 0, 'nothing is critical until released');
    await assert.rejects(() => results.release(LAB, id), { status: 403 });
    await results.release(PATH, id);
    l = await line(id);
    assert.equal(l.version, 2);
    assert.equal(l.history.length, 2);
    assert.equal(l.history[1].amendReason, 'Transcription error');
    assert.equal(l.history[0].amendReason, undefined);
    assert.equal(l.pendingAmendReason, undefined);
    assert.deepEqual(l.critical, { active: true });
    const rep = (await m.LabTestReport.find().lean()) as any[];
    assert.equal(rep.length, 1, 'the same report is updated');
    assert.equal(rep[0].amended, true);
    assert.equal(rep[0].status, 'Abnormal');
    const crit = await sent('lab.critical');
    assert.equal(crit.length, 1);
    assert.equal(crit[0].payload.version, 2);
    assert.equal((await sent('lab.resulted')).length, 2);
    assert.equal((await alerts()).length, 1);
    assert.equal((await alerts())[0].status, 'Pending');
    const clock = await clockOf('lab-critical', caseId);
    assert.ok(clock.some((c) => c.state === 'running'));
    await results.acknowledge(DOC, id);
    assert.ok((await line(id)).critical.ackAt);
    // a second amendment to critical clears the earlier acknowledgement
    await results.amend(LAB, id, { Sodium: 140, Potassium: 2.5 }, 'Re-run');
    await results.release(PATH, id);
    assert.deepEqual((await line(id)).critical, { active: true });
    assert.equal((await alerts())[0].status, 'Pending');
    assert.equal((await alerts()).length, 1);
    // the first clock stayed stopped; a fresh one runs for the same line
    const all = await clockOf('lab-critical', caseId);
    assert.equal(all.length, 2);
    assert.equal(all.filter((c) => c.state === 'running').length, 1);
    assert.equal(all.filter((c) => c.state !== 'running').length, 1);
    assert.ok(all.every((c) => c.ref === id));
  });

  test('amending a critical result down to normal still needs acknowledging', async () => {
    const { r, lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    const caseId = String(((await m.LabRequest.findById(r.id).lean()) as any).case);
    await results.enterResults(LAB, id, K);
    await results.release(PATH, id);
    await results.amend(LAB, id, NORMAL, 'Wrong sample value');
    await results.release(PATH, id);
    const l = await line(id);
    assert.equal(l.critical.active, true);
    assert.equal(l.critical.ackAt, undefined);
    const [a] = await alerts();
    assert.equal(a.status, 'Pending');
    assert.equal(a.title, 'Critical (amended): Electrolytes \u2014 acknowledge the correction');
    assert.ok(a.subtitle.startsWith('Was Potassium 6.4 mmol/L; now Sodium 140, Potassium 4.2'));
    assert.ok(a.subtitle.endsWith('For Dr. Shajin'));
    assert.equal((await clockOf('lab-critical', caseId))[0].state, 'running');
    await results.acknowledge(DOC, id);
    assert.equal((await clockOf('lab-critical', caseId))[0].state, 'met');
    assert.equal((await alerts())[0].status, 'Completed');
  });

  test('amending an acknowledged critical to normal leaves nothing to acknowledge', async () => {
    const { lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    await results.enterResults(LAB, id, K);
    await results.release(PATH, id);
    await results.acknowledge(DOC, id);
    await results.amend(LAB, id, NORMAL, 'fix');
    await results.release(PATH, id);
    assert.equal((await line(id)).critical.active, false);
    assert.equal((await alerts())[0].status, 'Completed');
  });

  test('sending back an amendment restores the released result', async () => {
    const { lineId } = await received(['electrolytes']);
    const id = lineId('electrolytes');
    await results.enterResults(LAB, id, NORMAL);
    await results.release(PATH, id);
    await results.amend(LAB, id, K, 'oops');
    await results.sendBack(PATH, id, 'not convinced');
    const l = await line(id);
    assert.equal(l.status, 'released');
    assert.equal(l.version, 1);
    assert.equal(l.results.find((x: any) => x.param === 'Potassium').value, 4.2);
    assert.equal(l.pendingAmendReason, undefined);
    assert.equal(l.sentBack, undefined);
    assert.equal(l.enteredBy.id, 'user-lab');
    assert.equal(l.enteredAt.getTime(), l.history[0].enteredAt.getTime());
  });

  test('releasing the last open line sends lab.request-done and stops the turnaround clock', async () => {
    const { r, lineId } = await received(['electrolytes', 'crp']);
    const caseId = String(((await m.LabRequest.findById(r.id).lean()) as any).case);
    await results.enterResults(LAB, lineId('crp'), { CRP: 2 });
    await results.release(PATH, lineId('crp'));
    assert.equal((await sent('lab.request-done')).length, 0);
    const resulted = (await sent('lab.resulted'))[0];
    const open = (await line(lineId('electrolytes'))).tatDueAt;
    assert.equal(new Date(resulted.payload.tatDueAt).getTime(), open.getTime(), 'the earliest still-open line');
    // The turnaround clock follows escalateAt: the later of that due and the first receipt plus its target.
    const req: any = await m.LabRequest.findById(r.id).lean();
    const target = Math.round((open.getTime() - req.createdAt.getTime()) / MIN) * MIN;
    assert.equal(new Date(resulted.payload.escalateAt).getTime(), Math.max(open.getTime(), req.firstReceivedAt.getTime() + target));
    assert.equal((await clockOf('lab-tat', caseId))[0].dueAt.getTime(), new Date(resulted.payload.escalateAt).getTime());
    await results.enterResults(LAB, lineId('electrolytes'), NORMAL);
    await results.release(PATH, lineId('electrolytes'));
    assert.equal((await sent('lab.request-done')).length, 1);
    const tat = await clockOf('lab-tat', caseId);
    assert.ok(tat.length > 0 && tat.every((c) => c.state !== 'running'));
    // amending later never reopens or re-announces
    await results.amend(LAB, lineId('crp'), { CRP: 9 }, 'recheck');
    await results.release(PATH, lineId('crp'));
    assert.equal((await sent('lab.request-done')).length, 1);
  });
  test('release returns before the AI answers, and the report already holds the template summary', async () => {
    const { lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), K);
    let asked = 0;
    aiImpl = () => {
      asked++;
      return new Promise(() => {});
    };
    await results.release(PATH, lineId('electrolytes'));
    assert.equal(asked, 1);
    const report: any = await m.LabTestReport.findOne({ labLine: lineId('electrolytes') }).lean();
    assert.deepEqual(report.aiSummary.findings, ['Potassium 6.4 mmol/L — high (critical)']);
    assert.equal(report.aiSummary.interpretation, '1 value(s) outside the reference range; 1 critical.');
    assert.equal(report.aiSummary.sample, false);
  });

  test('a valid AI summary replaces the template on the report', async () => {
    const { lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), K);
    aiImpl = async () => ({ findings: ['Potassium is high.'], interpretation: 'Raised potassium.', recommendations: ['Repeat the test.'], sample: true });
    await results.release(PATH, lineId('electrolytes'));
    for (let i = 0; i < 50; i++) {
      const r: any = await m.LabTestReport.findOne({ labLine: lineId('electrolytes') }).lean();
      if (r.aiSummary.interpretation === 'Raised potassium.') break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    const report: any = await m.LabTestReport.findOne({ labLine: lineId('electrolytes') }).lean();
    assert.deepEqual({ ...report.aiSummary, _id: undefined }.findings, ['Potassium is high.']);
    assert.equal(report.aiSummary.interpretation, 'Raised potassium.');
    assert.equal(report.aiSummary.sample, true);
  });

  test('an AI failure leaves the template and does not fail the release', async () => {
    const { lineId } = await received(['electrolytes']);
    await results.enterResults(LAB, lineId('electrolytes'), K);
    aiImpl = async () => {
      throw new Error('down');
    };
    await results.release(PATH, lineId('electrolytes'));
    await new Promise((ok) => setTimeout(ok, 50));
    const report: any = await m.LabTestReport.findOne({ labLine: lineId('electrolytes') }).lean();
    assert.equal(report.aiSummary.findings[0], 'Potassium 6.4 mmol/L — high (critical)');
  });
});
