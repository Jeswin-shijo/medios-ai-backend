import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_DISCHARGE_CONFIG, DEFAULT_WARNING_SIGNS } from './discharge-catalogue';
import { DischargeSettingsService } from './discharge-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };
const DOCTOR = { id: 'd1', name: 'Doctor', role: UserRole.DOCTOR };
const status = (code: number) => (e: any) => e?.status === code;

describe('DischargeSettingsService', () => {
  const m = models();
  let svc: DischargeSettingsService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    svc = new DischargeSettingsService(new SettingsService(m.HospitalSettings));
  });

  test('settings: defaults; 29 minutes is 400; reminderTime 25:00 is 400; a nurse gets 403', async () => {
    const got = await svc.get();
    assert.deepEqual(got, { leaveMinutes: 120, summaryMinutes: 60, reminderTime: '09:00', warningSigns: DEFAULT_WARNING_SIGNS, gatePassHeader: '' });

    await assert.rejects(() => svc.save(ADMIN, { leaveMinutes: 29 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { leaveMinutes: 721 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { leaveMinutes: 90.5 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { leaveMinutes: '90' } as never), status(400));
    await assert.rejects(() => svc.save(ADMIN, { summaryMinutes: 14 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { summaryMinutes: 481 }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { reminderTime: '25:00' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { reminderTime: '24:00' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { reminderTime: '9:00' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { reminderTime: '09:60' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { warningSigns: '' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { warningSigns: '   ' }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { warningSigns: 'x'.repeat(1001) }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { gatePassHeader: 'x'.repeat(121) }), status(400));
    await assert.rejects(() => svc.save(ADMIN, { colour: 'red' } as never), /not a discharge setting/);
    await assert.rejects(() => svc.save(ADMIN, 'everything' as never), status(400));
    await assert.rejects(() => svc.save(NURSE, { leaveMinutes: 90 }), status(403));
    await assert.rejects(() => svc.save(DOCTOR, { leaveMinutes: 90 }), status(403));
    assert.deepEqual(await svc.get(), got, 'nothing was saved');
  });

  test('an admin saves values that merge over earlier ones, and a bad stored value falls back', async () => {
    await svc.save(ADMIN, { leaveMinutes: 90, reminderTime: '08:30' });
    const next = await svc.save(ADMIN, { summaryMinutes: 45, warningSigns: '  Come back if you feel worse.  ', gatePassHeader: "St. Mary's Hospital, Nagercoil" });
    assert.deepEqual(next, {
      leaveMinutes: 90,
      summaryMinutes: 45,
      reminderTime: '08:30',
      warningSigns: 'Come back if you feel worse.',
      gatePassHeader: "St. Mary's Hospital, Nagercoil",
    });
    const settings = new SettingsService(m.HospitalSettings);
    assert.equal((await settings.getSettings()).discharge.leaveMinutes, 90, 'saved in the discharge section');

    const edges = await svc.save(ADMIN, { leaveMinutes: 720, summaryMinutes: 15, reminderTime: '23:59', warningSigns: 'x'.repeat(1000), gatePassHeader: '' });
    assert.deepEqual(
      [edges.leaveMinutes, edges.summaryMinutes, edges.reminderTime, edges.warningSigns.length, edges.gatePassHeader],
      [720, 15, '23:59', 1000, ''],
    );
    assert.equal((await svc.save(ADMIN, { leaveMinutes: 30, summaryMinutes: 480, reminderTime: '00:00' })).reminderTime, '00:00');

    await settings.setDischarge({ leaveMinutes: 5, summaryMinutes: '60', reminderTime: '24:00', warningSigns: '', gatePassHeader: 7 });
    assert.deepEqual(await svc.get(), { ...DEFAULT_DISCHARGE_CONFIG });
  });
});
