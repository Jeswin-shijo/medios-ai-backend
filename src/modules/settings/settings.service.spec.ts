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

  test('a call without a caller still cannot change an admin-only key', async () => {
    await assert.rejects(
      () => settings.updateSettings({ ai: { bedAutoAllocate: false } }),
      (err) => err instanceof ForbiddenException,
    );
    assert.equal((await settings.getSettings()).ai.bedAutoAllocate, true);
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

  test('only an admin can change coordination rules; other saves still work', async () => {
    await assert.rejects(
      () => settings.updateSettings({ coordinator: { rules: { x: true } } } as any, DOCTOR),
      (err: unknown) => err instanceof ForbiddenException && err.message === 'Only an admin can change coordination rules.',
    );
    assert.deepEqual((await settings.getSettings() as any).coordinator.rules, {});
    await settings.updateSettings({ profile: { name: 'Dr. Shajin' } }, DOCTOR);
    await settings.updateSettings({ coordinator: { rules: {} } } as any, DOCTOR);
    await settings.updateSettings({ coordinator: { rules: { x: true } } } as any, ADMIN);
    assert.deepEqual((await settings.getSettings() as any).coordinator.rules, { x: true });
  });

  test('only an admin can change changes by phone or the public address; a doctor can save the rest', async () => {
    const callAgent = async () => (await settings.getSettings() as any).callAgent;
    await assert.rejects(
      () => settings.updateSettings({ callAgent: { inboundChanges: false } } as any, DOCTOR),
      (err: unknown) => err instanceof ForbiddenException && err.message === 'Only an admin can turn appointment changes by phone on or off.',
    );
    await assert.rejects(
      () => settings.updateSettings({ callAgent: { publicApiUrl: 'https://evil.example.com' } } as any, DOCTOR),
      (err: unknown) => err instanceof ForbiddenException && err.message === "Only an admin can change the API's public address.",
    );
    assert.equal((await callAgent()).inboundChanges, true);
    assert.equal((await callAgent()).publicApiUrl, '');

    await settings.updateSettings({ callAgent: { inboundChanges: false, publicApiUrl: 'https://medios-api.onrender.com/api/' } } as any, ADMIN);
    // The web app sends the whole section back as the server resolved it.
    await settings.updateSettings({ callAgent: { ...(await callAgent()), publicApiUrl: 'https://medios-api.onrender.com', agentName: 'Meena' } } as any, DOCTOR);
    await settings.updateSettings({ callAgent: { agentName: 'Meena' } } as any, DOCTOR);
    const saved = await callAgent();
    assert.equal(saved.agentName, 'Meena');
    assert.equal(saved.inboundChanges, false);

    await assert.rejects(() => settings.updateSettings({ callAgent: { inboundChanges: true } } as any, DOCTOR), ForbiddenException);
    await assert.rejects(() => settings.updateSettings({ callAgent: { publicApiUrl: '' } } as any, DOCTOR), ForbiddenException);
  });
});
