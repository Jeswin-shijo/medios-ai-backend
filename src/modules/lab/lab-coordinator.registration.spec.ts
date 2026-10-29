import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { TimelineService } from '../timeline/timeline.service';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import { LabOrdersService } from './lab-orders.service';
import { LabSettingsService } from './lab-settings.service';
import { SettingsService } from '../settings/settings.service';

describe('LabCoordinatorRegistration', () => {
  const m = models();
  let registry: AgentRegistry;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    const messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const orders = new LabOrdersService(m.LabRequest, m.LabLine, m.LabSample, m.LabLocation, m.CoordinatorCounter, new PatientsService(m.Patient), cases, messages, new LabSettingsService(new SettingsService(m.HospitalSettings)));
    new LabCoordinatorRegistration(registry, orders, messages, m.LabRequest, m.LabLine).onModuleInit();
  });

  test('the lab agent registers its types, clocks, rule and location handlers', async () => {
    const types = ['ordered', 'cancelled', 'collected', 'collection-done', 'received', 'rejected', 'resulted', 'request-done', 'critical', 'critical-acked'];
    for (const t of types) assert.equal(registry.messageType(`lab.${t}`)?.agent, 'lab', t);
    for (const k of ['lab-collect', 'lab-recollect', 'lab-tat', 'lab-critical']) assert.ok(registry.clock(k), k);
    const rule = registry.rules().find((r) => r.key === 'critical-lab-escalation')!;
    assert.deepEqual([rule.agent, rule.default, rule.locked, rule.label], ['lab', true, true, 'Critical lab result escalation']);

    const req = 'r1';
    assert.equal(registry.clock('lab-collect')!.refFrom!('lab.ordered', { requestId: req }), req);
    assert.equal(registry.clock('lab-critical')!.refFrom!('lab.critical-acked', { lineId: 'l1' }), 'l1');
    assert.equal(registry.clock('lab-critical')!.minutes, 15);
    assert.equal(registry.clock('lab-critical')!.ladder, 'lab-critical');
    const tat = registry.clock('lab-tat')!;
    assert.equal(tat.match!('lab.received', { firstReceive: false }), false);
    assert.equal(tat.match!('lab.received', { firstReceive: true }), true);
    assert.equal(tat.match!('lab.resulted', {}), true);
    assert.deepEqual(tat.updateOn, ['lab.resulted', 'lab.cancelled']);
    const due = new Date(Date.now() + 60_000);
    assert.equal(tat.dueFrom!({ tatDueAt: due.toISOString() })!.getTime(), due.getTime());
    assert.ok(registry.clocksStoppingOn('lab.request-done').length >= 3);
    for (const t of ['er.arrived', 'bed.assigned', 'bed.transferred', 'er.left', 'bed.discharged']) {
      assert.ok(registry.subscribers(t).some((s) => s.agent === 'lab'), t);
    }
    const lab = registry.definitions().find((d) => d.key === 'lab')!;
    assert.deepEqual(await lab.status(), { open: 0, capacity: 0, onTimePct: null });
  });

  test('the close check is n/a with no lines, fails while any is open or a critical is unacknowledged', async () => {
    const check = registry.closeChecks().find((c) => c.agent === 'lab')!;
    const caseId = new Types.ObjectId();
    assert.equal(await check.check(String(caseId)), 'n/a');
    const request = await m.LabRequest.create({
      number: 'LR-0001', patient: new Types.ObjectId(), patientUhid: 'U', patientName: 'N', case: caseId,
      orderedBy: { id: 'u', name: 'D' }, priority: 'stat', orderedAt: new Date(), collectBy: new Date(),
    });
    const line = await m.LabLine.create({ request: request._id, test: 'cbc', status: 'ordered', tatDueAt: new Date() });
    assert.equal(await check.check(String(caseId)), 'fail');
    await m.LabLine.updateOne({ _id: line._id }, { status: 'released', critical: { active: true } });
    assert.equal(await check.check(String(caseId)), 'fail');
    await m.LabLine.updateOne({ _id: line._id }, { 'critical.ackAt': new Date() });
    assert.equal(await check.check(String(caseId)), 'pass');
    await m.LabLine.updateOne({ _id: line._id }, { status: 'cancelled', critical: { active: false } });
    assert.equal(await check.check(String(caseId)), 'pass');
  });
});
