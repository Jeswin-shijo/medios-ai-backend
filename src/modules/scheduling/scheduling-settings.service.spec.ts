import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_CONSULT_TARGETS, DEFAULT_SHIFTS, DEFAULT_WAIT_TARGETS, PROCEDURES, ROOMS } from './scheduling-catalogue';
import { SchedulingSettingsService } from './scheduling-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DOCTOR = { id: 'd1', name: 'Dr', role: UserRole.DOCTOR };

describe('SchedulingSettingsService', () => {
  const m = models();
  let svc: SchedulingSettingsService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    svc = new SchedulingSettingsService(new SettingsService(m.HospitalSettings));
  });

  test('settings default to the spec values and refuse 0 or 1441 minutes', async () => {
    const got = await svc.get();
    assert.deepEqual(got.shifts, DEFAULT_SHIFTS);
    assert.deepEqual(got.consultTargets, DEFAULT_CONSULT_TARGETS);
    assert.deepEqual(got.waitTargets, DEFAULT_WAIT_TARGETS);
    assert.deepEqual(Object.keys(got.roomHours), ROOMS.map((r) => r.key));
    assert.deepEqual(got.roomHours['cath-lab'], { open: '08:00', close: '18:00', turnover: 15 });
    assert.equal(got.procedureMinutes['coronary-angioplasty'], 90);
    assert.equal(Object.keys(got.procedureMinutes).length, PROCEDURES.length);

    for (const bad of [0, 1441, 1.5, '30', null]) {
      await assert.rejects(() => svc.save(ADMIN, { procedureMinutes: { 'hernia-repair': bad } }), /1 to 1440/);
      await assert.rejects(() => svc.save(ADMIN, { consultTargets: { stat: bad } }), /1 to 1440/);
      await assert.rejects(() => svc.save(ADMIN, { waitTargets: { urgent: bad } }), /1 to 1440/);
    }
    assert.deepEqual(await svc.get(), got);
  });

  test('an admin saves values that merge over earlier ones; others and unknown keys are refused', async () => {
    await svc.save(ADMIN, { consultTargets: { stat: 20 }, shifts: { night: { start: '21:00', end: '07:00' } } });
    const next = await svc.save(ADMIN, { consultTargets: { urgent: 90 }, roomHours: { xray: { open: '07:00', close: '21:00', turnover: 5 } }, procedureMinutes: { 'chest-xray': 12 } });
    assert.deepEqual(next.consultTargets, { stat: 20, urgent: 90, routine: 1440 });
    assert.deepEqual(next.shifts.night, { start: '21:00', end: '07:00' });
    assert.deepEqual(next.shifts.morning, DEFAULT_SHIFTS.morning);
    assert.deepEqual(next.roomHours.xray, { open: '07:00', close: '21:00', turnover: 5 });
    assert.equal(next.procedureMinutes['chest-xray'], 12);

    await assert.rejects(() => svc.save(DOCTOR, { consultTargets: { stat: 5 } }), /Only an admin/);
    await assert.rejects(() => svc.save(ADMIN, { colour: 'red' }), /not a scheduling setting/);
    await assert.rejects(() => svc.save(ADMIN, { procedureMinutes: { nope: 5 } }), /not a procedure/);
    await assert.rejects(() => svc.save(ADMIN, { consultTargets: { critical: 5 } }), /stat, urgent or routine/);
    await assert.rejects(() => svc.save(ADMIN, { shifts: { dawn: { start: '05:00', end: '08:00' } } }), /not a shift/);
    await assert.rejects(() => svc.save(ADMIN, { shifts: { night: { start: '25:00', end: '08:00' } } }), /HH:MM/);
    await assert.rejects(() => svc.save(ADMIN, { roomHours: { ot_9: { open: '08:00', close: '09:00', turnover: 5 } } }), /not a room/);
    await assert.rejects(() => svc.save(ADMIN, { roomHours: { xray: { open: '20:00', close: '08:00', turnover: 5 } } }), /open before close/);
    await assert.rejects(() => svc.save(ADMIN, 'x'), /Send the settings/);
    assert.equal((await svc.get()).consultTargets.stat, 20);
  });
});
