import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { AppointmentEvents } from './appointment-events';
import { AppointmentsService } from './appointments.service';

const ALL_WEEK = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00' }];
const day = (n: number) => {
  const d = clinicNow();
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

describe('AppointmentsService keeps the slot guard (mobile-style routes)', () => {
  const m = models();
  let service: AppointmentsService;
  let events: AppointmentEvents;
  let opd: OpdService;
  let shajin: any;
  let freed: any[];

  const body = (uhid: string, time: string, extra: Record<string, unknown> = {}) => ({
    uhid,
    patientName: `Patient ${uhid}`,
    age: 40,
    gender: 'Male',
    date: day(3),
    time,
    ...extra,
  });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await m.Appointment.syncIndexes();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    opd = new OpdService(m.Department, m.OpDoctor, new SettingsService(m.HospitalSettings));
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: ALL_WEEK } as any);
    await m.HospitalSettings.updateOne({}, { $set: { reception: { defaultDoctorId: String(shajin._id) } } });
    events = new AppointmentEvents();
    service = new AppointmentsService(m.Appointment, events, opd);
    freed = [];
    events.slotFreed$.subscribe((s) => freed.push(s));
  });

  test('a doctor-less POST gets the default doctor and a slot key', async () => {
    const apt: any = await service.create(body('U1', '10:00 AM') as any);
    assert.equal(apt.doctorId, String(shajin._id));
    assert.equal(apt.doctorName, 'Dr. Shajin');
    assert.equal(apt.departmentCode, 'gen-med');
    assert.equal(apt.slotKey, `${shajin._id}|${day(3)}|10:00 AM`);
  });

  test('the same slot booked twice is a 409 "That slot was just taken"', async () => {
    await service.create(body('U1', '10:00 AM') as any);
    await assert.rejects(() => service.create(body('U2', '10:00 AM') as any), (e: any) => e.getStatus?.() === 409 && /just taken/.test(e.message));
    assert.equal(await m.Appointment.countDocuments({}), 1);
  });

  test('a time written another way ("10:00am") still hits the same slot key', async () => {
    await service.create(body('U1', '10:00 AM') as any);
    await assert.rejects(() => service.create(body('U2', '10:00 am') as any), (e: any) => e.getStatus?.() === 409);
  });

  test('with no OP doctor the appointment is stored as before, without a key', async () => {
    await m.OpDoctor.deleteMany({});
    await m.HospitalSettings.updateOne({}, { $unset: { reception: 1 } });
    const apt: any = await service.create(body('U1', '10:00 AM') as any);
    assert.equal(apt.slotKey, undefined);
    assert.ok(!apt.doctorId);
  });

  test('a stale key left by an old cancel does not block a new booking', async () => {
    const a: any = await service.create(body('U1', '10:00 AM') as any);
    await m.Appointment.collection.updateOne({ _id: a._id }, { $set: { status: 'Canceled' } }); // key kept: a legacy cancel
    const b: any = await service.create(body('U2', '10:00 AM') as any);
    assert.equal(b.slotKey, `${shajin._id}|${day(3)}|10:00 AM`);
  });

  test('PATCH status Canceled releases the key and announces the freed slot', async () => {
    const a: any = await service.create(body('U1', '10:00 AM') as any);
    const done: any = await service.updateStatus(String(a._id), 'Canceled');
    assert.equal(done.status, 'Canceled');
    assert.equal(((await m.Appointment.findById(a._id).lean()) as any).slotKey, undefined);
    assert.deepEqual(freed.map((f) => [f.id, f.doctorId, f.date, f.time]), [[String(a._id), String(shajin._id), day(3), '10:00 AM']]);
    const b: any = await service.create(body('U2', '10:00 AM') as any);
    assert.ok(b.slotKey, 'the slot can be booked again');
  });

  test("a canceled appointment can't be reopened; a repeat cancel is harmless", async () => {
    const a: any = await service.create(body('U1', '10:00 AM') as any);
    await service.updateStatus(String(a._id), 'Canceled');
    for (const status of ['Waiting', 'Checked In', 'Scheduled']) {
      await assert.rejects(() => service.updateStatus(String(a._id), status), (e: any) => e.getStatus?.() === 409 && /can't be reopened/.test(e.message));
    }
    await service.updateStatus(String(a._id), 'Canceled');
    assert.equal(freed.length, 1, 'the slot is announced once');
  });

  test('other status changes still work and keep the key', async () => {
    const a: any = await service.create(body('U1', '10:00 AM') as any);
    const w: any = await service.updateStatus(String(a._id), 'Waiting');
    assert.equal(w.status, 'Waiting');
    assert.ok(w.slotKey);
    assert.equal(freed.length, 0);
  });
});
