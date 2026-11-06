import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { OpdService } from './opd.service';
import { UpdateDepartmentDto, UpdateDoctorDto } from './dto/opd.dto';
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

  test('a doctor whose name already says "Dr." is named once in the token-letters refusal (R33)', async () => {
    await opd.createDoctor(doctor({ name: 'Dr. Shajin' }));
    const said = (e: any) => {
      assert.ok(e instanceof ConflictException);
      assert.equal(e.message, 'Token letters "G" are already used by Dr. Shajin');
      return true;
    };
    await assert.rejects(opd.createDoctor(doctor({ name: 'Other', room: 'Room 102' })), said);
    // The same words when another desk won the race for the letters.
    await assert.rejects((opd as any).rethrowPrefixClash({ code: 11000 }, 'G'), said);
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

  test('concurrent creates with the same token letters leave exactly one active doctor', async () => {
    const results = await Promise.allSettled([
      opd.createDoctor(doctor({ name: 'A' })),
      opd.createDoctor(doctor({ name: 'B', room: 'Room 102' })),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof ConflictException);
    assert.equal(await m().OpDoctor.countDocuments({ active: true, tokenPrefix: 'G' }), 1);
  });

  test('the database refuses a second active doctor with the same letters, even past the service', async () => {
    await opd.createDoctor(doctor());
    await assert.rejects(m().OpDoctor.create({ ...doctor({ name: 'Raw' }) }), (e: any) => e.code === 11000);
  });

  test('updateDoctor reactivating onto taken letters answers 409', async () => {
    const a = await opd.createDoctor(doctor({ name: 'A' }));
    await opd.updateDoctor(String(a._id), { active: false });
    await opd.createDoctor(doctor({ name: 'B', room: 'Room 102' }));
    await assert.rejects(opd.updateDoctor(String(a._id), { active: true }), ConflictException);
  });

  test('updateDepartment and updateDoctor answer 404 for a malformed or unknown id', async () => {
    await assert.rejects(opd.updateDepartment('nope', { name: 'x' }), /Department not found/);
    await assert.rejects(opd.updateDepartment('000000000000000000000000', { name: 'x' }), /Department not found/);
    await assert.rejects(opd.updateDoctor('nope', { fee: 1 }), /Doctor not found/);
  });

  test('a partial doctor update changes only the fields sent', async () => {
    const d = await opd.createDoctor(doctor());
    const dto = Object.assign(new UpdateDoctorDto(), { active: false, room: undefined, fee: undefined });
    const updated = await opd.updateDoctor(String(d._id), dto);
    assert.equal(updated.active, false);
    assert.equal(updated.room, 'Room 101');
    assert.equal(updated.fee, 300);
  });

  test('a doctor whose room was removed from the queue can still be deactivated', async () => {
    const d = await opd.createDoctor(doctor());
    await settingsService.updateSettings({ queue: { counters: ['Room 102'] } } as any);
    const updated = await opd.updateDoctor(String(d._id), { active: false });
    assert.equal(updated.active, false);
    await assert.rejects(opd.updateDoctor(String(d._id), { active: true }), BadRequestException);
  });

  test('a partial department update changes only the fields sent', async () => {
    const dept = await m().Department.findOne({ code: 'paediatrics' });
    const dto = Object.assign(new UpdateDepartmentDto(), { active: false, name: undefined, color: undefined });
    const updated = await opd.updateDepartment(String(dept!._id), dto);
    assert.equal(updated.active, false);
    assert.equal(updated.name, 'Paediatrics');
    assert.equal(updated.color, '#E07B1D');
  });

  test('getDoctor answers 404 for a missing or malformed id', async () => {
    await assert.rejects(opd.getDoctor('nope'), /Doctor not found/);
    await assert.rejects(opd.getDoctor(String(new Types.ObjectId())), /Doctor not found/);
  });

  test('a real database error is not turned into "not found"', async () => {
    const shajin = await opd.createDoctor(doctor());
    await settingsService.updateSettings({ reception: { defaultDoctorId: String(shajin._id) } } as never);
    // The doctors collection fails on look-up by id; everything else still works.
    const failing = new Proxy(m().OpDoctor, { get: (model, key, self) => (key === 'findById' ? () => ({ exec: () => Promise.reject(new Error('database down')) }) : Reflect.get(model, key, self)) });
    const broken = new OpdService(m().Department, failing, settingsService);
    await assert.rejects(broken.getDoctor(String(shajin._id)), /database down/);
    await assert.rejects(broken.defaultDoctor(), /database down/);
    // A stored default that is not an id at all is skipped, as before.
    await settingsService.updateSettings({ reception: { defaultDoctorId: 'not-an-id' } } as never);
    assert.equal(String((await broken.defaultDoctor())!._id), String(shajin._id));
  });
});
