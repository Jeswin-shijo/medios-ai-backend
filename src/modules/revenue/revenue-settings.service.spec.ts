import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_DEPOSITS } from './revenue-catalogue';
import { RevenueSettingsService, defaultRevenueConfig } from './revenue-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const STAFF = { id: 's1', name: 'Front', role: UserRole.STAFF };

describe('RevenueSettingsService', () => {
  const m = models();
  let svc: RevenueSettingsService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    svc = new RevenueSettingsService(new SettingsService(m.HospitalSettings));
  });

  test('settings refuse a 49% threshold and an unknown key; a non-admin save is 403', async () => {
    const got = await svc.get();
    assert.deepEqual(got, defaultRevenueConfig());
    assert.deepEqual(got.deposits, DEFAULT_DEPOSITS);
    assert.equal(got.topupThreshold, 80);
    assert.deepEqual(got.clocks, { final: 60, topup: 240, refund: 2880 });

    await assert.rejects(() => svc.save(ADMIN, { topupThreshold: 49 }), (e: any) => e.status === 400);
    await assert.rejects(() => svc.save(ADMIN, { topupThreshold: 101 }), (e: any) => e.status === 400);
    await assert.rejects(() => svc.save(ADMIN, { colour: 'red' }), /not a revenue setting/);
    await assert.rejects(() => svc.save(ADMIN, { clocks: { final: 0 } }), (e: any) => e.status === 400);
    await assert.rejects(() => svc.save(ADMIN, { clocks: { final: 10081 } }), (e: any) => e.status === 400);
    await assert.rejects(() => svc.save(ADMIN, { receiptHeader: 'x'.repeat(121) }), (e: any) => e.status === 400);
    await assert.rejects(() => svc.save(ADMIN, { deposits: { emergency: 5 } }), (e: any) => e.status === 400);
    await assert.rejects(() => svc.save(STAFF, { topupThreshold: 70 }), (e: any) => e.status === 403);
    assert.deepEqual(await svc.get(), got);
  });

  test('an admin saves values that merge over earlier ones, and a bad stored value falls back', async () => {
    await svc.save(ADMIN, { topupThreshold: 70, deposits: { general: 12000 } });
    const next = await svc.save(ADMIN, { deposits: { critical: 60000 }, clocks: { topup: 120 }, stay: { hdu: 3 }, receiptHeader: 'Test Hospital' });
    assert.deepEqual(next.deposits, { general: 12000, private: 25000, critical: 60000 });
    assert.equal(next.topupThreshold, 70);
    assert.deepEqual(next.clocks, { final: 60, topup: 120, refund: 2880 });
    assert.equal(next.stay.hdu, 3);
    assert.equal(next.receiptHeader, 'Test Hospital');

    await new SettingsService(m.HospitalSettings).setRevenue({ topupThreshold: 12, deposits: { general: -4 } } as never);
    const fallback = await svc.get();
    assert.equal(fallback.topupThreshold, 80);
    assert.equal(fallback.deposits.general, 10000);
  });
});
