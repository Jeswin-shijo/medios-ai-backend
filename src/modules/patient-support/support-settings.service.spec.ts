import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_SUPPORT_CONFIG } from './support-catalogue';
import { SupportSettingsService } from './support-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };
const status = (code: number) => (e: any) => e?.status === code;

describe('SupportSettingsService', () => {
  const m = models();
  let settings: SettingsService;
  let svc: SupportSettingsService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    settings = new SettingsService(m.HospitalSettings);
    svc = new SupportSettingsService(settings);
  });

  test('settings: defaults, a bad range is refused, a nurse cannot save, unknown stored values fall back', async () => {
    assert.deepEqual(await svc.get(), DEFAULT_SUPPORT_CONFIG);

    await assert.rejects(() => svc.save(NURSE, { staleHours: 6 }), status(403));
    await assert.rejects(() => svc.save(ADMIN, { staleHours: 0 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { staleHours: 49 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { urgentMinutes: 9 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { normalHours: 25 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { checkupDay: 8 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { quietStart: '24:00' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { visitingHours: '' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { visitingHours: 'x'.repeat(121) }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { workStart: '20:00' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { checkupFrom: '18:00' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { ownerByType: { ...DEFAULT_SUPPORT_CONFIG.ownerByType, billing: 'nobody' } } as never), status(400));
    await assert.rejects(() => svc.save(ADMIN, { triggers: { admitted: 'yes' } } as never), status(400));
    await assert.rejects(() => svc.save(ADMIN, { triggers: { nonsense: true } } as never), status(400));
    await assert.rejects(() => svc.save(ADMIN, { nonsense: 1 } as never), status(400));
    assert.deepEqual(await svc.get(), DEFAULT_SUPPORT_CONFIG);

    const saved = await svc.save(ADMIN, {
      staleHours: 6,
      workStart: '09:00',
      workEnd: '18:00',
      visitingHours: '  5 PM to 8 PM ',
      ownerByType: { ...DEFAULT_SUPPORT_CONFIG.ownerByType, reports: 'relations' },
      triggers: { admitted: false } as never
    });
    assert.equal(saved.staleHours, 6);
    assert.equal(saved.workStart, '09:00');
    assert.equal(saved.visitingHours, '5 PM to 8 PM');
    assert.equal(saved.ownerByType.reports, 'relations');
    assert.equal(saved.triggers.admitted, false);
    assert.equal(saved.triggers['bill-final'], true);

    // Unknown or bad stored values fall back to the defaults.
    await settings.setSupport({
      staleHours: 'lots',
      quietStart: '99:99',
      workStart: '20:00',
      workEnd: '08:00',
      ownerByType: { billing: 'nobody', reports: 'ward' },
      triggers: { admitted: 'no' },
      extra: 1
    });
    const back = await svc.get();
    assert.equal(back.staleHours, 12);
    assert.equal(back.quietStart, '21:00');
    assert.equal(back.workStart, '08:00');
    assert.equal(back.ownerByType.billing, 'billing');
    assert.equal(back.ownerByType.reports, 'ward');
    assert.equal(back.triggers.admitted, true);
  });

  test('the unique indexes exist: dedupeKey, number, sourceKey, providerCallId (sparse)', async () => {
    const unique = async (model: { collection: { indexes(): Promise<any[]> } }, key: string) =>
      (await model.collection.indexes()).find((i) => i.unique && Object.keys(i.key).length === 1 && i.key[key] === 1);
    assert.ok(await unique(m.PatientUpdate, 'dedupeKey'), 'dedupeKey');
    assert.ok(await unique(m.SupportTicket, 'number'), 'ticket number');
    assert.ok(await unique(m.CheckupCall, 'number'), 'checkup number');
    assert.ok(await unique(m.CheckupCall, 'sourceKey'), 'sourceKey');
    assert.ok(await unique(m.SupportTemplate, 'key'), 'template key');
    assert.ok(await unique(m.SupportFaq, 'topic'), 'faq topic');
    const call = await unique(m.SupportTicket, 'providerCallId');
    assert.ok(call, 'providerCallId');
    assert.equal(call.sparse, true);
    assert.ok((await m.SupportFeedback.collection.indexes()).some((i) => i.key.at === -1));
  });
});
