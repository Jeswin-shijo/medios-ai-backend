import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingFollowupsService } from './scheduling-followups.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';

const DOC = { id: 'u1', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const FRONT = { id: 'f1', name: 'Front desk', role: UserRole.STAFF };
/** Tuesday 20 Oct 2026, 07:00 local, no CLINIC_DATE. */
const NOW = () => new Date(2026, 9, 20, 7, 0, 0, 0);
/** Two 15-minute slots a day: 09:00 and 09:15. */
const TWO_SLOTS = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '09:30' }];

describe('SchedulingFollowupsService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let followups: SchedulingFollowupsService;
  let waitlist: SchedulingWaitlistService;
  let shajin: any;
  let patient: any;
  let n = 0;

  const fill = async (date: string) => {
    for (const time of ['09:00 AM', '09:15 AM']) {
      await m.Appointment.create({ uhid: `F${++n}`, patientName: `Filler ${n}`, age: 30, gender: 'Male', date, time, type: 'Consultation', status: 'Scheduled', doctorId: String(shajin._id), doctorName: 'Dr. Shajin' });
    }
  };

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
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    const opd = new OpdService(m.Department, m.OpDoctor, new SettingsService(m.HospitalSettings));
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: TWO_SLOTS } as any);
    await m.HospitalSettings.updateOne({}, { $set: { reception: { defaultDoctorId: String(shajin._id) } } });
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    const appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    waitlist = new SchedulingWaitlistService(m.WaitItem, m.Appointment, m.Patient, m.FollowUpItem, m.TaskAlertItem, doctors, appts, undefined as any);
    const registry = new AgentRegistry();
    const messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock, { onPatientLeft: async () => 0 } as any, messages).onModuleInit();
    followups = new SchedulingFollowupsService(m.Patient, m.FollowUpItem, m.Case, opd, doctors, appts, waitlist, messages);
    patient = await m.Patient.create({ uhid: 'MHK202600001', name: 'Asha Menon', age: 40, gender: 'Female', phone: '9000000001' });
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  const order = (extra: Record<string, unknown> = {}) => followups.order(DOC, { patientId: String(patient._id), doctorId: String(shajin._id), inDays: 7, note: 'Review BP', ...extra } as any);

  test('a follow-up in 7 days books day 7 when free, day 8 when day 7 is full, and becomes a waitlist item when the week is full', async () => {
    const a = await order();
    assert.deepEqual([a.status, a.date, a.time], ['booked', '2026-10-27', '09:00 AM']);
    const apt = (await m.Appointment.findById(a.appointmentId).lean()) as any;
    assert.deepEqual([apt.type, apt.condition, apt.doctorId, apt.status, apt.uhid], ['Follow-up', 'Review BP', String(shajin._id), 'Scheduled', 'MHK202600001']);
    const fu = (await m.FollowUpItem.findById(a.followUpId).lean()) as any;
    assert.deepEqual([fu.status, fu.followUpDate, fu.followUpTime, String(fu.appointmentId), fu.assignedTo, fu.uhid, fu.note], ['Scheduled', '27 Oct 2026', '09:00 AM', a.appointmentId, 'Dr. Shajin', 'MHK202600001', 'Review BP']);

    // Fill day 7 (the first booking holds 09:00 already) and the next order moves to day 8.
    await fill('2026-10-27');
    const b = await order({ patientId: String((await m.Patient.create({ uhid: 'MHK202600002', name: 'Bala', age: 3, gender: 'Male', phone: '9000000002' }))._id) });
    assert.deepEqual([b.status, b.date], ['booked', '2026-10-28']);

    // Fill days 7 to 14: nothing in the window, so a waitlist item.
    for (const d of ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) await fill(d);
    const c = await order({ patientId: String((await m.Patient.create({ uhid: 'MHK202600003', name: 'Chitra', age: 50, gender: 'Female', phone: '9000000003' }))._id) });
    assert.equal(c.status, 'waitlisted');
    assert.equal(c.appointmentId, undefined);
    const fu2 = (await m.FollowUpItem.findById(c.followUpId).lean()) as any;
    assert.deepEqual([fu2.status, fu2.followUpDate, fu2.appointmentId], ['Pending', '27 Oct 2026', undefined]);
    const wait = (await m.WaitItem.findById(c.waitItemId).lean()) as any;
    assert.deepEqual([wait.kind, wait.reason, wait.status, String(wait.refId), wait.original], ['appointment', 'no-slot', 'open', c.followUpId, { date: '2026-10-27', time: '' }]);
    assert.ok(wait.offered.every((o: any) => o.date > '2026-11-04'), 'offered times are after the full week');
    assert.equal(fu2.note, 'Review BP', 'the note is kept when the week is full');
  });

  test('Book offered on a no-slot follow-up books a new appointment with the doctor\'s note and schedules the follow-up', async () => {
    for (const d of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']) await fill(d);
    const c = await order({ note: 'Check BP and sugar' });
    assert.equal(c.status, 'waitlisted');
    assert.equal(((await m.FollowUpItem.findById(c.followUpId).lean()) as any).note, 'Check BP and sugar');
    const wait = (await m.WaitItem.findById(c.waitItemId).lean()) as any;
    const pick = wait.offered[0];
    const done = await waitlist.bookOffered(FRONT, c.waitItemId!, 0);
    assert.equal(done.status, 'resolved');
    const apt = (await m.Appointment.findOne({ uhid: 'MHK202600001', type: 'Follow-up' }).lean()) as any;
    assert.deepEqual([apt.date, apt.time, apt.condition, apt.doctorId, apt.status], [pick.date, pick.time, 'Check BP and sugar', String(shajin._id), 'Scheduled']);
    const fu = (await m.FollowUpItem.findById(c.followUpId).lean()) as any;
    assert.equal(fu.status, 'Scheduled');
    assert.equal(String(fu.appointmentId), String(apt._id));
    assert.equal(fu.followUpTime, pick.time);
    assert.match(fu.followUpDate, /^\d{1,2} \w{3} 2026$/);
  });

  test('the department picks the first active doctor by name; inDays and role are checked', async () => {
    const opd = new OpdService(m.Department, m.OpDoctor, new SettingsService(m.HospitalSettings));
    await opd.createDoctor({ name: 'Dr. Anand', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G3', sessions: TWO_SLOTS } as any);
    const r = await followups.order(DOC, { patientId: String(patient._id), departmentCode: 'gen-med', inDays: 3 });
    const apt = (await m.Appointment.findById(r.appointmentId).lean()) as any;
    assert.equal(apt.doctorName, 'Dr. Anand');
    for (const bad of [0, 366, 1.5, '7' as any, -1]) await assert.rejects(() => order({ inDays: bad }), BadRequestException);
    await assert.rejects(() => followups.order(FRONT, { patientId: String(patient._id), inDays: 7 }), ForbiddenException);
    // No doctor named: the patient's usual (default) doctor.
    const d = await followups.order(DOC, { patientId: String(patient._id), inDays: 2 });
    assert.equal(((await m.Appointment.findById(d.appointmentId).lean()) as any).doctorName, 'Dr. Shajin');
  });

  test('followup-booked goes to the open case only, with no patient name; no case is opened for a follow-up', async () => {
    await order();
    assert.equal(await m.Case.countDocuments({}), 0);
    assert.equal(await m.AgentMessage.countDocuments({ type: 'scheduling.followup-booked' }), 0, 'no open case, no message');
    const theCase = await m.Case.create({ number: 'CASE-0001', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, kind: 'opd', priority: 'low', state: 'open', openedAt: new Date(), agents: ['scheduling'], refs: { bedRequestIds: [] }, openedBy: 'scheduling' });
    const b = await followups.order(DOC, { patientId: String(patient._id), doctorId: String(shajin._id), inDays: 2 });
    const msgs = (await m.AgentMessage.find({ type: 'scheduling.followup-booked' }).lean()) as any[];
    assert.equal(msgs.length, 1);
    assert.equal(String(msgs[0].case), String(theCase._id));
    assert.deepEqual(msgs[0].payload, { appointmentId: b.appointmentId, date: b.date, time: b.time, doctor: 'Dr. Shajin' });
    assert.ok(!JSON.stringify(msgs[0]).includes('Asha'));
    assert.ok(msgs[0].summary.length <= 140);
  });
});
