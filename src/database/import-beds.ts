import { readFileSync } from 'node:fs';
import mongoose, { Model, Schema } from 'mongoose';
import { Ward, WardSchema } from '../modules/beds/schemas/ward.schema';
import { Bed, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { BedSuggestion, BedSuggestionSchema } from '../modules/beds/schemas/bed-suggestion.schema';
import { BedRequest, BedRequestSchema } from '../modules/beds/schemas/bed-request.schema';
import { BedSnapshot, BedSnapshotSchema } from '../modules/beds/schemas/bed-snapshot.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { importRefusal, parseBedCsv } from '../modules/beds/bed-csv';
import { clinicNow } from '../common/utils/clinic-time';

// Replaces the wards and beds with the hospital's real ones from a CSV file (see
// docs/beds-import-template.csv). It also clears what points at the old beds or describes
// them: admissions, bed suggestions, Bed Agent requests (their open alerts are marked
// Completed) and hourly bed snapshots. Without --force, beds in use or any admission,
// suggestion or request make the import refuse.
//
//   MONGODB_URI=... npm run import-beds -- <file.csv> [--force]

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.model(cls.name, schema);

async function importBeds() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Usage: npm run import-beds -- <file.csv> [--force]');

  const { wards, beds, errors } = parseBedCsv(readFileSync(file, 'utf8'));
  if (errors.length) {
    errors.forEach((e) => console.error(e));
    process.exitCode = 1;
    return;
  }

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/medios_hospital';
  console.log(`Database: ${new URL(uri).host}`);
  await mongoose.connect(uri);

  const wardModel = model(Ward, WardSchema);
  const bedModel = model(Bed, BedSchema);
  const admissionModel = model(Admission, AdmissionSchema);
  const suggestionModel = model(BedSuggestion, BedSuggestionSchema);
  const requestModel = model(BedRequest, BedRequestSchema);
  const snapshotModel = model(BedSnapshot, BedSnapshotSchema);
  const alertModel = model(TaskAlertItem, TaskAlertItemSchema);
  const [inUse, admissions, suggestions, requests, snapshots] = await Promise.all([
    bedModel.countDocuments({ state: { $in: ['occupied', 'held'] } }),
    admissionModel.countDocuments({}),
    suggestionModel.countDocuments({}),
    requestModel.countDocuments({}),
    snapshotModel.countDocuments({}),
  ]);
  const refusal = importRefusal({ inUse, admissions, suggestions, requests, snapshots }, force);
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  await Promise.all([
    wardModel.deleteMany({}),
    bedModel.deleteMany({}),
    admissionModel.deleteMany({}),
    suggestionModel.deleteMany({}),
    requestModel.deleteMany({}),
    snapshotModel.deleteMany({}),
    alertModel.updateMany({ link: /^bed-request:/, status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }),
  ]);
  const insertedWards = await wardModel.insertMany(wards);
  const wardId = new Map(insertedWards.map((w) => [w.code, w._id]));
  const stateSince = clinicNow();
  await bedModel.insertMany(beds.map(({ wardCode, ...b }) => ({ ...b, ward: wardId.get(wardCode), stateSince })));
  console.log(`✅ Imported ${wards.length} wards and ${beds.length} beds`);
}

importBeds()
  .catch((err) => {
    console.error(`import-beds failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
