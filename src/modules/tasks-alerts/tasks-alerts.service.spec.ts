import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { TasksAlertsService } from './tasks-alerts.service';

describe('TasksAlertsService', () => {
  const m = models();
  let service: TasksAlertsService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    service = new TasksAlertsService(m.TaskAlertItem);
  });

  test('nobody can toggle or set the status of a lab-line critical alert; a normal alert still toggles', async () => {
    // The routes carry no role check of their own, so this holds for every role, admin included.
    const lab = await m.TaskAlertItem.create({ title: 'Critical: Electrolytes Potassium 6.4 mmol/L', type: 'Lab Alert', category: 'Critical', priority: 'High', link: 'lab-line:abc' });
    const refusal = { status: 409, message: 'Acknowledge this critical result on the Lab page.' };
    await assert.rejects(() => service.toggleStatus(String(lab._id)), refusal);
    for (const status of ['Completed', 'In Progress', 'Pending']) {
      await assert.rejects(() => service.updateStatus(String(lab._id), status), refusal);
    }
    assert.equal(((await m.TaskAlertItem.findById(lab._id).lean()) as any).status, 'Pending');

    const plain = await m.TaskAlertItem.create({ title: 'Review CBC', type: 'Lab Alert', category: 'Lab', link: 'bed-request:x' });
    assert.equal((await service.toggleStatus(String(plain._id))).status, 'Completed');
    assert.equal((await service.updateStatus(String(plain._id), 'Pending')).status, 'Pending');
  });

  test('a revenue-bill or revenue-refund alert cannot be toggled', async () => {
    for (const link of ['revenue-bill:abc', 'revenue-refund:abc']) {
      const r = await m.TaskAlertItem.create({ title: 'Final bill', type: 'System', category: 'System', priority: 'High', link });
      const refusal = { status: 409, message: 'This closes on the Revenue page.' };
      await assert.rejects(() => service.toggleStatus(String(r._id)), refusal);
      await assert.rejects(() => service.updateStatus(String(r._id), 'Completed'), refusal);
      assert.equal(((await m.TaskAlertItem.findById(r._id).lean()) as any).status, 'Pending');
    }
  });

  test('a discharge- alert cannot be toggled', async () => {
    for (const link of ['discharge-order:abc', 'discharge-order:abc:summary', 'discharge-plan:abc:reminder']) {
      const r = await m.TaskAlertItem.create({ title: 'Discharge', type: 'System', category: 'System', priority: 'High', link });
      const refusal = { status: 409, message: 'This closes on the Discharge page.' };
      await assert.rejects(() => service.toggleStatus(String(r._id)), refusal);
      await assert.rejects(() => service.updateStatus(String(r._id), 'Completed'), refusal);
      assert.equal(((await m.TaskAlertItem.findById(r._id).lean()) as any).status, 'Pending');
    }
  });

  test('a scheduling-consult alert cannot be toggled', async () => {
    const c = await m.TaskAlertItem.create({ title: 'Consult requested', type: 'System', category: 'Critical', priority: 'High', link: 'scheduling-consult:abc' });
    const refusal = { status: 409, message: 'Accept or complete this consult on the Scheduling page.' };
    await assert.rejects(() => service.toggleStatus(String(c._id)), refusal);
    await assert.rejects(() => service.updateStatus(String(c._id), 'Completed'), refusal);
    assert.equal(((await m.TaskAlertItem.findById(c._id).lean()) as any).status, 'Pending');
  });

  test('a pharmacy-line alert can not be toggled or set Completed (409); a pharmacy-rejected alert toggles', async () => {
    const q = await m.TaskAlertItem.create({ title: 'Pharmacy query: Amoxicillin 500 mg (allergy)', type: 'Medication Alert', category: 'Medication', priority: 'High', link: 'pharmacy-line:abc' });
    const refusal = { status: 409, message: 'Answer this query on the Pharmacy Agent page.' };
    await assert.rejects(() => service.toggleStatus(String(q._id)), refusal);
    for (const status of ['Completed', 'In Progress', 'Pending']) {
      await assert.rejects(() => service.updateStatus(String(q._id), status), refusal);
    }
    assert.equal(((await m.TaskAlertItem.findById(q._id).lean()) as any).status, 'Pending');
    const rej = await m.TaskAlertItem.create({ title: 'Rejected', type: 'Medication Alert', category: 'Medication', link: 'pharmacy-rejected:x' });
    assert.equal((await service.toggleStatus(String(rej._id))).status, 'Completed');
  });
});
