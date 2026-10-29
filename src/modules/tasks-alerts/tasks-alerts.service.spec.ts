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
});
