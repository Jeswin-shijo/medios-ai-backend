import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { PHARMACY_CLOCKS, PHARMACY_MESSAGE_TYPES, PharmacyCoordinatorRegistration } from './pharmacy-coordinator.registration';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { PharmacyPatientsService } from './pharmacy-patients.service';
import { PharmacySettingsService } from './pharmacy-settings.service';

describe('PharmacyCoordinatorRegistration', () => {
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
    const orders = new PharmacyOrdersService(
      m.PharmacyOrder, m.PharmacyLine, m.PharmacyLocation, m.CoordinatorCounter,
      new PatientsService(m.Patient), cases, messages, new PharmacySettingsService(new SettingsService(m.HospitalSettings)), new PharmacyPatientsService(m.Patient, m.LabTestReport),
    );
    new PharmacyCoordinatorRegistration(registry, orders, messages, new PharmacyChecksService(m.PharmacyLine, m.PharmacyOrder, m.TaskAlertItem, orders, cases, messages, new PharmacySettingsService(new SettingsService(m.HospitalSettings))), m.PharmacyOrder, m.PharmacyLine, m.Clock).onModuleInit();
  });

  test('the pharmacy agent registers its 12 message types, 3 clocks, the locked rule and the location handlers', async () => {
    const types = ['ordered', 'to-check', 'approved', 'to-issue', 'query', 'query-answered', 'rejected', 'issued', 'cancelled', 'stopped', 'check-done', 'issue-done'];
    assert.equal(PHARMACY_MESSAGE_TYPES.length, 12);
    for (const t of types) assert.equal(registry.messageType(`pharmacy.${t}`)?.agent, 'pharmacy', t);
    assert.equal(PHARMACY_CLOCKS.length, 3);
    for (const k of ['pharmacy-check', 'pharmacy-issue', 'pharmacy-query']) assert.ok(registry.clock(k), k);

    const rule = registry.rules().find((r) => r.key === 'medicine-safety-checks')!;
    assert.deepEqual([rule.agent, rule.default, rule.locked, rule.label], ['pharmacy', true, true, 'Medicine safety checks']);
    assert.equal(rule.description, 'Check every medicine order for allergy, clashes, doubles, dose and kidney function');

    for (const t of ['lab.resulted', 'er.arrived', 'bed.assigned', 'bed.transferred', 'er.left', 'bed.discharged']) {
      assert.ok(registry.subscribers(t).some((s) => s.agent === 'pharmacy'), t);
    }
    const def = registry.definitions().find((d) => d.key === 'pharmacy')!;
    assert.deepEqual(await def.status(), { open: 0, capacity: 0, onTimePct: null });
  });

  test('the clocks: refs carry the round or query, dues come from the payload, and the issue clock skips OPD', () => {
    const check = registry.clock('pharmacy-check')!;
    const issue = registry.clock('pharmacy-issue')!;
    const query = registry.clock('pharmacy-query')!;
    assert.deepEqual([check.ladder, issue.ladder, query.ladder], ['pharmacy', 'pharmacy', 'pharmacy-query']);
    assert.deepEqual([check.minutes, issue.minutes, query.minutes], [240, 240, 120]);
    assert.deepEqual([check.startOn, check.stopOn], ['pharmacy.to-check', ['pharmacy.check-done']]);
    assert.deepEqual([issue.startOn, issue.stopOn], ['pharmacy.to-issue', ['pharmacy.issue-done']]);
    assert.deepEqual([query.startOn, query.stopOn], ['pharmacy.query', ['pharmacy.query-answered', 'pharmacy.cancelled', 'pharmacy.stopped']]);

    assert.equal(check.refFrom!('pharmacy.to-check', { orderId: 'o1', checkRound: 2 }), 'o1:c2');
    assert.equal(check.refFrom!('pharmacy.check-done', { orderId: 'o1', checkRound: 1 }), 'o1:c1');
    assert.equal(issue.refFrom!('pharmacy.issue-done', { orderId: 'o1', issueRound: 3 }), 'o1:i3');
    assert.equal(query.refFrom!('pharmacy.query', { lineId: 'l1', querySeq: 2 }), 'l1:q2');
    assert.equal(query.refFrom!('pharmacy.cancelled', { lineId: 'l1', querySeq: 2 }), 'l1:q2');

    const due = new Date(Date.now() + 60_000);
    assert.equal(check.dueFrom!({ checkDueAt: due.toISOString() })!.getTime(), due.getTime());
    assert.equal(issue.dueFrom!({ issueDueAt: due })!.getTime(), due.getTime());
    assert.equal(query.dueFrom!({ queryDueAt: due })!.getTime(), due.getTime());
    assert.equal(check.dueFrom!({}), null);
    assert.deepEqual(check.updateOn, issue.updateOn);
    assert.ok(check.updateOn!.includes('pharmacy.approved') && check.updateOn!.includes('pharmacy.query'));

    assert.equal(issue.match!('pharmacy.to-issue', { setting: 'OPD' }), false);
    assert.equal(issue.match!('pharmacy.to-issue', { setting: 'ER' }), true);
    assert.equal(issue.match!('pharmacy.issue-done', { orderId: 'o1' }), true);

    assert.equal(query.resolveEscalationOnStop, true);
    assert.equal(query.resolvedBy, 'Query answered');
    assert.equal(query.alertLink!('l1:q2'), 'pharmacy-line:l1');
    assert.equal(query.alertLink!(null), null);
    assert.equal(check.resolveEscalationOnStop, undefined);
    assert.equal(check.detailFrom!({ orderNumber: 'MO-0001', medicine: 'enoxaparin' }), 'MO-0001 · Enoxaparin');
    assert.equal(query.detailFrom!({ orderNumber: 'MO-0001', medicine: 'enoxaparin', kind: 'kidney' }), 'MO-0001 · Enoxaparin · kidney');
    assert.equal(check.detailFrom!({ orderNumber: 'MO-0002', medicine: 'unlisted' }), 'MO-0002 · Unlisted medicine');
  });

  test('a generic settings patch never changes the pharmacy section', async () => {
    const settings = new SettingsService(m.HospitalSettings);
    const reader = new PharmacySettingsService(settings);
    assert.deepEqual(await reader.targets(), { check: { stat: 15, urgent: 60, routine: 240 }, issue: { stat: 15, urgent: 60, routine: 240 }, query: { stat: 30, urgent: 30, routine: 120 } });
    assert.equal(await reader.nearExpiryDays(), 90);
    for (const role of [UserRole.ADMIN, UserRole.DOCTOR]) {
      await settings.updateSettings({ pharmacy: { targets: { check: { stat: 5 } }, nearExpiryDays: 7 } } as never, { role });
    }
    assert.equal((await reader.targets()).check.stat, 15);
    assert.equal(await reader.nearExpiryDays(), 90);
    // The read side takes only valid saved values.
    await m.HospitalSettings.updateOne({}, { $set: { pharmacy: { targets: { check: { stat: 5, urgent: 0 }, issue: { routine: 1441 } }, nearExpiryDays: 366 } } });
    const t = await reader.targets();
    assert.deepEqual([t.check.stat, t.check.urgent, t.issue.routine], [5, 60, 240]);
    assert.equal(await reader.nearExpiryDays(), 90);
    await m.HospitalSettings.updateOne({}, { $set: { 'pharmacy.nearExpiryDays': 30 } });
    assert.equal(await reader.nearExpiryDays(), 30);
  });
});
