import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { Types } from 'mongoose';
import { parseIsoDay } from '../../common/utils/clinic-time';
import { hourOf } from '../../common/utils/series';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiProviderName } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { ROOMS } from './scheduling-catalogue';
import { SchedulingAiService, leaks } from './scheduling-ai';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingOverviewService } from './scheduling-overview.service';
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

const PATIENT = 'Mohan Raj';
const UHID = 'MHK202600970';
const PHONE = '9100000070';
const STAFF = 'Dr. Arun Menon';
const REASON = 'chest pain after exertion, call wife Latha';

/** A provider that records exactly what the AI client is handed. */
function stubProvider(name: AiProviderName, answer: unknown | ((req: any) => unknown) = { text: 'A busy day with a few conflicts to watch.' }) {
  const calls: { instructions: string; input: Record<string, unknown> }[] = [];
  const p: AiProvider = {
    name,
    model: 'm',
    complete: async (req) => {
      calls.push({ instructions: req.instructions, input: req.input });
      return typeof answer === 'function' ? answer(req) : answer;
    },
    check: async () => ({ ok: true, detail: 'fine' }),
  };
  return { p, calls };
}
const aiService = (p: AiProvider, on = true) => new AiService(p, { getSettings: async () => ({ ai: { schedulingSummary: on } }) } as any, { get: () => 50 } as any);

describe('SchedulingOverviewService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let patient: any;
  let caseId: Types.ObjectId;
  let seq = 0;
  let settings: SchedulingSettingsService;
  let doctors: SchedulingDoctorsService;

  const build = (ai: AiService) => new SchedulingOverviewService(m.SchedulingSnapshot, m.Appointment, m.ProcedureBooking, m.RoomBlock, m.ConsultRequest, m.WaitItem, m.OpDoctor, m.Department, m.TaskAlertItem, doctors, settings, new SchedulingAiService(ai));
  const overviewWith = (kind: AiProviderName = 'none') => build(aiService(stubProvider(kind).p));

  const opDoctor = (name: string, days: number[], departmentCode = 'CARD') =>
    m.OpDoctor.create({ name, departmentCode, room: 'Room 1', tokenPrefix: name.slice(-1).toUpperCase() + String(++seq), sessions: [{ days, start: '09:00', end: '13:00' }] });
  const appointment = (doctor: any, time: string, status = 'Scheduled', date = D) =>
    m.Appointment.create({ uhid: UHID, patientName: PATIENT, age: 58, gender: 'Male', time, date, doctorId: String(doctor._id), doctorName: doctor.name, departmentCode: doctor.departmentCode, status });
  const booking = (over: Record<string, unknown> = {}) =>
    m.ProcedureBooking.create({
      number: `PR-${String(++seq).padStart(4, '0')}`,
      patient: patient._id,
      patientUhid: UHID,
      patientName: PATIENT,
      case: caseId,
      procedure: 'coronary-angiography',
      priority: 'routine',
      status: 'booked',
      room: 'cath-lab',
      start: at('08:00'),
      end: at('09:30'),
      team: [{ role: 'cardiologist', name: STAFF }],
      requestedBy: { id: 'u', name: STAFF },
      earliest: at('08:00'),
      ...over,
    });
  const consult = (status: string, priority = 'urgent') =>
    m.ConsultRequest.create({
      number: `CO-${String(++seq).padStart(4, '0')}`,
      patient: patient._id,
      patientUhid: UHID,
      patientName: PATIENT,
      case: caseId,
      departmentCode: 'CARD',
      priority,
      reason: REASON,
      status,
      pagedTo: { id: 'u1', name: STAFF },
      pagedIds: ['u1'],
      dueAt: new Date(Date.now() + 60 * MIN),
      requestedBy: { id: 'u', name: STAFF },
      requestedAt: new Date(Date.now() - 30 * MIN),
    });
  const waitItem = () =>
    m.WaitItem.create({ kind: 'appointment', refId: new Types.ObjectId(), reason: 'doctor-leave', priority: 'routine', patient: patient._id, patientUhid: UHID, patientName: PATIENT, original: { date: D, time: '09:00 AM' } });
  const conflictAlert = (kind: string, ref: string, status = 'Pending') =>
    m.TaskAlertItem.create({ title: `${STAFF} is double-booked`, subtitle: 'Doctor double-booked', type: 'System', category: 'System', priority: 'Medium', status, link: `scheduling-conflict:${kind}:${ref}` });

  /** The day the tests share: two doctors in session (one on leave), appointments, procedures, a consult, a waitlist item and a conflict. */
  async function populate() {
    const arun = await opDoctor(STAFF, [2]);
    const beena = await opDoctor('Dr. Beena', [3]); // no session on a Tuesday
    const chitra = await opDoctor('Dr. Chitra', [2]); // in session, but on leave today
    await m.DoctorProfile.create({ doctorId: String(chitra._id), slotMinutes: 15, leave: [{ from: D, to: D, reason: 'Conference' }] });
    await m.DoctorProfile.create({ doctorId: String(arun._id), slotMinutes: 20, leave: [] });
    await appointment(arun, '09:00 AM');
    await appointment(arun, '06:00 AM', 'Waiting'); // an hour late at 07:00
    await appointment(arun, '10:00 AM', 'Canceled');
    await appointment(arun, '09:00 AM', 'Scheduled', '2026-10-21'); // tomorrow
    await appointment(beena, '09:30 AM', 'Scheduled', '2026-10-21');
    await booking(); // cath lab, 90 min
    await booking({ procedure: 'chest-xray', room: 'xray', start: at('10:00'), end: at('10:10'), status: 'in-progress' }); // imaging
    await booking({ status: 'cancelled', room: 'ot-1', start: at('11:00'), end: at('12:30') });
    await booking({ status: 'requested', room: undefined, start: undefined, end: undefined });
    await m.RoomBlock.create({ room: 'ot-2', from: at('08:00'), to: at('12:00'), reason: 'Deep clean', by: { id: 'a', name: 'Admin' } });
    await consult('paged');
    await consult('seen');
    await waitItem();
    await conflictAlert('doctor-overlap', 'r1');
    await conflictAlert('leave', 'r2', 'Completed');
    return { arun, beena, chitra };
  }

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
    const settingsService = new SettingsService(m.HospitalSettings);
    settings = new SchedulingSettingsService(settingsService);
    doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, new OpdService(m.Department, m.OpDoctor, settingsService));
    patient = await m.Patient.create({ uhid: UHID, name: PATIENT, age: 58, gender: 'Male', phone: PHONE });
    caseId = new Types.ObjectId();
    await m.Department.create({ code: 'CARD', name: 'Cardiology', tokenPrefix: 'C' });
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test("overview counts today's appointments, procedures, open consults, waitlist and conflicts", async () => {
    await populate();
    const o = await overviewWith().overview();
    assert.equal(o.cards.appointmentsToday.value, 2, 'tomorrow and cancelled are not counted');
    assert.equal(o.cards.proceduresToday.value, 2, 'cancelled and unscheduled are not counted');
    assert.equal(o.cards.openConsults.value, 1, 'paged is open, seen is not');
    assert.equal(o.cards.waitlist.value, 1);
    assert.equal(o.cards.conflicts.value, 1, 'a completed conflict alert is not open');
    assert.equal(o.conflicts.length, 1);
    assert.deepEqual([o.conflicts[0].kind, o.conflicts[0].ref], ['doctor-overlap', 'r1']);
    assert.ok(o.conflicts[0].text.includes('double-booked'));

    // merged schedule: opd, procedure, imaging and consult rows, sorted by time, UHID never a name
    const kinds = o.schedule.map((r) => r.kind);
    assert.deepEqual([...new Set(kinds)].sort(), ['consult', 'imaging', 'opd', 'procedure']);
    assert.equal(o.schedule.filter((r) => r.kind === 'opd').length, 2);
    assert.equal(o.schedule.find((r) => r.kind === 'imaging')!.doctorOrRoom, 'X-ray');
    assert.ok(o.schedule.every((r) => r.who === UHID));
    assert.ok(!JSON.stringify(o.schedule).includes(PATIENT));
    const times = o.schedule.filter((r) => r.kind !== 'consult').map((r) => r.time);
    assert.deepEqual(times, [...times].sort());

    // room use: 90 booked minutes in the cath lab against its 10 elective hours
    const cath = o.roomUse.find((r) => r.room === 'cath-lab')!;
    assert.deepEqual([cath.bookedMin, cath.openMin], [90, 600]);
    assert.equal(o.roomUse.find((r) => r.room === 'xray')!.bookedMin, 10);
    assert.equal(o.roomUse.find((r) => r.room === 'ot-1')!.bookedMin, 0);
  });

  test('the calendar has one column per doctor in session today and one per room', async () => {
    const { arun, beena, chitra } = await populate();
    const { calendar } = await overviewWith().overview();
    const docCols = calendar.columns.filter((c) => c.kind === 'doctor');
    assert.deepEqual(docCols.map((c) => c.key), [String(arun._id)], 'no Tuesday session (Dr. Beena) and on leave (Dr. Chitra) are left out');
    assert.ok(!docCols.some((c) => [String(beena._id), String(chitra._id)].includes(c.key)));
    assert.deepEqual(calendar.columns.filter((c) => c.kind === 'room').map((c) => c.key), ROOMS.map((r) => r.key));
    // appointment blocks span the doctor's slot length (20 min), procedures sit in their room, room blocks too
    const apt = calendar.blocks.find((b) => b.column === String(arun._id) && b.start === at('09:00').toISOString())!;
    assert.equal(apt.end, at('09:20').toISOString());
    assert.ok(calendar.blocks.some((b) => b.column === 'cath-lab' && b.kind === 'procedure'));
    assert.ok(calendar.blocks.some((b) => b.column === 'ot-2' && b.kind === 'block'));
    assert.ok(!calendar.blocks.some((b) => b.column === 'ot-1'), 'a cancelled booking is not drawn');
    assert.ok(!calendar.blocks.some((b) => b.status === 'Canceled' || b.status === 'cancelled'));
  });

  test('the AI input holds counts only — no name, UHID, number or staff name, and free text never appears', async () => {
    await populate();
    const blobs: string[] = [];
    for (const mode of ['sample', 'claude'] as const) {
      const { p, calls } = stubProvider(mode);
      const real = aiService(p);
      const spy: any[] = [];
      const orig = real.runStructured.bind(real);
      (real as any).runStructured = (task: any) => {
        spy.push({ instructions: task.instructions, input: task.input });
        return orig(task);
      };
      await build(real).summarise();
      assert.equal(spy.length, 1);
      if (mode === 'claude') assert.equal(calls.length, 1, 'the client got the same payload');
      blobs.push(...spy.map((x) => JSON.stringify(x)), ...calls.map((x) => JSON.stringify(x)));
    }
    const secrets = [PATIENT, 'Mohan', 'Raj', UHID, PHONE, 'MHK', 'PR-0', 'CO-0', STAFF, 'Arun', 'Menon', 'Dr.', REASON, 'chest pain', 'Latha', 'Deep clean', 'Conference', String(patient._id), String(caseId)];
    for (const blob of blobs) {
      for (const s of secrets) assert.ok(!blob.includes(s), `leaked ${s}`);
      assert.ok(!leaks(blob), 'the leak check passes on the whole payload');
      assert.ok(!/\b[a-f\d]{24}\b/i.test(blob) && !/\d{9,}/.test(blob));
    }
    // what is there: counts by whitelisted keys
    const input = JSON.parse(blobs[0]).input;
    assert.deepEqual(Object.keys(input).sort(), ['appointmentsByDepartment', 'avgWaitMin', 'conflictsByKind', 'consultsByPriorityStatus', 'roomUsePctByKind', 'waitlist']);
    assert.deepEqual(input.appointmentsByDepartment, { Cardiology: 2 });
    assert.equal(input.avgWaitMin, 60);
    assert.deepEqual(input.conflictsByKind, { 'doctor-overlap': 1 });
    assert.equal(input.waitlist, 1);
    assert.equal(input.roomUsePctByKind['cath-lab'], 15);
    assert.deepEqual(input.consultsByPriorityStatus, { 'urgent/paged': 1, 'urgent/seen': 1 });
  });

  test('the sample summary is marked sample', async () => {
    await populate();
    const sample = await overviewWith('sample').summarise();
    assert.equal(sample.sample, true);
    assert.equal(sample.source, 'ai');
    assert.match(sample.text, /2 appointments/);
    // off or failing → the rule-written sentence, not marked sample
    const off = await overviewWith('none').summarise();
    assert.equal(off.sample, false);
    assert.equal(off.source, 'rules');
    assert.equal(off.text, sample.text, 'the same fixed sentence');
    // an AI answer that leaks is refused and the rule sentence is used
    const bad = await build(aiService(stubProvider('claude', { text: `See ${UHID}` }).p)).summarise();
    assert.equal(bad.source, 'rules');
    const good = await build(aiService(stubProvider('claude').p)).summarise();
    assert.deepEqual([good.source, good.sample], ['ai', false]);
  });

  test('snapshots store the hour once, feed the trend and fill a 168-point series with gaps as null', async () => {
    await populate();
    const svc = overviewWith();
    await svc.snapshot();
    await svc.snapshot();
    assert.equal(await m.SchedulingSnapshot.countDocuments(), 1);
    const dayAgo = hourOf(new Date(Date.now() - 24 * 60 * MIN));
    await m.SchedulingSnapshot.create({ hour: dayAgo, at: dayAgo, appointmentsToday: 1, proceduresToday: 1, openConsults: 1, waitlist: 1, conflicts: 1 });
    const o = await svc.overview();
    assert.equal(o.cards.appointmentsToday.trendPct, 100);
    assert.equal(o.cards.appointmentsToday.spark.length, 24);
    assert.equal(o.cards.appointmentsToday.spark.at(-1), 2);
    const s = await svc.series('7d');
    assert.equal(s.points.length, 168);
    assert.equal(s.points.at(-1)!.appointmentsToday, 2);
    assert.equal(s.points[0].appointmentsToday, null);
    assert.equal((await svc.series('24h')).points.length, 24);
  });
});
