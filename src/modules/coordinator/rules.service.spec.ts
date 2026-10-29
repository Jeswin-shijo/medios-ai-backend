import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { CoordinatorEvent, CoordinatorEvents } from './coordinator-events';
import { RulesService } from './rules.service';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });
const admin = { id: 'a', name: 'Asha', role: UserRole.ADMIN };
const doctor = { id: 'd', name: 'Dr', role: UserRole.DOCTOR };

describe('RulesService', () => {
  const { HospitalSettings } = models();
  let settings: SettingsService;
  let service: RulesService;
  let seen: CoordinatorEvent[];

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
    const events = new CoordinatorEvents();
    seen = [];
    events.events$.subscribe((e) => seen.push(e));
    service = new RulesService(registry, settings, events);
  });

  test('rules list locked, switchable and coming-soon rules; locked rules refuse changes; a rule with a settingPath writes that setting (test with ai.bedAutoAllocate); non-admins are refused', async () => {
    const list = await service.list();
    assert.deepEqual(list.map((r) => r.key), [
      'emergency-first', 'escalate-overdue', 'bed-auto-allocate', 'test-a', 'test-b', 'discharge-dependency-checks',
    ]);
    const by = (k: string) => list.find((r) => r.key === k)!;
    assert.equal(by('emergency-first').locked, true);
    assert.equal(by('emergency-first').value, true);
    assert.equal(by('test-a').value, false);
    assert.equal(by('bed-auto-allocate').value, true);
    assert.equal(list.some((r) => r.key === 'critical-lab-escalation'), false);
    assert.deepEqual(by('discharge-dependency-checks'), {
      key: 'discharge-dependency-checks', agent: 'discharge', label: 'Discharge dependency checks', description: '', value: false, locked: true, comingWith: 'discharge',
    });

    await assert.rejects(() => service.set(doctor, 'test-a', true), ForbiddenException);
    await assert.rejects(() => service.set(doctor, 'nope', true), ForbiddenException);
    await assert.rejects(() => service.set(admin, 'nope', true), NotFoundException);
    await assert.rejects(() => service.set(admin, 'discharge-dependency-checks', true), NotFoundException);
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

  test('a rule change tells open screens with a rule event; a refused change does not', async () => {
    await assert.rejects(() => service.set(doctor, 'test-a', true), ForbiddenException);
    await assert.rejects(() => service.set(admin, 'emergency-first', false), ConflictException);
    assert.equal(seen.length, 0);
    await service.set(admin, 'test-a', true);
    await service.set(admin, 'bed-auto-allocate', false);
    assert.deepEqual(seen, [{ kind: 'rule', id: 'test-a' }, { kind: 'rule', id: 'bed-auto-allocate' }]);
  });
});
