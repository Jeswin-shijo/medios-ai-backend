import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from './agent-registry';
import { CoordinatorEvent, CoordinatorEvents } from './coordinator-events';
import { AgentMessageInput } from './coordinator-types';
import { MessageProblem, MessagesService } from './messages.service';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });

describe('MessagesService', () => {
  const { AgentMessage } = models();
  let registry: AgentRegistry;
  let events: CoordinatorEvents;
  let service: MessagesService;
  let seen: CoordinatorEvent[];
  let problems: MessageProblem[];
  let calls: { er: string[]; lab: string[]; bounce: number };
  let erFails: number; // how many times the er handler throws before it works

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  const msg = (over: Partial<AgentMessageInput> = {}): AgentMessageInput => ({
    from: 'er', to: ['lab'], type: 'er.ping', priority: 'medium', summary: 'ping', payload: { n: 1 }, ...over,
  });

  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    events = new CoordinatorEvents();
    service = new MessagesService(AgentMessage, registry, events);
    seen = [];
    problems = [];
    calls = { er: [], lab: [], bounce: 0 };
    erFails = 0;
    events.events$.subscribe((e) => seen.push(e));
    service.onProblem(async (p) => void problems.push(p));
    registry.register({
      key: 'er',
      messageTypes: [
        { type: 'er.ping', agent: 'er', description: 'ping', payload: { n: 'number' } },
        { type: 'er.bounce', agent: 'er', description: 'bounce', payload: { n: 'number' } },
      ],
      handles: [
        {
          type: 'lab.pong',
          handler: async (id) => {
            // Bounce back to lab with a new payload every time, so only the hop guard stops it.
            calls.bounce += 1;
            const m = await service.get(id);
            await service.send({ from: 'er', to: ['lab'], type: 'er.bounce', priority: 'low', summary: 'b', payload: { n: calls.bounce }, causedBy: m!.id });
          },
        },
      ],
      status,
    });
    registry.register({
      key: 'lab',
      messageTypes: [
        { type: 'lab.pong', agent: 'lab', description: 'pong', payload: { n: 'number' } },
        { type: 'lab.note', agent: 'lab', description: 'note', payload: { n: 'number' } },
      ],
      handles: [
        {
          type: 'er.ping',
          handler: async (id) => {
            calls.lab.push(id);
            if (erFails-- > 0) throw new Error('lab is down');
          },
        },
        {
          type: 'er.bounce',
          handler: async (id) => {
            const m = await service.get(id);
            await service.send({ from: 'lab', to: ['er'], type: 'lab.pong', priority: 'low', summary: 'p', payload: { n: m!.hop }, causedBy: m!.id });
          },
        },
      ],
      status,
    });
  });

  test('send stores, delivers to subscribers and emits a message event', async () => {
    const m = await service.send(msg());
    assert.ok(m);
    assert.equal(m.state, 'delivered');
    assert.equal(m.hop, 0);
    assert.equal(calls.lab.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'message');
    assert.equal(seen[0].id, String(m._id));
    assert.equal(await AgentMessage.countDocuments(), 1);
  });

  test('a message with no subscribers is delivered at once', async () => {
    const m = await service.send({ from: 'coordinator', to: ['er'], type: 'case.opened', priority: 'low', summary: 'x' });
    assert.equal(m?.state, 'delivered');
  });

  test('send refuses an unknown type or a bad payload', async () => {
    await assert.rejects(service.send(msg({ type: 'nope.nothing' })), BadRequestException);
    await assert.rejects(service.send(msg({ payload: { n: 'one' } })), BadRequestException);
    assert.equal(await AgentMessage.countDocuments(), 0);
  });

  test('a failing handler is retried and the message fails after 3 attempts with one problem report', async () => {
    erFails = 99;
    const m = await service.send(msg());
    assert.equal(m?.state, 'failed');
    assert.equal(m?.attempts, 3);
    assert.equal(calls.lab.length, 3);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].kind, 'failed');
  });

  test('a retry only calls handlers that have not succeeded yet', async () => {
    let good = 0;
    registry.register({
      key: 'scheduling',
      messageTypes: [],
      handles: [{ type: 'er.ping', handler: async () => void (good += 1) }],
      status,
    });
    erFails = 1;
    const m = await service.send(msg());
    assert.equal(m?.state, 'delivered');
    assert.equal(calls.lab.length, 2);
    assert.equal(good, 1);
    assert.equal(problems.length, 0);
  });

  test('a chain deeper than 10 hops is refused with one loop report', async () => {
    await service.send({ from: 'er', to: ['lab'], type: 'er.bounce', priority: 'low', summary: 'start', payload: { n: 0 } });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].kind, 'loop');
    const hops = (await AgentMessage.find().lean()).map((m) => m.hop);
    assert.equal(Math.max(...hops), 10);
    assert.equal(hops.length, 11);
  });

  test('the same message within 1 minute is dropped as a duplicate', async () => {
    assert.ok(await service.send(msg()));
    assert.equal(await service.send(msg()), null);
    assert.ok(await service.send(msg({ payload: { n: 2 } })));
    assert.equal(await service.send(msg({ payload: { n: 2 }, dedupeKey: 'other' })) !== null, true);
    assert.equal(await AgentMessage.countDocuments(), 3);
    // After the window it is allowed again.
    await AgentMessage.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 61_000) } });
    assert.ok(await service.send(msg()));
  });

  test('resolves marks the earlier message resolved and openWork lists only unresolved work, critical first', async () => {
    // Created oldest-first in the order critical, high, medium, low... then reversed priority so recency and rank disagree.
    const crit = await service.send(msg({ opensWork: true, priority: 'critical', payload: { n: 1 } }));
    const high = await service.send(msg({ opensWork: true, priority: 'high', payload: { n: 2 } }));
    const med = await service.send(msg({ opensWork: true, priority: 'medium', payload: { n: 3 } }));
    const done = await service.send(msg({ opensWork: true, priority: 'high', payload: { n: 4 } }));
    const low = await service.send(msg({ opensWork: true, priority: 'low', payload: { n: 5 } }));
    await service.send(msg({ payload: { n: 6 }, resolves: String(done!._id) }));
    const fixed = await AgentMessage.findById(done!._id).lean();
    assert.ok(fixed?.resolvedAt);
    const open = await service.list({ openWork: true });
    assert.deepEqual(open.map((m) => m.id), [crit, high, med, low].map((m) => String(m!._id)));
    assert.equal(typeof open[0].createdAt, 'string');
  });

  test('a second resolve keeps the first resolvedAt and resolvedBy', async () => {
    const work = await service.send(msg({ opensWork: true, payload: { n: 1 } }));
    const first = await service.send(msg({ payload: { n: 2 }, resolves: String(work!._id) }));
    const before = await AgentMessage.findById(work!._id).lean();
    await service.send(msg({ payload: { n: 3 }, resolves: String(work!._id) }));
    const after = await AgentMessage.findById(work!._id).lean();
    assert.equal(String(after?.resolvedBy), String(first!._id));
    assert.equal(after?.resolvedAt?.getTime(), before?.resolvedAt?.getTime());
  });

  test('malformed or unknown ids are refused with BadRequest and nothing is stored', async () => {
    const ghost = new Types.ObjectId().toString();
    await assert.rejects(service.send(msg({ case: 'nope' })), BadRequestException);
    await assert.rejects(service.send(msg({ causedBy: 'nope' })), BadRequestException);
    await assert.rejects(service.send(msg({ resolves: 'nope' })), BadRequestException);
    await assert.rejects(service.send(msg({ causedBy: ghost })), BadRequestException);
    await assert.rejects(service.send(msg({ resolves: ghost })), BadRequestException);
    await assert.rejects(service.list({ case: 'nope' }), BadRequestException);
    assert.equal(await AgentMessage.countDocuments(), 0);
  });

  test('a caller-supplied dedupeKey is stored as given', async () => {
    const m = await service.send(msg({ dedupeKey: 'my-key' }));
    assert.equal(m?.dedupeKey, 'my-key');
  });

  test('list filters by case, agent and before, newest first within a priority', async () => {
    const c = new Types.ObjectId().toString();
    const a = await service.send(msg({ case: c, payload: { n: 1 } }));
    const b = await service.send(msg({ case: c, payload: { n: 2 } }));
    await service.send(msg({ from: 'lab', to: ['er'], type: 'lab.note', payload: { n: 3 } }));
    const hi = await service.send(msg({ case: c, priority: 'high', payload: { n: 4 } }));
    assert.equal((await service.list({ case: c })).length, 3);
    assert.equal((await service.list({ agent: 'lab' })).length, 4);
    assert.deepEqual((await service.list({ case: c })).map((m) => m.id), [hi, b, a].map((m) => String(m!._id)));
    assert.deepEqual((await service.list({ case: c, before: String(b!._id) })).map((m) => m.id), [String(a!._id)]);
    assert.equal(await service.countSince(new Date(Date.now() - 60_000)), 4);
  });

  test("sort 'recent' lists the newest 50 in time order whatever their priority; the default stays emergency-first", async () => {
    const priorities = ['low', 'medium', 'high', 'critical'] as const;
    const t0 = Date.now() - 60 * 60_000;
    // 60 messages, one a second, with mixed priorities and the critical ones among the oldest.
    const docs = Array.from({ length: 60 }, (_, i) => ({
      case: null, from: 'er', to: ['lab'], type: 'er.ping', priority: i < 5 ? 'critical' : priorities[i % 3], summary: `m${i}`, payload: { n: i },
      hop: 0, dedupeKey: `k${i}`, state: 'delivered', attempts: 0, needsPerson: false, opensWork: false, createdAt: new Date(t0 + i * 1000),
    }));
    await AgentMessage.collection.insertMany(docs);

    const recent = await service.list({ sort: 'recent' });
    assert.equal(recent.length, 50);
    assert.deepEqual(recent.map((m) => m.summary), Array.from({ length: 50 }, (_, k) => `m${59 - k}`));
    // Paging back from the last one gives the 10 before it, still newest first.
    const older = await service.list({ sort: 'recent', before: recent[49].id });
    assert.deepEqual(older.map((m) => m.summary), Array.from({ length: 10 }, (_, k) => `m${9 - k}`));

    const byPriority = await service.list({});
    assert.deepEqual(byPriority.slice(0, 5).map((m) => m.summary), ['m4', 'm3', 'm2', 'm1', 'm0']);
    const ranks = byPriority.map((m) => ['critical', 'high', 'medium', 'low'].indexOf(m.priority));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });

  test('send trims a long summary to 140 characters with an ellipsis', async () => {
    const m = await service.send(msg({ summary: 'x'.repeat(200) }));
    assert.equal(m!.summary.length, 140);
    assert.ok(m!.summary.endsWith('…'));
    const short = await service.send(msg({ summary: 'y'.repeat(140), payload: { n: 2 } }));
    assert.equal(short!.summary, 'y'.repeat(140));
  });

  test('send refuses a sender that does not own the type, an unknown recipient or priority', async () => {
    await assert.rejects(service.send(msg({ from: 'lab' })), BadRequestException);
    await assert.rejects(service.send(msg({ from: 'coordinator' })), BadRequestException);
    await assert.rejects(service.send(msg({ to: ['lab', 'nobody' as never] })), BadRequestException);
    await assert.rejects(service.send(msg({ priority: 'urgent' as never })), BadRequestException);
    assert.equal(await AgentMessage.countDocuments(), 0);
    // An agent that is not built yet is still a known recipient.
    assert.ok(await service.send(msg({ to: ['pharmacy'] })));
  });

  test('redeliverPending delivers a pending message exactly once after a restart', async () => {
    await AgentMessage.collection.insertOne({
      case: null, from: 'er', to: ['lab'], type: 'er.ping', priority: 'medium', summary: 'left over', payload: { n: 9 },
      hop: 0, dedupeKey: 'left', state: 'pending', attempts: 0, needsPerson: false, opensWork: false, createdAt: new Date(Date.now() - 60_000),
    });
    const [a, b] = await Promise.all([service.redeliverPending(), service.redeliverPending()]);
    assert.equal(a + b, 1);
    assert.equal(calls.lab.length, 1);
    assert.equal(await service.redeliverPending(), 0);
    assert.equal((await AgentMessage.findOne().lean())?.state, 'delivered');
  });

  test('redeliverPending skips a message stored in the last 10 seconds', async () => {
    await AgentMessage.collection.insertOne({
      case: null, from: 'er', to: ['lab'], type: 'er.ping', priority: 'medium', summary: 'fresh', payload: { n: 9 },
      hop: 0, dedupeKey: 'fresh', state: 'pending', attempts: 0, needsPerson: false, opensWork: false, createdAt: new Date(),
    });
    assert.equal(await service.redeliverPending(), 0);
    assert.equal(calls.lab.length, 0);
  });

  test('redeliverPending skips a message whose lock has not run out', async () => {
    await AgentMessage.collection.insertOne({
      case: null, from: 'er', to: ['lab'], type: 'er.ping', priority: 'medium', summary: 'busy', payload: { n: 9 },
      hop: 0, dedupeKey: 'busy', state: 'pending', attempts: 0, needsPerson: false, opensWork: false,
      createdAt: new Date(Date.now() - 60_000), lockedUntil: new Date(Date.now() + 30_000),
    });
    assert.equal(await service.redeliverPending(), 0);
    assert.equal(calls.lab.length, 0);
  });
});
