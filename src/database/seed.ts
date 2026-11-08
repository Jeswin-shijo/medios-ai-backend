import mongoose, { Model, Schema } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { User, UserSchema } from '../modules/users/schemas/user.schema';
import { RefreshToken, RefreshTokenSchema } from '../modules/auth/schemas/refresh-token.schema';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { Appointment, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import { Consultation, ConsultationSchema } from '../modules/consultations/schemas/consultation.schema';
import { Prescription, PrescriptionSchema } from '../modules/prescriptions/schemas/prescription.schema';
import { Medication, MedicationSchema } from '../modules/medications/schemas/medication.schema';
import { LabTestReport, LabTestReportSchema } from '../modules/lab-reports/schemas/lab-report.schema';
import { ImagingStudy, ImagingStudySchema } from '../modules/imaging/schemas/imaging.schema';
import { BillInvoice, BillInvoiceSchema } from '../modules/billing/schemas/bill.schema';
import { FollowUpItem, FollowUpItemSchema } from '../modules/follow-ups/schemas/follow-up.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { ClinicalDocument, ClinicalDocumentSchema } from '../modules/documents/schemas/document.schema';
import { VitalsRecord, VitalsRecordSchema } from '../modules/vitals/schemas/vitals.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { MessageThread, MessageThreadSchema } from '../modules/messages/schemas/message.schema';
import { HospitalSettings, HospitalSettingsSchema } from '../modules/settings/schemas/settings.schema';
import { AgentCall, AgentCallSchema } from '../modules/calls/schemas/agent-call.schema';
import { InboundSession, InboundSessionSchema } from '../modules/calls/schemas/inbound-session.schema';
import { CallerLookup, CallerLookupSchema } from '../modules/calls/schemas/caller-lookup.schema';
import { QueueToken, QueueTokenSchema } from '../modules/queue/schemas/queue-token.schema';
import { QueueSequence, QueueSequenceSchema } from '../modules/queue/schemas/queue-sequence.schema';
import { PatientCard, PatientCardSchema } from '../modules/queue/schemas/patient-card.schema';
import { Department, DepartmentSchema } from '../modules/opd/schemas/department.schema';
import { OpDoctor, OpDoctorSchema } from '../modules/opd/schemas/op-doctor.schema';
import { OpVisit, OpVisitSchema } from '../modules/reception/schemas/op-visit.schema';
import { OpSequence, OpSequenceSchema } from '../modules/reception/schemas/op-sequence.schema';
import { ReceptionSession, ReceptionSessionSchema } from '../modules/reception/schemas/reception-session.schema';
import { OtpChallenge, OtpChallengeSchema } from '../modules/reception/schemas/otp-challenge.schema';
import { formatTokenLabel, newSecret } from '../modules/reception/format';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedDischarge } from './seed-discharge';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';
import { seedPharmacy } from './seed-pharmacy';
import { seedRevenue } from './seed-revenue';
import { seedScheduling } from './seed-scheduling';
import { resolveDemoPassword } from './seed-password';
import { appointmentStart, isoDate } from '../common/utils/clinic-time';
import { buildCounters, buildDepartments, buildDoctors } from './seed-opd';

// Seeds the demo hospital. The fixtures in ./seed-data are the records the web app
// was designed around (Dr. Shajin's clinic on 26 Sep 2026, with Arun Kumar as the
// patient whose chart is filled in). Records go through the real Mongoose schemas,
// so enums, required fields and timestamps are enforced exactly as in the API.

// Use the same database the API would: read .env (an explicit MONGODB_URI wins), never guess one.
const envFile = join(__dirname, '..', '..', '.env');
if (!process.env.MONGODB_URI && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.MONGODB_URI) {
  console.error('Refusing to seed: MONGODB_URI is not set (put it in .env or pass it explicitly).');
  process.exit(1);
}
const MONGODB_URI = process.env.MONGODB_URI as string;
// Demo accounts for local development only; never seed these into a real deployment.
const DEMO_EMAIL = 'doctor@medios.ai';
const ADMIN_EMAIL = 'admin@medios.ai';
const STAFF_ACCOUNTS = [
  { email: 'nurse@medios.ai', name: 'Nurse Anjali Thomas', department: 'Nursing', role: 'nurse' },
  { email: 'pharmacy@medios.ai', name: 'Neethu George', department: 'Pharmacy', role: 'pharmacist' },
  { email: 'lab@medios.ai', name: 'Vishnu Prasad', department: 'Laboratory', role: 'lab' },
  { email: 'frontdesk@medios.ai', name: 'Front Desk', department: 'Reception', role: 'staff' },
  // The pathologist validates what lab@ enters: results need two people.
  ...LAB_DEMO_ACCOUNTS,
];
const BCRYPT_ROUNDS = 12;
/** The clinic day the fixtures describe (CLINIC_DATE in development). */
const DEMO_DAY = '2026-09-26';

/** The database name in a MongoDB URI, never the URI itself: it may hold credentials (they end at the last '@'). */
function databaseName(uri: string): string {
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const hosts = rest.slice(rest.lastIndexOf('@') + 1);
  const slash = hosts.indexOf('/');
  return (slash === -1 ? '' : hosts.slice(slash + 1).split('?')[0]) || '(default)';
}

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'seed-data', `${name}.json`), 'utf8'));

// Loosely typed on purpose: generic Model<T> inference over these schemas sends tsc out of memory.
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.model(cls.name, schema);

/**
 * Replaces a collection with the fixture records. Lists are read newest-first
 * (sorted by createdAt/updatedAt), so each record is stamped one second older
 * than the one before it to keep the fixture order.
 */
async function replace(label: string, target: Model<any>, records: any[]) {
  await target.deleteMany({});
  const now = Date.now();
  const stamped = records.map((r, i) => {
    const at = new Date(now - i * 1000);
    return { ...r, createdAt: at, updatedAt: at };
  });
  await target.insertMany(stamped);
  console.log(`✅ ${records.length} ${label}`);
}

/**
 * Drops a collection (a missing one is fine) and rebuilds the model's indexes, so a
 * reseed never depends on the API's start-up index migration and old unique indexes
 * (date_1_number_1, date_1, phone10_1) cannot survive.
 */
async function recreate(target: Model<any>) {
  try {
    await target.collection.drop();
  } catch (err: any) {
    if (err?.codeName !== 'NamespaceNotFound' && err?.code !== 26 && !/ns not found/i.test(String(err?.message))) throw err;
  }
  await target.syncIndexes();
}

/** Departments and OP doctors for the reception kiosk; returns the doctors with their ids. */
async function seedOpd(doctorUserId: string) {
  const departments = buildDepartments();
  const doctors = buildDoctors(departments);
  await recreate(model(Department, DepartmentSchema));
  await recreate(model(OpDoctor, OpDoctorSchema));
  await model(Department, DepartmentSchema).insertMany(departments);
  const saved = await model(OpDoctor, OpDoctorSchema).insertMany(
    doctors.map((d) => ({ ...d, ...(d.name === 'Dr. Shajin' && { userId: doctorUserId }) })),
  );
  console.log(`✅ ${departments.length} departments, ${saved.length} OP doctors (rooms ${doctors.map((d) => d.room).join(', ')})`);
  return { doctors: saved.map((d: any) => d.toObject()), counters: buildCounters(doctors) };
}

const MINUTE = 60_000;
const DEMO_CARDS = [
  { cardId: '04A1B2C3', uhid: 'MHK202500324' }, // Rekha S
  { cardId: '0004567890', uhid: 'MHK202500325' }, // David Raj
  { cardId: '04C8D9E0F1A2B3', uhid: 'MHK202500326' }, // Selvi A
];

/**
 * The demo day's token queue, in step with its appointments: everyone who has
 * arrived holds a token, numbered in the order they came. Display links are kept.
 */
async function seedQueue(shajin: { _id: any; name: string; room: string; tokenPrefix: string; departmentName: string }) {
  const tokens = model(QueueToken, QueueTokenSchema);
  // Dropped, not emptied, so the new indexes replace the old unique ones.
  await recreate(tokens);
  await recreate(model(QueueSequence, QueueSequenceSchema));
  for (const [cls, schema] of [
    [OpVisit, OpVisitSchema],
    [OpSequence, OpSequenceSchema],
    [ReceptionSession, ReceptionSessionSchema],
    [OtpChallenge, OtpChallengeSchema],
  ] as const) {
    await recreate(model(cls, schema as Schema));
  }
  const doctorId = String(shajin._id);

  const arrived = await model(Appointment, AppointmentSchema)
    .find({ date: DEMO_DAY, status: { $in: ['Completed', 'In Consultation', 'Checked In', 'Waiting'] } })
    .lean<any[]>();
  // Arrival: the recorded check-in time, else ten minutes before the slot. Timestamps
  // use the real date (as new tokens will), so waiting times read sensibly.
  const realDay = isoDate();
  const arrival = (a: any) =>
    a.checkedInTime ? appointmentStart(realDay, a.checkedInTime) : new Date(appointmentStart(realDay, a.time).getTime() - 10 * MINUTE);
  arrived.sort((a, b) => arrival(a).getTime() - arrival(b).getTime());

  const records = arrived.map((a, i) => {
    const issuedAt = arrival(a);
    const calledAt = new Date(Math.max(issuedAt.getTime(), appointmentStart(realDay, a.time).getTime()));
    const seen = a.status === 'Completed' || a.status === 'In Consultation';
    return {
      date: DEMO_DAY,
      number: i + 1,
      label: formatTokenLabel(shajin.tokenPrefix, i + 1),
      series: doctorId,
      doctorId,
      doctorName: shajin.name,
      department: shajin.departmentName,
      room: shajin.room,
      trackCode: newSecret(16),
      status: a.status === 'Completed' ? 'completed' : a.status === 'In Consultation' ? 'called' : 'waiting',
      uhid: a.uhid,
      patientName: a.patientName,
      appointmentId: String(a._id),
      appointmentTime: a.time,
      source: 'front-desk',
      issuedBy: 'Front Desk',
      ...(seen && { counter: shajin.room, calledAt, firstCalledAt: calledAt, calledBy: 'Dr. Shajin' }),
      ...(a.status === 'Completed' && { completedAt: new Date(calledAt.getTime() + 15 * MINUTE) }),
      ...(a.status !== 'Completed' && { activeKey: `${DEMO_DAY}:${a.uhid}` }),
      createdAt: issuedAt,
      updatedAt: issuedAt,
    };
  });
  await tokens.insertMany(records);
  await model(QueueSequence, QueueSequenceSchema).create({ date: DEMO_DAY, series: doctorId, last: records.length });
  console.log(`✅ ${records.length} queue tokens`);

  // Demo cards for patients not checked in yet, so the kiosk can be tried without
  // real cards. Cards linked by hand are kept (patients keep their UHIDs).
  for (const card of DEMO_CARDS) {
    await model(PatientCard, PatientCardSchema).updateOne({ cardId: card.cardId }, { $set: { ...card, linkedBy: 'Seed' } }, { upsert: true });
  }
  console.log(`✅ ${DEMO_CARDS.length} demo patient cards (${DEMO_CARDS.map((c) => c.cardId).join(', ')})`);
}

async function seed() {
  const DEMO_PASSWORD = resolveDemoPassword(); // refuses a remote database without SEED_DEMO_PASSWORD, before anything is wiped
  // Name only: the URI may hold credentials.
  console.log('🌱 Seeding database', databaseName(MONGODB_URI));
  await mongoose.connect(MONGODB_URI);

  const [doctor] = fixture('users');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  await replace('users (doctor, admin, nurse, pharmacy, lab, front desk, pathologist)', model(User, UserSchema), [
    {
      email: DEMO_EMAIL,
      passwordHash,
      name: doctor.name,
      avatar: doctor.avatar,
      specialty: 'General Physician',
      department: 'General Medicine',
      doctorId: 'MHK-DOC-042',
      phone: '+91 98765 43210',
      role: 'doctor',
      isActive: true,
      passwordChangedAt: new Date(),
    },
    {
      // Creates staff accounts (POST /auth/register is admin-only).
      email: ADMIN_EMAIL,
      passwordHash,
      name: 'Hospital Admin',
      department: 'Administration',
      role: 'admin',
      isActive: true,
      passwordChangedAt: new Date(),
    },
    // One account per remaining role, so role-specific screens can be tried.
    ...STAFF_ACCOUNTS.map((a) => ({ ...a, passwordHash, isActive: true, passwordChangedAt: new Date() })),
  ]);
  // Users were recreated, so every stored session is void.
  await model(RefreshToken, RefreshTokenSchema).deleteMany({});
  const doctorUser = await model(User, UserSchema).findOne({ email: DEMO_EMAIL }).lean<any>();
  const opd = await seedOpd(String(doctorUser._id));
  const shajin = opd.doctors.find((d: any) => d.name === 'Dr. Shajin');

  await replace('patients', model(Patient, PatientSchema), fixture('patients'));
  await replace('appointments', model(Appointment, AppointmentSchema), fixture('appointments'));
  await replace('consultations', model(Consultation, ConsultationSchema), fixture('consultations'));
  await replace('prescriptions', model(Prescription, PrescriptionSchema), fixture('prescriptions'));
  await replace('medications', model(Medication, MedicationSchema), fixture('medications'));
  await replace('lab reports', model(LabTestReport, LabTestReportSchema), fixture('lab-reports'));
  await replace('imaging studies', model(ImagingStudy, ImagingStudySchema), fixture('imaging'));
  await replace('invoices', model(BillInvoice, BillInvoiceSchema), fixture('invoices'));
  await replace('follow-ups', model(FollowUpItem, FollowUpItemSchema), fixture('follow-ups'));
  await replace('timeline events', model(TimelineEvent, TimelineEventSchema), fixture('timeline'));
  await replace('documents', model(ClinicalDocument, ClinicalDocumentSchema), fixture('documents'));
  await replace('vitals records', model(VitalsRecord, VitalsRecordSchema), fixture('vitals'));
  await replace('tasks and alerts', model(TaskAlertItem, TaskAlertItemSchema), fixture('tasks-alerts'));
  await replace('message threads', model(MessageThread, MessageThreadSchema), fixture('messages'));
  const settings = fixture('settings');
  settings.queue = { ...settings.queue, counters: opd.counters };
  settings.reception = { ...settings.reception, defaultDoctorId: String(shajin._id) };
  await replace('settings', model(HospitalSettings, HospitalSettingsSchema), [settings]);
  // The call log and inbound callers' sessions refer to the appointments just replaced.
  await model(AgentCall, AgentCallSchema).deleteMany({});
  await model(InboundSession, InboundSessionSchema).deleteMany({});
  await model(CallerLookup, CallerLookupSchema).deleteMany({});
  // The fixture appointments are Dr. Shajin's (the Scheduling seed below gives them his id), so their tokens are on his line.
  const departmentName = buildDepartments().find((d) => d.code === shajin.departmentCode)!.name;
  await seedQueue({ _id: shajin._id, name: shajin.name, room: shajin.room, tokenPrefix: shajin.tokenPrefix, departmentName });
  // Wards, beds and the two real admissions (the patients come first); also clears admissions and bed suggestions.
  // Their times fall on the clinic day: CLINIC_DATE may be unset (the seed reads .env only when MONGODB_URI is not passed).
  await seedBeds(process.env.CLINIC_DATE ?? DEMO_DAY);
  // Cases, messages, an approval, an escalation and snapshots for the Coordinator, built on the bed requests above.
  await seedCoordinator(process.env.CLINIC_DATE ?? DEMO_DAY);
  // The ER day: visits, bays, cases, clocks and messages (after the Coordinator, which wipes cases and clocks).
  await seedEr(process.env.CLINIC_DATE ?? DEMO_DAY);
  // The lab day: requests on the ER, ward and outpatient cases above, with samples, results, reports, clocks and messages.
  await seedLab(process.env.CLINIC_DATE ?? DEMO_DAY);
  // The pharmacy day: stock and about 25 medicine orders on the ER, ward and outpatient cases above, with their checks, queries, issues, clocks and messages.
  await seedPharmacy(process.env.CLINIC_DATE ?? DEMO_DAY);
  // The scheduling day: doctor logins, staff and a week's roster, appointments by doctor (one doctor on leave), procedures with Mohan Raj's
  // cath-lab story, consults, conflicts and snapshots, on the cases above.
  await seedScheduling(process.env.CLINIC_DATE ?? DEMO_DAY);
  // The revenue day: the price list and about 20 bills in every state, on the visits, stays, tests, medicines and appointments above (it starts billing from now).
  await seedRevenue(process.env.CLINIC_DATE ?? DEMO_DAY);
  // The discharge day: David Raj's discharge and ten more stays in every checklist state, billed by Revenue's own services, and snapshots.
  // Last: it sets both the Discharge and the Revenue start stamps after its records, so neither minute pass back-bills or repairs them.
  await seedDischarge(process.env.CLINIC_DATE ?? DEMO_DAY);

  console.log(
    `🎉 Seeding complete. Sign in as ${DEMO_EMAIL} (doctor), ${ADMIN_EMAIL} (admin) or ${STAFF_ACCOUNTS.map((a) => a.email).join(', ')}; ${process.env.SEED_DEMO_PASSWORD ? 'password from SEED_DEMO_PASSWORD' : `password ${DEMO_PASSWORD}`}`,
  );
}

seed()
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
