import mongoose, { Model, Schema } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
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

// Seeds the demo hospital. The fixtures in ./seed-data are the records the web app
// was designed around (Dr. Shajin's clinic on 26 Sep 2026, with Arun Kumar as the
// patient whose chart is filled in). Records go through the real Mongoose schemas,
// so enums, required fields and timestamps are enforced exactly as in the API.

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/medios_hospital';
// Demo accounts for local development only; never seed these into a real deployment.
const DEMO_EMAIL = 'doctor@medios.ai';
const ADMIN_EMAIL = 'admin@medios.ai';
const DEMO_PASSWORD = 'Admin@123';
const BCRYPT_ROUNDS = 12;

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

async function seed() {
  console.log('🌱 Connecting to MongoDB at', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);

  const [doctor] = fixture('users');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  await replace('users (doctor, admin)', model(User, UserSchema), [
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
  ]);
  // Users were recreated, so every stored session is void.
  await model(RefreshToken, RefreshTokenSchema).deleteMany({});

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
  await replace('settings', model(HospitalSettings, HospitalSettingsSchema), [fixture('settings')]);
  // The call log refers to the appointments just replaced.
  await model(AgentCall, AgentCallSchema).deleteMany({});

  console.log(`🎉 Seeding complete. Sign in as ${DEMO_EMAIL} (doctor) or ${ADMIN_EMAIL} (admin), password ${DEMO_PASSWORD}`);
}

seed()
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
