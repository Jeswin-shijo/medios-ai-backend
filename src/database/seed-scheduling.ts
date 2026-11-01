import mongoose, { Model, Schema, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { clockLabel, displayDateTime, isoDate, parseIsoDay } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { AppointmentEvents } from '../modules/appointments/appointment-events';
import { Appointment, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import type { Actor } from '../modules/beds/actor';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CasesService } from '../modules/coordinator/cases.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { DEFAULT_LADDERS, DEFAULT_TITLES, EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { RulesService } from '../modules/coordinator/rules.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { ErVisit, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { FollowUpItem, FollowUpItemSchema } from '../modules/follow-ups/schemas/follow-up.schema';
import { LabTestReport, LabTestReportSchema } from '../modules/lab-reports/schemas/lab-report.schema';
import { OpdService } from '../modules/opd/opd.service';
import { Department, DepartmentSchema } from '../modules/opd/schemas/department.schema';
import { OpDoctor, OpDoctorSchema } from '../modules/opd/schemas/op-doctor.schema';
import { PatientsService } from '../modules/patients/patients.service';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { PharmacyChecksService } from '../modules/pharmacy/pharmacy-checks.service';
import { PharmacyCoordinatorRegistration } from '../modules/pharmacy/pharmacy-coordinator.registration';
import { PharmacyOrdersService } from '../modules/pharmacy/pharmacy-orders.service';
import { PharmacyPatientsService } from '../modules/pharmacy/pharmacy-patients.service';
import { PharmacyProceduresService } from '../modules/pharmacy/pharmacy-procedures.service';
import { PharmacySettingsService } from '../modules/pharmacy/pharmacy-settings.service';
import { PharmacyLine, PharmacyLineSchema } from '../modules/pharmacy/schemas/pharmacy-line.schema';
import { PharmacyLocation, PharmacyLocationSchema } from '../modules/pharmacy/schemas/pharmacy-location.schema';
import { PharmacyOrder, PharmacyOrderSchema } from '../modules/pharmacy/schemas/pharmacy-order.schema';
import { PharmacyProcedureNote, PharmacyProcedureNoteSchema } from '../modules/pharmacy/schemas/pharmacy-procedure-note.schema';
import { resolveQueueSettings } from '../modules/queue/queue-settings';
import { SchedulingAiService } from '../modules/scheduling/scheduling-ai';
import { SchedulingAppointmentsService } from '../modules/scheduling/scheduling-appointments.service';
import { Shift, Skill, procedureByKey, roomByKey } from '../modules/scheduling/scheduling-catalogue';
import { SchedulingConflictsService } from '../modules/scheduling/scheduling-conflicts.service';
import { SchedulingConsultsService } from '../modules/scheduling/scheduling-consults.service';
import { SCHEDULING_CLOCKS, SchedulingCoordinatorRegistration } from '../modules/scheduling/scheduling-coordinator.registration';
import { SchedulingDoctorsService } from '../modules/scheduling/scheduling-doctors.service';
import { SchedulingOverviewService } from '../modules/scheduling/scheduling-overview.service';
import { SchedulingProceduresService } from '../modules/scheduling/scheduling-procedures.service';
import { SchedulingRoomsService } from '../modules/scheduling/scheduling-rooms.service';
import { SchedulingRosterService } from '../modules/scheduling/scheduling-roster.service';
import { SchedulingSettingsService } from '../modules/scheduling/scheduling-settings.service';
import { SchedulingWaitlistService } from '../modules/scheduling/scheduling-waitlist.service';
import { ConsultRequest, ConsultRequestSchema } from '../modules/scheduling/schemas/consult-request.schema';
import { DoctorProfile, DoctorProfileSchema } from '../modules/scheduling/schemas/doctor-profile.schema';
import { ProcedureBooking, ProcedureBookingSchema } from '../modules/scheduling/schemas/procedure-booking.schema';
import { RoomBlock, RoomBlockSchema } from '../modules/scheduling/schemas/room-block.schema';
import { RosterEntry, RosterEntrySchema } from '../modules/scheduling/schemas/roster-entry.schema';
import { SchedulingLock, SchedulingLockSchema } from '../modules/scheduling/schemas/scheduling-lock.schema';
import { SchedulingSnapshot, SchedulingSnapshotSchema } from '../modules/scheduling/schemas/scheduling-snapshot.schema';
import { StaffMember, StaffMemberSchema } from '../modules/scheduling/schemas/staff-member.schema';
import { WaitItem, WaitItemSchema } from '../modules/scheduling/schemas/wait-item.schema';
import { HospitalSettings, HospitalSettingsSchema } from '../modules/settings/schemas/settings.schema';
import { SettingsService } from '../modules/settings/settings.service';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { TimelineService } from '../modules/timeline/timeline.service';
import { User, UserRole, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Demo password for the doctor logins: local development only. */
const DEMO_PASSWORD = 'Admin@123';
const BCRYPT_ROUNDS = 12;
/** Marks the made-up outpatients of this seed (never a demo patient), so a rerun clears them and nothing else. */
export const SCHEDULING_MARK = 'Seed: scheduling demo';

// ---------------------------------------------------------------------------------------------
// People. Dr. Shajin (doctor@) and his department come from seedOpd; the kiosk's other doctors get their logins here.
// ---------------------------------------------------------------------------------------------

interface DoctorAccount {
  email: string;
  name: string;
  specialty: string;
  department: string;
  skill: Skill;
  /** The OP doctor's department code; none for the staff-only doctors. */
  code: string;
}

/** Every doctor's login (role doctor, the demo password, local only). doctor@ stays Dr. Shajin's. */
export const SCHEDULING_DOCTOR_ACCOUNTS: DoctorAccount[] = [
  { email: 'arun@medios.ai', name: 'Dr. Arun Kumar', specialty: 'General Physician', department: 'General Medicine', skill: 'physician', code: 'gen-med' },
  { email: 'priya@medios.ai', name: 'Dr. Priya Fernandez', specialty: 'General Physician', department: 'General Medicine', skill: 'physician', code: 'gen-med' },
  { email: 'meena@medios.ai', name: 'Dr. Meena Joseph', specialty: 'Paediatrician', department: 'Pediatrics', skill: 'paediatrician', code: 'pediatrics' },
  { email: 'rajesh@medios.ai', name: 'Dr. Rajesh Pillai', specialty: 'Cardiologist', department: 'Cardiology', skill: 'cardiologist', code: 'cardiology' },
  { email: 'john@medios.ai', name: 'Dr. John Varghese', specialty: 'Orthopaedic Surgeon', department: 'Orthopedics', skill: 'orthopaedic-surgeon', code: 'orthopedics' },
  { email: 'lakshmi@medios.ai', name: 'Dr. Lakshmi Narayanan', specialty: 'Obstetrician and Gynaecologist', department: 'Gynecology', skill: 'obstetrician', code: 'gynecology' },
  // There is no dermatology skill: the dermatologist can take her department's consults as a physician.
  { email: 'suresh@medios.ai', name: 'Dr. Suresh Nair', specialty: 'Dermatologist', department: 'Dermatology', skill: 'physician', code: 'dermatology' },
  { email: 'kavitha@medios.ai', name: 'Dr. Kavitha Menon', specialty: 'Cardiologist', department: 'Cardiology', skill: 'cardiologist', code: 'cardiology' },
  { email: 'vinod@medios.ai', name: 'Dr. Vinod Kumar', specialty: 'General Surgeon', department: 'General Surgery', skill: 'surgeon', code: 'surgery' },
  { email: 'anand@medios.ai', name: 'Dr. Anand Iyer', specialty: 'ENT Surgeon', department: 'ENT', skill: 'ent-surgeon', code: 'ent' },
  // Staff-only doctors: rostered and paged, with no outpatient clinic.
  { email: 'anitha.anaesthesia@medios.ai', name: 'Dr. Anitha Rao', specialty: 'Anaesthetist', department: 'Anaesthesia', skill: 'anaesthetist', code: '' },
  { email: 'ravi.radiology@medios.ai', name: 'Dr. Ravi Shankar', specialty: 'Radiologist', department: 'Radiology', skill: 'radiologist', code: '' },
];

const MON_SAT = [1, 2, 3, 4, 5, 6];
const EXTRA_DEPARTMENTS = [
  { code: 'surgery', name: 'General Surgery', tokenPrefix: 'S', icon: 'content-cut', color: '#0EA5E9', order: 6, active: true },
  { code: 'ent', name: 'ENT', tokenPrefix: 'E', icon: 'hearing', color: '#14B8A6', order: 7, active: true },
];
const EXTRA_DOCTORS = [
  {
    name: 'Dr. Kavitha Menon', qualifications: 'MBBS, MD, DM (Cardiology)', departmentCode: 'cardiology', fee: 600, room: 'Room 306', tokenPrefix: 'C2',
    sessions: [{ days: MON_SAT, start: '10:00', end: '13:00' }, { days: MON_SAT, start: '17:00', end: '20:00' }],
  },
  // Outpatients on Tuesday, Thursday and Saturday mornings; the other days are for the theatre.
  { name: 'Dr. Vinod Kumar', qualifications: 'MBBS, MS (General Surgery)', departmentCode: 'surgery', fee: 500, room: 'Room 401', tokenPrefix: 'S', sessions: [{ days: [2, 4, 6], start: '09:00', end: '13:00' }] },
  {
    name: 'Dr. Anand Iyer', qualifications: 'MBBS, MS (ENT)', departmentCode: 'ent', fee: 400, room: 'Room 113', tokenPrefix: 'E',
    sessions: [{ days: MON_SAT, start: '09:00', end: '13:00' }, { days: MON_SAT, start: '17:00', end: '20:00' }],
  },
];

/** The rest of the team, with no login (the OT and cath lab in charge calls them). */
const TEAM: { name: string; skill: Skill }[] = [
  { name: 'Sister Bindu Mathew', skill: 'cath-nurse' },
  { name: 'Sister Reena Paul', skill: 'cath-nurse' },
  { name: 'Sister Deepa Raj', skill: 'ot-nurse' },
  { name: 'Sister Mini Joseph', skill: 'ot-nurse' },
  { name: 'Sister Shiny Thomas', skill: 'ot-nurse' },
  { name: 'Sister Ancy Varghese', skill: 'procedure-nurse' },
  { name: 'Arjun Menon', skill: 'cath-technician' },
  { name: 'Sajith Kumar', skill: 'cath-technician' },
  { name: 'Manoj Pillai', skill: 'radiographer' },
  { name: 'Divya Suresh', skill: 'radiographer' },
  { name: 'Dr. Neena Philip', skill: 'sonologist' },
];
/** The existing accounts that are staff members too. */
const LINKED: { email: string; skill: Skill }[] = [
  { email: 'nurse@medios.ai', skill: 'ward-nurse' },
  { email: 'pharmacy@medios.ai', skill: 'pharmacist' },
  { email: 'lab@medios.ai', skill: 'lab-technician' },
];

/** Made-up outpatients for the other doctors' clinics (marked, cleared on a rerun). */
const OUTPATIENTS: { name: string; age: number; gender: 'Male' | 'Female'; department: string; conditions: string[] }[] = [
  { name: 'Saravanan K', age: 45, gender: 'Male', department: 'General Medicine', conditions: ['Fatty liver'] },
  { name: 'Deepika S', age: 31, gender: 'Female', department: 'General Medicine', conditions: [] },
  { name: 'Venkatesh B', age: 60, gender: 'Male', department: 'General Medicine', conditions: ['Acid reflux'] },
  { name: 'Esther Paul', age: 36, gender: 'Female', department: 'General Medicine', conditions: [] },
  { name: 'Ajith Kumar', age: 38, gender: 'Male', department: 'General Medicine', conditions: ['Hypertension'] },
  { name: 'Shalini G', age: 25, gender: 'Female', department: 'General Medicine', conditions: [] },
  { name: 'Ramachandran V', age: 67, gender: 'Male', department: 'General Medicine', conditions: ['COPD'] },
  { name: 'Kavya Nair', age: 8, gender: 'Female', department: 'Pediatrics', conditions: ['Asthma'] },
  { name: 'Rahul Menon', age: 6, gender: 'Male', department: 'Pediatrics', conditions: [] },
  { name: 'Aadhya R', age: 3, gender: 'Female', department: 'Pediatrics', conditions: [] },
  { name: 'Gopal Krishnan', age: 64, gender: 'Male', department: 'Cardiology', conditions: ['Coronary artery disease'] },
  { name: 'Rosamma Thomas', age: 58, gender: 'Female', department: 'Cardiology', conditions: ['Hypertension'] },
  { name: 'Abdul Rahim', age: 51, gender: 'Male', department: 'Cardiology', conditions: ['Palpitations'] },
  { name: 'Nandhini P', age: 27, gender: 'Female', department: 'Gynecology', conditions: ['Pregnancy'] },
  { name: 'Sumathi V', age: 34, gender: 'Female', department: 'Gynecology', conditions: [] },
  { name: 'Karthika S', age: 22, gender: 'Female', department: 'Dermatology', conditions: ['Acne'] },
  { name: 'Bindhu Raj', age: 40, gender: 'Female', department: 'Dermatology', conditions: ['Eczema'] },
  { name: 'Mani Selvam', age: 47, gender: 'Male', department: 'ENT', conditions: ['Sinusitis'] },
  { name: 'Ilango R', age: 55, gender: 'Male', department: 'General Surgery', conditions: ['Inguinal hernia'] },
  { name: 'Rajendran P', age: 49, gender: 'Male', department: 'Cardiology', conditions: [] },
  { name: 'Tamilarasi K', age: 50, gender: 'Female', department: 'Orthopedics', conditions: ['Knee pain'] },
  { name: 'Antony Raj', age: 62, gender: 'Male', department: 'Orthopedics', conditions: ['Low back pain'] },
  { name: 'Kumari Devi', age: 44, gender: 'Female', department: 'Orthopedics', conditions: [] },
  { name: 'Sebastian J', age: 57, gender: 'Male', department: 'Orthopedics', conditions: ['Frozen shoulder'] },
  { name: 'Jebakumar S', age: 9, gender: 'Male', department: 'Pediatrics', conditions: [] },
];

/**
 * The other doctors' appointments: `day` 0 is the clinic day, 1 the next day; `who` is the outpatient's index. On the clinic
 * day a time already past is Completed, the rest Scheduled. Dr. John Varghese's four on the next day fall on his leave.
 */
const APPOINTMENTS: { doctor: string; day: 0 | 1; time: string; who: number; type: string; condition: string }[] = [
  { doctor: 'Dr. Arun Kumar', day: 0, time: '08:15', who: 0, type: 'Consultation', condition: 'Tiredness and right upper abdominal discomfort' },
  { doctor: 'Dr. Arun Kumar', day: 0, time: '09:00', who: 1, type: 'Consultation', condition: 'Fever for three days' },
  { doctor: 'Dr. Arun Kumar', day: 0, time: '11:30', who: 4, type: 'Follow-up', condition: 'Blood pressure review' },
  { doctor: 'Dr. Arun Kumar', day: 0, time: '16:30', who: 6, type: 'Follow-up', condition: 'Breathlessness review' },
  { doctor: 'Dr. Priya Fernandez', day: 0, time: '08:30', who: 2, type: 'Consultation', condition: 'Heartburn after meals' },
  { doctor: 'Dr. Priya Fernandez', day: 0, time: '10:00', who: 3, type: 'Consultation', condition: 'Headache' },
  { doctor: 'Dr. Priya Fernandez', day: 0, time: '12:15', who: 5, type: 'Routine Checkup', condition: '' },
  { doctor: 'Dr. Meena Joseph', day: 0, time: '09:15', who: 7, type: 'Pediatric OPD', condition: 'Wheezing at night' },
  { doctor: 'Dr. Meena Joseph', day: 0, time: '10:30', who: 8, type: 'Pediatric OPD', condition: 'Vaccination' },
  { doctor: 'Dr. Meena Joseph', day: 0, time: '17:30', who: 9, type: 'Pediatric OPD', condition: 'Cough and cold' },
  { doctor: 'Dr. Rajesh Pillai', day: 0, time: '09:30', who: 10, type: 'Follow-up', condition: 'Angina review' },
  { doctor: 'Dr. Rajesh Pillai', day: 0, time: '11:00', who: 11, type: 'Consultation', condition: 'High blood pressure' },
  { doctor: 'Dr. Kavitha Menon', day: 0, time: '10:15', who: 12, type: 'Consultation', condition: 'Palpitations' },
  { doctor: 'Dr. Kavitha Menon', day: 0, time: '17:15', who: 19, type: 'Consultation', condition: 'Chest discomfort on walking' },
  { doctor: 'Dr. Lakshmi Narayanan', day: 0, time: '09:45', who: 13, type: 'Antenatal', condition: '28 weeks' },
  { doctor: 'Dr. Lakshmi Narayanan', day: 0, time: '12:00', who: 14, type: 'Consultation', condition: 'Irregular cycles' },
  { doctor: 'Dr. Suresh Nair', day: 0, time: '17:00', who: 15, type: 'Consultation', condition: 'Acne' },
  { doctor: 'Dr. Suresh Nair', day: 0, time: '18:30', who: 16, type: 'Follow-up', condition: 'Eczema review' },
  { doctor: 'Dr. Anand Iyer', day: 0, time: '11:15', who: 17, type: 'Consultation', condition: 'Blocked nose and facial pain' },
  { doctor: 'Dr. Vinod Kumar', day: 0, time: '10:45', who: 18, type: 'Consultation', condition: 'Groin swelling' },
  { doctor: 'Dr. John Varghese', day: 1, time: '09:00', who: 20, type: 'Consultation', condition: 'Knee pain' },
  { doctor: 'Dr. John Varghese', day: 1, time: '09:30', who: 21, type: 'Follow-up', condition: 'Low back pain review' },
  { doctor: 'Dr. John Varghese', day: 1, time: '10:15', who: 22, type: 'Consultation', condition: 'Ankle sprain' },
  { doctor: 'Dr. John Varghese', day: 1, time: '11:00', who: 23, type: 'Follow-up', condition: 'Frozen shoulder review' },
  // The one who would like an earlier time.
  { doctor: 'Dr. Meena Joseph', day: 1, time: '10:00', who: 24, type: 'Pediatric OPD', condition: 'Ear pain' },
];
const LEAVE = { doctor: 'Dr. John Varghese', reason: 'Medical conference' };

// ---------------------------------------------------------------------------------------------

/** The clinic moment for the real moment `nowMs`: the clinic day, at the real time of day. */
function clinicAt(day: string, nowMs: number): number {
  const d = new Date(nowMs);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m) d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

/** A small repeatable number generator, so the history is the same on every seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (day: string, n: number): string => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
/** A clinic-clock moment: day + "HH:mm". */
const at = (day: string, hhmm: string): Date => {
  const d = parseIsoDay(day);
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  return d;
};
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The services the app wires, built by hand on the seed's models (as the specs do). */
function wire() {
  const registry = new AgentRegistry();
  const events = new CoordinatorEvents();
  const messages = new MessagesService(model(AgentMessage, AgentMessageSchema) as never, registry, events);
  const escalations = new EscalationsService(
    model(Escalation, EscalationSchema) as never, model(DutyTitle, DutyTitleSchema) as never, model(Ladder, LadderSchema) as never,
    model(TaskAlertItem, TaskAlertItemSchema) as never, model(User, UserSchema) as never, messages, events,
  );
  // Starts and stops the clocks the messages below ask for.
  new ClocksService(model(Clock, ClockSchema) as never, registry, messages, escalations);
  // No case closes while the seed runs: every case it touches stays open for the work of the other agents (an ER visit, an
  // admission) or for its own bookings and consults, so the close checks would all hold it open. An empty registry has none.
  const cases = new CasesService(model(Case, CaseSchema) as never, model(CoordinatorCounter, CoordinatorCounterSchema) as never, messages, new AgentRegistry(), new TimelineService(model(TimelineEvent, TimelineEventSchema) as never));
  const settingsService = new SettingsService(model(HospitalSettings, HospitalSettingsSchema) as never);
  const settings = new SchedulingSettingsService(settingsService);
  const patients = new PatientsService(model(Patient, PatientSchema) as never);
  const roster = new SchedulingRosterService(model(StaffMember, StaffMemberSchema) as never, model(RosterEntry, RosterEntrySchema) as never, settings, escalations);
  roster.onModuleInit();
  const consults = new SchedulingConsultsService(
    model(ConsultRequest, ConsultRequestSchema) as never, model(StaffMember, StaffMemberSchema) as never, model(OpDoctor, OpDoctorSchema) as never,
    model(Department, DepartmentSchema) as never, model(CoordinatorCounter, CoordinatorCounterSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never,
    patients, cases, messages, settings, roster, escalations,
  );
  new SchedulingCoordinatorRegistration(registry, model(ConsultRequest, ConsultRequestSchema) as never, model(ProcedureBooking, ProcedureBookingSchema) as never, model(Clock, ClockSchema) as never, consults, messages).onModuleInit();
  const procedures = new SchedulingProceduresService(
    model(ProcedureBooking, ProcedureBookingSchema) as never, model(RoomBlock, RoomBlockSchema) as never, model(StaffMember, StaffMemberSchema) as never,
    model(RosterEntry, RosterEntrySchema) as never, model(Appointment, AppointmentSchema) as never, model(OpDoctor, OpDoctorSchema) as never,
    model(SchedulingLock, SchedulingLockSchema) as never, model(CoordinatorCounter, CoordinatorCounterSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never,
    patients, cases, messages, settings, new RulesService(registry, settingsService, events), model(WaitItem, WaitItemSchema) as never,
  );
  const opd = new OpdService(model(Department, DepartmentSchema) as never, model(OpDoctor, OpDoctorSchema) as never, settingsService);
  const doctors = new SchedulingDoctorsService(model(DoctorProfile, DoctorProfileSchema) as never, model(Appointment, AppointmentSchema) as never, opd);
  const appointments = new SchedulingAppointmentsService(model(Appointment, AppointmentSchema) as never, model(Patient, PatientSchema) as never, doctors, opd, new AppointmentEvents());
  const waitlist = new SchedulingWaitlistService(
    model(WaitItem, WaitItemSchema) as never, model(Appointment, AppointmentSchema) as never, model(Patient, PatientSchema) as never,
    model(FollowUpItem, FollowUpItemSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never, doctors, appointments, procedures,
  );
  waitlist.onModuleInit();
  const conflicts = new SchedulingConflictsService(
    model(Appointment, AppointmentSchema) as never, model(ProcedureBooking, ProcedureBookingSchema) as never, model(RoomBlock, RoomBlockSchema) as never,
    model(OpDoctor, OpDoctorSchema) as never, model(StaffMember, StaffMemberSchema) as never, model(WaitItem, WaitItemSchema) as never,
    model(TaskAlertItem, TaskAlertItemSchema) as never, doctors, roster, escalations,
  );
  // snapshot() never asks the AI, so the overview has none.
  const overview = new SchedulingOverviewService(
    model(SchedulingSnapshot, SchedulingSnapshotSchema) as never, model(Appointment, AppointmentSchema) as never, model(ProcedureBooking, ProcedureBookingSchema) as never,
    model(RoomBlock, RoomBlockSchema) as never, model(ConsultRequest, ConsultRequestSchema) as never, model(WaitItem, WaitItemSchema) as never,
    model(OpDoctor, OpDoctorSchema) as never, model(Department, DepartmentSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never,
    doctors, settings, new SchedulingAiService(undefined as never),
  );
  const rooms = new SchedulingRoomsService(model(RoomBlock, RoomBlockSchema) as never, settings);
  // Pharmacy hears about the bookings (the contrast note, flag and alert), as it does in the app.
  const facts = new PharmacyPatientsService(model(Patient, PatientSchema) as never, model(LabTestReport, LabTestReportSchema) as never, model(PharmacyProcedureNote, PharmacyProcedureNoteSchema) as never);
  const pharmacySettings = new PharmacySettingsService(settingsService);
  const orders = new PharmacyOrdersService(
    model(PharmacyOrder, PharmacyOrderSchema) as never, model(PharmacyLine, PharmacyLineSchema) as never, model(PharmacyLocation, PharmacyLocationSchema) as never,
    model(CoordinatorCounter, CoordinatorCounterSchema) as never, patients, cases, messages, pharmacySettings, facts,
  );
  const checks = new PharmacyChecksService(model(PharmacyLine, PharmacyLineSchema) as never, model(PharmacyOrder, PharmacyOrderSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never, orders, cases, messages, pharmacySettings);
  new PharmacyCoordinatorRegistration(
    registry, orders, messages, checks, model(PharmacyOrder, PharmacyOrderSchema) as never, model(PharmacyLine, PharmacyLineSchema) as never, model(Clock, ClockSchema) as never,
    new PharmacyProceduresService(model(PharmacyProcedureNote, PharmacyProcedureNoteSchema) as never, model(PharmacyLine, PharmacyLineSchema) as never, model(PharmacyOrder, PharmacyOrderSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never, orders, cases, messages, facts),
  ).onModuleInit();
  return { messages, escalations, cases, settingsService, roster, consults, procedures, opd, doctors, appointments, waitlist, conflicts, overview, rooms };
}

/**
 * Replaces everything the Scheduling agent keeps with a demo week: the two extra departments and three extra OP doctors,
 * a login for every doctor, staff and a 7-day roster, appointments by doctor (one doctor on leave, with a waitlist),
 * about 12 procedures with Mohan Raj's cath-lab story, three consults, two conflicts and a week of hourly snapshots.
 * Run after seedOpd (in seed.ts) and seedPharmacy: the procedures and consults sit on the cases the ER, Bed and other
 * seeds made, and Pharmacy flags Mohan Raj's metformin when it hears of his angiography. It goes through the live
 * services wherever they can say it (booking, leave, the waitlist, paging, the conflict sweep); only what happened
 * before now (a case in progress, one done, an overdue consult's escalation) is backdated, the way seed-er does it.
 * Schedule times use the clinic clock (`clinicDay`); everything else the real clock, so nothing is after `nowMs`.
 * `nowMs` is for tests, which pin the clock (Date) to it as well: the live services stamp their own records.
 */
export async function seedScheduling(clinicDay: string, nowMs: number = Date.now()): Promise<void> {
  if (Math.abs(Date.now() - nowMs) > 5 * MIN) throw new Error('Scheduling seed: nowMs must be the clock now (a test pins Date to it): the live services stamp their records with it.');
  // The services read "today" from CLINIC_DATE; the seed does not read .env, so the clinic day is pinned while it runs.
  const savedClinic = process.env.CLINIC_DATE;
  process.env.CLINIC_DATE = clinicDay;
  try {
    await run(clinicDay, nowMs);
  } finally {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  }
}

async function run(clinicDay: string, nowMs: number): Promise<void> {
  const users = model(User, UserSchema);
  const patientsModel = model(Patient, PatientSchema);
  const appointmentsModel = model(Appointment, AppointmentSchema);
  const opDoctors = model(OpDoctor, OpDoctorSchema);
  const departments = model(Department, DepartmentSchema);
  const staffModel = model(StaffMember, StaffMemberSchema);
  const entries = model(RosterEntry, RosterEntrySchema);
  const profiles = model(DoctorProfile, DoctorProfileSchema);
  const blocks = model(RoomBlock, RoomBlockSchema);
  const bookings = model(ProcedureBooking, ProcedureBookingSchema);
  const consultsModel = model(ConsultRequest, ConsultRequestSchema);
  const waitItems = model(WaitItem, WaitItemSchema);
  const snapshots = model(SchedulingSnapshot, SchedulingSnapshotSchema);
  const locks = model(SchedulingLock, SchedulingLockSchema);
  const messagesModel = model(AgentMessage, AgentMessageSchema);
  const clocks = model(Clock, ClockSchema);
  const escalationsModel = model(Escalation, EscalationSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const notes = model(PharmacyProcedureNote, PharmacyProcedureNoteSchema);
  const cases = model(Case, CaseSchema);
  const timeline = model(TimelineEvent, TimelineEventSchema);
  const counters = model(CoordinatorCounter, CoordinatorCounterSchema);
  const titles = model(DutyTitle, DutyTitleSchema);
  const ladders = model(Ladder, LadderSchema);
  const visits = model(ErVisit, ErVisitSchema);

  // ---- Time -------------------------------------------------------------------------------------
  const clinicMs = clinicAt(clinicDay, nowMs);
  /** The clinic moment of a real moment. */
  const clinicOf = (ms: number): Date => new Date(clinicMs - (nowMs - ms));
  const plus1 = addDays(clinicDay, 1);
  const plus2 = addDays(clinicDay, 2);
  const plus3 = addDays(clinicDay, 3);

  // ---- What the seed builds on, checked before anything is wiped ---------------------------------------
  const shajin = await opDoctors.findOne({ name: 'Dr. Shajin' }).lean<any>();
  if (!shajin) throw new Error('Scheduling seed: no OP doctor Dr. Shajin. Run seedOpd (seed.ts) first.');
  const account = async (email: string) => {
    const u = await users.findOne({ email }).select('name role').lean<any>();
    if (!u) throw new Error(`Scheduling seed: no user ${email}. Seed the users first.`);
    return { id: String(u._id), name: u.name as string, role: u.role as UserRole };
  };
  const admin = await account('admin@medios.ai');
  const doctorAt = await account('doctor@medios.ai');
  const nurseAt = await account('nurse@medios.ai');
  const pharmacistAt = await account('pharmacy@medios.ai');
  const labAt = await account('lab@medios.ai');
  const desk = await account('frontdesk@medios.ai');
  const openVisits = await visits.find({ status: { $ne: 'left' } }).lean<any[]>();
  const erPatient = async (text: RegExp): Promise<any> => {
    const v = openVisits.find((x) => text.test(x.complaintText ?? ''));
    const c = v ? await cases.findById(v.case).lean<any>() : null;
    const p = c ? await patientsModel.findById(c.patient).lean<any>() : null;
    if (!p) throw new Error(`Scheduling seed: no open ER visit matches ${text}. Run the ER seed first.`);
    return p;
  };
  const mohan = await erPatient(/Pressure in the chest/);
  if (mohan.name !== 'Mohan Raj') throw new Error('Scheduling seed: the chest-pressure patient must be Mohan Raj. Run the ER seed first.');
  const strokePatient = await erPatient(/Face drooping/);
  const breathless = await erPatient(/Breathless, needs oxygen/);
  const roadAccident = await erPatient(/Road accident/);
  const abdomen = await erPatient(/Pain in the upper abdomen/);
  const chills = await erPatient(/Fever with chills/);
  const byUhid = async (uhid: string) => {
    const p = await patientsModel.findOne({ uhid }).lean<any>();
    if (!p) throw new Error(`Scheduling seed: patient ${uhid} not found. Seed the patients first.`);
    return p;
  };
  const davidRaj = await byUhid('MHK202500325');
  const jamesWilson = await byUhid('MHK202500327');
  const rekha = await byUhid('MHK202500324');
  const rajeshKumar = await byUhid('MHK202500198');

  // ---- The previous run's data, and nothing else, goes ------------------------------------------------
  const oldBookingIds = (await bookings.find().select('_id').lean<any[]>()).map((b) => String(b._id));
  const oldClockIds = (await clocks.find({ def: /^scheduling-/ }).select('_id').lean<any[]>()).map((c) => String(c._id));
  const oldEscalationIds = (await escalationsModel.find({ $or: [{ ladder: 'consult' }, { 'source.id': { $in: oldClockIds } }] }).select('_id').lean<any[]>()).map((e) => String(e._id));
  const oldCases = await cases.find({ openedBy: 'scheduling' }).select('number').lean<any[]>();
  const oldCaseIds = oldCases.map((c) => c._id);
  const oldUhids = (await patientsModel.find({ address: SCHEDULING_MARK }).select('uhid').lean<any[]>()).map((p) => p.uhid as string);
  await Promise.all([
    staffModel.deleteMany({}),
    entries.deleteMany({}),
    profiles.deleteMany({}),
    blocks.deleteMany({}),
    bookings.deleteMany({}),
    consultsModel.deleteMany({}),
    waitItems.deleteMany({}),
    snapshots.deleteMany({}),
    locks.deleteMany({}),
    messagesModel.deleteMany({
      $or: [
        { from: 'scheduling' },
        { case: { $in: oldCaseIds } },
        { dedupeKey: { $in: [...oldClockIds.map((id) => `clock.expired:${id}`), ...oldEscalationIds.map((id) => `escalation.raised:${id}`)] } },
      ],
    }),
    clocks.deleteMany({ $or: [{ def: /^scheduling-/ }, { case: { $in: oldCaseIds } }] }),
    escalationsModel.deleteMany({ _id: { $in: oldEscalationIds } }),
    alerts.deleteMany({
      $or: [
        { link: /^scheduling-/ },
        { link: { $in: [...oldEscalationIds.map((id) => `escalation:${id}`), ...oldBookingIds.flatMap((id) => [`pharmacy-contrast:${id}`, `pharmacy-dapt:${id}`])] } },
      ],
    }),
    // Pharmacy's notes exist only because of these bookings.
    notes.deleteMany({ bookingId: { $in: oldBookingIds } }),
    cases.deleteMany({ openedBy: 'scheduling' }),
    timeline.deleteMany({ title: { $in: oldCases.flatMap((c) => [`Case ${c.number} opened`, `Case ${c.number} closed`]) } }),
    counters.deleteMany({ key: { $in: ['scheduling-procedure', 'scheduling-consult'] } }),
    appointmentsModel.deleteMany({ uhid: { $in: oldUhids } }),
    patientsModel.deleteMany({ address: SCHEDULING_MARK }),
    opDoctors.deleteMany({ name: { $in: EXTRA_DOCTORS.map((d) => d.name) } }),
    departments.deleteMany({ code: { $in: EXTRA_DEPARTMENTS.map((d) => d.code) } }),
  ]);
  const lastCase = (await cases.find({ number: /^CASE-\d{4,}$/ }).select('number').lean<any[]>()).reduce((max, c) => Math.max(max, Number(String(c.number).slice(5))), 0);
  await counters.updateOne({ key: 'case' }, { $set: { last: lastCase } }, { upsert: true });

  const w = wire();
  await w.procedures.onModuleInit();

  // ---- Departments and OP doctors: the three new rooms join the queue (12 rooms in all) -----------------------
  const stored = await w.settingsService.getSettings();
  const queue = resolveQueueSettings((stored as any).queue);
  const extraRooms = EXTRA_DOCTORS.map((d) => d.room);
  await w.settingsService.updateSettings({ queue: { ...(stored as any).queue, counters: [...queue.counters.filter((c) => !extraRooms.includes(c)), ...extraRooms] } } as never, { role: UserRole.ADMIN });
  for (const d of EXTRA_DEPARTMENTS) await w.opd.createDepartment(d as never);
  for (const d of EXTRA_DOCTORS) await w.opd.createDoctor(d as never);

  // ---- Logins: every doctor, linked to the OP doctor of the same name ------------------------------------------
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  const userOf = new Map<string, string>([['Dr. Shajin', doctorAt.id]]);
  for (const a of SCHEDULING_DOCTOR_ACCOUNTS) {
    const u = await users
      .findOneAndUpdate(
        { email: a.email },
        {
          $set: { passwordHash, name: a.name, specialty: a.specialty, department: a.department, role: UserRole.DOCTOR, isActive: true, passwordChangedAt: new Date(), failedLoginAttempts: 0 },
          $unset: { lockedUntil: '' },
          $inc: { tokenVersion: 1 },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean<any>();
    userOf.set(a.name, String(u._id));
    if (a.code) await opDoctors.updateOne({ name: a.name }, { $set: { userId: String(u._id) } });
  }
  const unlinked = await opDoctors.find({ active: true, $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }] }).select('name').lean<any[]>();
  if (unlinked.length) throw new Error(`Scheduling seed: OP doctors without a login: ${unlinked.map((d) => d.name).join(', ')}`);
  const opOf = new Map((await opDoctors.find().lean<any[]>()).map((d) => [d.name as string, d]));

  // ---- Staff members ----------------------------------------------------------------------------------------
  const staffId = new Map<string, string>();
  const addStaff = async (name: string, skill: Skill, departmentCode: string, userId?: string) => {
    const s = await w.roster.upsertStaff(admin, { name, skills: [skill], departmentCode, ...(userId ? { userId } : {}) });
    staffId.set(name, String(s._id));
  };
  await addStaff('Dr. Shajin', 'physician', shajin.departmentCode, doctorAt.id);
  for (const a of SCHEDULING_DOCTOR_ACCOUNTS) await addStaff(a.name, a.skill, a.code, userOf.get(a.name));
  for (const t of TEAM) await addStaff(t.name, t.skill, '');
  const linked = new Map([[nurseAt, 'nurse@medios.ai'], [pharmacistAt, 'pharmacy@medios.ai'], [labAt, 'lab@medios.ai']].map(([u, email]) => [email as string, u as typeof nurseAt]));
  for (const l of LINKED) {
    const u = linked.get(l.email)!;
    await addStaff(u.name, l.skill, '', u.id);
  }

  // ---- The roster: clinic day −3 to +3, every shift covered; title holders as the other seeds set them ---------------
  const leaveDay = plus1;
  const days = Array.from({ length: 7 }, (_, i) => addDays(clinicDay, i - 3));
  let rostered = 0;
  const put = async (date: string, shift: Shift, name: string, titleKeys: string[] = []) => {
    await w.roster.setEntry(admin, { date, shift, staffId: staffId.get(name)!, titles: titleKeys });
    rostered++;
  };
  for (const [i, date] of days.entries()) {
    const even = i % 2 === 0;
    const onLeave = (name: string) => name === LEAVE.doctor && date === leaveDay;
    const morning = [
      'Dr. Meena Joseph', 'Dr. Rajesh Pillai', 'Dr. Kavitha Menon', 'Dr. John Varghese', 'Dr. Lakshmi Narayanan', 'Dr. Vinod Kumar', 'Dr. Anand Iyer',
      'Dr. Anitha Rao', 'Dr. Ravi Shankar', 'Dr. Neena Philip', 'Sister Bindu Mathew', 'Arjun Menon', 'Sister Deepa Raj', 'Sister Ancy Varghese', 'Manoj Pillai',
      even ? 'Dr. Arun Kumar' : 'Dr. Priya Fernandez',
    ];
    await put(date, 'morning', 'Dr. Shajin', ['duty-doctor', 'er-consultant']);
    await put(date, 'morning', nurseAt.name, ['er-nurse-in-charge', 'ot-in-charge']);
    await put(date, 'morning', pharmacistAt.name, ['pharmacist-on-duty']);
    await put(date, 'morning', labAt.name, ['lab-in-charge']);
    for (const name of morning) if (!onLeave(name)) await put(date, 'morning', name);
    for (const name of [even ? 'Dr. Priya Fernandez' : 'Dr. Arun Kumar', 'Dr. Suresh Nair', 'Sister Reena Paul', 'Sajith Kumar', 'Sister Mini Joseph', 'Divya Suresh']) await put(date, 'evening', name);
    await put(date, 'night', 'Sister Shiny Thomas');
    await put(date, 'on-call', 'Dr. Rajesh Pillai', ['cardiology-on-call']);
    const onCall = [
      'Dr. Vinod Kumar', 'Dr. John Varghese', 'Dr. Lakshmi Narayanan', 'Dr. Meena Joseph', 'Dr. Anitha Rao', 'Dr. Anand Iyer',
      even ? 'Dr. Arun Kumar' : 'Dr. Priya Fernandez', even ? 'Sister Bindu Mathew' : 'Sister Reena Paul', even ? 'Arjun Menon' : 'Sajith Kumar', even ? 'Manoj Pillai' : 'Divya Suresh',
    ];
    for (const name of onCall) if (!onLeave(name)) await put(date, 'on-call', name);
  }
  // Fixed holders for the two titles no other seed fills, so no roster gap shows at any hour (Z33); the roster still names who is on duty.
  for (const t of DEFAULT_TITLES) await titles.updateOne({ key: t.key }, { $setOnInsert: { key: t.key, label: t.label, holders: [] } }, { upsert: true });
  for (const l of DEFAULT_LADDERS) await ladders.updateOne({ key: l.key }, { $setOnInsert: { key: l.key, label: l.label, steps: l.steps } }, { upsert: true });
  await titles.updateOne({ key: 'ot-in-charge' }, { $set: { holders: [new Types.ObjectId(nurseAt.id)] } });
  await titles.updateOne({ key: 'chief-pharmacist' }, { $set: { holders: [new Types.ObjectId(pharmacistAt.id)] } });

  // ---- Outpatients and appointments ---------------------------------------------------------------------------
  const prefix = `MHK${new Date(nowMs).getFullYear()}`;
  const lastUhid = await patientsModel.findOne({ uhid: { $regex: `^${prefix}\\d{5}$` } }).sort({ uhid: -1 }).select('uhid').lean<any>();
  let serial = lastUhid ? Number(String(lastUhid.uhid).slice(prefix.length)) : 0;
  const madePatients = await patientsModel.insertMany(
    OUTPATIENTS.map((p, i) => ({
      uhid: `${prefix}${String(++serial).padStart(5, '0')}`, name: p.name, age: p.age, gender: p.gender, phone: `90000094${String(i).padStart(2, '0')}`,
      address: SCHEDULING_MARK, department: p.department, conditions: p.conditions, status: 'Follow-up', createdAt: new Date(nowMs), updatedAt: new Date(nowMs),
    })),
  );
  const outpatient = (i: number): any => madePatients[i];
  const clinicNowMin = new Date(clinicMs).getHours() * 60 + new Date(clinicMs).getMinutes();
  const aptDocs = APPOINTMENTS.map((a) => {
    const doctor = opOf.get(a.doctor);
    if (!doctor) throw new Error(`Scheduling seed: no OP doctor ${a.doctor}.`);
    const p = outpatient(a.who);
    const past = a.day === 0 && minutesOf(a.time) < clinicNowMin;
    return {
      uhid: p.uhid, patientName: p.name, age: p.age, gender: p.gender, phone: p.phone, date: a.day === 0 ? clinicDay : plus1, time: clockLabel(minutesOf(a.time)),
      type: a.type, condition: a.condition, status: past ? 'Completed' : 'Scheduled', checkedInTime: past ? clockLabel(minutesOf(a.time) - 10) : '', tags: p.conditions,
      confirmation: a.day === 1 ? 'Confirmed' : 'Unconfirmed', ...(a.day === 1 ? { confirmedAt: new Date(nowMs) } : {}),
      doctorId: String(doctor._id), doctorName: doctor.name, departmentCode: doctor.departmentCode, createdAt: new Date(nowMs), updatedAt: new Date(nowMs),
    };
  });
  // The slot-key index first (the collection was replaced), then the backfill: the fixtures go to Dr. Shajin and every live appointment gets its key.
  await appointmentsModel.syncIndexes();
  const insertedApts = await appointmentsModel.insertMany(aptDocs);
  await w.appointments.backfill();

  // ---- Leave and the waitlist: through the services, so each appointment on leave is listed once ------------------
  const john = opOf.get(LEAVE.doctor)!;
  await w.doctors.setProfile(admin, String(john._id), { leave: [{ from: leaveDay, to: leaveDay, reason: LEAVE.reason }] });
  const wantsEarlier = insertedApts[APPOINTMENTS.findIndex((a) => a.who === 24)];
  await w.waitlist.markEarlierWanted(desk, String(wantsEarlier._id));

  // ---- Procedures -----------------------------------------------------------------------------------------------
  const actorOf = (name: string): Actor => ({ id: userOf.get(name)!, name, role: UserRole.DOCTOR });
  const doctorActor: Actor = { id: doctorAt.id, name: doctorAt.name, role: doctorAt.role };
  const nurseActor: Actor = { id: nurseAt.id, name: nurseAt.name, role: nurseAt.role };

  // What happened before now, backdated: a STAT chest X-ray done an hour ago, and a STAT CT head in progress.
  await pastStat(w, { patient: breathless, procedure: 'chest-xray', room: 'xray', requestedAgo: 75, startAgo: 73, doneAgo: 62, by: doctorActor, team: nurseActor, nowMs, clinicOf });
  await pastStat(w, { patient: strokePatient, procedure: 'ct-head', room: 'ct', requestedAgo: 11, startAgo: 10, by: doctorActor, team: nurseActor, nowMs, clinicOf });

  // Both theatres are out until tomorrow evening: OT 1 for its anaesthesia machine; OT 2's air handling failed after a hernia
  // repair was booked there, so that booking sits under the block (a conflict), and an urgent fracture fixation can't be booked.
  const otFrom = at(clinicDay, '07:00');
  const otTo = at(plus1, '21:00');
  await w.rooms.addBlock(admin, 'ot-1', { from: otFrom, to: otTo, reason: 'Anaesthesia machine annual service' });
  await w.procedures.request(actorOf('Dr. Vinod Kumar'), { patientId: String(outpatient(18)._id), procedure: 'hernia-repair', priority: 'routine', earliest: at(plus1, '10:00'), note: 'Right inguinal hernia' });
  await w.rooms.addBlock(admin, 'ot-2', { from: otFrom, to: otTo, reason: 'Air handling unit failure' });
  await w.procedures.request(doctorActor, { patientId: String(roadAccident._id), procedure: 'fracture-fixation', priority: 'urgent', note: 'Closed fracture of the left tibia' });

  // Planned cases across the week.
  await w.procedures.request(doctorActor, { patientId: String(abdomen._id), procedure: 'ultrasound-abdomen', priority: 'urgent', note: 'Upper abdominal pain' });
  await w.procedures.request(doctorActor, { patientId: String(chills._id), procedure: 'chest-xray', priority: 'urgent', note: 'Fever with chills: look for a chest source' });
  await w.procedures.request(actorOf('Dr. Kavitha Menon'), { patientId: String(jamesWilson._id), procedure: 'echocardiogram', priority: 'routine', earliest: plus1 });
  await w.procedures.request(actorOf('Dr. Lakshmi Narayanan'), { patientId: String(rekha._id), procedure: 'caesarean-section', priority: 'routine', earliest: plus2, note: 'Elective, previous caesarean' });
  await w.procedures.request(actorOf('Dr. Priya Fernandez'), { patientId: String(outpatient(2)._id), procedure: 'upper-gi-endoscopy', priority: 'routine', earliest: plus2, note: 'Heartburn not settling on tablets' });
  await w.procedures.request(actorOf('Dr. Rajesh Pillai'), { patientId: String(rajeshKumar._id), procedure: 'echocardiogram', priority: 'routine', earliest: plus2 });
  await w.procedures.request(actorOf('Dr. Arun Kumar'), { patientId: String(outpatient(0)._id), procedure: 'ct-abdomen-contrast', priority: 'routine', earliest: plus3, note: 'Liver lesion on ultrasound' });

  // ---- Mohan Raj: a STAT cardiology consult, accepted by the cardiologist on call, who books his angiography ----------
  const rajesh = actorOf('Dr. Rajesh Pillai');
  const statConsult = await w.consults.request(doctorActor, { patientId: String(mohan._id), departmentCode: 'cardiology', priority: 'stat', reason: 'Chest pressure with ECG changes' });
  await w.consults.accept(rajesh, statConsult.id);
  const angio = await w.procedures.request(rajesh, { patientId: String(mohan._id), procedure: 'coronary-angiography', priority: 'routine', earliest: at(plus2, '08:30'), note: 'Rule out coronary disease' });
  if (angio.status !== 'booked' || new Date(angio.start!).getTime() !== at(plus2, '08:30').getTime()) {
    throw new Error(`Scheduling seed: Mohan Raj's angiography was not booked for 08:30 on ${plus2} (${angio.status} ${angio.start}).`);
  }

  // ---- The other consults: a routine one, and an urgent one overdue and escalated -------------------------------------
  await w.consults.request(actorOf('Dr. Kavitha Menon'), { patientId: String(jamesWilson._id), departmentCode: 'dermatology', priority: 'routine', reason: 'Itchy rash on both forearms since admission' });
  await overdueConsult(w, {
    actor: actorOf('Dr. Vinod Kumar'), patient: davidRaj, departmentCode: 'gen-med', reason: 'High blood sugar after surgery', ago: 135, nowMs, clinicOf,
  });

  // ---- Conflicts and snapshots ----------------------------------------------------------------------------------
  const found = await w.conflicts.sweep();
  const points = history(nowMs);
  await snapshots.insertMany(points);
  await w.overview.snapshot();

  const total = await bookings.countDocuments();
  console.log(
    `✅ Scheduling: ${SCHEDULING_DOCTOR_ACCOUNTS.length} doctor logins (${SCHEDULING_DOCTOR_ACCOUNTS.map((a) => a.email).join(', ')}; password ${DEMO_PASSWORD}), ` +
      `${staffId.size} staff, ${rostered} roster entries, ${insertedApts.length} appointments, ${total} procedures, ${await consultsModel.countDocuments()} consults, ` +
      `${await waitItems.countDocuments({ status: 'open' })} on the waitlist, ${found.length} conflicts, ${points.length + 1} snapshots`,
  );
}

type World = ReturnType<typeof wire>;

/**
 * A STAT procedure that started before now (and, with `doneAgo`, finished): the booking goes through the live announce and
 * team-alert code at each step, then its times move back to when it happened. Minutes are before now. The team is whoever
 * the roster has on duty with the skill (on site first, else on call).
 */
async function pastStat(
  w: World,
  o: { patient: any; procedure: string; room: string; requestedAgo: number; startAgo: number; doneAgo?: number; by: Actor; team: Actor; nowMs: number; clinicOf: (ms: number) => Date },
): Promise<void> {
  const bookings = model(ProcedureBooking, ProcedureBookingSchema);
  const messagesModel = model(AgentMessage, AgentMessageSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const counters = model(CoordinatorCounter, CoordinatorCounterSchema);
  const def = procedureByKey(o.procedure)!;
  const room = roomByKey(o.room)!;
  if (room.kind !== def.roomKind) throw new Error(`Scheduling seed: ${def.name} does not go in ${room.name}.`);
  const real = (ago: number) => new Date(o.nowMs - ago * MIN);
  const clinic = (ago: number) => o.clinicOf(o.nowMs - ago * MIN);
  // A STAT starts to the whole minute.
  const start = clinic(o.startAgo);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + def.minutes * MIN);
  const role = def.team[0];
  const duty = (await w.roster.onDuty(start, { onCall: true })).filter((d) => d.skills.includes(role));
  const member = duty.find((d) => d.shift !== 'on-call') ?? duty[0];
  if (!member) throw new Error(`Scheduling seed: nobody with the skill ${role} is on duty at ${start.toISOString()}.`);
  if (def.team.length !== 1) throw new Error('Scheduling seed: a backdated STAT takes a one-person team.');

  const { case: theCase } = await w.cases.openOrJoin({ patientId: String(o.patient._id), patientUhid: o.patient.uhid, patientName: o.patient.name, kind: 'opd', priority: 'high', openedBy: 'scheduling' });
  const counter = await counters.findOneAndUpdate({ key: 'scheduling-procedure' }, { $inc: { last: 1 } }, { upsert: true, new: true }).lean<any>();
  const number = `PR-${String(counter.last).padStart(4, '0')}`;
  const requestedAt = clinic(o.requestedAgo);
  const created = await bookings.create({
    number, patient: o.patient._id, patientUhid: o.patient.uhid, patientName: o.patient.name, case: theCase._id, procedure: def.key, priority: 'stat', status: 'requested',
    team: [], requestedBy: { id: o.by.id, name: o.by.name }, note: '', earliest: requestedAt, history: [{ at: requestedAt, what: 'Requested', by: o.by.name }],
  });
  const id = String(created._id);
  const raw = bookings.collection;
  await w.procedures.reannounce(id);
  await raw.updateOne(
    { _id: created._id },
    {
      $set: { status: 'booked', room: o.room, start, end, team: [{ role, staffId: member.staffId, name: member.name }] },
      $push: { history: { at: requestedAt, what: `Booked for ${displayDateTime(start)} in ${room.name}`, by: 'Scheduling Agent' } } as never,
      $unset: { announcedAt: '' },
    },
  );
  await w.procedures.reannounce(id);
  await w.procedures.raiseTeamAlerts(id);
  await raw.updateOne({ _id: created._id }, { $set: { status: 'in-progress', startedAt: start }, $push: { history: { at: start, what: 'Started', by: o.team.name } } as never, $unset: { announcedAt: '' } });
  await w.procedures.reannounce(id);
  const times: Record<string, Date> = {
    'scheduling.procedure-requested': real(o.requestedAgo),
    'scheduling.procedure-booked': new Date(real(o.requestedAgo).getTime() + 1000),
    'scheduling.procedure-started': real(o.startAgo),
  };
  let last = real(o.startAgo);
  if (o.doneAgo !== undefined) {
    const doneAt = clinic(o.doneAgo);
    await raw.updateOne({ _id: created._id }, { $set: { status: 'done', doneAt }, $push: { history: { at: doneAt, what: 'Done', by: o.team.name } } as never, $unset: { announcedAt: '' } });
    await w.procedures.reannounce(id);
    await alerts.collection.updateMany({ link: { $regex: `^scheduling-(team|page|call):${id}:` } }, { $set: { status: 'Completed' } });
    times['scheduling.procedure-done'] = real(o.doneAgo);
    last = real(o.doneAgo);
  }
  for (const [type, when] of Object.entries(times)) await messagesModel.collection.updateMany({ type, 'payload.bookingId': id }, { $set: { createdAt: when, updatedAt: when } });
  await alerts.collection.updateMany({ link: { $regex: `^scheduling-(team|page|call):${id}:` } }, { $set: { createdAt: new Date(real(o.requestedAgo).getTime() + 1000), updatedAt: last } });
  const fresh = await raw.findOne({ _id: created._id });
  if (!fresh?.announcedAt) throw new Error(`Scheduling seed: ${number} was not announced.`);
  await raw.updateOne({ _id: created._id }, { $set: { createdAt: real(o.requestedAgo), updatedAt: last, announcedAt: new Date(last.getTime() + 300) } });
}

/**
 * An urgent consult asked for `ago` minutes ago and never seen: it goes through the live request and paging, then its times
 * move back; its Seen clock is then expired and escalated as the Coordinator's clock pass does it (the same message, ladder,
 * reason and alert link), at the moment it ran out.
 */
async function overdueConsult(
  w: World,
  o: { actor: Actor; patient: any; departmentCode: string; reason: string; ago: number; nowMs: number; clinicOf: (ms: number) => Date },
): Promise<void> {
  const consultsModel = model(ConsultRequest, ConsultRequestSchema);
  const messagesModel = model(AgentMessage, AgentMessageSchema);
  const clocks = model(Clock, ClockSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const escalationsModel = model(Escalation, EscalationSchema);
  const view = await w.consults.request(o.actor, { patientId: String(o.patient._id), departmentCode: o.departmentCode, priority: 'urgent', reason: o.reason });
  const id = new Types.ObjectId(view.id);
  const shift = o.ago * MIN;
  const back = (d: Date | undefined | null) => (d ? new Date(new Date(d).getTime() - shift) : d);
  const c = (await consultsModel.collection.findOne({ _id: id }))!;
  await consultsModel.collection.updateOne(
    { _id: id },
    { $set: { requestedAt: back(c.requestedAt), createdAt: back(c.createdAt), updatedAt: back(c.updatedAt), announcedAt: back(c.announcedAt), dueAt: back(c.dueAt) } },
  );
  const dueAt = back(c.dueAt) as Date;
  for (const m of await messagesModel.collection.find({ 'payload.consultId': view.id }).toArray()) {
    await messagesModel.collection.updateOne({ _id: m._id }, { $set: { createdAt: back(m.createdAt), 'payload.dueAt': back(m.payload.dueAt) } });
  }
  const clock = (await clocks.collection.findOne({ def: 'scheduling-consult', ref: view.id }))!;
  await clocks.collection.updateOne({ _id: clock._id }, { $set: { startedAt: back(clock.startedAt), createdAt: back(clock.createdAt), updatedAt: back(clock.updatedAt), dueAt } });
  const link = `scheduling-consult:${view.id}`;
  const alert = (await alerts.collection.findOne({ link }))!;
  await alerts.collection.updateOne({ _id: alert._id }, { $set: { createdAt: back(alert.createdAt), updatedAt: back(alert.updatedAt), dueDateTime: displayDateTime(o.clinicOf(dueAt.getTime())) } });

  // The clock pass: expire it, say so, and raise the consult ladder with the clock's own reason and alert link.
  const def = SCHEDULING_CLOCKS.find((d) => d.key === 'scheduling-consult')!;
  const claimed = (await clocks.findOneAndUpdate({ _id: clock._id, state: 'running' }, { $set: { state: 'expired' } }, { new: true }).lean<any>())!;
  await w.messages.send({
    case: String(claimed.case), from: 'coordinator', to: ['coordinator'], type: 'clock.expired', priority: 'high', summary: `${def.label} overdue`.slice(0, 140),
    payload: { clockKey: def.key }, causedBy: String(claimed.startedBy), dedupeKey: `clock.expired:${claimed._id}`,
  });
  const esc = await w.escalations.raise({
    ladder: def.ladder, case: String(claimed.case), reason: `${def.label} overdue${claimed.detail ? ` — ${claimed.detail}` : ''}`,
    source: { kind: 'clock', id: String(claimed._id) }, alertLink: def.alertLink!(view.id)!, closesOnStop: true,
  });
  await clocks.collection.updateOne({ _id: clock._id }, { $set: { escalation: esc._id, updatedAt: dueAt } });
  // ...at the moment it ran out.
  const raised = new Date(dueAt.getTime() + 1000);
  await escalationsModel.collection.updateOne({ _id: esc._id }, { $set: { raisedAt: dueAt, stepAt: dueAt, createdAt: dueAt, updatedAt: dueAt } });
  await messagesModel.collection.updateOne({ dedupeKey: `clock.expired:${claimed._id}` }, { $set: { createdAt: dueAt, updatedAt: dueAt } });
  await messagesModel.collection.updateOne({ dedupeKey: `escalation.raised:${esc._id}` }, { $set: { createdAt: raised, updatedAt: raised } });
  await alerts.collection.updateOne({ link }, { $set: { updatedAt: raised } });
}

/** The agent's card values at every hour of the last week but this one (the live snapshot adds this hour). */
function history(nowMs: number): Record<string, any>[] {
  const r = rng(31102026);
  const lastHour = hourOf(new Date(nowMs)).getTime();
  const busyAt = (h: number) => Math.max(0, Math.sin(((h - 7) / 14) * Math.PI));
  return Array.from({ length: 167 }, (_, k) => {
    const hour = new Date(lastHour - (167 - k) * HOUR);
    const h = hour.getHours();
    const dayShare = h < 8 ? 0.05 : Math.min(1, (h - 7) / 13);
    return {
      hour,
      at: new Date(Math.min(nowMs, hour.getTime() + 59 * MIN)),
      appointmentsToday: Math.round((34 + r() * 10) * (0.6 + 0.4 * dayShare)),
      proceduresToday: Math.max(1, Math.round(3 + r() * 4)),
      openConsults: Math.max(0, Math.round(1 + 3 * busyAt(h) + (r() - 0.5) * 2)),
      conflicts: Math.max(0, Math.round(busyAt(h) * 2 + (r() - 0.6))),
      waitlist: Math.max(1, Math.round(3 + r() * 3)),
    };
  });
}
