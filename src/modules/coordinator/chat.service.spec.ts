import * as assert from 'node:assert/strict';
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
    const clocks = new ClocksService(Clock, registry, messages, escalations);
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
});
