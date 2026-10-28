import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { UserRole } from '../users/schemas/user.schema';
import { SettingsService } from './settings.service';

const DOCTOR = { role: UserRole.DOCTOR };
const ADMIN = { role: UserRole.ADMIN };

describe('SettingsService', () => {
  const { HospitalSettings } = models();
  let settings: SettingsService;

  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    settings = new SettingsService(HospitalSettings);
  });

  test('a doctor cannot change ai.bedAutoAllocate; an admin can', async () => {
    await assert.rejects(
      () => settings.updateSettings({ ai: { bedAutoAllocate: false } }, DOCTOR),
      (err: unknown) => err instanceof ForbiddenException && err.message === 'Only an admin can change automatic bed allocation.',
    );
    assert.equal((await settings.getSettings()).ai.bedAutoAllocate, true);

    await settings.updateSettings({ ai: { bedAutoAllocate: false } }, ADMIN);
    assert.equal((await settings.getSettings()).ai.bedAutoAllocate, false);

    // A doctor's save that carries the stored value, or leaves it out, goes through.
    await settings.updateSettings({ ai: { bedAutoAllocate: false, responseTone: 'Detailed' } }, DOCTOR);
    await settings.updateSettings({ ai: { bedSuggestions: false }, profile: { name: 'Dr. Shajin' } }, DOCTOR);
    const saved = await settings.getSettings();
    assert.equal(saved.ai.bedAutoAllocate, false);
    assert.equal(saved.ai.responseTone, 'Detailed');
    assert.equal(saved.ai.bedSuggestions, false);
    assert.equal(saved.profile.name, 'Dr. Shajin');

    await assert.rejects(() => settings.updateSettings({ ai: { bedAutoAllocate: true } }, DOCTOR), ForbiddenException);
    assert.equal((await settings.getSettings()).ai.bedAutoAllocate, false);
  });

  test('an ai patch with one key keeps the other ai keys', async () => {
    await settings.updateSettings({ ai: { model: 'claude-opus-5-5', bedSuggestions: true } }, ADMIN);

    await settings.updateSettings({ ai: { bedAutoAllocate: false } }, ADMIN);

    const { ai } = await settings.getSettings();
    assert.equal(ai.model, 'claude-opus-5-5');
    assert.equal(ai.bedSuggestions, true);
    assert.equal(ai.bedAutoAllocate, false);
  });
});
