import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingAppointmentsService } from '../scheduling/scheduling-appointments.service';
import { SchedulingDoctorsService } from '../scheduling/scheduling-doctors.service';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { CallsService } from './calls.service';
import { InboundService, ToolContext } from './inbound.service';
import { SlotsService } from './slots.service';
import { StartCallRequest, VoiceProvider } from './providers/voice-provider';

const PHONE = '+91 98765 43210';
const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const STRONG: ToolContext = { callerNumber: PHONE };
const dayOffset = (days: number) => {
  const d = clinicNow();
  d.setDate(d.getDate() + days);
  return isoDate(d);
};

class FakeProvider implements VoiceProvider {
  readonly name = 'simulated';
  readonly live = false;
  started: StartCallRequest[] = [];
  async startCall(request: StartCallRequest) {
    this.started.push(request);
    return { providerCallId: `fake_${this.started.length}` };
  }
}

describe('Calls use the patient\'s own doctor\'s timetable', () => {
  const m = models();
  let calls: CallsService;
  let inbound: InboundService;
  let provider: FakeProvider;
  let schedulingApts: SchedulingAppointmentsService;
  let freed: any[];
  let morning: any;
  let afternoon: any;
  const WEEK = (start: string, end: string) => [{ days: [0, 1, 2, 3, 4, 5, 6], start, end }];

  const patient = (uhid: string, name: string, extra: Record<string, unknown> = {}) =>
    m.Patient.create({ uhid, name, age: 34, gender: 'Female', phone: PHONE, dob: '14 Mar 1992', ...extra });
  const verify = async (name: string) => {
    const r = await inbound.run('find_patient', { phone: PHONE, patient_name: name, date_of_birth: '14 March 1992' }, STRONG);
    assert.equal(r.verified, true);
    return String(r.caller_ref);
  };

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await m.Appointment.syncIndexes();
    provider = new FakeProvider();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101', 'Room 102'] } });
    const settings = new SettingsService(m.HospitalSettings);
    await settings.updateSettings({ callAgent: { callingHoursStart: '00:00', callingHoursEnd: '23:59' } } as any, { role: UserRole.ADMIN });
    const opd = new OpdService(m.Department, m.OpDoctor, settings);
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    morning = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: WEEK('09:00', '10:00') } as any);
    afternoon = await opd.createDoctor({ name: 'Dr. Priya', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 102', tokenPrefix: 'G2', sessions: WEEK('15:00', '17:00') } as any);
    await m.HospitalSettings.updateOne({}, { $set: { reception: { defaultDoctorId: String(morning._id) } } });
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    schedulingApts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    freed = [];
    schedulingApts.onFreed.push((s) => {
      freed.push(s);
    });
    const tasks = new TasksAlertsService(m.TaskAlertItem);
    const slots = new SlotsService(m.Appointment, doctors, opd, m.Patient);
    inbound = new InboundService(m.AgentCall, m.InboundSession, m.CallerLookup, m.Appointment, m.Patient, new AppointmentEvents(), tasks, settings, slots, schedulingApts);
    const config = { get: () => undefined };
    calls = new CallsService(m.AgentCall, m.Appointment, m.Patient, m.FollowUpItem, tasks, settings, slots, inbound, config as any, provider, schedulingApts);
  });

  test("the booking call offers the patient's doctor's free slots", async () => {
    await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    const call = await calls.requestBooking({ uhid: 'U1' }, 'Staff');
    assert.equal(call.offeredSlots.length, 2);
    for (const s of call.offeredSlots) assert.match(s.time, /^0[3-4]:\d\d PM$/, `${s.time} is in Dr. Priya's afternoon session`);
    assert.notEqual(call.offeredSlots[0].date, call.offeredSlots[1].date, 'one slot per day first, as before');
  });

  test('a booked outcome creates the appointment with the doctor and slotKey; a taken slot is slot_taken', async () => {
    await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    const call = await calls.requestBooking({ uhid: 'U1' }, 'Staff');
    const slot = call.offeredSlots[0];
    const r = await calls.recordResult({ providerCallId: 'fake_1', outcome: 'booked', chosenSlot: 1, summary: '', transcript: [] });
    assert.equal(r.matched, true);
    const apt = (await m.Appointment.findOne({ uhid: 'U1' }).lean().exec()) as any;
    assert.equal(apt.doctorId, String(afternoon._id));
    assert.equal(apt.doctorName, 'Dr. Priya');
    assert.equal(apt.departmentCode, 'gen-med');
    assert.equal(apt.slotKey, `${afternoon._id}|${slot.date}|${slot.time}`);
    // A second call offered the same slot: the slot is gone, so the front desk is asked to rebook.
    await patient('U2', 'Bala', { doctor: 'Dr. Priya', phone: '+91 98765 43211' });
    await m.AgentCall.create({ purpose: 'booking', status: 'calling', uhid: 'U2', patientName: 'Bala', phone: '+919876543211', provider: 'simulated', scheduledFor: new Date(), providerCallId: 'x2', offeredSlots: [slot], visitReason: 'Review' });
    await calls.recordResult({ providerCallId: 'x2', outcome: 'booked', chosenSlot: 1, summary: '', transcript: [] });
    assert.equal(await m.Appointment.countDocuments({ uhid: 'U2' }), 0);
    assert.equal(await m.TaskAlertItem.countDocuments({ title: /Rebook Bala/ }), 1);
  });

  test('an inbound booking creates the appointment with the doctor and slotKey', async () => {
    await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    const ref = await verify('Rekha Suresh');
    const found = await inbound.run('find_free_slots', { caller_ref: ref }, STRONG);
    assert.equal(found.ok, true);
    const session = (await m.InboundSession.findOne({ code: ref }).lean().exec()) as any;
    for (const s of session.slots) assert.match(s.time, /PM$/);
    assert.equal((await inbound.run('book_appointment', { caller_ref: ref, slot_id: 'S1', reason: 'Fever' }, STRONG)).ok, true);
    const apt = (await m.Appointment.findOne({ uhid: 'U1' }).lean().exec()) as any;
    assert.equal(apt.doctorId, String(afternoon._id));
    assert.equal(apt.slotKey, `${afternoon._id}|${session.slots[0].date}|${session.slots[0].time}`);
  });

  test('a patient with no named doctor gets the default doctor', async () => {
    await patient('U1', 'Rekha Suresh');
    const ref = await verify('Rekha Suresh');
    await inbound.run('find_free_slots', { caller_ref: ref }, STRONG);
    await inbound.run('book_appointment', { caller_ref: ref, slot_id: 'S1' }, STRONG);
    assert.equal(((await m.Appointment.findOne({ uhid: 'U1' }).lean().exec()) as any).doctorId, String(morning._id));
  });

  test('two inbound callers booking the same slot at once: one wins, the other is told it was just taken', async () => {
    await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    await patient('U2', 'Bala Kumar', { doctor: 'Dr. Priya' });
    const a = await verify('Rekha Suresh');
    const b = await verify('Bala Kumar');
    await inbound.run('find_free_slots', { caller_ref: a }, STRONG);
    await inbound.run('find_free_slots', { caller_ref: b }, STRONG);
    const out = await Promise.all([a, b].map((ref) => inbound.run('book_appointment', { caller_ref: ref, slot_id: 'S1' }, STRONG)));
    assert.deepEqual(out.map((o) => o.ok).sort(), [false, true]);
    assert.match(String(out.find((o) => !o.ok)!.message), /just taken/);
    assert.equal(await m.Appointment.countDocuments({ status: 'Scheduled' }), 1);
  });

  test('an inbound reschedule moves the slotKey and hands the old slot on; a cancel unsets the key so the slot can be booked again', async () => {
    const p = await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    const date = dayOffset(4);
    const apt = await schedulingApts.book(ADMIN, { patientId: String(p._id), doctorId: String(afternoon._id), date, time: '03:00 PM' });
    const ref = await verify('Rekha Suresh');
    await inbound.run('list_appointments', { caller_ref: ref }, STRONG);
    await inbound.run('find_free_slots', { caller_ref: ref, preferred_date: dayOffset(6) }, STRONG);
    const slot = ((await m.InboundSession.findOne({ code: ref }).lean().exec()) as any).slots[0];
    assert.equal((await inbound.run('reschedule_appointment', { caller_ref: ref, appointment_id: 'A1', slot_id: 'S1' }, STRONG)).ok, true);
    let now = (await m.Appointment.findById(apt._id).lean().exec()) as any;
    assert.equal(now.slotKey, `${afternoon._id}|${slot.date}|${slot.time}`);
    assert.deepEqual(freed.map((f) => [f.id, f.doctorId, f.date, f.time]), [[String(apt._id), String(afternoon._id), date, '03:00 PM']]);

    assert.equal((await inbound.run('cancel_appointment', { caller_ref: ref, appointment_id: 'A1' }, STRONG)).ok, true);
    now = (await m.Appointment.findById(apt._id).lean().exec()) as any;
    assert.equal(now.status, 'Canceled');
    assert.equal(now.slotKey, undefined, 'the cancel unsets slotKey');
    assert.equal(freed.length, 2);
    assert.deepEqual([freed[1].date, freed[1].time], [slot.date, slot.time]);
    // The slot can be booked again.
    const q = await patient('U2', 'Bala Kumar', { phone: '+91 98765 43299' });
    const again = await schedulingApts.book(ADMIN, { patientId: String(q._id), doctorId: String(afternoon._id), date: slot.date, time: slot.time });
    assert.equal(again.slotKey, `${afternoon._id}|${slot.date}|${slot.time}`);
  });

  test('a cancelled outcome on a confirmation call unsets slotKey and frees the slot', async () => {
    const p = await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    const date = dayOffset(4);
    const apt = await schedulingApts.book(ADMIN, { patientId: String(p._id), doctorId: String(afternoon._id), date, time: '03:00 PM' });
    await calls.requestConfirmation(String(apt._id), 'Staff');
    await calls.recordResult({ providerCallId: 'fake_1', outcome: 'cancelled', summary: '', transcript: [] });
    const now = (await m.Appointment.findById(apt._id).lean().exec()) as any;
    assert.equal(now.status, 'Canceled');
    assert.equal(now.slotKey, undefined);
    assert.deepEqual(freed.map((f) => [f.doctorId, f.date, f.time]), [[String(afternoon._id), date, '03:00 PM']]);
  });

  test("a confirmation call's alternatives are the appointment's own doctor's slots; a reschedule keeps that doctor and re-keys", async () => {
    const p = await patient('U1', 'Rekha Suresh');
    const date = dayOffset(4);
    const apt = await schedulingApts.book(ADMIN, { patientId: String(p._id), doctorId: String(afternoon._id), date, time: '03:00 PM' });
    const call = await calls.requestConfirmation(String(apt._id), 'Staff');
    for (const s of call.offeredSlots) assert.match(s.time, /PM$/, 'Dr. Priya, not the patient\'s default doctor');
    const alt = call.offeredSlots[0];
    await calls.recordResult({ providerCallId: 'fake_1', outcome: 'rescheduled', chosenSlot: 1, summary: '', transcript: [] });
    const now = (await m.Appointment.findById(apt._id).lean().exec()) as any;
    assert.equal(now.date, alt.date);
    assert.equal(now.doctorId, String(afternoon._id));
    assert.equal(now.slotKey, `${afternoon._id}|${alt.date}|${alt.time}`);
    assert.equal(freed.length, 1);
    assert.equal(freed[0].time, '03:00 PM');
  });

  test('with no OP doctors the clinic sessions are used as before', async () => {
    await m.OpDoctor.updateMany({}, { $set: { active: false } });
    await patient('U1', 'Rekha Suresh', { doctor: 'Dr. Priya' });
    const call = await calls.requestBooking({ uhid: 'U1' }, 'Staff');
    assert.equal(call.offeredSlots.length, 2);
    await calls.recordResult({ providerCallId: 'fake_1', outcome: 'booked', chosenSlot: 1, summary: '', transcript: [] });
    const apt = (await m.Appointment.findOne({ uhid: 'U1' }).lean().exec()) as any;
    assert.equal(apt.doctorId, undefined);
    assert.equal(apt.slotKey, undefined);
  });
});
