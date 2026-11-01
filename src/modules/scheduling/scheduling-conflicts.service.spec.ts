import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { Types } from 'mongoose';
import { parseIsoDay } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { SchedulingConflictsService } from './scheduling-conflicts.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';

const MIN = 60_000;
/** Tuesday 20 Oct 2026, 07:00 local; CLINIC_DATE unset, so the clinic clock is this clock. */
const NOW = () => new Date(2026, 9, 20, 7, 0, 0, 0);
const D = '2026-10-20';
const at = (hhmm: string, day = D) => {
  const d = parseIsoDay(day);
  const [h, mm] = hhmm.split(':').map(Number);
  d.setHours(h, mm, 0, 0);
  return d;
};

describe('SchedulingConflictsService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let conflicts: SchedulingConflictsService;
  let patient: any;
  let caseId: Types.ObjectId;
  let seq = 0;

  const conflictAlerts = () => m.TaskAlertItem.find({ link: /^scheduling-conflict:/ }).sort({ link: 1 }).lean().exec() as Promise<any[]>;
  const pending = async () => (await conflictAlerts()).filter((a) => a.status === 'Pending');
  const opDoctor = (name: string, userId?: string) =>
    m.OpDoctor.create({ name, departmentCode: 'CARD', room: 'Room 1', tokenPrefix: 'A', sessions: [], ...(userId ? { userId } : {}) });
  const appointment = (doctor: any, time: string, status = 'Scheduled', date = D) =>
    m.Appointment.create({ uhid: patient.uhid, patientName: 'Mohan Raj', age: 58, gender: 'Male', time, date, doctorId: String(doctor._id), doctorName: doctor.name, status });
  const booking = (team: any[], over: Record<string, unknown> = {}) =>
    m.ProcedureBooking.create({
      number: `PR-${String(++seq).padStart(4, '0')}`,
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: 'Mohan Raj',
      case: caseId,
      procedure: 'coronary-angiography',
      priority: 'routine',
      status: 'booked',
      room: 'cath-lab',
      start: at('08:00'),
      end: at('09:30'),
      team: team.map((s) => ({ role: 'cardiologist', staffId: String(s._id), name: s.name })),
      requestedBy: { id: 'u', name: 'Dr. X' },
      earliest: at('08:00'),
      ...over,
    });

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
    seq = 0;
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    const settingsService = new SettingsService(m.HospitalSettings);
    const roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, new SchedulingSettingsService(settingsService), escalations);
    roster.onModuleInit();
    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    conflicts = new SchedulingConflictsService(m.Appointment, m.ProcedureBooking, m.RoomBlock, m.OpDoctor, m.StaffMember, m.WaitItem, m.TaskAlertItem, doctors, roster, escalations);
    patient = await m.Patient.create({ uhid: 'MHK202600970', name: 'Mohan Raj', age: 58, gender: 'Male', phone: '9100000070' });
    caseId = new Types.ObjectId();
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test('a doctor with an appointment inside their own booked procedure is one conflict', async () => {
    const userId = String(new Types.ObjectId());
    const arun = await m.StaffMember.create({ name: 'Dr. Arun', skills: ['cardiologist'], departmentCode: 'CARD', userId });
    const doc = await opDoctor('Dr. Arun', userId);
    await booking([arun]);
    await appointment(doc, '08:30 AM');

    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'doctor-overlap');
    assert.ok(!found[0].text.includes('Mohan'), 'no patient name');
    assert.match(found[0].text, /Dr\. Arun/);

    await conflicts.sweep();
    const alerts = await conflictAlerts();
    assert.equal(alerts.length, 1, 'one alert, however many passes');
    assert.equal(alerts[0].link, `scheduling-conflict:doctor-overlap:${found[0].ref}`);
    assert.deepEqual([alerts[0].type, alerts[0].category, alerts[0].priority, alerts[0].status], ['System', 'System', 'Medium', 'Pending']);
  });

  test('blocking OT 2 over a booking raises one conflict, and removing the block clears it', async () => {
    await booking([], { room: 'ot-2', procedure: 'hernia-repair', start: at('09:00'), end: at('10:30') });
    assert.deepEqual(await conflicts.sweep(), []);

    const block = await m.RoomBlock.create({ room: 'ot-2', from: at('08:00'), to: at('12:00'), reason: 'Deep clean', by: { id: 'a', name: 'Admin' } });
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'room-blocked');
    assert.match(found[0].text, /OT 2/);
    assert.equal((await pending()).length, 1);

    await m.RoomBlock.deleteOne({ _id: block._id });
    assert.deepEqual(await conflicts.sweep(), []);
    assert.equal((await pending()).length, 0, 'the alert closes itself');
    assert.equal((await conflictAlerts()).length, 1, 'it is completed, not removed');
  });

  test('an appointment still Waiting 45 min after its time → doctor running late', async () => {
    const doc = await opDoctor('Dr. Shajin');
    mock.timers.tick(2 * 60 * MIN + 40 * MIN); // 09:40
    await appointment(doc, '09:00 AM', 'Waiting');
    assert.deepEqual(await conflicts.sweep(), [], '40 minutes is not late yet');

    mock.timers.tick(6 * MIN); // 09:46
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'running-late');
    assert.equal(found[0].ref, String(doc._id));
    assert.match(found[0].text, /1 patient/);
    assert.ok(!found[0].text.includes('Mohan'));

    await m.Appointment.updateMany({}, { $set: { status: 'In Consultation' } });
    assert.deepEqual(await conflicts.sweep(), []);
    assert.equal((await pending()).length, 0);
  });

  test('a booked procedure not started 30 min after start → late start', async () => {
    const b = await booking([]);
    mock.timers.tick(60 * MIN + 20 * MIN); // 08:20
    assert.deepEqual(await conflicts.sweep(), []);

    mock.timers.tick(11 * MIN); // 08:31
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'late-start');
    assert.equal(found[0].ref, String(b._id));
    assert.match(found[0].text, /PR-0001/);

    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'in-progress' } });
    assert.deepEqual(await conflicts.sweep(), []);
    assert.equal((await pending()).length, 0);
  });

  test('a title with no roster holder and no fixed holder → roster gap', async () => {
    await m.DutyTitle.create({ key: 'duty-doctor', label: 'Duty doctor', holders: [] });
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'roster-gap');
    assert.equal(found[0].ref, 'duty-doctor');

    const ravi = await m.StaffMember.create({ name: 'Dr. Ravi', skills: ['physician'], departmentCode: 'GEN', userId: String(new Types.ObjectId()) });
    await m.RosterEntry.create({ date: '2026-10-19', shift: 'night', staff: ravi._id, titles: ['duty-doctor'] });
    assert.deepEqual(await conflicts.sweep(), [], 'rostered now: no gap');
    assert.equal((await pending()).length, 0);
  });

  test('a live appointment on a leave day with no open wait item is one conflict, and it clears once it is on the waitlist', async () => {
    const doc = await opDoctor('Dr. Shajin');
    await m.DoctorProfile.create({ doctorId: String(doc._id), leave: [{ from: D, to: D, reason: 'Conference' }] });
    const apt = await appointment(doc, '10:00 AM');
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'leave');
    assert.equal(found[0].ref, String(apt._id));
    assert.ok(!found[0].text.includes('Mohan'));

    await m.WaitItem.create({
      kind: 'appointment', refId: apt._id, reason: 'doctor-leave', priority: 'routine', patient: patient._id,
      patientUhid: patient.uhid, patientName: 'Mohan Raj', original: { date: D, time: '10:00 AM' },
    });
    assert.deepEqual(await conflicts.sweep(), []);
    assert.equal((await pending()).length, 0);
  });

  test('an alert closed by hand is reopened by the next sweep while the cause persists, and a returning conflict reopens it', async () => {
    const b = await booking([]);
    mock.timers.tick(60 * MIN + 31 * MIN); // 08:31
    assert.equal((await conflicts.sweep()).length, 1);
    await m.TaskAlertItem.updateMany({ link: /^scheduling-conflict:/ }, { $set: { status: 'Completed' } });
    assert.equal((await conflicts.sweep()).length, 1);
    assert.equal((await pending()).length, 1, 'reopened');

    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'in-progress' } });
    await conflicts.sweep();
    assert.equal((await pending()).length, 0);
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'booked' } });
    await conflicts.sweep();
    assert.equal((await pending()).length, 1, 'the returning cause reopens the same alert');
    assert.equal((await conflictAlerts()).length, 1);
  });

  test('two overlapping appointments of one doctor are one conflict', async () => {
    const doc = await opDoctor('Dr. Shajin');
    await appointment(doc, '09:00 AM');
    await appointment(doc, '09:10 AM'); // a 15-minute slot runs to 09:15
    await appointment(doc, '09:30 AM');
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'doctor-overlap');
  });

  test('a doctor on two overlapping procedures is one conflict', async () => {
    const arun = await m.StaffMember.create({ name: 'Dr. Arun', skills: ['cardiologist'], departmentCode: 'CARD' });
    await booking([arun], { start: at('08:00'), end: at('09:30') });
    await booking([arun], { start: at('09:00'), end: at('10:00'), room: 'ot-1' });
    await booking([arun], { start: at('10:30'), end: at('11:00'), room: 'ot-1' });
    const found = await conflicts.sweep();
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'doctor-overlap');
    assert.match(found[0].text, /PR-0001.*PR-0002/);
  });

  test('running late starts at exactly 45 minutes and a late start at exactly 30', async () => {
    const doc = await opDoctor('Dr. Shajin');
    mock.timers.tick(2 * 60 * MIN); // 09:00
    await appointment(doc, '09:00 AM', 'Checked In');
    await booking([], { start: at('09:00'), end: at('09:45') });
    mock.timers.tick(30 * MIN - 1000); // 09:29:59
    assert.deepEqual(await conflicts.sweep(), []);
    mock.timers.tick(1000); // 09:30:00
    assert.deepEqual((await conflicts.sweep()).map((c) => c.kind), ['late-start']);
    mock.timers.tick(15 * MIN - 1000); // 09:44:59
    assert.deepEqual((await conflicts.sweep()).map((c) => c.kind), ['late-start']);
    mock.timers.tick(1000); // 09:45:00
    assert.deepEqual((await conflicts.sweep()).map((c) => c.kind).sort(), ['late-start', 'running-late']);
  });
});
