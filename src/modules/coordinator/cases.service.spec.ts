import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { TimelineService } from '../timeline/timeline.service';
import { AgentRegistry } from './agent-registry';
import { CasesService } from './cases.service';
import { CoordinatorEvents } from './coordinator-events';
import { MessagesService } from './messages.service';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });

describe('CasesService', () => {
  const { AgentMessage, Case, CoordinatorCounter, TimelineEvent } = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let service: CasesService;
  let checks: { a: boolean | 'n/a'; b: boolean | 'n/a' };
  const patientId = String(new Types.ObjectId());

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  const input = (over: Partial<Parameters<CasesService['openOrJoin']>[0]> = {}) => ({
    patientId, patientUhid: 'MHK202600009', patientName: 'Test Patient', kind: 'er' as const, priority: 'medium' as const, openedBy: 'er' as const, ...over,
  });

  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    messages = new MessagesService(AgentMessage, registry, new CoordinatorEvents());
    service = new CasesService(Case, CoordinatorCounter, messages, registry, new TimelineService(TimelineEvent));
    checks = { a: false, b: false };
    registry.register({
      key: 'bed',
      messageTypes: [{ type: 'test.ping', agent: 'bed', description: 'test', payload: {} }],
      closeChecks: [
        { agent: 'bed', label: 'Bed released', check: async () => checks.a },
        { agent: 'bed', label: 'Bed cleaned', check: async () => checks.b },
      ],
      status,
    });
  });

  test('openOrJoin opens a case with a number and a case.opened message', async () => {
    const { case: c, opened } = await service.openOrJoin(input());
    assert.equal(opened, true);
    assert.equal(c.number, 'CASE-0001');
    assert.equal(c.state, 'open');
    assert.deepEqual(c.agents, ['er']);
    const sent = await messages.list({ case: String(c._id) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'case.opened');
    assert.ok(!sent[0].summary.includes('Test Patient'));
    const second = await service.openOrJoin(input({ patientId: String(new Types.ObjectId()), patientUhid: 'MHK202600010' }));
    assert.equal(second.case.number, 'CASE-0002');
  });

  test('a second openOrJoin for the same patient joins the open case', async () => {
    const first = await service.openOrJoin(input());
    const again = await service.openOrJoin(input({ openedBy: 'bed' }));
    assert.equal(again.opened, false);
    assert.equal(String(again.case._id), String(first.case._id));
    assert.deepEqual([...again.case.agents].sort(), ['bed', 'er']);

    await resetTestDb();
    const [x, y] = await Promise.all([service.openOrJoin(input()), service.openOrJoin(input({ openedBy: 'bed' }))]);
    assert.equal([x, y].filter((r) => r.opened).length, 1);
    assert.equal(String(x.case._id), String(y.case._id));
    assert.equal(await Case.countDocuments({ state: 'open' }), 1);
    assert.equal(await AgentMessage.countDocuments({ type: 'case.opened' }), 1);
    const stored = await Case.findById(x.case._id).lean();
    assert.deepEqual([...stored!.agents].sort(), ['bed', 'er']);
  });

  test('joining an er case for an admission makes it ipd and keeps the higher priority', async () => {
    await service.openOrJoin(input({ priority: 'critical' }));
    const { case: c } = await service.openOrJoin(input({ kind: 'ipd', priority: 'low', openedBy: 'bed' }));
    assert.equal(c.kind, 'ipd');
    assert.equal(c.priority, 'critical');
    const back = await service.openOrJoin(input({ kind: 'er', priority: 'high' }));
    assert.equal(back.case.kind, 'ipd');
    assert.equal(back.case.priority, 'critical');
  });

  test('evaluateClose closes only when every close check passes, and logs why', async () => {
    const { case: c } = await service.openOrJoin(input());
    const id = String(c._id);
    checks.a = true;
    assert.equal(await service.evaluateClose(id), false);
    assert.equal((await service.get(id))!.state, 'open');
    checks.b = true;
    assert.equal(await service.evaluateClose(id), true);
    const closed = (await service.get(id))!;
    assert.equal(closed.state, 'closed');
    assert.equal(closed.closedReason, 'Bed released; Bed cleaned');
    assert.ok(closed.closedAt);
    const types = (await service.timeline(id)).map((m) => m.type);
    assert.deepEqual(types, ['case.opened', 'case.closed']);
    assert.equal(await service.evaluateClose(id), false);
    assert.equal(await AgentMessage.countDocuments({ type: 'case.closed' }), 1);
    // A new open case may start for the same patient once the old one is closed.
    const next = await service.openOrJoin(input());
    assert.equal(next.opened, true);
  });

  test('a case closes when no check fails and at least one passes; n/a checks are ignored', async () => {
    const { case: c } = await service.openOrJoin(input());
    const id = String(c._id);
    checks.a = 'n/a';
    checks.b = true;
    assert.equal(await service.evaluateClose(id), true);
    const closed = (await service.get(id))!;
    assert.equal(closed.state, 'closed');
    assert.equal(closed.closedReason, 'Bed cleaned');
  });

  test('a case whose checks are all n/a stays open', async () => {
    const { case: c } = await service.openOrJoin(input());
    checks.a = 'n/a';
    checks.b = 'n/a';
    assert.equal(await service.evaluateClose(String(c._id)), false);
    assert.equal((await service.get(String(c._id)))!.state, 'open');
    checks.b = false; // a fail beats an n/a
    assert.equal(await service.evaluateClose(String(c._id)), false);
  });

  test('evaluateOpenCases counts closed cases, and a listener closes on a stored message', async () => {
    const { case: c } = await service.openOrJoin(input());
    assert.equal(await service.evaluateOpenCases(), 0);
    checks.a = true;
    checks.b = true;
    assert.equal(await service.evaluateOpenCases(), 1);
    assert.equal((await service.get(String(c._id)))!.state, 'closed');
    assert.equal((await service.byNumber('CASE-0001'))!.number, 'CASE-0001');
    assert.equal(await service.get('nope'), null);
    assert.equal((await service.list({ state: 'closed' })).length, 1);
  });

  test('a case does not close at the instant it opens', async () => {
    checks.a = true;
    checks.b = true;
    const { case: c } = await service.openOrJoin(input());
    assert.equal((await service.get(String(c._id)))!.state, 'open');
    assert.equal(await AgentMessage.countDocuments({ type: 'case.closed' }), 0);
  });

  test('a stored message with a case triggers the close check', async () => {
    const { case: c } = await service.openOrJoin(input());
    checks.a = true;
    checks.b = true;
    await messages.send({ case: String(c._id), from: 'bed', to: ['coordinator'], type: 'test.ping', priority: 'low', summary: 'poke', dedupeKey: 'poke' });
    assert.equal((await service.get(String(c._id)))!.state, 'closed');
  });

  test('milestones are written to the patient timeline', async () => {
    const { case: c } = await service.openOrJoin(input());
    await service.openOrJoin(input({ kind: 'ipd' }));
    checks.a = true;
    checks.b = true;
    await service.evaluateClose(String(c._id));
    const rows = await TimelineEvent.find({ uhid: 'MHK202600009' }).sort({ createdAt: 1, _id: 1 }).lean();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].category, 'Emergency');
    assert.equal(rows[0].status, 'Completed');
    assert.match(rows[0].date, /^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
    assert.match(rows[0].time, /^\d{2}:\d{2} (AM|PM)$/);
    assert.equal(rows[1].category, 'Admission');
    assert.ok(rows[1].title.includes('CASE-0001'));
  });
});
