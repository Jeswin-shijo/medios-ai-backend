import mongoose, { Model, Schema } from 'mongoose';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { Ward, WardSchema } from '../modules/beds/schemas/ward.schema';
import { Bed, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { BedSuggestion, BedSuggestionSchema } from '../modules/beds/schemas/bed-suggestion.schema';
import { buildBedSeed } from '../modules/beds/bed-layout';
import { clinicNow } from '../common/utils/clinic-time';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.model(cls.name, schema);

const DAY = 24 * 60 * 60_000;

/** The two demo patients who really occupy a bed; the other occupied beds are sample occupants. */
const NAMED_ADMISSIONS: Record<string, { department: string; roomClass: string; needs: string[]; notes: string }> = {
  MHK202500325: { department: 'General Surgery', roomClass: 'general', needs: [], notes: 'Post-operative care' }, // David Raj
  MHK202500327: { department: 'Cardiology', roomClass: 'hdu', needs: ['monitor'], notes: 'Chest pain, under observation' }, // James Wilson
};

/**
 * Replaces the wards, beds, admissions and bed suggestions with the demo hospital's
 * 138 beds. Run after the patients are seeded: two beds hold real admissions.
 */
export async function seedBeds(): Promise<void> {
  const wards = model(Ward, WardSchema);
  const beds = model(Bed, BedSchema);
  const admissions = model(Admission, AdmissionSchema);
  await Promise.all([wards.deleteMany({}), beds.deleteMany({}), admissions.deleteMany({}), model(BedSuggestion, BedSuggestionSchema).deleteMany({})]);

  const layout = buildBedSeed();
  const insertedWards = await wards.insertMany(layout.wards);
  const wardId = new Map(insertedWards.map((w) => [w.code, w._id]));

  const stateSince = clinicNow();
  const insertedBeds = await beds.insertMany(
    layout.beds.map(({ wardCode, namedPatientUhid, ...b }) => ({ ...b, ward: wardId.get(wardCode), stateSince })),
  );

  const patients = model(Patient, PatientSchema);
  const admittedAt = new Date(clinicNow().getTime() - 2 * DAY);
  for (const [i, seeded] of layout.beds.entries()) {
    if (!seeded.namedPatientUhid) continue;
    const patient = await patients.findOne({ uhid: seeded.namedPatientUhid }).lean<any>();
    if (!patient) throw new Error(`Bed seed: patient ${seeded.namedPatientUhid} not found. Seed the patients first.`);
    const bed = insertedBeds[i];
    const stay = NAMED_ADMISSIONS[seeded.namedPatientUhid];
    const admission = await admissions.create({
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: patient.name,
      bed: bed._id,
      doctor: patient.doctor ?? '',
      ...stay,
      expectedStayDays: 5,
      status: 'active',
      admittedAt,
      admittedBy: 'Seed',
    });
    await beds.updateOne({ _id: bed._id }, { $set: { admission: admission._id } });
  }

  const occupied = layout.beds.filter((b) => b.state === 'occupied').length;
  console.log(`✅ ${layout.wards.length} wards, ${layout.beds.length} beds (${occupied} occupied)`);
}
