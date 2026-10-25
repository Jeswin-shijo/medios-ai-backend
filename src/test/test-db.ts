import mongoose, { Model, Schema } from 'mongoose';
import { Admission, AdmissionDocument, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { Bed, BedDocument, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Ward, WardDocument, WardSchema } from '../modules/beds/schemas/ward.schema';
import { Patient, PatientDocument, PatientSchema } from '../modules/patients/schemas/patient.schema';

// Database specs share one throwaway database. The name check stops a stray
// MONGODB_TEST_URI from wiping a real one (medios_hospital, medios_beds_dev).

const DEFAULT_URI = 'mongodb://localhost:27017/medios_test';

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
    Ward: model(Ward, WardSchema) as Model<WardDocument>,
    Bed: model(Bed, BedSchema) as Model<BedDocument>,
    Admission: model(Admission, AdmissionSchema) as Model<AdmissionDocument>,
    Patient: model(Patient, PatientSchema) as Model<PatientDocument>,
  };
}

/**
 * Connects to the test database and builds every model's indexes, which the specs
 * rely on (one active admission per patient). syncIndexes builds them once, in place
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
