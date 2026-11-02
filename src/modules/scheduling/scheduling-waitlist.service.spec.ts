import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { parseIsoDay } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { OpdService } from '../opd/opd.service';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingProceduresService } from './scheduling-procedures.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const FRONT = { id: 'f1', name: 'Front desk', role: UserRole.STAFF };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };
/** Tuesday 20 Oct 2026, 07:00 local, with no CLINIC_DATE (so the clinic clock is this clock). */
const NOW = () => new Date(2026, 9, 20, 7, 0, 0, 0);
const D = '2026-10-20';
const D1 = '2026-10-21';
const D2 = '2026-10-22';
const ALL_WEEK = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '13:00' }];
const at = (day: string, hhmm: string) => {
  const d = parseIsoDay(day);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};

describe('SchedulingWaitlistService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let doctors: SchedulingDoctorsService;
  let appts: SchedulingAppointmentsService;
  let procedures: SchedulingProceduresService;
  let waitlist: SchedulingWaitlistService;
  let shajin: any;
  let arun: any;
  let n = 0;

  const patient = (name: string) => m.Patient.create({ uhid: `MHK2026${String(++n).padStart(5, '0')}`, name, age: 40, gender: 'Male', phone: '9000000000' });
  const book = async (name: string, doc: any, date: string, time: string) => {
    const p = await patient(name);
    return appts.book(ADMIN, { patientId: String(p._id), doctorId: String(doc._id), date, time });
  };
  const openItems = () => m.WaitItem.find({ status: 'open' }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    mock.timers.enable({ apis: ['Date'], now: NOW() });
    await resetTestDb();
    await m.Appointment.syncIndexes();
    await m.WaitItem.syncIndexes();
    n = 0;
    await m.HospitalSettings.create({ queue: { counters: ['Room 101', 'Room 102'] } });
    const settingsService = new SettingsService(m.HospitalSettings);
    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: ALL_WEEK } as any);
    arun = await opd.createDoctor({ name: 'Dr. Arun Kumar', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 102', tokenPrefix: 'G2', sessions: ALL_WEEK } as any);
    await m.HospitalSettings.updateOne({}, { $set: { reception: { defaultDoctorId: String(shajin._id) } } });
    doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock, { onPatientLeft: async () => 0 } as any, messages).onModuleInit();
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    procedures = new SchedulingProceduresService(
      m.ProcedureBooking, m.RoomBlock, m.StaffMember, m.RosterEntry, m.Appointment, m.OpDoctor, m.SchedulingLock,
      m.CoordinatorCounter, m.TaskAlertItem, new PatientsService(m.Patient), cases, messages, new SchedulingSettingsService(settingsService),
      new RulesService(registry, settingsService, events), m.WaitItem,
    );
    waitlist = new SchedulingWaitlistService(m.WaitItem, m.Appointment, m.Patient, m.FollowUpItem, m.TaskAlertItem, doctors, appts, procedures);
    waitlist.onModuleInit();
    void escalations;
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test('leave over 4 booked appointments puts 4 items on the waitlist; saving the same leave again adds none', async () => {
    for (const [i, t] of ['09:00 AM', '09:15 AM', '09:30 AM', '09:45 AM'].entries()) await book(`Patient ${i}`, shajin, D2, t);
    await book('Elsewhere', arun, D2, '09:00 AM');
    const leave = [{ from: D2, to: D2, reason: 'Conference' }];
    const first = await doctors.setProfile(ADMIN, String(shajin._id), { leave });
    assert.equal(first.onLeave.length, 4);
    const items = await openItems();
    assert.equal(items.length, 4, 'one item per appointment on leave, none for the other doctor');
    for (const i of items) {
      assert.equal(i.kind, 'appointment');
      assert.equal(i.reason, 'doctor-leave');
      assert.equal(i.doctorId, String(shajin._id));
      assert.equal(i.offered.length, 2);
      for (const o of i.offered) assert.notEqual(o.date, D2, 'never offered a day of the leave');
    }
    const ids = items.map((i) => String(i._id)).sort();
    // Review Focus 3: the same leave saved again.
    const again = await doctors.setProfile(ADMIN, String(shajin._id), { leave });
    assert.equal(again.onLeave.length, 4);
    assert.equal(await m.WaitItem.countDocuments({}), 4, 'no new item');
    assert.deepEqual((await openItems()).map((i) => String(i._id)).sort(), ids, 'the same four items');
  });

  test('book offered moves the appointment and resolves the item', async () => {
    const apt = await book('Asha', shajin, D2, '09:00 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    const [item] = await openItems();
    await m.TaskAlertItem.create({ title: 'old', type: 'Follow-up', category: 'System', link: `scheduling-waitlist:${item._id}` });
    const pick = item.offered[1];
    const done = await waitlist.bookOffered(FRONT, String(item._id), 1);
    assert.equal(done.status, 'resolved');
    const moved = (await m.Appointment.findById(apt._id).lean()) as any;
    assert.deepEqual([moved.date, moved.time, moved.status], [pick.date, pick.time, 'Scheduled']);
    assert.equal(moved.slotKey, `${shajin._id}|${pick.date}|${pick.time}`);
    assert.equal((await m.TaskAlertItem.findOne({ link: `scheduling-waitlist:${item._id}` }).lean())!.status, 'Completed');
    assert.equal((await waitlist.list('open')).length, 0);
    assert.equal((await waitlist.list('resolved')).length, 1);
    // Closed items can't be booked again.
    await assert.rejects(() => waitlist.bookOffered(FRONT, String(item._id), 0), ConflictException);
  });

  test('book offered on a slot that was just taken refreshes the offers and gives 409', async () => {
    await book('Asha', shajin, D2, '09:00 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    const [item] = await openItems();
    const taken = item.offered[0];
    const p = await patient('Taker');
    await appts.book(ADMIN, { patientId: String(p._id), doctorId: String(shajin._id), date: taken.date, time: taken.time });
    await assert.rejects(() => waitlist.bookOffered(FRONT, String(item._id), 0), (e: any) => e instanceof ConflictException && /just taken/.test(e.message));
    const [fresh] = await openItems();
    assert.equal(fresh.status, 'open');
    assert.ok(!fresh.offered.some((o: any) => o.date === taken.date && o.time === taken.time), 'the taken slot is no longer offered');
    assert.equal(fresh.offered.length, 2);
  });

  test('find another offers the next two after the latest offered; cancel booking cancels the appointment and closes the item', async () => {
    const apt = await book('Asha', shajin, D2, '09:00 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    const [item] = await openItems();
    const latest = at(item.offered[1].date, '00:00').getTime();
    const next = await waitlist.findAnother(FRONT, String(item._id));
    assert.equal(next.offered.length, 2);
    const key = (o: any) => `${o.date} ${o.time}`;
    for (const o of next.offered as any[]) {
      assert.ok(!item.offered.some((x: any) => key(x) === key(o)), 'not one of the old offers');
      assert.ok(at(o.date, '00:00').getTime() >= latest);
    }
    await assert.rejects(() => waitlist.cancelBooking(FRONT, String(item._id), ' '), BadRequestException);
    const closed = await waitlist.cancelBooking(FRONT, String(item._id), 'Patient no longer needs it');
    assert.equal(closed.status, 'cancelled');
    assert.equal(((await m.Appointment.findById(apt._id).lean()) as any).status, 'Canceled');
  });

  test('only admin, doctor and front desk may act on the waitlist', async () => {
    await book('Asha', shajin, D2, '09:00 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    const [item] = await openItems();
    await assert.rejects(() => waitlist.bookOffered(NURSE, String(item._id), 0), ForbiddenException);
    await assert.rejects(() => waitlist.findAnother(NURSE, String(item._id)), ForbiddenException);
    await assert.rejects(() => waitlist.cancelBooking(NURSE, String(item._id), 'x'), ForbiddenException);
    await assert.rejects(() => waitlist.markEarlierWanted(NURSE, String(item.refId)), ForbiddenException);
  });

  test('a cancelled appointment offers its slot to the oldest earlier-wanted item of that doctor', async () => {
    const a1 = await book('First', shajin, D2, '12:00 PM');
    const a2 = await book('Second', shajin, D2, '12:15 PM');
    const other = await book('Other doctor', arun, D2, '12:30 PM');
    const blocker = await book('Blocker', shajin, D1, '09:00 AM');
    const i1 = await waitlist.markEarlierWanted(FRONT, String(a1._id));
    mock.timers.tick(1000);
    const i2 = await waitlist.markEarlierWanted(FRONT, String(a2._id));
    const i3 = await waitlist.markEarlierWanted(FRONT, String(other._id));
    assert.ok(i1.offered.every((o: any) => o.date + o.time < D2), 'earlier-wanted offers are earlier than the booked time');
    await appts.cancel(FRONT, String(blocker._id), 'Patient cancelled');
    const byId = async (id: string) => (await m.WaitItem.findById(id).lean()) as any;
    const got1 = await byId(i1.id);
    assert.deepEqual([got1.offered[0].date, got1.offered[0].time], [D1, '09:00 AM'], 'the freed slot comes first');
    assert.equal(got1.offered.length, 2, 'at most two offers');
    assert.ok(!(await byId(i2.id)).offered.some((o: any) => o.date === D1 && o.time === '09:00 AM'), 'only the oldest item gets it');
    assert.ok(!(await byId(i3.id)).offered.some((o: any) => o.date === D1 && o.time === '09:00 AM'), 'another doctor never gets it');
    // The appointment itself did not move: a person must press Book offered.
    assert.equal(((await m.Appointment.findById(a1._id).lean()) as any).date, D2);
  });

  test('a freed slot is offered only when it is still free, past the 15-minute floor, and earlier than the booked time (P6-a)', async () => {
    await m.OpDoctor.updateOne({ _id: shajin._id }, { $set: { sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '07:00', end: '13:00' }] } });
    const a1 = await book('First', shajin, D2, '12:00 PM');
    const item = await waitlist.markEarlierWanted(FRONT, String(a1._id));
    const offeredOf = async () => ((await m.WaitItem.findById(item.id).lean()) as any).offered;
    const before = await offeredOf();
    const doc = String(shajin._id);
    // Freed, but another live appointment holds it now (a repeated cancel result): not offered.
    await book('Holder', shajin, D1, '09:00 AM');
    await waitlist.onFreed({ id: 'x', doctorId: doc, date: D1, time: '09:00 AM' });
    assert.deepEqual(await offeredOf(), before, 'a held slot is not offered');
    // Free and in a session, but inside the 15-minute floor (clock 07:00): not offered.
    await waitlist.onFreed({ id: 'y', doctorId: doc, date: D, time: '07:00 AM' });
    assert.deepEqual(await offeredOf(), before, 'a slot inside the floor is not offered');
    // Later than the booked time: no use to a patient who wants earlier.
    await waitlist.onFreed({ id: 'z', doctorId: doc, date: D2, time: '12:15 PM' });
    assert.deepEqual(await offeredOf(), before, 'a later slot is not offered');
    // A genuinely free earlier slot is offered first.
    await waitlist.onFreed({ id: 'w', doctorId: doc, date: D1, time: '09:15 AM' });
    const after = await offeredOf();
    assert.deepEqual([after[0].date, after[0].time], [D1, '09:15 AM']);
    assert.equal(after.length, 2);
  });

  test('earlier wanted on an appointment that already has an open item sets wantsEarlier and keeps its reason and offers', async () => {
    const a = await book('Asha', shajin, D2, '09:00 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    const [leaveItem] = await openItems();
    assert.equal(leaveItem.wantsEarlier, false);
    const view = await waitlist.markEarlierWanted(FRONT, String(a._id));
    assert.equal(view.id, String(leaveItem._id));
    assert.equal(view.reason, 'doctor-leave');
    assert.equal(view.wantsEarlier, true);
    assert.deepEqual(view.offered, leaveItem.offered);
    assert.equal(await m.WaitItem.countDocuments({}), 1);
    assert.equal(((await m.WaitItem.findById(leaveItem._id).lean()) as any).wantsEarlier, true);
  });

  test('book offered on a Reschedule Requested appointment leaves it Unconfirmed at the new time', async () => {
    const a = await book('Asha', shajin, D2, '09:00 AM');
    await m.Appointment.updateOne({ _id: a._id }, { $set: { confirmation: 'Reschedule Requested' } });
    const item = await waitlist.add({ kind: 'appointment', refId: String(a._id), reason: 'patient-request', priority: 'routine' });
    await waitlist.bookOffered(FRONT, item.id, 0);
    const now = (await m.Appointment.findById(a._id).lean()) as any;
    assert.deepEqual([now.date, now.time, now.confirmation], [item.offered[0].date, item.offered[0].time, 'Unconfirmed']);
  });

  test('earlier wanted with nothing earlier free is an item with no offers', async () => {
    const a1 = await book('First', shajin, D, '09:00 AM');
    const view = await waitlist.markEarlierWanted(FRONT, String(a1._id));
    assert.deepEqual(view.offered, []);
    assert.equal(view.reason, 'earlier-wanted');
    assert.equal(view.wantsEarlier, true);
    const again = await waitlist.markEarlierWanted(FRONT, String(a1._id));
    assert.equal(again.id, view.id, 'idempotent');
  });

  test('add is idempotent per open item, and a closed item can be added again', async () => {
    const a = await book('Asha', shajin, D2, '09:00 AM');
    const one = await waitlist.add({ kind: 'appointment', refId: String(a._id), reason: 'patient-request', priority: 'routine' });
    const two = await waitlist.add({ kind: 'appointment', refId: String(a._id), reason: 'doctor-leave', priority: 'routine' });
    assert.equal(two.id, one.id);
    assert.equal(await m.WaitItem.countDocuments({}), 1);
    assert.deepEqual(one.offered.length, 2);
    await waitlist.cancelBooking(FRONT, one.id, 'gone');
    await assert.rejects(() => waitlist.add({ kind: 'appointment', refId: String(new Types.ObjectId()), reason: 'patient-request', priority: 'routine' }));
  });

  test('an item over 24 h old raises one alert; it is completed when the item is resolved', async () => {
    const a = await book('Asha', shajin, D2, '09:00 AM');
    const item = await waitlist.add({ kind: 'appointment', refId: String(a._id), reason: 'patient-request', priority: 'routine' });
    assert.deepEqual(await waitlist.ageAlerts(), { raised: 0, completed: 0 });
    mock.timers.tick(23 * 3_600_000);
    assert.equal((await waitlist.ageAlerts()).raised, 0, 'not yet 24 hours');
    mock.timers.tick(2 * 3_600_000);
    assert.equal((await waitlist.ageAlerts()).raised, 1);
    assert.equal((await waitlist.ageAlerts()).raised, 0, 'only once');
    const alerts = await m.TaskAlertItem.find({ link: `scheduling-waitlist:${item.id}` }).lean();
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].type, alerts[0].category, alerts[0].priority, alerts[0].status], ['Follow-up', 'System', 'Medium', 'Pending']);
    // A day later the old offers are stale: ask for new ones, then book.
    await waitlist.findAnother(FRONT, item.id);
    await waitlist.bookOffered(FRONT, item.id, 0);
    assert.equal((await m.TaskAlertItem.findOne({ link: `scheduling-waitlist:${item.id}` }).lean())!.status, 'Completed');
    assert.equal((await waitlist.ageAlerts()).raised, 0, 'a completed alert is not raised again');
  });

  test('a procedure item offers the next two bookable starts; book offered re-books by the planner rules', async () => {
    const cardio = await m.StaffMember.create({ name: 'Dr. Arun', skills: ['cardiologist'], departmentCode: 'CARD' });
    const nurse = await m.StaffMember.create({ name: 'Anitha', skills: ['cath-nurse'], departmentCode: 'CARD' });
    const tech = await m.StaffMember.create({ name: 'Ravi', skills: ['cath-technician'], departmentCode: 'CARD' });
    for (const day of [D, D1]) for (const s of [cardio, nurse, tech]) await m.RosterEntry.create({ date: day, shift: 'morning', staff: s._id });
    const p = await patient('Mohan Raj');
    const v = await procedures.request(ADMIN, { patientId: String(p._id), procedure: 'coronary-angiography', priority: 'routine' } as any);
    assert.equal(v.status, 'booked');
    // Bumped: the booking goes back to waiting, the way Task 9 will do it.
    await m.ProcedureBooking.updateOne(
      { _id: v.id },
      { $set: { status: 'requested', bumpedFrom: { start: v.start, room: v.room } }, $unset: { room: 1, start: 1, end: 1 } },
    );
    const item = await waitlist.add({ kind: 'procedure', refId: v.id, reason: 'bumped', priority: 'routine' });
    assert.equal(item.offered.length, 2);
    const [o1, o2] = item.offered as any[];
    assert.ok(new Date(o2.start).getTime() >= new Date(o1.start).getTime() + 15 * 60_000, 'the second is planned from the first + 15 minutes');
    assert.equal(o1.room, 'cath-lab');
    assert.equal(new Date((item.original as any).start).getTime(), new Date(v.start!).getTime(), 'original is where it was bumped from');
    const next = await waitlist.findAnother(FRONT, item.id);
    assert.ok(new Date((next.offered[0] as any).start).getTime() >= new Date(o2.start).getTime() + 15 * 60_000);
    const done = await waitlist.bookOffered(FRONT, item.id, 0);
    assert.equal(done.status, 'resolved');
    const booked = (await m.ProcedureBooking.findById(v.id).lean()) as any;
    assert.equal(booked.status, 'booked');
    assert.equal(booked.start.getTime(), new Date((next.offered[0] as any).start).getTime(), 'booked at the offered start');
  });

  test('book offered with the offered start taken: 409, nothing booked, a bumped case stays requested (I3)', async () => {
    const cardio = await m.StaffMember.create({ name: 'Dr. Arun', skills: ['cardiologist'], departmentCode: 'CARD' });
    const nurse = await m.StaffMember.create({ name: 'Anitha', skills: ['cath-nurse'], departmentCode: 'CARD' });
    const tech = await m.StaffMember.create({ name: 'Ravi', skills: ['cath-technician'], departmentCode: 'CARD' });
    for (const day of [D, D1]) for (const s of [cardio, nurse, tech]) await m.RosterEntry.create({ date: day, shift: 'morning', staff: s._id });
    const p = await patient('Mohan Raj');
    const v = await procedures.request(ADMIN, { patientId: String(p._id), procedure: 'coronary-angiography', priority: 'routine' } as any);
    await m.ProcedureBooking.updateOne(
      { _id: v.id },
      { $set: { status: 'requested', bumpedFrom: { start: v.start, room: v.room } }, $unset: { room: 1, start: 1, end: 1 } },
    );
    const item = await waitlist.add({ kind: 'procedure', refId: v.id, reason: 'bumped', priority: 'routine' });
    const offeredStart = new Date((item.offered[0] as any).start).getTime();
    // Another request takes the offered start before the person presses Book offered.
    const q = await patient('Taken First');
    const other = await procedures.request(ADMIN, { patientId: String(q._id), procedure: 'coronary-angiography', priority: 'routine' } as any);
    assert.equal(new Date(other.start!).getTime(), offeredStart, 'the other request now holds the offered start');
    await assert.rejects(() => waitlist.bookOffered(FRONT, item.id, 0), (e: any) => e instanceof ConflictException && /just taken/.test(e.message));
    const after = (await m.ProcedureBooking.findById(v.id).lean()) as any;
    assert.equal(after.status, 'requested', 'a bumped case never becomes cant-book here');
    assert.ok(!after.start && !after.room, 'nothing was booked, not even a later time');
    assert.ok(after.bumpedFrom, 'it still remembers where it was bumped from');
    const still = (await m.WaitItem.findById(item.id).lean()) as any;
    assert.equal(still.status, 'open');
    assert.ok(still.offered.every((o: any) => new Date(o.start).getTime() !== offeredStart), 'the offers were refreshed');
    assert.equal(await m.TaskAlertItem.countDocuments({ link: new RegExp(`scheduling-wait.*${v.id}`) }), 0, 'no wait alert from Book offered');
  });

  test('an appointment item settles when the appointment is moved or cancelled outside the waitlist (I4)', async () => {
    const moved = await book('Moved', shajin, D2, '09:00 AM');
    const gone = await book('Gone', shajin, D2, '09:15 AM');
    const kept = await book('Kept', shajin, D2, '09:30 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    assert.equal((await openItems()).length, 3);
    const item = async (apt: any) => (await m.WaitItem.findOne({ refId: apt._id }).lean()) as any;
    // The front desk moves one on the Appointments screen, and cancels another.
    await appts.move(FRONT, String(moved._id), { date: D1, time: '10:00 AM' });
    await appts.cancel(FRONT, String(gone._id), 'Patient cancelled');
    assert.equal((await item(moved)).status, 'resolved');
    assert.equal((await item(gone)).status, 'cancelled');
    assert.equal((await item(kept)).status, 'open');
    assert.equal((await m.TaskAlertItem.countDocuments({ link: `scheduling-waitlist:${(await item(moved))._id}`, status: { $ne: 'Completed' } })), 0);
  });

  test('settleAppointmentItems (the reconcile pass) settles items whose appointment changed through a direct save (calls, other paths)', async () => {
    const a = await book('A', shajin, D2, '09:00 AM');
    const b = await book('B', shajin, D2, '09:15 AM');
    const c = await book('C', shajin, D2, '09:30 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D2, to: D2, reason: '' }] });
    await m.Appointment.updateOne({ _id: a._id }, { $set: { date: D1, time: '11:00 AM', slotKey: `${shajin._id}|${D1}|11:00 AM` } });
    await m.Appointment.updateOne({ _id: b._id }, { $set: { status: 'Canceled' }, $unset: { slotKey: 1 } });
    mock.timers.tick(60_000);
    assert.equal(await waitlist.settleAppointmentItems(new Date(Date.now() - 30_000)), 2);
    const state = async (apt: any) => ((await m.WaitItem.findOne({ refId: apt._id }).lean()) as any).status;
    assert.deepEqual([await state(a), await state(b), await state(c)], ['resolved', 'cancelled', 'open']);
    assert.equal(await waitlist.settleAppointmentItems(new Date(Date.now() - 30_000)), 0, 'nothing more to settle');
  });

  test('removing leave cancels the open doctor-leave items whose appointment is no longer on leave (I6)', async () => {
    const a = await book('A', shajin, D2, '09:00 AM');
    const b = await book('B', shajin, D1, '09:00 AM');
    await book('Other', arun, D2, '09:00 AM');
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D1, to: D1, reason: '' }, { from: D2, to: D2, reason: '' }] });
    assert.equal((await openItems()).length, 2);
    // The admin removes the D2 leave; D1 stays.
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [{ from: D1, to: D1, reason: '' }] });
    const state = async (apt: any) => ((await m.WaitItem.findOne({ refId: apt._id }).lean()) as any).status;
    assert.deepEqual([await state(a), await state(b)], ['cancelled', 'open']);
    // All leave removed: the rest go too, and a late-added item of a patient request is not touched.
    const c = await book('C', shajin, '2026-10-23', '09:00 AM');
    await waitlist.add({ kind: 'appointment', refId: String(c._id), reason: 'patient-request', priority: 'routine' });
    await doctors.setProfile(ADMIN, String(shajin._id), { leave: [] });
    assert.deepEqual([await state(a), await state(b), await state(c)], ['cancelled', 'cancelled', 'open']);
    assert.equal((await m.Appointment.findById(b._id).lean() as any).status, 'Scheduled', 'the appointments themselves are untouched');
  });
});
