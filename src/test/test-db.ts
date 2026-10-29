import mongoose, { Model, Schema } from 'mongoose';
import { Patient, PatientDocument, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { Appointment, AppointmentDocument, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import { QueueToken, QueueTokenDocument, QueueTokenSchema } from '../modules/queue/schemas/queue-token.schema';
import { QueueSequence, QueueSequenceDocument, QueueSequenceSchema } from '../modules/queue/schemas/queue-sequence.schema';
import { QueueDisplay, QueueDisplayDocument, QueueDisplaySchema } from '../modules/queue/schemas/queue-display.schema';
import { PatientCard, PatientCardDocument, PatientCardSchema } from '../modules/queue/schemas/patient-card.schema';
import { HospitalSettings, HospitalSettingsDocument, HospitalSettingsSchema } from '../modules/settings/schemas/settings.schema';
import { BillInvoice, BillInvoiceDocument, BillInvoiceSchema } from '../modules/billing/schemas/bill.schema';
import { Department, DepartmentDocument, DepartmentSchema } from '../modules/opd/schemas/department.schema';
import { ReceptionSession, ReceptionSessionDocument, ReceptionSessionSchema } from '../modules/reception/schemas/reception-session.schema';
import { OtpChallenge, OtpChallengeDocument, OtpChallengeSchema } from '../modules/reception/schemas/otp-challenge.schema';
import { OpDoctor, OpDoctorDocument, OpDoctorSchema } from '../modules/opd/schemas/op-doctor.schema';
import { OpVisit, OpVisitDocument, OpVisitSchema } from '../modules/reception/schemas/op-visit.schema';
import { OpSequence, OpSequenceDocument, OpSequenceSchema } from '../modules/reception/schemas/op-sequence.schema';

// Database specs share one throwaway database. The name check stops a stray
// MONGODB_TEST_URI from wiping a real one (medios_hospital, medios_reception_dev).

const DEFAULT_URI = 'mongodb://localhost:27017/medios_reception_test';

/** The database name in a MongoDB URI: the path after the hosts, before any options. */
function databaseName(uri: string): string {
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('?')[0];
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
}

function assertTestDatabase(name: string) {
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must end in _test.`);
  }
}

const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

/** The models the database specs use, registered once on the default connection. */
export function models() {
  return {
    Patient: model(Patient, PatientSchema) as Model<PatientDocument>,
    Appointment: model(Appointment, AppointmentSchema) as Model<AppointmentDocument>,
    QueueToken: model(QueueToken, QueueTokenSchema) as Model<QueueTokenDocument>,
    QueueSequence: model(QueueSequence, QueueSequenceSchema) as Model<QueueSequenceDocument>,
    QueueDisplay: model(QueueDisplay, QueueDisplaySchema) as Model<QueueDisplayDocument>,
    PatientCard: model(PatientCard, PatientCardSchema) as Model<PatientCardDocument>,
    HospitalSettings: model(HospitalSettings, HospitalSettingsSchema) as Model<HospitalSettingsDocument>,
    BillInvoice: model(BillInvoice, BillInvoiceSchema) as Model<BillInvoiceDocument>,
    Department: model(Department, DepartmentSchema) as Model<DepartmentDocument>,
    OpDoctor: model(OpDoctor, OpDoctorSchema) as Model<OpDoctorDocument>,
    ReceptionSession: model(ReceptionSession, ReceptionSessionSchema) as Model<ReceptionSessionDocument>,
    OtpChallenge: model(OtpChallenge, OtpChallengeSchema) as Model<OtpChallengeDocument>,
    OpVisit: model(OpVisit, OpVisitSchema) as Model<OpVisitDocument>,
    OpSequence: model(OpSequence, OpSequenceSchema) as Model<OpSequenceDocument>,
  };
}

/**
 * Connects to the test database and builds every model's indexes, which the specs
 * rely on (unique keys). syncIndexes builds them once, in place
 * of the background auto-build, and drops any an older schema left behind.
 */
export async function connectTestDb(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_TEST_URI ?? DEFAULT_URI;
  assertTestDatabase(databaseName(uri));
  await mongoose.connect(uri, { autoIndex: false });
  await Promise.all(Object.values(models()).map((m) => m.syncIndexes()));
  return mongoose;
}

/** Empties every collection, keeping the indexes. */
export async function resetTestDb(): Promise<void> {
  assertTestDatabase(mongoose.connection.name);
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function closeTestDb(): Promise<void> {
  await mongoose.disconnect();
}
