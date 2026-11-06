import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiService } from '../ai/ai.service';
import { AiProviderName, AiResult, StructuredTask } from '../ai/ai-types';
import { AgentRegistry } from '../coordinator/agent-registry';
import { ApprovalsService } from '../coordinator/approvals.service';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import { BedAgentService } from './bed-agent.service';
import { BedAiOutput } from './bed-ai-task';
import { BedAlerts } from './bed-alerts';
import { BedCoordinatorBridge } from './bed-coordinator.bridge';
import { BedEvents } from './bed-events';
import { buildBedSeed } from './bed-layout';
import { BedRequestsService, CreateBedRequestInput } from './bed-requests.service';
import { BedsService } from './beds.service';
import { SuggestionsService } from './suggestions.service';

const DOCTOR: Actor = { id: 'user-doctor', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const MIN = 60_000;

/** Answers as sample mode does, from the task's own keyword check. */
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

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('BedCoordinatorBridge', () => {
  const m = models();
  const { Ward, Bed, Admission, BedSuggestion, Patient, BedRequest, TaskAlertItem, HospitalSettings } = m;
  let events: BedEvents;
  let beds: BedsService;
  let requests: BedRequestsService;
  let agent: BedAgentService;
  let bridge: BedCoordinatorBridge;
  let messages: MessagesService;
  let cases: CasesService;
  let clocks: ClocksService;
  let escalations: EscalationsService;
  let approvals: ApprovalsService;
  let bedIds: Map<string, string>;
  let patientCount: number;
  let names: string[];

  const bed = (code: string) => bedIds.get(code)!;
  const patient = async (name?: string) => {
    patientCount++;
    const n = name ?? `Patient Number${patientCount}`;
    names.push(n);
    const created = await Patient.create({
      uhid: `MHK2026007${String(patientCount).padStart(2, '0')}`,
      name: n,
      age: 45,
      gender: 'Male',
      phone: `90000007${String(patientCount).padStart(2, '0')}`,
    });
    return { id: String(created._id), uhid: created.uhid };
  };
  const ask = async (over: Partial<CreateBedRequestInput> & { patientId: string }) =>
    String(
      (
        await requests.create(DOCTOR, {
          type: 'admission',
          roomClass: 'general',
          needs: [],
          notes: 'Fever for three days',
          department: 'General Medicine',
          doctor: 'Dr. Shajin',
          expectedStayDays: 3,
          priority: 'high',
          ...over,
        })
      )._id,
    );
  const fillGeneralMen = async () => {
    const wardA = await Ward.findOne({ code: 'GWA' }).lean().exec();
    await Bed.updateMany({ ward: wardA._id, state: 'free' }, { state: 'occupied', occupantGender: 'Male' }).exec();
  };
  const freeGeneralMen = async () => {
    const wardA = await Ward.findOne({ code: 'GWA' }).lean().exec();
    await Bed.updateMany({ ward: wardA._id, state: 'occupied', admission: null }, { state: 'free', $unset: { occupantGender: 1 } }).exec();
  };
  const all = (type?: string) => m.AgentMessage.find(type ? { type } : {}).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const seed = buildBedSeed();
    const wards = await Ward.insertMany(seed.wards);
    const wardId = new Map(wards.map((w) => [w.code, w._id]));
    const inserted = await Bed.insertMany(
      seed.beds.map(({ wardCode, namedPatientUhid: _uhid, ...b }) => ({ ...b, ward: wardId.get(wardCode) })),
    );
    bedIds = new Map(inserted.map((b, i) => [`${seed.beds[i].wardCode}-${seed.beds[i].number}`, String(b._id)]));
    patientCount = 0;
    names = [];

    events = new BedEvents();
    const patients = new PatientsService(Patient);
    beds = new BedsService(Ward, Bed, Admission, patients, events, m.DischargeOrder);
    requests = new BedRequestsService(BedRequest, patients, beds, new BedAlerts(TaskAlertItem), events);
    const suggestions = new SuggestionsService(BedSuggestion, beds, patients, fakeAi() as unknown as AiService);
    agent = new BedAgentService(requests, suggestions, beds, new SettingsService(HospitalSettings), events);

    const registry = new AgentRegistry();
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, TaskAlertItem, m.User, messages, new CoordinatorEvents());
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, new CoordinatorEvents());
    bridge = new BedCoordinatorBridge(events, requests, registry, messages, cases, approvals, Admission, BedRequest, Bed, Ward);
    bridge.onModuleInit();
  });

  const noNames = async () => {
    const rows = await all();
    const everything = JSON.stringify([
      rows,
      await m.Approval.find().lean(),
      await m.Escalation.find().lean(),
      await TaskAlertItem.find({ link: { $not: /^bed-request:/ } }).lean(),
    ]);
    for (const n of names) assert.ok(!everything.includes(n), `a message, approval, escalation or alert leaked the name ${n}`);
  };

  test('a new bed request opens a case and sends bed.request', async () => {
    const p = await patient();
    const id = await ask({ patientId: p.id });
    await bridge.idle();

    const c: any = await m.Case.findOne().lean();
    assert.equal(c.kind, 'ipd');
    assert.equal(c.openedBy, 'bed');
    assert.equal(c.priority, 'high');
    assert.equal(c.state, 'open');
    assert.deepEqual(c.refs.bedRequestIds, [id]);

    const sent = await all('bed.request');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opensWork, true);
    assert.equal(String(sent[0].case), String(c._id));
    assert.equal(sent[0].payload.requestId, id);
    assert.ok(sent[0].summary.includes(p.uhid));
    await noNames();
  });

  test('a second request or an Admit here for the same patient joins the same case', async () => {
    const p = await patient();
    const first = await ask({ patientId: p.id });
    await bridge.idle();

    // Admit here: a person places the patient, naming no request.
    const target = bed('GWA-4');
    const suggestionId = String(new Types.ObjectId());
    await beds.hold(target, DOCTOR, suggestionId, 'Male');
    const admission = await beds.admit(target, DOCTOR, {
      patientId: p.id,
      suggestionId,
      doctor: 'Dr. Shajin',
      department: 'General Medicine',
      roomClass: 'general',
      needs: [],
      notes: '',
      expectedStayDays: 3,
    });
    await bridge.idle();
    assert.equal(await m.Case.countDocuments(), 1);
    const afterAdmit: any = await m.Case.findOne().lean();
    assert.equal(afterAdmit.refs.admissionId, String(admission._id));
    assert.equal((await all('bed.assigned')).length, 1);

    // The open request is cancelled; the admission keeps the case open. A new request joins it.
    await requests.cancel(DOCTOR, first);
    await bridge.idle();
    assert.equal(((await m.Case.findOne().lean()) as any).state, 'open');
    const second = await ask({ patientId: p.id, type: 'transfer', fromBedId: target, roomClass: 'general' });
    await bridge.idle();
    assert.equal(await m.Case.countDocuments(), 1);
    const joined: any = await m.Case.findOne().lean();
    assert.deepEqual(joined.refs.bedRequestIds, [first, second]);
    assert.equal((await all('bed.request')).length, 2);
    await noNames();
  });

  test('assignment resolves the request work and the bed-wait clock stops', async () => {
    const p = await patient();
    await fillGeneralMen();
    const id = await ask({ patientId: p.id });
    await agent.process(id);
    await bridge.idle();
    assert.equal(((await BedRequest.findById(id).lean()) as any).state, 'waiting');
    assert.equal(await clocks.countRunning(), 1);
    const [request] = await all('bed.request');
    assert.ok(!request.resolvedAt);

    await freeGeneralMen();
    await agent.process(id);
    await bridge.idle();
    const req: any = await BedRequest.findById(id).lean();
    assert.equal(req.state, 'assigned');

    const [assigned] = await all('bed.assigned');
    assert.equal(String(assigned.resolves), String(request._id));
    assert.equal(assigned.payload.bedLabel, req.assignedBedLabel);
    assert.ok(assigned.summary.includes(p.uhid));
    assert.ok(assigned.summary.includes(req.assignedBedLabel));
    const resolved: any = await m.AgentMessage.findById(request._id).lean();
    assert.ok(resolved.resolvedAt);
    assert.equal(await clocks.countRunning(), 0);
    const [clock]: any[] = await m.Clock.find().lean();
    assert.equal(clock.state, 'met');
    const c: any = await m.Case.findOne().lean();
    assert.equal(c.refs.admissionId, String(req.admission));
    await noNames();
  });

  test('bed.assigned carries the ward name', async () => {
    const p = await patient();
    const id = await ask({ patientId: p.id });
    await agent.process(id);
    await bridge.idle();
    const req: any = await BedRequest.findById(id).lean();
    assert.equal(req.state, 'assigned');
    const [assigned] = await all('bed.assigned');
    const placedBed: any = await Bed.findById(req.assignedBed).lean();
    const placedWard: any = await Ward.findById(placedBed.ward).lean();
    assert.ok(placedWard.name);
    assert.equal(assigned.payload.ward, placedWard.name);
  });

  test('a retry that waits again logs one bed.waiting; a wait after attention logs a new one', async () => {
    const p = await patient();
    await fillGeneralMen();
    const id = await ask({ patientId: p.id });
    await agent.process(id);
    await bridge.idle();
    const again = (state: 'waiting' | 'attention') =>
      events.requestChanged({ id, state, type: 'admission', patientName: '', reason: '' });
    const ageAll = () => m.AgentMessage.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 5 * MIN) } });
    assert.equal((await all('bed.waiting')).length, 1);

    await ageAll();
    again('waiting');
    await bridge.idle();
    assert.equal((await all('bed.waiting')).length, 1);

    again('attention');
    await bridge.idle();
    await ageAll();
    again('waiting');
    await bridge.idle();
    assert.equal((await all('bed.waiting')).length, 2);
  });

  test('a replayed event sends bed.request when an earlier send was lost, and only once', async () => {
    const p = await patient();
    const id = await ask({ patientId: p.id });
    await bridge.idle();
    await m.AgentMessage.deleteMany({ type: 'bed.request' }); // the send was lost; the refs stayed
    events.requestChanged({ id, state: 'searching', type: 'admission', patientName: '', reason: '' });
    await bridge.idle();
    assert.equal((await all('bed.request')).length, 1);
    events.requestChanged({ id, state: 'searching', type: 'admission', patientName: '', reason: '' });
    await bridge.idle();
    assert.equal((await all('bed.request')).length, 1);
  });

  test('a request waiting 60 minutes escalates through the bed-wait ladder', async () => {
    const p = await patient();
    await fillGeneralMen();
    const id = await ask({ patientId: p.id });
    await agent.process(id);
    await bridge.idle();
    assert.equal(await clocks.checkDue(new Date(Date.now() + 59 * MIN)), 0);
    assert.equal(await clocks.checkDue(new Date(Date.now() + 61 * MIN)), 1);
    const esc: any[] = await m.Escalation.find().lean();
    assert.equal(esc.length, 1);
    assert.equal(esc[0].ladder, 'bed-wait');
  });

  test('a needs-attention request becomes an approval that closes when the request is assigned or cancelled', async () => {
    const p1 = await patient();
    const id1 = await ask({ patientId: p1.id, notes: 'Suspected TB, cough for weeks' });
    await agent.process(id1);
    await bridge.idle();
    assert.equal(((await BedRequest.findById(id1).lean()) as any).state, 'attention');
    const [a1]: any[] = await m.Approval.find().lean();
    assert.equal(a1.type, 'bed.attention');
    assert.equal(a1.state, 'open');
    assert.deepEqual(a1.source, { kind: 'bed-request', id: id1 });
    assert.ok(a1.summary.includes(p1.uhid));
    const [att] = await all('bed.attention');
    assert.equal(att.needsPerson, true);

    await agent.resolveNotesNeed(DOCTOR, id1, 'isolation', false);
    await until(async () => ((await BedRequest.findById(id1).lean()) as any).state === 'assigned');
    await bridge.idle();
    assert.equal(((await m.Approval.findById(a1._id).lean()) as any).state, 'done');

    const p2 = await patient();
    const id2 = await ask({ patientId: p2.id, notes: 'Suspected TB, cough for weeks' });
    await agent.process(id2);
    await bridge.idle();
    const a2: any = await m.Approval.findOne({ 'source.id': id2 }).lean();
    assert.equal(a2.state, 'open');
    await requests.cancel(DOCTOR, id2);
    await bridge.idle();
    assert.equal(((await m.Approval.findById(a2._id).lean()) as any).state, 'done');
    assert.equal((await all('bed.cancelled')).length, 1);
    await noNames();
  });

  test('a cancelled request with no admission closes its case; an admitted case closes on discharge', async () => {
    const p1 = await patient();
    const id1 = await ask({ patientId: p1.id });
    await bridge.idle();
    assert.equal(((await m.Case.findOne().lean()) as any).state, 'open'); // R8: a new case never closes empty
    await requests.cancel(DOCTOR, id1);
    await bridge.idle();
    const c1: any = await m.Case.findOne({ patientUhid: p1.uhid }).lean();
    assert.equal(c1.state, 'closed');
    assert.ok(c1.closedReason.includes('Admission discharged or request cancelled'));

    const p2 = await patient();
    const id2 = await ask({ patientId: p2.id });
    await agent.process(id2);
    await bridge.idle();
    const req: any = await BedRequest.findById(id2).lean();
    const c2a: any = await m.Case.findOne({ patientUhid: p2.uhid }).lean();
    assert.equal(c2a.state, 'open');
    await beds.discharge(String(req.assignedBed), DOCTOR, String(req.admission), { viaDischarge: true });
    await bridge.idle();
    const c2: any = await m.Case.findOne({ patientUhid: p2.uhid }).lean();
    assert.equal(c2.state, 'closed');
    const [discharged] = await all('bed.discharged');
    assert.equal(String(discharged.case), String(c2._id));
    await noNames();
  });

  test('the bed check is n/a for a case with no bed refs', async () => {
    const p = await patient();
    const { case: c } = await cases.openOrJoin({
      patientId: p.id, patientUhid: p.uhid, patientName: 'x', kind: 'er', priority: 'medium', openedBy: 'er',
    });
    assert.equal(await (bridge as any).closeCheck(String(c._id)), 'n/a');
  });

  test('a close check between assignment and the bridge catching up keeps the case open', async () => {
    const p = await patient();
    const id = await ask({ patientId: p.id });
    await bridge.idle();
    // Hold the bridge back: the request is assigned, but the bridge has not written the admission yet.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (bridge as any).queue = (bridge as any).queue.then(() => gate);
    await agent.process(id);
    const req: any = await BedRequest.findById(id).lean();
    assert.equal(req.state, 'assigned');
    assert.equal(await cases.evaluateOpenCases(), 0);
    assert.equal(((await m.Case.findOne().lean()) as any).state, 'open');

    release();
    await bridge.idle();
    assert.equal(await m.Case.countDocuments(), 1);
    const c: any = await m.Case.findOne().lean();
    assert.equal(c.state, 'open');
    assert.equal(c.refs.admissionId, String(req.admission));
    assert.equal(await cases.evaluateOpenCases(), 0);
  });

  test('a hand placement for a waiting request keeps one case, even when the agent cancels the request first', async () => {
    const p = await patient();
    await fillGeneralMen();
    const id = await ask({ patientId: p.id });
    await agent.process(id);
    await bridge.idle();
    assert.equal(((await BedRequest.findById(id).lean()) as any).state, 'waiting');

    // Staff free a bed and place the patient there for this request...
    const target = bed('GWA-4');
    await Bed.updateOne({ _id: target }, { state: 'free', $unset: { occupantGender: 1 } }).exec();
    const suggestionId = String(new Types.ObjectId());
    await beds.hold(target, DOCTOR, suggestionId, 'Male');
    const admission = await beds.admit(target, DOCTOR, {
      patientId: p.id,
      suggestionId,
      doctor: 'Dr. Shajin',
      department: 'General Medicine',
      roomClass: 'general',
      needs: [],
      notes: '',
      expectedStayDays: 3,
      requestId: id,
    });
    // ...but a retry pass sees the admission first and closes the request as moot.
    await agent.process(id);
    assert.equal(((await BedRequest.findById(id).lean()) as any).state, 'cancelled');
    await agent.completeByHand(id, {
      bedId: target,
      bedLabel: 'GWA-4',
      wardName: 'General Ward A',
      admissionId: String(admission._id),
      actor: DOCTOR,
      suggestionId,
    });
    await bridge.idle();
    assert.equal(await cases.evaluateOpenCases(), 0);

    assert.equal(await m.Case.countDocuments(), 1);
    const c: any = await m.Case.findOne().lean();
    assert.equal(c.state, 'open');
    assert.equal(c.refs.admissionId, String(admission._id));

    // The discharge lands on the same case and closes it.
    await beds.discharge(target, DOCTOR, String(admission._id), { viaDischarge: true });
    await bridge.idle();
    assert.equal(await m.Case.countDocuments(), 1);
    const closed: any = await m.Case.findOne().lean();
    assert.equal(closed.state, 'closed');
    const [discharged] = await all('bed.discharged');
    assert.equal(String(discharged.case), String(c._id));
    await noNames();
  });

  test('a bed.attention approval closes when the request goes back to searching or waiting; a later attention opens a new one', async () => {
    const p = await patient();
    const id = await ask({ patientId: p.id, notes: 'Suspected TB, cough for weeks' });
    await agent.process(id);
    await bridge.idle();
    const again = (state: 'searching' | 'waiting' | 'attention') =>
      events.requestChanged({ id, state, type: 'admission', patientName: '', reason: '' });
    const open = () => m.Approval.find({ 'source.id': id, state: 'open' }).lean().exec() as Promise<any[]>;

    const [first] = await open();
    assert.ok(first);
    again('searching');
    await bridge.idle();
    assert.equal((await open()).length, 0);
    assert.equal(((await m.Approval.findById(first._id).lean()) as any).state, 'done');

    again('attention');
    await bridge.idle();
    const [second] = await open();
    assert.ok(second);
    assert.notEqual(String(second._id), String(first._id));
    again('waiting');
    await bridge.idle();
    assert.equal((await open()).length, 0);
    assert.equal(await m.Approval.countDocuments({ 'source.id': id }), 2);
  });

  test('a cleaned bed is logged with no case', async () => {
    const p = await patient();
    const id = await ask({ patientId: p.id });
    await agent.process(id);
    await bridge.idle();
    const req: any = await BedRequest.findById(id).lean();
    await beds.discharge(String(req.assignedBed), DOCTOR, String(req.admission), { viaDischarge: true });
    await beds.markCleaned(String(req.assignedBed), DOCTOR);
    await bridge.idle();
    const [cleaned] = await all('bed.cleaned');
    assert.equal(cleaned.case, null);
    assert.equal(cleaned.payload.bedLabel, req.assignedBedLabel);
    assert.equal(cleaned.priority, 'low');
    await noNames();
  });
});
