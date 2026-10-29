import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { RulesService } from './rules.service';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });
const admin = { id: 'a', name: 'Asha', role: UserRole.ADMIN };
const doctor = { id: 'd', name: 'Dr', role: UserRole.DOCTOR };

describe('RulesService', () => {
  const { HospitalSettings } = models();
  let settings: SettingsService;
  let service: RulesService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    settings = new SettingsService(HospitalSettings);
    const registry = new AgentRegistry();
    registry.register({
      key: 'bed',
      messageTypes: [],
      rules: [
        { key: 'bed-auto-allocate', agent: 'bed', label: 'Allocate beds automatically', description: 'd', default: true, settingPath: 'ai.bedAutoAllocate' },
        { key: 'test-a', agent: 'bed', label: 'A', description: 'a', default: false },
        { key: 'test-b', agent: 'bed', label: 'B', description: 'b', default: true },
      ],
      status,
    });
    service = new RulesService(registry, settings);
  });

  test('rules list locked, switchable and coming-soon rules; locked rules refuse changes; a rule with a settingPath writes that setting (test with ai.bedAutoAllocate); non-admins are refused', async () => {
    const list = await service.list();
    assert.deepEqual(list.map((r) => r.key), [
      'emergency-first', 'escalate-overdue', 'bed-auto-allocate', 'test-a', 'test-b', 'critical-lab-escalation', 'discharge-dependency-checks',
    ]);
    const by = (k: string) => list.find((r) => r.key === k)!;
    assert.equal(by('emergency-first').locked, true);
    assert.equal(by('emergency-first').value, true);
    assert.equal(by('test-a').value, false);
    assert.equal(by('bed-auto-allocate').value, true);
    assert.deepEqual(by('critical-lab-escalation'), {
      key: 'critical-lab-escalation', agent: 'lab', label: 'Critical lab result escalation', description: '', value: false, locked: true, comingWith: 'lab',
    });

    await assert.rejects(() => service.set(doctor, 'test-a', true), ForbiddenException);
    await assert.rejects(() => service.set(doctor, 'nope', true), ForbiddenException);
    await assert.rejects(() => service.set(admin, 'nope', true), NotFoundException);
    await assert.rejects(() => service.set(admin, 'critical-lab-escalation', true), NotFoundException);
    await assert.rejects(() => service.set(admin, 'emergency-first', false), (e: unknown) => e instanceof ConflictException && e.message === 'This rule is always on.');

    // A rule with a settingPath writes that setting.
    const view = await service.set(admin, 'bed-auto-allocate', false);
    assert.equal(view.value, false);
    assert.equal((await settings.getSettings()).ai.bedAutoAllocate, false);
    assert.equal(await service.isOn('bed-auto-allocate'), false);

    // Changing one coordinator rule does not drop another.
    await service.set(admin, 'test-a', true);
    await service.set(admin, 'test-b', false);
    assert.equal(await service.isOn('test-a'), true);
    assert.equal(await service.isOn('test-b'), false);
    assert.deepEqual((await settings.getSettings()).coordinator.rules, { 'test-a': true, 'test-b': false });
    assert.equal(await service.isOn('emergency-first'), true);
    assert.equal(await service.isOn('unknown'), false);
  });
});
