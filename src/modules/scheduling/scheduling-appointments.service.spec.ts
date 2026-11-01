import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { appointmentStart, clinicNow, isoDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };

/** A clinic day n days from the (possibly pinned) clinic today. */
const dayPlus = (n: number) => {
  const d = clinicNow();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
/** Pins the clock to 2026-10-20 10:15:00.000 local, with no CLINIC_DATE, while `fn` runs. */
const NOW = () => new Date(2026, 9, 20, 10, 15, 0, 0);
async function withClockAsync<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.CLINIC_DATE;
  delete process.env.CLINIC_DATE;
  mock.timers.enable({ apis: ['Date'], now: NOW() });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
    if (saved !== undefined) process.env.CLINIC_DATE = saved;
  }
}
const ALL_WEEK = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '13:00' }];

describe('Scheduling appointments by doctor', () => {
  const m = models();
  let doctors: SchedulingDoctorsService;
  let appts: SchedulingAppointmentsService;
  let opd: OpdService;
  let freed: any[];
  let shajin: any;
  let other: any;

  const patient = (uhid: string, name: string, extra: Record<string, unknown> = {}) =>
    m.Patient.create({ uhid, name, age: 40, gender: 'Male', phone: '9000000000', ...extra });
  const book = (p: any, doc: any, date: string, time: string, actor: any = ADMIN) =>
    appts.book(actor, { patientId: String(p._id), doctorId: String(doc._id), date, time, type: 'Consultation', condition: 'Fever' });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await m.Appointment.syncIndexes();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101', 'Room 102'] } });
    opd = new OpdService(m.Department, m.OpDoctor, new SettingsService(m.HospitalSettings));
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: ALL_WEEK } as any);
    other = await opd.createDoctor({ name: 'Dr. Arun Kumar', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 102', tokenPrefix: 'G2', sessions: ALL_WEEK } as any);
    await m.HospitalSettings.updateOne({}, { $set: { reception: { defaultDoctorId: String(shajin._id) } } });
    doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    freed = [];
    appts.onFreed.push((a) => {
      freed.push(a);
    });
  });

  test("free slots follow the doctor's sessions, slot length and taken times, never before clinicNow + 15 min today", async () => {
    await m.OpDoctor.updateMany({}, { $set: { sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:30' }] } });
    await doctors.setProfile(ADMIN, String(shajin._id), { slotMinutes: 30 });
    const from = new Date(clinicNow().getTime() + 15 * 60_000);
    const slots = await doctors.freeSlots(String(shajin._id), from, 400);
    assert.ok(slots.length > 100);
    for (const s of slots) {
      assert.ok(appointmentStart(s.date, s.time).getTime() >= from.getTime() - 59_999, `${s.date} ${s.time} is before ${from.toISOString()}`);
      const minutes = appointmentStart(s.date, s.time).getMinutes();
      assert.ok(minutes === 0 || minutes === 30, 'slots follow the 30-minute length');
    }
    // The front-desk lead is a floor: with the clock at exactly 10:15:00 and 15-minute slots the first slot is 10:30, whatever `from` says.
    await doctors.setProfile(ADMIN, String(shajin._id), { slotMinutes: 15 });
    const early = await withClockAsync(() => doctors.freeSlots(String(shajin._id), new Date(2026, 9, 20, 9, 0), 2));
    assert.deepEqual(early.map((x) => [x.date, x.time]), [['2026-10-20', '10:30 AM'], ['2026-10-20', '10:45 AM']]);
    // A taken slot disappears, and freeing it (by excluding that appointment) brings it back.
    const target = slots[slots.length - 1];
    const p = await patient('U1', 'Asha');
    const made = await book(p, shajin, target.date, target.time);
    const again = await doctors.freeSlots(String(shajin._id), from, 400);
    assert.ok(!again.some((s) => s.date === target.date && s.time === target.time));
    assert.equal(await doctors.isFree(String(shajin._id), target.date, target.time), false);
    assert.equal(await doctors.isFree(String(shajin._id), target.date, target.time, String(made._id)), true);
    // The other doctor's slot is not taken.
    assert.equal(await doctors.isFree(String(other._id), target.date, target.time), true);
  });

  test('two bookings of one slot at once: exactly one wins, the other gets 409', async () => {
    await m.Appointment.syncIndexes();
    const a = await patient('U1', 'Asha');
    const b = await patient('U2', 'Bala');
    const date = dayPlus(5);
    const results = await Promise.allSettled([book(a, shajin, date, '10:00 AM'), book(b, shajin, date, '10:00 AM')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.ok(bad[0].reason instanceof ConflictException);
    assert.match(bad[0].reason.message, /That slot was just taken/);
    assert.equal(await m.Appointment.countDocuments({ date, doctorId: String(shajin._id), status: { $ne: 'Canceled' } }), 1);
  });

  test("the same patient can't hold two overlapping appointments", async () => {
    const p = await patient('U1', 'Asha');
    const date = dayPlus(4);
    await book(p, shajin, date, '10:00 AM');
    await assert.rejects(book(p, other, date, '10:00 AM'), ConflictException); // another doctor, same time
    await book(p, other, date, '11:00 AM'); // well apart: fine
    assert.equal(await m.Appointment.countDocuments({ uhid: 'U1', status: { $ne: 'Canceled' } }), 2);
  });

  test('a leave day has no slots, and setting leave returns the booked appointments in it', async () => {
    const p1 = await patient('U1', 'Asha');
    const p2 = await patient('U2', 'Bala');
    const day = dayPlus(3);
    await book(p1, shajin, day, '09:00 AM');
    await book(p2, shajin, day, '09:15 AM');
    await book(p1, shajin, dayPlus(6), '09:00 AM');
    const onLeaveCalls: any[] = [];
    doctors.onLeave.push((info) => {
      onLeaveCalls.push(info);
    });
    const hit = await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: day, to: day, reason: 'Conference' }] });
    assert.equal(hit.onLeave.length, 2);
    assert.deepEqual((await doctors.profile(String(shajin._id))).leave.map((l) => l.from), [day]);
    const slots = await doctors.freeSlots(String(shajin._id), clinicNow(), 500);
    assert.ok(slots.length > 0);
    assert.ok(!slots.some((s) => s.date === day));
    assert.equal(onLeaveCalls.length, 1);
    // Leave is limited: a nurse, and a doctor for someone else's list, get 403.
    await assert.rejects(doctors.setProfile(NURSE, String(shajin._id), { leave: [] }), ForbiddenException);
    await m.OpDoctor.updateOne({ _id: shajin._id }, { $set: { userId: 'u-shajin' } });
    const self = { id: 'u-shajin', name: 'Shajin', role: UserRole.DOCTOR };
    await doctors.setProfile(self, String(shajin._id), { leave: [] });
    await assert.rejects(doctors.setProfile(self, String(other._id), { leave: [] }), ForbiddenException);
  });

  test('cancel frees the slot for a new booking', async () => {
    const a = await patient('U1', 'Asha');
    const b = await patient('U2', 'Bala');
    const date = dayPlus(2);
    const first = await book(a, shajin, date, '11:00 AM');
    await assert.rejects(book(b, shajin, date, '11:00 AM'), ConflictException);
    const canceled = await appts.cancel(ADMIN, String(first._id), 'Patient asked');
    assert.equal(canceled.status, 'Canceled');
    assert.equal((await m.Appointment.findById(first._id).lean())!.slotKey, undefined);
    assert.equal(freed.length, 1);
    assert.equal(freed[0].date, date);
    assert.equal(freed[0].time, '11:00 AM');
    assert.equal(freed[0].doctorId, String(shajin._id));
    const second = await book(b, shajin, date, '11:00 AM');
    assert.equal(second.slotKey, `${shajin._id}|${date}|11:00 AM`);
    // A cancel done outside this service (apt.save) leaves a stale key: booking heals it.
    await m.Appointment.updateOne({ _id: second._id }, { $set: { status: 'Canceled' } });
    const third = await book(a, shajin, date, '11:00 AM');
    assert.equal(third.status, 'Scheduled');
  });

  test('move books the new slot and frees the old one', async () => {
    const a = await patient('U1', 'Asha');
    const date = dayPlus(2);
    const apt = await book(a, shajin, date, '09:00 AM');
    const moved = await appts.move(ADMIN, String(apt._id), { date, time: '10:30 AM', doctorId: String(other._id) });
    assert.equal(moved.doctorName, 'Dr. Arun Kumar');
    assert.equal(moved.slotKey, `${other._id}|${date}|10:30 AM`);
    assert.equal(await doctors.isFree(String(shajin._id), date, '09:00 AM'), true);
    assert.equal(freed.length, 1);
    assert.equal(freed[0].time, '09:00 AM');
  });

  test('backfill gives every doctor-less appointment the default doctor and is idempotent', async () => {
    const date = dayPlus(1);
    const raw = (uhid: string, time: string, status = 'Scheduled') =>
      ({ uhid, patientName: uhid, age: 30, gender: 'Male', date, time, status });
    await m.Appointment.collection.insertMany([
      { ...raw('B1', '09:00 AM'), createdAt: new Date(1) },
      { ...raw('B2', '09:00 AM'), createdAt: new Date(2) }, // clashes with B1: left without a key
      { ...raw('B3', '10:00 AM') },
      { ...raw('B4', '10:00 AM', 'Canceled') }, // canceled: no key
    ] as any);
    const first = await appts.backfill();
    assert.equal(first.assigned, 4);
    const all = await m.Appointment.find({ date }).lean();
    assert.ok(all.every((a) => a.doctorId === String(shajin._id) && a.doctorName === 'Dr. Shajin' && a.departmentCode === 'gen-med'));
    const keyed = all.filter((a) => a.slotKey).map((a) => a.uhid).sort();
    assert.deepEqual(keyed, ['B1', 'B3']);
    const second = await appts.backfill();
    assert.equal(second.assigned, 0);
    assert.equal(second.keyed, 0);
    assert.equal((await m.Appointment.find({ date, slotKey: { $type: 'string' } }).lean()).length, 2);
  });

  test('doctorForPatient matches "Dr. Shajin" case-insensitively and falls back to the default doctor', async () => {
    const p1 = await patient('U1', 'Asha', { doctor: 'dr. arun kumar' });
    const p2 = await patient('U2', 'Bala', { doctor: 'Dr. Nobody' });
    const p3 = await patient('U3', 'Chitra', { doctor: 'DR. SHAJIN' });
    assert.equal(String((await doctors.doctorForPatient(p1)).id), String(other._id));
    assert.equal(String((await doctors.doctorForPatient(p2)).id), String(shajin._id));
    assert.equal(String((await doctors.doctorForPatient(p3)).id), String(shajin._id));
    await m.OpDoctor.updateOne({ _id: other._id }, { $set: { active: false } });
    assert.equal(String((await doctors.doctorForPatient(p1)).id), String(shajin._id)); // inactive is skipped
  });
  test('book enforces the 15-minute front-desk lead exactly (clock at 10:15:00)', async () => {
    const p = await patient('U1', 'Asha');
    const id = String(shajin._id);
    const tryBook = (date: string, time: string) => withClockAsync(() => book(p, shajin, date, time));
    const lead = (e: any) => e instanceof BadRequestException && /at least 15 minutes/.test(e.message);
    await assert.rejects(tryBook('2026-10-19', '10:00 AM'), lead); // a past date
    await assert.rejects(tryBook('2026-10-20', '10:00 AM'), lead); // earlier today
    await assert.rejects(tryBook('2026-10-20', '10:15 AM'), lead); // now itself: inside the lead
    // The first grid time at or after now + 15 is exactly 10:30: accepted (a `<=` would refuse it).
    const ok = await tryBook('2026-10-20', '10:30 AM');
    assert.equal(ok.slotKey, `${id}|2026-10-20|10:30 AM`);
    // One minute inside the lead on a 5-minute grid is refused, the boundary itself is accepted.
    await doctors.setProfile(ADMIN, id, { slotMinutes: 5 });
    const q = await patient('U2', 'Bala');
    await assert.rejects(withClockAsync(() => book(q, shajin, '2026-10-20', '10:25 AM')), lead);
    const edge = await withClockAsync(() => book(q, shajin, '2026-10-20', '10:35 AM'));
    assert.equal(edge.time, '10:35 AM');
  });

  test('the overlap window is exclusive: 10:00 then 10:15 on 15-minute slots is allowed', async () => {
    const p = await patient('U1', 'Asha');
    const date = dayPlus(4);
    await book(p, shajin, date, '10:00 AM');
    await book(p, shajin, date, '10:15 AM');
    assert.equal(await m.Appointment.countDocuments({ uhid: 'U1', status: { $ne: 'Canceled' } }), 2);
  });

  test("a canceled appointment doesn't block an overlapping time", async () => {
    const p = await patient('U1', 'Asha');
    const date = dayPlus(4);
    const first = await book(p, shajin, date, '10:00 AM');
    await assert.rejects(book(p, other, date, '10:00 AM'), ConflictException);
    await appts.cancel(ADMIN, String(first._id), 'changed mind');
    const again = await book(p, other, date, '10:00 AM');
    assert.equal(again.status, 'Scheduled');
  });

  test('a two-day leave range blocks both its first and last day, and nothing around it', async () => {
    const p = await patient('U1', 'Asha');
    const day = dayPlus(10);
    const next = dayPlus(11);
    const days = [dayPlus(9), day, next, dayPlus(12)];
    for (const d of days) await book(p, shajin, d, '09:00 AM');
    const res = await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: day, to: next, reason: 'Course' }] });
    assert.deepEqual(res.onLeave.map((a) => a.date).sort(), [day, next]);
    const slots = await doctors.freeSlots(String(shajin._id), clinicNow(), 600);
    const dates = new Set(slots.map((s) => s.date));
    assert.ok(!dates.has(day) && !dates.has(next));
    assert.ok(dates.has(dayPlus(9)) || dates.has(dayPlus(12)));
  });

  test('leave must be real dates in order', async () => {
    const id = String(shajin._id);
    const day = dayPlus(10);
    const bad = (leave: any) => assert.rejects(doctors.setProfile(ADMIN, id, { leave }), BadRequestException);
    await bad([{ from: dayPlus(11), to: day, reason: '' }]);
    await bad([{ from: '2026-02-30', to: '2026-03-01', reason: '' }]);
    await bad([{ from: 'tomorrow', to: day, reason: '' }]);
    await bad([{ from: day, to: day, reason: 'x'.repeat(121) }]);
  });
});
