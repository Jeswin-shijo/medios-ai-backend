import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from './agent-registry';
import { ClocksService } from './clocks.service';
import { CoordinatorEvents } from './coordinator-events';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';

const MIN = 60_000;
const status = async () => ({ open: 0, capacity: 0, onTimePct: null });

describe('ClocksService', () => {
  const { AgentMessage, Clock, DutyTitle, Escalation, Ladder, TaskAlertItem, User } = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let escalations: EscalationsService;
  let service: ClocksService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    registry.register({
      key: 'er',
      messageTypes: [
        { type: 'test.wait', agent: 'er', description: 'waiting', payload: {} },
        { type: 'test.done', agent: 'er', description: 'done', payload: {} },
      ],
      clocks: [{ key: 'test-wait', agent: 'er', label: 'Test wait', startOn: 'test.wait', stopOn: ['test.done'], minutes: 10, ladder: 'default' }],
      status,
    });
    messages = new MessagesService(AgentMessage, registry, new CoordinatorEvents());
    escalations = new EscalationsService(Escalation, DutyTitle, Ladder, TaskAlertItem, User, messages);
    await escalations.ensureDefaults();
    service = new ClocksService(Clock, registry, messages, escalations);
  });

  const send = (type: string, caseId: string | null = null) =>
    messages.send({ case: caseId, from: 'er', to: ['coordinator'], type, priority: 'medium', summary: type, payload: {} });

  test('a start message starts a clock and a repeat does not restart it', async () => {
    const caseId = String(new Types.ObjectId());
    const first = await send('test.wait', caseId);
    const [clock]: any[] = await Clock.find().lean();
    assert.equal(clock.state, 'running');
    assert.equal(clock.def, 'test-wait');
    assert.equal(String(clock.startedBy), String(first!._id));
    assert.equal(new Date(clock.dueAt).getTime() - new Date(clock.startedAt).getTime(), 10 * MIN);

    const backdated = new Date(Date.now() - 5 * MIN);
    await Clock.updateOne({ _id: clock._id }, { $set: { startedAt: backdated } });
    await messages.send({ case: caseId, from: 'er', to: ['coordinator'], type: 'test.wait', priority: 'medium', summary: 'again', payload: {} });
    const all: any[] = await Clock.find().lean();
    assert.equal(all.length, 1);
    assert.equal(String(all[0].startedBy), String(first!._id));
    assert.equal(new Date(all[0].startedAt).getTime(), backdated.getTime());

    await send('test.wait'); // no case: its own clock
    assert.equal(await service.countRunning(), 2);
  });

  test('a stop message meets the clock and records the minutes', async () => {
    const caseId = String(new Types.ObjectId());
    await send('test.wait', caseId);
    await Clock.updateOne({}, { $set: { startedAt: new Date(Date.now() - 4 * MIN) } });
    await send('test.done', caseId);
    const [clock]: any[] = await Clock.find().lean();
    assert.equal(clock.state, 'met');
    assert.equal(clock.metMinutes, 4);
    assert.ok(clock.stoppedAt);
    assert.equal(await service.countRunning(), 0);
    await send('test.done', caseId); // nothing running: a no-op
    assert.equal((await Clock.findOne().lean() as any).metMinutes, 4);
  });

  test('checkDue expires an overdue clock, sends clock.expired and raises its ladder once', async () => {
    const caseId = String(new Types.ObjectId());
    const start = await send('test.wait', caseId);
    assert.equal(await service.checkDue(new Date(Date.now() + 9 * MIN)), 0);
    const later = new Date(Date.now() + 11 * MIN);
    assert.equal(await service.checkDue(later), 1);
    assert.equal(await service.checkDue(later), 0);

    const [clock]: any[] = await Clock.find().lean();
    assert.equal(clock.state, 'expired');
    assert.ok(clock.escalation);
    const sent = await messages.list({ type: 'clock.expired' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].case, caseId);
    assert.equal(sent[0].causedBy, String(start!._id));
    assert.deepEqual(sent[0].payload, { clockKey: 'test-wait' });
    assert.equal(sent[0].summary, 'Test wait overdue');
    const esc: any[] = await Escalation.find().lean();
    assert.equal(esc.length, 1);
    assert.equal(esc[0].reason, 'Test wait overdue');
    assert.deepEqual(esc[0].source, { kind: 'clock', id: String(clock._id) });
    assert.equal(String(esc[0]._id), String(clock.escalation));

    // A late stop is recorded but the clock stays expired and the escalation open.
    await send('test.done', caseId);
    const after: any = await Clock.findOne().lean();
    assert.equal(after.state, 'expired');
    assert.ok(after.stoppedAt);
    assert.equal(typeof after.metMinutes, 'number');
    assert.equal(((await Escalation.findOne().lean()) as any).state, 'open');
  });

  test('checkDue after a restart expires a clock that fell due while the API was down', async () => {
    const caseId = new Types.ObjectId();
    const startMsg = await send('test.wait', String(caseId));
    await Clock.deleteMany({}); // as if the API had stored the start but never run a check
    const started = new Date(Date.now() - 30 * MIN);
    await Clock.collection.insertOne({
      def: 'test-wait',
      case: caseId,
      startedBy: startMsg!._id,
      startedAt: started,
      dueAt: new Date(started.getTime() + 10 * MIN),
      state: 'running',
    });
    // The new process starts with nothing in memory.
    const fresh = new ClocksService(Clock, registry, messages, escalations);
    assert.equal(await fresh.checkDue(new Date()), 1);
    assert.equal(await fresh.checkDue(new Date()), 0);
    assert.equal((await messages.list({ type: 'clock.expired' })).length, 1);
    assert.equal(await Escalation.countDocuments(), 1);
  });
});
