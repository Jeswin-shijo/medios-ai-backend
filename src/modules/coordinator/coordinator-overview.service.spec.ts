import * as assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { after, before, beforeEach, describe, test } from 'node:test';
import { hourOf } from '../../common/utils/series';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentStatusService } from './agent-status.service';
import { AgentRegistry } from './agent-registry';
import { CoordinatorEvent, CoordinatorEvents } from './coordinator-events';
import { CoordinatorOverviewService } from './coordinator-overview.service';
import { MessagesService } from './messages.service';

const MIN = 60_000;

describe('AgentStatusService and CoordinatorOverviewService', () => {
  const { AgentMessage, Case, CoordinatorSnapshot, Escalation } = models();
  let registry: AgentRegistry;
  let events: CoordinatorEvents;
  let seen: CoordinatorEvent[];
  let messages: MessagesService;
  let statuses: AgentStatusService;
  let overview: CoordinatorOverviewService;
  let approvalsOpen = 0;
  let clocksRunning = 0;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    approvalsOpen = 0;
    clocksRunning = 0;
    registry = new AgentRegistry();
    events = new CoordinatorEvents();
    seen = [];
    events.events$.subscribe((e) => seen.push(e));
    messages = new MessagesService(AgentMessage, registry, events);
    statuses = new AgentStatusService(registry, events);
    overview = new CoordinatorOverviewService(
      CoordinatorSnapshot,
      Case,
      Escalation,
      statuses,
      messages,
      { countOpen: async () => approvalsOpen } as any,
      { countRunning: async () => clocksRunning } as any,
    );
  });

  test('poll marks an agent online, and offline after 2 minutes without a successful poll', async () => {
    let fail = false;
    registry.register({
      key: 'er',
      messageTypes: [],
      status: async () => {
        if (fail) throw new Error('down');
        return { open: 4, capacity: 10, onTimePct: 90 };
      },
    });
    const t0 = new Date('2026-10-29T10:00:00Z');
    const find = (now: Date) => statuses.list(now).find((a) => a.key === 'er')!;
    assert.equal(find(t0).online, false);

    await statuses.poll(t0);
    assert.deepEqual(
      { ...find(new Date(t0.getTime() + MIN)) },
      { key: 'er', name: 'ER', job: find(t0).job, built: true, online: true, open: 4, capacity: 10, onTimePct: 90 },
    );
    assert.equal(seen.filter((e) => e.summary === 'ER online').length, 1);

    fail = true;
    await statuses.poll(new Date(t0.getTime() + 3 * MIN));
    assert.equal(find(new Date(t0.getTime() + 3 * MIN)).online, false);
    assert.equal(seen.filter((e) => e.summary === 'ER offline').length, 1);
    assert.equal(seen.filter((e) => e.kind === 'agent' && e.id === 'er').length, 2);
  });

  test('unbuilt agents are listed as not built', async () => {
    const list = statuses.list();
    assert.equal(list.length, 9);
    assert.equal(list[0].key, 'coordinator');
    const lab = list.find((a) => a.key === 'lab')!;
    assert.deepEqual(
      { built: lab.built, online: lab.online, open: lab.open, capacity: lab.capacity, onTimePct: lab.onTimePct },
      { built: false, online: false, open: 0, capacity: 0, onTimePct: null },
    );
    assert.equal(list[0].built, true);
  });

  test('overview cards count open cases, online agents of 9, messages today and open escalations', async () => {
    await Case.collection.insertMany([{ number: 'C1', patient: new Types.ObjectId(), state: 'open' }, { number: 'C2', patient: new Types.ObjectId(), state: 'open' }, { number: 'C3', state: 'closed' }]);
    await Escalation.collection.insertMany([
      { state: 'open', createdAt: new Date() },
      { state: 'acknowledged', createdAt: new Date() },
    ]);
    approvalsOpen = 2;
    clocksRunning = 3;
    await AgentMessage.collection.insertMany([
      { createdAt: new Date() },
      { createdAt: new Date() },
      { createdAt: new Date(Date.now() - 3 * 24 * 3_600_000) },
    ]);
    await statuses.poll(new Date());

    const o = await overview.overview();
    assert.equal(o.cards.activeWorkflows.value, 2);
    assert.equal(o.cards.activeWorkflows.note, 'open cases');
    assert.equal(o.cards.agentsCoordinated.value, 1);
    assert.equal(o.cards.agentsCoordinated.total, 9);
    assert.equal(o.cards.tasksRouted.value, 2);
    assert.equal(o.cards.escalations.value, 3);
    assert.equal(o.cards.escalations.trendPct, null);
    assert.equal(o.cards.escalations.spark.length, 24);
    assert.equal(o.agents.length, 9);
    assert.equal(o.openApprovals, 2);
    assert.equal(o.runningClocks, 3);
  });

  test('snapshot upserts one record per real hour', async () => {
    await overview.snapshot();
    approvalsOpen = 5;
    await overview.snapshot();
    const all: any[] = await CoordinatorSnapshot.find().lean();
    assert.equal(all.length, 1);
    assert.equal(all[0].hour.getTime(), hourOf(new Date()).getTime());
    assert.equal(all[0].escalations, 5);

    const { range, points } = await overview.series('24h');
    assert.equal(range, '24h');
    assert.equal(points.length, 24);
    assert.equal(points[23].escalations, 5);
    assert.equal(points[0].escalations, null);
    assert.equal((await overview.series('7d')).points.length, 168);
  });
});
