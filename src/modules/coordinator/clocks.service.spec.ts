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
        { type: 'test.due', agent: 'er', description: 'due from payload', payload: {} },
        { type: 'test.move', agent: 'er', description: 'moves the due time', payload: {} },
        { type: 'test.scoped', agent: 'er', description: 'matched by payload', payload: {} },
        { type: 'test.scoped.done', agent: 'er', description: 'matched stop', payload: {} },
      ],
      clocks: [
        { key: 'test-wait', agent: 'er', label: 'Test wait', startOn: 'test.wait', stopOn: ['test.done'], minutes: 10, ladder: 'default' },
        {
          key: 'test-due',
          agent: 'er',
          label: 'Test due',
          startOn: 'test.due',
          stopOn: [],
          minutes: 10,
          ladder: 'default',
          dueFrom: (p) => (typeof p.at === 'string' ? new Date(p.at) : null),
          updateOn: ['test.move'],
        },
        {
          key: 'test-scoped',
          agent: 'er',
          label: 'Test scoped',
          startOn: 'test.scoped',
          stopOn: ['test.scoped.done'],
          minutes: 10,
          ladder: 'default',
          match: (_t, p) => p.step === 'ecg',
        },
      ],
      status,
    });
    messages = new MessagesService(AgentMessage, registry, new CoordinatorEvents());
    escalations = new EscalationsService(Escalation, DutyTitle, Ladder, TaskAlertItem, User, messages, new CoordinatorEvents());
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

  const sendWith = (type: string, payload: Record<string, unknown>, caseId: string | null = null) =>
    messages.send({ case: caseId, from: 'er', to: ['coordinator'], type, priority: 'medium', summary: type, payload });

  test("a clock's due time can come from the start message", async () => {
    const caseId = String(new Types.ObjectId());
    const at = new Date(Date.now() + 25 * MIN);
    await sendWith('test.due', { at: at.toISOString() }, caseId);
    const clock: any = await Clock.findOne({ def: 'test-due' }).lean();
    assert.equal(new Date(clock.dueAt).getTime(), at.getTime());
    // No usable date: falls back to the minutes.
    const other = String(new Types.ObjectId());
    await sendWith('test.due', {}, other);
    const fallback: any = await Clock.findOne({ def: 'test-due', case: new Types.ObjectId(other) }).lean();
    assert.equal(new Date(fallback.dueAt).getTime() - new Date(fallback.startedAt).getTime(), 10 * MIN);
    const bad = String(new Types.ObjectId());
    await sendWith('test.due', { at: 'not a date' }, bad);
    const invalid: any = await Clock.findOne({ def: 'test-due', case: new Types.ObjectId(bad) }).lean();
    assert.equal(new Date(invalid.dueAt).getTime() - new Date(invalid.startedAt).getTime(), 10 * MIN);
  });

  test('an update message moves a running clock and a past due time expires on the next check', async () => {
    const caseId = String(new Types.ObjectId());
    const other = String(new Types.ObjectId());
    const first = new Date(Date.now() + 25 * MIN);
    await sendWith('test.due', { at: first.toISOString() }, caseId);
    await sendWith('test.due', { at: first.toISOString() }, other);
    const later = new Date(Date.now() + 40 * MIN);
    await sendWith('test.move', { at: later.toISOString() }, caseId);
    const moved: any = await Clock.findOne({ def: 'test-due', case: new Types.ObjectId(caseId) }).lean();
    const untouched: any = await Clock.findOne({ def: 'test-due', case: new Types.ObjectId(other) }).lean();
    assert.equal(new Date(moved.dueAt).getTime(), later.getTime());
    assert.equal(new Date(untouched.dueAt).getTime(), first.getTime());

    // A due time already past: the next check expires it.
    await sendWith('test.move', { at: new Date(Date.now() - MIN).toISOString() }, caseId);
    assert.equal(await service.checkDue(new Date()), 1);
    const expired: any = await Clock.findOne({ _id: moved._id }).lean();
    assert.equal(expired.state, 'expired');
    // An expired clock is never moved back.
    await sendWith('test.move', { at: new Date(Date.now() + 60 * MIN).toISOString() }, caseId);
    const still: any = await Clock.findOne({ _id: moved._id }).lean();
    assert.equal(still.state, 'expired');
    assert.equal(new Date(still.dueAt).getTime(), new Date(expired.dueAt).getTime());
  });

  test('match filters start and stop by payload', async () => {
    const caseId = String(new Types.ObjectId());
    await sendWith('test.scoped', { step: 'ct' }, caseId);
    assert.equal(await Clock.countDocuments({ def: 'test-scoped' }), 0);
    await sendWith('test.scoped', { step: 'ecg' }, caseId);
    assert.equal(await Clock.countDocuments({ def: 'test-scoped', state: 'running' }), 1);
    await sendWith('test.scoped.done', { step: 'ct' }, caseId);
    assert.equal(await Clock.countDocuments({ def: 'test-scoped', state: 'running' }), 1);
    await sendWith('test.scoped.done', { step: 'ecg' }, caseId);
    assert.equal(await Clock.countDocuments({ def: 'test-scoped', state: 'met' }), 1);
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
    const freshMessages = new MessagesService(AgentMessage, registry, new CoordinatorEvents());
    const fresh = new ClocksService(Clock, registry, freshMessages, new EscalationsService(Escalation, DutyTitle, Ladder, TaskAlertItem, User, freshMessages, new CoordinatorEvents()));
    assert.equal(await fresh.checkDue(new Date()), 1);
    assert.equal(await fresh.checkDue(new Date()), 0);
    assert.equal((await messages.list({ type: 'clock.expired' })).length, 1);
    assert.equal(await Escalation.countDocuments(), 1);
  });

  test('a clock left expired with no escalation is escalated once by the next checkDue', async () => {
    const caseId = new Types.ObjectId();
    const startMsg = await send('test.wait', String(caseId));
    await Clock.deleteMany({});
    const started = new Date(Date.now() - 30 * MIN);
    const { insertedId } = await Clock.collection.insertOne({
      def: 'test-wait', case: caseId, startedBy: startMsg!._id, startedAt: started,
      dueAt: new Date(started.getTime() + 10 * MIN), state: 'expired',
    });
    assert.equal(await service.checkDue(new Date()), 0);
    assert.equal(await Escalation.countDocuments(), 1);
    const clock: any = await Clock.findById(insertedId).lean();
    assert.equal(String(clock.escalation), String(((await Escalation.findOne().lean()) as any)._id));
    assert.equal((await messages.list({ type: 'clock.expired' })).length, 0);
    await service.checkDue(new Date());
    assert.equal(await Escalation.countDocuments(), 1);
  });
});
