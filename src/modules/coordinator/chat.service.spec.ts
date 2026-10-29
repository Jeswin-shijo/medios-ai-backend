import * as assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiResult, StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { Actor } from '../beds/actor';
import { PatientsService } from '../patients/patients.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { AgentStatusService } from './agent-status.service';
import { ApprovalsService } from './approvals.service';
import { CasesService } from './cases.service';
import { ChatService } from './chat.service';
import { ClocksService } from './clocks.service';
import { CoordinatorEvents } from './coordinator-events';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';

const status = async () => ({ open: 1, capacity: 4, onTimePct: null });
const actor: Actor = { id: 'u1', name: 'Dr Test', role: UserRole.DOCTOR };

/** Stands in for AiService: records each task and rewords nothing (returns the template it was given). */
function fakeAi() {
  const fake = {
    tasks: [] as StructuredTask<any>[],
    async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
      fake.tasks.push(task);
      return { ok: true, value: { answer: (task.input as any).template } as T, sample: false, provider: 'claude', model: 'm', latencyMs: 1 };
    },
  };
  return fake;
}

describe('ChatService', () => {
  const { AgentMessage, Approval, Case, ChatLog, Clock, CoordinatorCounter, DutyTitle, Escalation, Ladder, Patient, TaskAlertItem, TimelineEvent, User, Admission } = models();
  let ai: ReturnType<typeof fakeAi>;
  let service: ChatService;
  let cases: CasesService;
  let clocks: ClocksService;
  let messages: MessagesService;
  let patientId: string;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const registry = new AgentRegistry();
    registry.register({
      key: 'bed',
      messageTypes: [{ type: 'bed.requested', agent: 'bed', description: 'asked', payload: {} }],
      clocks: [{ key: 'bed-wait', agent: 'bed', label: 'Bed wait', startOn: 'bed.requested', stopOn: [], minutes: 30, ladder: 'default' }],
      status,
    });
    const events = new CoordinatorEvents();
    messages = new MessagesService(AgentMessage, registry, events);
    const escalations = new EscalationsService(Escalation, DutyTitle, Ladder, TaskAlertItem, User, messages);
    await escalations.ensureDefaults();
    clocks = new ClocksService(Clock, registry, messages, escalations);
    cases = new CasesService(Case, CoordinatorCounter, messages, registry, new TimelineService(TimelineEvent));
    const approvals = new ApprovalsService(Approval, DutyTitle, registry, messages);
    const patients = new PatientsService(Patient);
    ai = fakeAi();
    service = new ChatService(ChatLog, Escalation, cases, clocks, approvals, new AgentStatusService(registry, events), patients, ai as unknown as AiService, registry);
    const p = await Patient.create({ uhid: 'MHK202577777', name: 'Zarathustra Quillfeather', age: 60, gender: 'Male', phone: '9876543210' });
    patientId = String(p._id);
  });

  const openCase = async () => {
    const { case: c } = await cases.openOrJoin({ patientId, patientUhid: 'MHK202577777', patientName: 'Zarathustra Quillfeather', kind: 'ipd', priority: 'high', openedBy: 'bed' });
    await messages.send({ case: String(c._id), from: 'bed', to: ['coordinator'], type: 'bed.requested', priority: 'high', summary: 'MHK202577777 needs a bed', payload: {} });
    return c;
  };

  test('ask answers a case status from local facts', async () => {
    const c = await openCase();
    const res = await service.ask(actor, 'Where is the bed request for MHK202577777?');
    assert.match(res.answer, /Zarathustra Quillfeather \(MHK202577777\)/);
    assert.match(res.answer, /open \(IPD, high priority\)/);
    assert.match(res.answer, /Bed wait has \d+ min left/);
    assert.deepEqual(res.action, { kind: 'open', screen: 'case', params: { caseId: String(c._id) } });
    assert.equal(await ChatLog.countDocuments(), 1);

    const unknown = await service.ask(actor, 'tell me a joke');
    assert.match(unknown.answer, /^I can answer questions about cases, bed requests, agents and approvals\./);
    assert.equal(ai.tasks.length, 1);
    assert.equal(await ChatLog.countDocuments(), 2);
  });

  test('allocate-bed returns an open-form action and creates nothing', async () => {
    const before = [await Case.countDocuments(), await AgentMessage.countDocuments(), await Admission.countDocuments()];
    const res = await service.ask(actor, 'Allocate bed for MHK202577777');
    assert.deepEqual(res.action, { kind: 'open', screen: 'bed-request-form', params: { patientId, uhid: 'MHK202577777' } });
    assert.match(res.answer, /Zarathustra Quillfeather \(MHK202577777\)/);
    assert.deepEqual([await Case.countDocuments(), await AgentMessage.countDocuments(), await Admission.countDocuments()], before);
    assert.equal(ai.tasks.length, 0);
    assert.equal((await ChatLog.findOne().lean())!.aiInput, null);
  });

  test("nothing sent to the AI contains the patient's name or UHID", async () => {
    const c = await openCase();
    const res = await service.ask(actor, `Status of ${c.number} for Zarathustra Quillfeather MHK202577777`);
    await service.ask(actor, 'Discharge status for MHK202577777');
    assert.ok(ai.tasks.length >= 2);
    assert.match(res.answer, /Zarathustra Quillfeather/);
    assert.match(res.answer, /MHK202577777/);
    const sent = JSON.stringify(ai.tasks.map((t) => ({ instructions: t.instructions, input: t.input })));
    const logged = JSON.stringify((await ChatLog.find().lean()).map((l) => l.aiInput));
    for (const blob of [sent, logged]) {
      for (const secret of ['Zarathustra', 'Quillfeather', 'MHK202577777', c.number, patientId, String(c._id), 'Where is', 'Status of']) {
        assert.ok(!blob.includes(secret), `leaked ${secret}`);
      }
    }
    const log = (await ChatLog.findOne({ question: /^Status of/ }).lean())!;
    assert.deepEqual((log.aiInput as any).input.facts.agents, ['bed']);
    assert.match(log.answer, /Zarathustra/);
  });

  const approval = (type: string, agent: string, summary: string) =>
    Approval.create({ type, agent, summary, roles: ['doctor'], primary: { kind: 'approve', label: 'Approve' } });

  test('approvals counts open approvals by type and agent', async () => {
    await approval('bed-override', 'bed', 'MHK202588888 needs a decision');
    await approval('bed-override', 'bed', 'another');
    await approval('discharge-sign', 'discharge', 'sign it');
    const res = await service.ask(actor, 'Pending approvals');
    assert.match(res.answer, /3 open approvals/);
    assert.match(res.answer, /2 bed-override from Bed/);
    assert.match(res.answer, /1 discharge-sign from Discharge/);
    const facts = (ai.tasks[0].input as any).facts;
    assert.equal(facts.open, 3);
    assert.ok(!JSON.stringify(ai.tasks[0]).includes('MHK202588888'));
  });

  test('overdue lists an expired clock with an open escalation and a running clock due soon', async () => {
    const lateCase = String(new Types.ObjectId());
    const soonCase = String(new Types.ObjectId());
    await messages.send({ case: lateCase, from: 'bed', to: ['coordinator'], type: 'bed.requested', priority: 'high', summary: 'late', payload: {} });
    await messages.send({ case: soonCase, from: 'bed', to: ['coordinator'], type: 'bed.requested', priority: 'high', summary: 'soon', payload: {} });
    await Clock.updateOne({ case: lateCase }, { $set: { dueAt: new Date(Date.now() - 60_000) } });
    await Clock.updateOne({ case: soonCase }, { $set: { dueAt: new Date(Date.now() + 5 * 60_000) } });
    assert.equal(await clocks.checkDue(new Date()), 1);
    const res = await service.ask(actor, 'What is overdue?');
    assert.match(res.answer, /1 item overdue with an open escalation: Bed wait \(1\)/);
    assert.match(res.answer, /1 item due within 15 minutes: Bed wait \(1\)/);
  });

  test('every AI-bound intent sends no identity, id or UHID, and the case status names its last update', async () => {
    const c = await openCase();
    await approval('bed-override', 'bed', 'MHK202588888 needs a decision');
    const questions = [
      'Where is the bed request for MHK202577777?',
      'Discharge status for MHK202577777',
      'Check discharge status',
      'Show agent workload',
      'Pending approvals',
      "What's overdue?",
    ];
    const answers: string[] = [];
    for (const q of questions) answers.push((await service.ask(actor, q)).answer);
    assert.equal(ai.tasks.length, questions.length);
    assert.match(answers[0], /Last update: asked, \d+ min ago/);
    assert.match(answers[2], /For example: 'Discharge status for MHK202500323'\.$/);
    const logs = await ChatLog.find().lean();
    const blobs = [...ai.tasks.map((t) => JSON.stringify({ instructions: t.instructions, input: t.input })), ...logs.map((l) => JSON.stringify(l.aiInput))];
    assert.equal(blobs.length, questions.length * 2);
    for (const blob of blobs) {
      for (const secret of ['Zarathustra', 'Quillfeather', 'MHK202577777', c.number, patientId, String(c._id)]) assert.ok(!blob.includes(secret), `leaked ${secret}`);
      assert.ok(!/MHK\d{9}/i.test(blob), 'a UHID reached the AI');
      assert.ok(!/\b[a-f\d]{24}\b/i.test(blob), 'an id reached the AI');
    }
  });

  test('a question that fails or is not text is still logged, and an AI that is off leaves aiInput empty', async () => {
    ai.runStructured = async () => ({ ok: false, failure: 'off', provider: 'none', model: 'none', latencyMs: 0 }) as any;
    const res = await service.ask(actor, 'Show agent workload');
    assert.equal(res.sample, false);
    assert.equal((await ChatLog.findOne({ question: 'Show agent workload' }).lean())!.aiInput, null);
    await service.ask(actor, undefined as unknown as string);
    assert.equal(await ChatLog.countDocuments(), 2);
  });
});
