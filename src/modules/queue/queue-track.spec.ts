import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { QueueService } from './queue.service';
import { QueueEvents } from './queue-events';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { AppointmentEvents } from '../appointments/appointment-events';

describe('QueueService.track', () => {
  let queue: QueueService;
  let docA: string;
  const m = () => models();

  const issueFor = async (uhid: string) => {
    await m().Patient.create({ uhid, name: `Patient ${uhid}`, phone: '9876543210', gender: 'Male', age: 30 } as any);
    return (await queue.issue({ uhid, doctorId: docA }, 'Tester')).token;
  };

  before(connectTestDb);
  after(closeTestDb);

  beforeEach(async () => {
    await resetTestDb();
    await m().Department.create({ code: 'general-medicine', name: 'General Medicine', tokenPrefix: 'G', order: 1 } as any);
    const a = await m().OpDoctor.create({ name: 'Dr. A', departmentCode: 'general-medicine', room: 'Room 101', tokenPrefix: 'G', fee: 300 } as any);
    docA = String(a._id);
    await m().HospitalSettings.create({ hospital: { name: "St. Mary's" }, queue: { counters: ['Room 101'] }, reception: { defaultDoctorId: docA } } as any);
    const settings = new SettingsService(m().HospitalSettings);
    const opd = new OpdService(m().Department, m().OpDoctor, settings);
    queue = new QueueService(m().QueueToken, m().QueueSequence, m().Appointment, m().Patient, settings, new QueueEvents(), new AppointmentEvents(), opd);
  });

  test('a waiting token shows its place and room, and no patient identity', async () => {
    await issueFor('U1');
    const second = await issueFor('U2');
    const view = await queue.track(second.trackCode!);
    assert.equal(view.status, 'waiting');
    assert.equal(view.ahead, 1);
    assert.equal(view.room, 'Room 101');
    assert.equal(view.hospitalName, "St. Mary's");
    assert.equal(view.doctorName, 'Dr. A');
    assert.equal(view.ended, false);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('uhid') && !json.includes('patientName') && !json.includes('Patient U'));
  });

  test('a called token reports when it was called', async () => {
    const first = await issueFor('U1');
    await queue.call('Room 101', 'Tester');
    const view = await queue.track(first.trackCode!);
    assert.equal(view.status, 'called');
    assert.ok(view.calledAt);
  });

  test('a skipped token reads as called', async () => {
    const first = await issueFor('U1');
    await queue.call('Room 101', 'Tester');
    await queue.skip(String(first._id));
    assert.equal((await queue.track(first.trackCode!)).status, 'called');
  });

  test("nowServing is the label called in the token's room", async () => {
    await issueFor('U1');
    const second = await issueFor('U2');
    await queue.call('Room 101', 'Tester');
    const view = await queue.track(second.trackCode!);
    assert.equal(view.status, 'waiting');
    assert.equal(view.nowServing, 'G-001');
  });

  test("a token from an earlier day is marked ended", async () => {
    const first = await issueFor('U1');
    await m().QueueToken.updateOne({ _id: first._id }, { $set: { date: '2026-09-25' } });
    assert.equal((await queue.track(first.trackCode!)).ended, true);
  });

  test('an unknown code is not found', async () => {
    await assert.rejects(() => queue.track('x'.repeat(24)), NotFoundException);
  });
});
