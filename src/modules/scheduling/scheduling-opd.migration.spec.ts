import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingOpdMigration } from './scheduling-opd.migration';

describe('SchedulingOpdMigration (a database with no OP doctors)', () => {
  const m = models();
  let settings: SettingsService;
  let migration: SchedulingOpdMigration;

  const doctorUser = (name: string, email: string, extra: Record<string, unknown> = {}) => m.User.create({ email, passwordHash: 'x', name, role: 'doctor', ...extra });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await m.Department.syncIndexes();
    await m.OpDoctor.syncIndexes();
    settings = new SettingsService(m.HospitalSettings);
    await settings.updateSettings({ queue: { counters: ['Room 7', 'Room 8'] }, callAgent: { clinicSessions: '09:00-13:00, 14:00-17:00', closedDays: ['Sun'] } } as never, { role: UserRole.ADMIN });
    migration = new SchedulingOpdMigration(m.Department, m.OpDoctor, m.User, settings);
  });

  test('creates General Medicine, one OP doctor from the first active doctor login, and the default doctor', async () => {
    await m.User.create({ email: 'nurse@x.in', passwordHash: 'x', name: 'Nurse', role: 'nurse' });
    await doctorUser('Dr. Off', 'off@x.in', { isActive: false });
    const shajin = await doctorUser('Dr. Shajin', 'shajin@x.in');
    await doctorUser('Dr. Later', 'later@x.in');
    const out = await migration.run();
    assert.equal(out, 'created');
    const depts = (await m.Department.find({}).lean()) as any[];
    assert.deepEqual(depts.map((d) => [d.code, d.name, d.tokenPrefix, d.active]), [['general-medicine', 'General Medicine', 'G', true]]);
    const docs = (await m.OpDoctor.find({}).lean()) as any[];
    assert.equal(docs.length, 1);
    assert.deepEqual([docs[0].name, docs[0].departmentCode, docs[0].room, docs[0].tokenPrefix, docs[0].userId, docs[0].active], ['Dr. Shajin', 'general-medicine', 'Room 7', 'G', String(shajin._id), true]);
    assert.deepEqual(docs[0].sessions.map((s: any) => [s.days, s.start, s.end]), [[[1, 2, 3, 4, 5, 6], '09:00', '13:00'], [[1, 2, 3, 4, 5, 6], '14:00', '17:00']]);
    const stored = (await settings.getSettings()) as any;
    assert.equal(stored.reception.defaultDoctorId, String(docs[0]._id));
    assert.equal((stored.queue.counters as string[]).join(','), 'Room 7,Room 8', 'the queue rooms are untouched');
  });

  test('is idempotent: a second run, or any existing OP doctor, changes nothing', async () => {
    await doctorUser('Dr. Shajin', 'shajin@x.in');
    assert.equal(await migration.run(), 'created');
    assert.equal(await migration.run(), 'skipped');
    assert.equal(await m.OpDoctor.countDocuments({}), 1);
    assert.equal(await m.Department.countDocuments({}), 1);
  });

  test('keeps an existing department and does nothing without a doctor login', async () => {
    assert.equal(await migration.run(), 'skipped', 'no doctor login: nothing to name the doctor after');
    assert.equal(await m.Department.countDocuments({}), 0);
    await m.Department.create({ code: 'paeds', name: 'Paediatrics', tokenPrefix: 'P', order: 1, active: true });
    await doctorUser('Dr. Shajin', 'shajin@x.in');
    assert.equal(await migration.run(), 'created');
    assert.equal(await m.Department.countDocuments({}), 1, 'no General Medicine added when a department exists');
    assert.equal(((await m.OpDoctor.findOne({}).lean()) as any).departmentCode, 'paeds');
  });
});
