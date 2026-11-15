import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import * as bcrypt from 'bcryptjs';
import { clockLabel, clockMinutes, parseIsoDay } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { AppointmentEvents } from '../modules/appointments/appointment-events';
import { UserRole } from '../modules/users/schemas/user.schema';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CasesService } from '../modules/coordinator/cases.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { DEFAULT_TITLES, EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { RulesService } from '../modules/coordinator/rules.service';
import { OpdService } from '../modules/opd/opd.service';
import { PatientsService } from '../modules/patients/patients.service';
import { ACTIVE_ISSUED_MS } from '../modules/pharmacy/pharmacy-orders.service';
import { contrastFlag, contrastWhen } from '../modules/pharmacy/pharmacy-rules';
import { resolveQueueSettings, MAX_COUNTERS } from '../modules/queue/queue-settings';
import { procedureByKey } from '../modules/scheduling/scheduling-catalogue';
import { SchedulingAppointmentsService } from '../modules/scheduling/scheduling-appointments.service';
import { SchedulingConflictsService } from '../modules/scheduling/scheduling-conflicts.service';
import { SchedulingConsultsService } from '../modules/scheduling/scheduling-consults.service';
import { SchedulingCoordinatorRegistration } from '../modules/scheduling/scheduling-coordinator.registration';
import { SchedulingDoctorsService } from '../modules/scheduling/scheduling-doctors.service';
import { SchedulingProceduresService } from '../modules/scheduling/scheduling-procedures.service';
import { SchedulingReconcileService } from '../modules/scheduling/scheduling-reconcile.service';
import { SchedulingRosterService } from '../modules/scheduling/scheduling-roster.service';
import { SchedulingSettingsService } from '../modules/scheduling/scheduling-settings.service';
import { SchedulingWaitlistService } from '../modules/scheduling/scheduling-waitlist.service';
import { SettingsService } from '../modules/settings/settings.service';
import { TimelineService } from '../modules/timeline/timeline.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';
import { buildCounters, buildDepartments, buildDoctors } from './seed-opd';
import { seedPharmacy } from './seed-pharmacy';
import { seedScheduling } from './seed-scheduling';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = '2026-09-26';
const PLUS1 = '2026-09-27';
const PLUS2 = '2026-09-28';
/** The real clock while seeding: Thursday 29 Oct 2026, 10:00 local. The clinic clock is 26 Sep 2026 at the same time. */
const NOW = new Date(2026, 9, 29, 10, 0, 0, 0).getTime();
const CLINIC_NOW = new Date(2026, 8, 26, 10, 0, 0, 0).getTime();
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'seed-data', `${name}.json`), 'utf8'));

const DOCTOR_LOGINS: [string, string][] = [
  ['arun@medios.ai', 'Dr. Arun Kumar'],
  ['priya@medios.ai', 'Dr. Priya Fernandez'],
  ['meena@medios.ai', 'Dr. Meena Joseph'],
  ['rajesh@medios.ai', 'Dr. Rajesh Pillai'],
  ['john@medios.ai', 'Dr. John Varghese'],
  ['lakshmi@medios.ai', 'Dr. Lakshmi Narayanan'],
  ['suresh@medios.ai', 'Dr. Suresh Nair'],
  ['kavitha@medios.ai', 'Dr. Kavitha Menon'],
  ['vinod@medios.ai', 'Dr. Vinod Kumar'],
  ['anand@medios.ai', 'Dr. Anand Iyer'],
];
const STAFF_ONLY_DOCTORS: [string, string, string][] = [
  ['anitha.anaesthesia@medios.ai', 'Dr. Anitha Rao', 'anaesthetist'],
  ['ravi.radiology@medios.ai', 'Dr. Ravi Shankar', 'radiologist'],
];

describe('seedScheduling', () => {
  const m = models();
  const ids: Record<string, string> = {};
  const holdersBefore: Record<string, string[]> = {};
  let savedClinic: string | undefined;
  let log: string[] = [];

  /** Quiet console while seeding; returns what was logged. */
  const quiet = async (work: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.join(' '));
    };
    try {
      await work();
    } finally {
      console.log = real;
    }
    return lines;
  };

  /** The Scheduling agent wired to the test database, as the module wires it (roster as the duty source). */
  const world = () => {
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    new ClocksService(m.Clock, registry, messages, escalations);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new SchedulingSettingsService(settingsService);
    const roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, settings, escalations);
    roster.onModuleInit();
    const consults = new SchedulingConsultsService(
      m.ConsultRequest, m.StaffMember, m.OpDoctor, m.Department, m.CoordinatorCounter, m.TaskAlertItem,
      new PatientsService(m.Patient), cases, messages, settings, roster, escalations,
    );
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock, consults, messages).onModuleInit();
    const procedures = new SchedulingProceduresService(
      m.ProcedureBooking, m.RoomBlock, m.StaffMember, m.RosterEntry, m.Appointment, m.OpDoctor, m.SchedulingLock,
      m.CoordinatorCounter, m.TaskAlertItem, new PatientsService(m.Patient), cases, messages, settings, new RulesService(registry, settingsService, events), m.WaitItem,
    );
    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    const appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    const waitlist = new SchedulingWaitlistService(m.WaitItem, m.Appointment, m.Patient, m.FollowUpItem, m.TaskAlertItem, doctors, appts, procedures);
    waitlist.onModuleInit();
    const conflicts = new SchedulingConflictsService(m.Appointment, m.ProcedureBooking, m.RoomBlock, m.OpDoctor, m.StaffMember, m.WaitItem, m.TaskAlertItem, doctors, roster, escalations);
    const reconcile = new SchedulingReconcileService(m.ProcedureBooking, m.ConsultRequest, m.WaitItem, procedures, consults, waitlist, conflicts);
    return { escalations, roster, doctors, reconcile };
  };

  const userId = async (email: string) => String((await m.User.findOne({ email }).lean<any>().exec())!._id);
  const mohan = async () => {
    const visit = (await m.ErVisit.find().lean<any[]>().exec()).find((v) => /Pressure in the chest/.test(v.complaintText ?? ''))!;
    const c = (await m.Case.findById(visit.case).lean<any>().exec())!;
    return { visit, patient: (await m.Patient.findById(c.patient).lean<any>().exec())! };
  };

  /** The hospital as the main seed leaves it before seedScheduling: users, OP doctors (seedOpd), settings, fixtures, then the other agents. */
  const seedTheRest = async (nowMs: number) => {
    await quiet(async () => {
      await seedEr(DAY, nowMs);
      await seedLab(DAY, nowMs);
      await seedPharmacy(DAY, nowMs);
    });
  };

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    savedClinic = process.env.CLINIC_DATE;
    // The seed may run without CLINIC_DATE (.env is read only when MONGODB_URI is not passed): it must not depend on it.
    delete process.env.CLINIC_DATE;
    mock.timers.enable({ apis: ['Date'], now: NOW });

    for (const [key, email, name, role, department] of [
      ['admin', 'admin@medios.ai', 'Hospital Admin', 'admin', 'Administration'],
      ['doctor', 'doctor@medios.ai', 'Dr. Shajin', 'doctor', 'General Medicine'],
      ['nurse', 'nurse@medios.ai', 'Nurse Anjali Thomas', 'nurse', 'Nursing'],
      ['pharmacist', 'pharmacy@medios.ai', 'Neethu George', 'pharmacist', 'Pharmacy'],
      ['lab', 'lab@medios.ai', 'Vishnu Prasad', 'lab', 'Laboratory'],
      ['desk', 'frontdesk@medios.ai', 'Front Desk', 'staff', 'Reception'],
    ] as const) ids[key] = String((await m.User.create({ email, passwordHash: 'x', name, role, department }))._id);
    const path = LAB_DEMO_ACCOUNTS[0];
    await m.User.create({ email: path.email, passwordHash: 'x', name: path.name, role: path.role, department: path.department });
    // seedOpd, as seed.ts runs it: departments, OP doctors (Dr. Shajin linked to doctor@), queue rooms and the default doctor.
    const departments = buildDepartments();
    const doctors = buildDoctors(departments);
    await m.Department.insertMany(departments);
    const saved = await m.OpDoctor.insertMany(doctors.map((d) => ({ ...d, ...(d.name === 'Dr. Shajin' && { userId: ids.doctor }) })));
    ids.shajin = String(saved.find((d: any) => d.name === 'Dr. Shajin')!._id);
    const settings = fixture('settings');
    settings.queue = { ...settings.queue, counters: buildCounters(doctors) };
    settings.reception = { ...settings.reception, defaultDoctorId: ids.shajin };
    await m.HospitalSettings.create(settings);
    await m.Patient.insertMany(fixture('patients'));
    await m.Appointment.insertMany(fixture('appointments'));
    await m.Prescription.insertMany(fixture('prescriptions'));
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY, NOW);
    });
    await seedTheRest(NOW);

    // Who held each duty title before Scheduling: the fixed holders (else the admins).
    const plain = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, new MessagesService(m.AgentMessage, new AgentRegistry(), new CoordinatorEvents()), new CoordinatorEvents());
    for (const t of DEFAULT_TITLES) holdersBefore[t.key] = (await plain.holders(t.key)).ids.sort();

    log = await quiet(() => seedScheduling(DAY, NOW));
    process.env.CLINIC_DATE = DAY;
  });

  after(async () => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
    await closeTestDb();
  });

  test('departments, doctors and logins as listed; queue rooms ≤ 12', async () => {
    const departments = await m.Department.find().lean<any[]>().exec();
    assert.deepEqual(departments.map((d) => d.code).sort(), ['cardiology', 'dermatology', 'ent', 'gen-med', 'gynecology', 'orthopedics', 'pediatrics', 'surgery']);
    const dept = (code: string) => departments.find((d) => d.code === code)!;
    assert.deepEqual([dept('surgery').name, dept('surgery').tokenPrefix, dept('surgery').active], ['General Surgery', 'S', true]);
    assert.deepEqual([dept('ent').name, dept('ent').tokenPrefix, dept('ent').active], ['ENT', 'E', true]);

    const doctors = await m.OpDoctor.find().lean<any[]>().exec();
    assert.equal(doctors.length, 11);
    const doctor = (name: string) => doctors.find((d) => d.name === name)!;
    for (const [name, code, room, prefix] of [
      ['Dr. Kavitha Menon', 'cardiology', 'Room 306', 'C2'],
      ['Dr. Vinod Kumar', 'surgery', 'Room 401', 'S'],
      ['Dr. Anand Iyer', 'ent', 'Room 113', 'E'],
    ]) {
      const d = doctor(name);
      assert.deepEqual([d.departmentCode, d.room, d.tokenPrefix, d.active], [code, room, prefix, true], name);
      assert.ok(d.sessions.length >= 1, `${name} has OP sessions`);
    }

    // 11 doctors' rooms plus the Consultation Room: 12 queue rooms, all kept by the queue settings.
    const settings = (await m.HospitalSettings.findOne().lean<any>().exec())!;
    const counters: string[] = settings.queue.counters;
    assert.equal(counters.length, 12);
    assert.ok(counters.length <= MAX_COUNTERS);
    assert.deepEqual(resolveQueueSettings(settings.queue).counters, counters);
    for (const d of doctors) assert.ok(counters.includes(d.room), d.room);
    assert.ok(counters.includes('Consultation Room'));
    // Dr. Shajin stays the default doctor, and doctor@ stays his login.
    assert.equal(settings.reception.defaultDoctorId, ids.shajin);
    assert.equal(doctor('Dr. Shajin').userId, ids.doctor);

    // Every OP doctor has a doctor login, linked to the OP doctor and to one staff member.
    for (const [email, name] of DOCTOR_LOGINS) {
      const u = (await m.User.findOne({ email }).select('+passwordHash').lean<any>().exec())!;
      assert.ok(u, `${email} exists`);
      assert.deepEqual([u.name, u.role, u.isActive], [name, UserRole.DOCTOR, true], email);
      assert.equal(doctor(name).userId, String(u._id), `${name} is linked to ${email}`);
      const staff = await m.StaffMember.find({ userId: String(u._id) }).lean<any[]>().exec();
      assert.equal(staff.length, 1, `${email} has one staff member`);
      assert.equal(staff[0].departmentCode, doctor(name).departmentCode);
      assert.ok(staff[0].skills.length >= 1);
    }
    const kavitha = (await m.User.findOne({ email: 'kavitha@medios.ai' }).select('+passwordHash').lean<any>().exec())!;
    assert.ok(await bcrypt.compare('Admin@123', kavitha.passwordHash), 'the demo password works');
    // The two staff-only doctors: a login and a staff member, no OP doctor.
    for (const [email, name, skill] of STAFF_ONLY_DOCTORS) {
      const u = (await m.User.findOne({ email }).lean<any>().exec())!;
      assert.deepEqual([u?.name, u?.role], [name, UserRole.DOCTOR], email);
      const staff = (await m.StaffMember.findOne({ userId: String(u._id) }).lean<any>().exec())!;
      assert.deepEqual(staff.skills, [skill]);
      assert.equal(await m.OpDoctor.countDocuments({ name }).exec(), 0);
    }
    const shajinStaff = (await m.StaffMember.findOne({ userId: ids.doctor }).lean<any>().exec())!;
    assert.deepEqual([shajinStaff.name, shajinStaff.departmentCode, shajinStaff.skills], ['Dr. Shajin', 'gen-med', ['physician']]);

    // The rest of the team, with no login; nurse@, pharmacy@ and lab@ are each one staff member.
    const noLogin = await m.StaffMember.find({ userId: { $exists: false } }).lean<any[]>().exec();
    const bySkill = (skill: string) => noLogin.filter((s) => s.skills.includes(skill)).length;
    assert.deepEqual(
      ['cath-nurse', 'ot-nurse', 'procedure-nurse', 'cath-technician', 'radiographer', 'sonologist'].map(bySkill),
      [2, 3, 1, 2, 2, 1],
    );
    assert.equal(noLogin.length, 11);
    for (const key of ['nurse', 'pharmacist', 'lab']) assert.equal(await m.StaffMember.countDocuments({ userId: ids[key] }).exec(), 1, `${key} is a staff member`);
    assert.equal(await m.StaffMember.countDocuments().exec(), 11 + 2 + 11 + 3);
    assert.match(log.join('\n'), /✅ .*scheduling/i);
  });

  test('duty titles resolve through the roster to the same people as before', async () => {
    const w = world();
    const rajesh = await userId('rajesh@medios.ai');
    const changed: Record<string, string[]> = {
      // Nobody held these before (they fell back to the admins); now the roster or a fixed holder names someone.
      'cardiology-on-call': [rajesh],
      'ot-in-charge': [ids.nurse],
      'chief-pharmacist': [ids.pharmacist],
      'ward-nurse-in-charge': [ids.nurse],
      'patient-relations': [ids.desk],
    };
    for (const t of DEFAULT_TITLES) {
      const now = (await w.escalations.holders(t.key)).ids.sort();
      assert.deepEqual(now, changed[t.key] ?? holdersBefore[t.key], t.key);
    }
    // The roster itself names them during the day shift: the title holders the other seeds set, the same people.
    const at = new Date(CLINIC_NOW);
    for (const [key, who] of [
      ['er-nurse-in-charge', ids.nurse],
      ['ot-in-charge', ids.nurse],
      ['duty-doctor', ids.doctor],
      ['er-consultant', ids.doctor],
      ['cardiology-on-call', rajesh],
      ['pharmacist-on-duty', ids.pharmacist],
      ['lab-in-charge', ids.lab],
    ] as const) assert.deepEqual(await w.roster.titleHolders(key, at), [who], key);
    // The on-call entry runs past midnight: at 02:00 the next day Dr. Rajesh Pillai is still cardiology on-call.
    assert.deepEqual(await w.roster.titleHolders('cardiology-on-call', new Date(2026, 8, 27, 2, 0)), [rajesh]);
    // Fixed holders keep the demo free of roster gaps at any hour.
    for (const t of await w.escalations.titles()) {
      if (!t.holderNames.length) assert.ok(await w.roster.titleHolders(t.key, at), `${t.key} has a holder`);
    }
    assert.deepEqual((await m.DutyTitle.findOne({ key: 'ot-in-charge' }).lean<any>().exec())!.holders.map(String), [ids.nurse]);
    assert.deepEqual((await m.DutyTitle.findOne({ key: 'chief-pharmacist' }).lean<any>().exec())!.holders.map(String), [ids.pharmacist]);

    // Seven days from clinic day −3 to +3, every shift covered.
    const entries = await m.RosterEntry.find().lean<any[]>().exec();
    const days = ['2026-09-23', '2026-09-24', '2026-09-25', DAY, PLUS1, PLUS2, '2026-09-29'];
    assert.deepEqual([...new Set(entries.map((e) => e.date))].sort(), days);
    for (const d of days) for (const s of ['morning', 'evening', 'night', 'on-call']) assert.ok(entries.some((e) => e.date === d && e.shift === s), `${d} ${s}`);
  });

  test("Mohan Raj's angiography is booked at 08:30 on day +2 with the cath team, and his metformin line carries the contrast flag", async () => {
    const { visit, patient } = await mohan();
    assert.equal(patient.name, 'Mohan Raj');
    const b = (await m.ProcedureBooking.findOne({ patient: patient._id, procedure: 'coronary-angiography' }).lean<any>().exec())!;
    assert.ok(b, 'his booking exists');
    assert.deepEqual([b.status, b.room], ['booked', 'cath-lab']);
    assert.equal(b.start.getTime(), new Date(2026, 8, 28, 8, 30).getTime());
    assert.equal(b.end.getTime(), new Date(2026, 8, 28, 9, 15).getTime());
    assert.equal(String(b.case), String(visit.case), 'on his ER case');
    assert.ok(b.announcedAt instanceof Date);
    assert.deepEqual(b.team.map((t: any) => t.role), ['cardiologist', 'cath-nurse', 'cath-technician']);
    for (const t of b.team) {
      assert.ok(t.staffId && !t.unfilled, `${t.role} filled`);
      const s = (await m.StaffMember.findById(t.staffId).lean<any>().exec())!;
      assert.ok(s.skills.includes(t.role), `${s.name} is a ${t.role}`);
    }
    const booked = await m.AgentMessage.find({ type: 'scheduling.procedure-booked', 'payload.bookingId': String(b._id) }).lean<any[]>().exec();
    assert.equal(booked.length, 1);
    assert.equal(booked[0].payload.contrast, true);

    // Pharmacy learnt of it from the message: the note, the flag on his issued metformin line, and one alert.
    const note = (await m.PharmacyProcedureNote.findOne({ bookingId: String(b._id) }).lean<any>().exec())!;
    assert.deepEqual([note.status, note.start.getTime(), String(note.patient)], ['booked', b.start.getTime(), String(patient._id)]);
    const metformin = (await m.PharmacyLine.findOne({ patient: patient._id, medicine: 'metformin' }).lean<any>().exec())!;
    assert.ok(metformin, 'his metformin line exists');
    assert.deepEqual([metformin.status, metformin.dose, metformin.frequency], ['issued', 500, 'BD']);
    const issuedAt = metformin.issued.realAt.getTime();
    assert.ok(issuedAt <= NOW && issuedAt > NOW - ACTIVE_ISSUED_MS, 'issued within the active window, not after now');
    const expected = contrastFlag(
      { medicine: 'metformin', dose: 500, frequency: 'BD' },
      { age: null, sex: null, weightKg: null, allergies: [], egfr: null, kidneyStatus: 'unknown', contrast: { at: b.start, number: b.number } },
    )!;
    const flag = metformin.flags.find((f: any) => f.key === 'procedure.contrast');
    assert.ok(flag, 'the contrast flag is on the metformin line');
    assert.deepEqual([flag.severity, flag.text], [expected.severity, expected.text]);
    const alerts = await m.TaskAlertItem.find({ link: `pharmacy-contrast:${b._id}` }).lean<any[]>().exec();
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].status, alerts[0].title], ['Pending', `Contrast dye on ${contrastWhen(b.start)}: hold metformin`]);

    // His STAT cardiology consult, accepted by the cardiologist on call.
    const consult = (await m.ConsultRequest.findOne({ patient: patient._id }).lean<any>().exec())!;
    assert.deepEqual([consult.departmentCode, consult.priority, consult.status], ['cardiology', 'stat', 'accepted']);
    assert.equal(consult.pagedTo.id, await userId('rajesh@medios.ai'));
    assert.ok(consult.acceptedAt.getTime() <= NOW);
  });

  test('four leave appointments are on the waitlist once', async () => {
    const john = (await m.OpDoctor.findOne({ name: 'Dr. John Varghese' }).lean<any>().exec())!;
    const profile = (await m.DoctorProfile.findOne({ doctorId: String(john._id) }).lean<any>().exec())!;
    assert.deepEqual(profile.leave.map((l: any) => [l.from, l.to]), [[PLUS2, PLUS2]]);
    const apts = await m.Appointment.find({ doctorId: String(john._id), date: PLUS2, status: 'Scheduled' }).lean<any[]>().exec();
    assert.equal(apts.length, 4);
    for (const a of apts) assert.equal(a.slotKey, `${john._id}|${PLUS2}|${a.time}`);
    const leaveItems = async () => m.WaitItem.find({ kind: 'appointment', reason: 'doctor-leave', status: 'open' }).lean<any[]>().exec();
    const items = await leaveItems();
    assert.equal(items.length, 4);
    assert.deepEqual(items.map((i) => String(i.refId)).sort(), apts.map((a) => String(a._id)).sort());
    for (const i of items) assert.equal(i.doctorId, String(john._id));
    // The leave day is a Monday, inside his sessions; every offer is a real free slot, not on the leave day.
    assert.equal(parseIsoDay(PLUS2).getDay(), 1);
    const doctorsSvc = world().doctors;
    for (const i of [...items, ...(await m.WaitItem.find({ status: 'open', reason: 'earlier-wanted' }).lean<any[]>().exec())]) {
      assert.ok(i.offered.length > 0, 'has offers');
      for (const o of i.offered) {
        assert.notEqual(i.reason === 'doctor-leave' ? o.date : '', PLUS2);
        assert.ok(await doctorsSvc.isSlot(i.doctorId, o.date, o.time), `${o.date} ${o.time} is one of the doctor's slots`);
      }
    }
    // Plus one patient who wants an earlier time: five open items in all.
    const open = await m.WaitItem.find({ status: 'open' }).lean<any[]>().exec();
    assert.equal(open.length, 5);
    const earlier = open.filter((i) => i.reason === 'earlier-wanted');
    assert.equal(earlier.length, 1);
    assert.equal(earlier[0].wantsEarlier, true);

    // Saving the same leave again keeps each appointment on the list once.
    const w = world();
    await w.doctors.setProfile({ id: ids.admin, name: 'Hospital Admin', role: UserRole.ADMIN }, String(john._id), { leave: [{ from: PLUS2, to: PLUS2, reason: profile.leave[0].reason }] });
    assert.equal((await leaveItems()).length, 4);
    assert.equal(await m.WaitItem.countDocuments({ status: 'open' }).exec(), 5);
  });

  test('appointments, procedures, consults and conflicts as listed', async () => {
    // The 18 fixture appointments are Dr. Shajin's, each with its slot key.
    const fixtures = fixture('appointments') as { uhid: string; date: string; time: string }[];
    assert.equal(fixtures.length, 18);
    for (const f of fixtures) {
      const a = (await m.Appointment.findOne({ uhid: f.uhid, date: f.date, time: f.time }).lean<any>().exec())!;
      assert.deepEqual([a.doctorId, a.doctorName, a.departmentCode], [ids.shajin, 'Dr. Shajin', 'gen-med'], `${f.uhid} ${f.date} ${f.time}`);
      assert.equal(a.slotKey, `${ids.shajin}|${f.date}|${clockLabel(clockMinutes(f.time))}`);
    }
    // 25 more across the other doctors on the clinic day and the next.
    const others = await m.Appointment.find({ doctorId: { $ne: ids.shajin } }).lean<any[]>().exec();
    assert.equal(others.length, 25);
    assert.ok(new Set(others.map((a) => a.doctorId)).size >= 6, 'spread across the doctors');
    for (const a of others) {
      assert.ok([DAY, PLUS2].includes(a.date), a.date);
      assert.ok(a.slotKey && a.doctorName && a.departmentCode, 'doctor fields and slot key');
      assert.ok(await m.Patient.exists({ uhid: a.uhid }).exec(), `${a.uhid} is a patient`);
    }

    // About 12 procedures: one STAT in progress, one done, one urgent that can't be booked (no free OT), the rest booked.
    const bookings = await m.ProcedureBooking.find().lean<any[]>().exec();
    assert.ok(bookings.length >= 10 && bookings.length <= 14, `${bookings.length} procedures`);
    const status = (s: string) => bookings.filter((b) => b.status === s);
    assert.equal(status('in-progress').length, 1);
    assert.equal(status('in-progress')[0].priority, 'stat');
    assert.ok(status('in-progress')[0].startedAt.getTime() <= CLINIC_NOW);
    assert.ok(status('in-progress')[0].end.getTime() > CLINIC_NOW, 'still running');
    assert.equal(status('done').length, 1);
    assert.equal(status('cant-book').length, 1);
    assert.equal(status('requested').length + status('cancelled').length, 0);
    assert.equal(status('booked').length, bookings.length - 3);
    const waiting = status('cant-book')[0];
    assert.equal(waiting.priority, 'urgent');
    assert.equal(procedureByKey(waiting.procedure)!.roomKind, 'ot');
    const waitClock = await m.Clock.find({ def: 'scheduling-booking', ref: String(waiting._id) }).lean<any[]>().exec();
    assert.equal(waitClock.length, 1);
    assert.equal(waitClock[0].state, 'running');
    assert.ok(waitClock[0].dueAt.getTime() > NOW);
    assert.equal((await m.TaskAlertItem.findOne({ link: `scheduling-wait:${waiting._id}` }).lean<any>().exec())!.status, 'Pending');
    for (const b of bookings) {
      assert.ok(b.announcedAt instanceof Date, `${b.number} announced`);
      if (b.status === 'booked') assert.ok(b.team.length && b.team.every((t: any) => t.staffId && !t.unfilled), `${b.number} has its team`);
    }
    assert.deepEqual(bookings.map((b) => b.number).sort(), bookings.map((_, i) => `PR-${String(i + 1).padStart(4, '0')}`));

    // OT 2 is blocked over exactly one booking.
    const blocks = await m.RoomBlock.find({ room: 'ot-2' }).lean<any[]>().exec();
    const under = status('booked').filter((b) => b.room === 'ot-2' && blocks.some((x) => x.from < b.end && b.start < x.to));
    assert.equal(under.length, 1);

    // Consults: STAT accepted, one urgent overdue and escalated, one routine.
    const consults = await m.ConsultRequest.find().lean<any[]>().exec();
    assert.deepEqual(consults.map((c) => `${c.priority}:${c.status}`).sort(), ['routine:paged', 'stat:accepted', 'urgent:paged']);
    const overdue = consults.find((c) => c.priority === 'urgent')!;
    assert.ok(overdue.dueAt.getTime() < NOW, 'the urgent consult is overdue');
    const clock = (await m.Clock.findOne({ def: 'scheduling-consult', ref: String(overdue._id) }).lean<any>().exec())!;
    assert.equal(clock.state, 'expired');
    const escalation = (await m.Escalation.findById(clock.escalation).lean<any>().exec())!;
    assert.deepEqual([escalation.ladder, escalation.state, escalation.alertLink], ['consult', 'open', `scheduling-consult:${overdue._id}`]);
    const page = (await m.TaskAlertItem.findOne({ link: `scheduling-consult:${overdue._id}` }).lean<any>().exec())!;
    assert.match(page.title, /^Escalated to Medical superintendent: Consult seen overdue/);
    assert.equal(page.status, 'Pending');
    for (const c of consults.filter((x) => x.priority !== 'urgent')) {
      const running = (await m.Clock.findOne({ def: 'scheduling-consult', ref: String(c._id) }).lean<any>().exec())!;
      assert.equal(running.state, 'running');
      assert.ok(running.dueAt.getTime() > NOW);
      assert.ok(c.announcedAt instanceof Date);
    }

    // Two conflicts: OT 2 blocked over a booking, and Dr. Shajin running late (his fixture patients still wait).
    const conflicts = await m.TaskAlertItem.find({ link: /^scheduling-conflict:/, status: { $ne: 'Completed' } }).lean<any[]>().exec();
    assert.deepEqual(conflicts.map((c) => c.link.split(':')[1]).sort(), ['room-blocked', 'running-late']);
    assert.equal(conflicts.find((c) => c.link.startsWith('scheduling-conflict:running-late:'))!.link, `scheduling-conflict:running-late:${ids.shajin}`);
    assert.match(conflicts.find((c) => c.link.startsWith('scheduling-conflict:room-blocked:'))!.title, /^OT 2 is blocked/);
  });

  test('no patient name in any scheduling message or alert', async () => {
    const names = (await m.Patient.find().lean<any[]>().exec()).map((p) => p.name as string);
    // Staff names are allowed in alert words (Dr. Arun Kumar shares a patient's name).
    const people = [...(await m.StaffMember.find().lean<any[]>().exec()).map((s) => s.name as string), ...(await m.User.find().lean<any[]>().exec()).map((u) => u.name as string)]
      .sort((a, b) => b.length - a.length);
    const strip = (text: string) => people.reduce((t, p) => t.split(p).join(''), text);

    const msgs = await m.AgentMessage.find({ type: /^scheduling\./ }).lean<any[]>().exec();
    assert.ok(msgs.length >= 30, `${msgs.length} messages`);
    for (const msg of msgs) {
      const text = `${msg.summary} ${JSON.stringify(msg.payload)}`;
      for (const n of names) assert.ok(!text.includes(n), `"${n}" in ${msg.type}`);
      assert.ok(msg.summary.length <= 140);
      assert.match(msg.summary, /^(PR|CO)-\d{4}: /);
      assert.ok(!/MHK2\d{9}/.test(text), 'no UHID');
    }
    // The escalation's own messages about the overdue consult.
    for (const msg of await m.AgentMessage.find({ type: { $in: ['clock.expired', 'escalation.raised'] }, summary: /Consult/ }).lean<any[]>().exec()) {
      for (const n of names) assert.ok(!msg.summary.includes(n), `"${n}" in ${msg.type}`);
    }
    const alerts = await m.TaskAlertItem.find({ link: /^scheduling-/ }).lean<any[]>().exec();
    assert.ok(alerts.length >= 15, `${alerts.length} alerts`);
    for (const a of alerts) {
      const text = strip(`${a.title} ${a.subtitle} ${a.link}`);
      for (const n of names) assert.ok(!text.includes(n), `"${n}" in the alert ${a.link}: ${a.title} / ${a.subtitle}`);
    }
    for (const c of await m.Clock.find({ def: /^scheduling-/ }).lean<any[]>().exec()) for (const n of names) assert.ok(!(c.detail ?? '').includes(n), `"${n}" in a clock detail`);
  });

  test('168 snapshots', async () => {
    const snaps = await m.SchedulingSnapshot.find().sort({ hour: 1 }).lean<any[]>().exec();
    assert.equal(snaps.length, 168);
    for (const s of snaps) {
      for (const k of ['proceduresToday', 'openConsults', 'conflicts', 'waitlist', 'appointmentsToday']) assert.ok(Number.isInteger(s[k]) && s[k] >= 0, k);
      assert.ok(s.at.getTime() <= NOW, 'not after now');
    }
    const last = snaps.at(-1)!;
    assert.equal(last.hour.getTime(), hourOf(new Date(NOW)).getTime());
    assert.equal(snaps[0].hour.getTime(), last.hour.getTime() - 167 * HOUR);
    // The last one holds this hour's real numbers.
    assert.deepEqual([last.openConsults, last.waitlist, last.conflicts], [3, 5, 2]);
    assert.equal(last.appointmentsToday, await m.Appointment.countDocuments({ date: DAY, status: { $nin: ['Canceled', 'No Show'] } }).exec());
  });

  test('reconcile sends nothing after seeding', async () => {
    // Two minutes on, so the reconcile pass's 30-second grace hides nothing the seed wrote.
    mock.timers.setTime(NOW + 2 * MIN);
    const w = world();
    const snap = async () => ({
      messages: await m.AgentMessage.countDocuments().exec(),
      alerts: (await m.TaskAlertItem.find().sort({ _id: 1 }).lean<any[]>().exec()).map((a) => [String(a._id), a.link, a.status, a.title, a.subtitle]),
      bookings: (await m.ProcedureBooking.find().sort({ _id: 1 }).lean<any[]>().exec()).map((b) => [String(b._id), b.status, b.announcedAt?.getTime(), b.start?.getTime(), b.room, b.history.length]),
      consults: (await m.ConsultRequest.find().sort({ _id: 1 }).lean<any[]>().exec()).map((c) => [String(c._id), c.status, c.announcedAt?.getTime()]),
      waitItems: (await m.WaitItem.find().sort({ _id: 1 }).lean<any[]>().exec()).map((i) => [String(i._id), i.status, JSON.stringify(i.offered)]),
      clocks: (await m.Clock.find().sort({ _id: 1 }).lean<any[]>().exec()).map((c) => [String(c._id), c.state, c.dueAt.getTime()]),
      escalations: await m.Escalation.countDocuments().exec(),
    });
    const beforeRun = await snap();
    try {
      const result = await w.reconcile.reconcile();
      assert.deepEqual([result.announced, result.alerts, result.waitItems, result.booked], [0, 0, 0, 0]);
      assert.equal(result.conflicts, 2);
      assert.deepEqual(await snap(), beforeRun, 'nothing new was sent or written');
    } finally {
      mock.timers.setTime(NOW);
    }
  });

  test('nothing is after now at 06:00 or 23:00', async () => {
    for (const [label, hour] of [['06:00', 6], ['23:00', 23]] as const) {
      // The next real day, so everything the earlier tests wrote is before either moment.
      const at = new Date(2026, 9, 30, hour, 0, 0).getTime();
      const clinic = new Date(2026, 8, 26, hour, 0, 0).getTime();
      mock.timers.setTime(at);
      delete process.env.CLINIC_DATE;
      try {
        await seedTheRest(at);
        await quiet(() => seedScheduling(DAY, at));
      } finally {
        process.env.CLINIC_DATE = DAY;
      }
      const real = (d: Date | undefined | null, what: string) => d && assert.ok(new Date(d).getTime() <= at, `${what} ${new Date(d).toISOString()} is after now (${label})`);
      const clinicTime = (d: Date | undefined | null, what: string) => d && assert.ok(new Date(d).getTime() <= clinic, `${what} ${new Date(d).toISOString()} is after the clinic now (${label})`);

      // The story holds at either hour.
      const { patient } = await mohan();
      const b = (await m.ProcedureBooking.findOne({ patient: patient._id, procedure: 'coronary-angiography' }).lean<any>().exec())!;
      assert.equal(b.start.getTime(), new Date(2026, 8, 28, 8, 30).getTime(), `Mohan Raj at 08:30 on day +2 (${label})`);
      assert.deepEqual(await Promise.all(['in-progress', 'done', 'cant-book'].map((s) => m.ProcedureBooking.countDocuments({ status: s }).exec())), [1, 1, 1], label);
      assert.equal(await m.Escalation.countDocuments({ ladder: 'consult', state: 'open' }).exec(), 1, label);
      assert.equal(await m.WaitItem.countDocuments({ status: 'open' }).exec(), 5, label);

      for (const x of await m.ProcedureBooking.find().lean<any[]>().exec()) {
        for (const k of ['createdAt', 'updatedAt', 'announcedAt']) real(x[k], `${x.number} ${k}`);
        for (const k of ['startedAt', 'doneAt']) clinicTime(x[k], `${x.number} ${k}`);
        for (const h of x.history) clinicTime(h.at, `${x.number} history "${h.what}"`);
      }
      for (const c of await m.ConsultRequest.find().lean<any[]>().exec()) for (const k of ['createdAt', 'updatedAt', 'requestedAt', 'acceptedAt', 'announcedAt']) real(c[k], `${c.number} ${k}`);
      for (const [label2, rows] of [
        ['wait item', await m.WaitItem.find().lean<any[]>().exec()],
        ['room block', await m.RoomBlock.find().lean<any[]>().exec()],
        ['roster entry', await m.RosterEntry.find().lean<any[]>().exec()],
        ['staff member', await m.StaffMember.find().lean<any[]>().exec()],
        ['doctor profile', await m.DoctorProfile.find().lean<any[]>().exec()],
        ['appointment', await m.Appointment.find().lean<any[]>().exec()],
        ['user', await m.User.find().lean<any[]>().exec()],
        ['procedure note', await m.PharmacyProcedureNote.find().lean<any[]>().exec()],
        ['timeline event', await m.TimelineEvent.find().lean<any[]>().exec()],
        ['department', await m.Department.find().lean<any[]>().exec()],
        ['OP doctor', await m.OpDoctor.find().lean<any[]>().exec()],
      ] as const) for (const r of rows) for (const k of ['createdAt', 'updatedAt']) real(r[k], `${label2} ${k}`);
      const schedulingCases = await m.Case.find({ openedBy: 'scheduling' }).lean<any[]>().exec();
      for (const c of schedulingCases) {
        clinicTime(c.openedAt, `${c.number} openedAt`);
        real(c.createdAt, `${c.number} createdAt`);
        real(c.updatedAt, `${c.number} updatedAt`);
      }
      const consultClocks = await m.Clock.find({ def: /^scheduling-/ }).lean<any[]>().exec();
      for (const c of consultClocks) {
        for (const k of ['startedAt', 'stoppedAt', 'createdAt', 'updatedAt']) real(c[k], `${c.def} ${k}`);
        if (c.state === 'running') assert.ok(c.dueAt.getTime() > at, `${c.def} running but due ${c.dueAt.toISOString()} (${label})`);
      }
      const escalations = await m.Escalation.find({ ladder: 'consult' }).lean<any[]>().exec();
      for (const e of escalations) for (const k of ['raisedAt', 'stepAt', 'createdAt', 'updatedAt']) real(e[k], `escalation ${k}`);
      const messages = await m.AgentMessage.find({
        $or: [
          { from: 'scheduling' },
          { case: { $in: schedulingCases.map((c) => c._id) } },
          { dedupeKey: { $in: [...consultClocks.map((c) => `clock.expired:${c._id}`), ...escalations.map((e) => `escalation.raised:${e._id}`)] } },
        ],
      }).lean<any[]>().exec();
      assert.ok(messages.length >= 30);
      for (const msg of messages) real(msg.createdAt, `${msg.type} createdAt`);
      for (const a of await m.TaskAlertItem.find({ link: /^(scheduling-|pharmacy-contrast:)/ }).lean<any[]>().exec()) {
        real(a.createdAt, `${a.link} createdAt`);
        real(a.updatedAt, `${a.link} updatedAt`);
      }
      const snaps = await m.SchedulingSnapshot.find().sort({ hour: 1 }).lean<any[]>().exec();
      assert.equal(snaps.length, 168);
      assert.equal(snaps.at(-1)!.hour.getTime(), hourOf(new Date(at)).getTime());
      for (const s of snaps) real(s.at, 'snapshot at');
    }
    mock.timers.setTime(NOW);
  });
});
