import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { OpdService } from './opd.service';
import { SettingsService } from '../settings/settings.service';

const session = (start: string, end: string, days = [6]) => ({ days, start, end });
const doctor = (over: Record<string, unknown> = {}) => ({
  name: 'Shajin',
  qualifications: 'MBBS',
  departmentCode: 'general-medicine',
  fee: 300,
  room: 'Room 101',
  tokenPrefix: 'G',
  sessions: [session('09:00', '13:00')],
  ...over,
});

describe('OpdService', () => {
  let opd: OpdService;
  let settingsService: SettingsService;
  const m = () => models();

  before(async () => {
    await connectTestDb();
  });
  after(closeTestDb);

  beforeEach(async () => {
    await resetTestDb();
    await m().HospitalSettings.create({ queue: { counters: ['Room 101', 'Room 102'] } });
    settingsService = new SettingsService(m().HospitalSettings);
    opd = new OpdService(m().Department, m().OpDoctor, settingsService);
    await opd.createDepartment({ code: 'general-medicine', name: 'General Medicine', tokenPrefix: 'G', icon: 'local-hospital', color: '#1D6FE0', order: 1, active: true });
    await opd.createDepartment({ code: 'paediatrics', name: 'Paediatrics', tokenPrefix: 'P', icon: 'child-care', color: '#E07B1D', order: 2, active: true });
  });

  test('createDoctor refuses a room outside the queue rooms', async () => {
    await assert.rejects(opd.createDoctor(doctor({ room: 'Room 999' })), BadRequestException);
  });

  test('createDoctor refuses an unknown department', async () => {
    await assert.rejects(opd.createDoctor(doctor({ departmentCode: 'nope' })), BadRequestException);
  });

  test('createDoctor refuses token letters used by another active doctor', async () => {
    const first = await opd.createDoctor(doctor());
    await assert.rejects(opd.createDoctor(doctor({ name: 'Other', room: 'Room 102' })), (e: any) => {
      assert.ok(e instanceof ConflictException);
      assert.match(e.message, /Token letters "G" are already used by Dr\. Shajin/);
      return true;
    });
    await opd.updateDoctor(String(first._id), { active: false });
    const second = await opd.createDoctor(doctor({ name: 'Other', room: 'Room 102' }));
    assert.equal(second.tokenPrefix, 'G');
  });

  test('updateDoctor lets a doctor keep their own token letters', async () => {
    const d = await opd.createDoctor(doctor());
    const updated = await opd.updateDoctor(String(d._id), { fee: 400 });
    assert.equal(updated.fee, 400);
  });

  test('createDoctor refuses overlapping sessions on the same day', async () => {
    await assert.rejects(
      opd.createDoctor(doctor({ sessions: [session('09:00', '13:00'), session('12:00', '14:00')] })),
      BadRequestException,
    );
    await opd.createDoctor(doctor({ sessions: [session('09:00', '13:00'), session('12:00', '14:00', [5])] }));
  });

  test('createDoctor refuses a session that ends before it starts', async () => {
    await assert.rejects(opd.createDoctor(doctor({ sessions: [session('13:00', '09:00')] })), BadRequestException);
  });

  test('suggestPrefix gives G, then G2, then G3', async () => {
    assert.equal(await opd.suggestPrefix('general-medicine'), 'G');
    await opd.createDoctor(doctor());
    assert.equal(await opd.suggestPrefix('general-medicine'), 'G2');
    await opd.createDoctor(doctor({ name: 'B', tokenPrefix: 'G2', room: 'Room 102' }));
    assert.equal(await opd.suggestPrefix('general-medicine'), 'G3');
  });

  test('defaultDoctor prefers reception.defaultDoctorId and falls back to the first active doctor', async () => {
    assert.equal(await opd.defaultDoctor(), null);
    const paed = await opd.createDoctor(doctor({ name: 'Anil', departmentCode: 'paediatrics', tokenPrefix: 'P', room: 'Room 102' }));
    const gen = await opd.createDoctor(doctor({ name: 'Zed' }));
    // No setting: first by department order, so General Medicine's Zed beats Paediatrics' Anil.
    assert.equal(String((await opd.defaultDoctor())!._id), String(gen._id));
    await settingsService.updateSettings({ reception: { defaultDoctorId: String(paed._id) } } as any);
    assert.equal(String((await opd.defaultDoctor())!._id), String(paed._id));
    await opd.updateDoctor(String(paed._id), { active: false });
    assert.equal(String((await opd.defaultDoctor())!._id), String(gen._id));
  });

  test('getDoctor answers 404 for a missing or malformed id', async () => {
    await assert.rejects(opd.getDoctor('nope'), /Doctor not found/);
  });
});
