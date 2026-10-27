import mongoose, { Model, Schema, Types } from 'mongoose';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { Ward, WardSchema } from '../modules/beds/schemas/ward.schema';
import { Bed, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { BedSuggestion, BedSuggestionSchema } from '../modules/beds/schemas/bed-suggestion.schema';
import { BedRequest, BedRequestSchema } from '../modules/beds/schemas/bed-request.schema';
import { BedSnapshot, BedSnapshotSchema } from '../modules/beds/schemas/bed-snapshot.schema';
import { buildBedSeed } from '../modules/beds/bed-layout';
import { clinicNow } from '../common/utils/clinic-time';
import { WardType } from '../modules/beds/bed-types';
import { pastRequests, sampleInpatients, snapshotHistory, SnapshotCounts } from './sample-inpatients';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.model(cls.name, schema);

const DAY = 24 * 60 * 60_000;

/** The two demo patients who really occupy a bed; the other occupied beds are sample occupants. */
const NAMED_ADMISSIONS: Record<string, { department: string; roomClass: string; needs: string[]; notes: string }> = {
  MHK202500325: { department: 'General Surgery', roomClass: 'general', needs: [], notes: 'Post-operative care' }, // David Raj
  MHK202500327: { department: 'Cardiology', roomClass: 'hdu', needs: ['monitor'], notes: 'Chest pain, under observation' }, // James Wilson
};

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Replaces the wards, beds, admissions, bed suggestions, bed requests and bed snapshots with the demo hospital's
 * 138 beds. Run after the patients are seeded: two beds hold real admissions. Times
 * fall on `clinicDay` (YYYY-MM-DD, the demo day) at the current time of day.
 */
export async function seedBeds(clinicDay: string): Promise<void> {
  const wards = model(Ward, WardSchema);
  const beds = model(Bed, BedSchema);
  const admissions = model(Admission, AdmissionSchema);
  await Promise.all([wards.deleteMany({}), beds.deleteMany({}), admissions.deleteMany({}), model(BedSuggestion, BedSuggestionSchema).deleteMany({})]);
  const requests = model(BedRequest, BedRequestSchema);
  const snapshots = model(BedSnapshot, BedSnapshotSchema);
  await Promise.all([requests.deleteMany({}), snapshots.deleteMany({})]);
  await requests.syncIndexes();

  const layout = buildBedSeed();
  const insertedWards = await wards.insertMany(layout.wards);
  const wardId = new Map(insertedWards.map((w) => [w.code, w._id]));

  const stateSince = clinicNow(clinicDay);
  const insertedBeds = await beds.insertMany(
    layout.beds.map(({ wardCode, namedPatientUhid, ...b }) => ({ ...b, ward: wardId.get(wardCode), stateSince })),
  );

  const patients = model(Patient, PatientSchema);
  const admittedAt = new Date(stateSince.getTime() - 2 * DAY);
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

  // Sample occupants get an admission with no Patient behind it, on the clinic clock.
  const wardByCode = new Map(layout.wards.map((w) => [w.code, w]));
  const sampleBeds = layout.beds.flatMap((seeded, i) =>
    seeded.sample ? [{ seeded, bed: insertedBeds[i], ward: wardByCode.get(seeded.wardCode)! }] : [],
  );
  const sample = sampleInpatients(
    sampleBeds.map(({ seeded, ward }) => ({
      label: seeded.label,
      wardName: ward.name,
      wardType: ward.type,
      occupantGender: seeded.occupantGender!,
      nearDepartments: ward.nearDepartments,
      features: seeded.features,
    })),
    stateSince,
  );
  const admissionOf = new Map<string, { id: Types.ObjectId; patient: Types.ObjectId; bedId: Types.ObjectId }>();
  const sampleDocs = sample.map((a, i) => {
    const entry = { id: new Types.ObjectId(), patient: new Types.ObjectId(), bedId: sampleBeds[i].bed._id };
    admissionOf.set(a.label, entry);
    return {
      _id: entry.id,
      patient: entry.patient,
      patientUhid: a.uhid,
      patientName: a.name,
      bed: entry.bedId,
      doctor: a.doctor,
      department: a.department,
      roomClass: a.roomClass,
      needs: a.needs,
      notes: a.notes,
      expectedStayDays: a.expectedStayDays,
      status: 'active',
      admittedAt: a.admittedAt,
      admittedBy: 'Seed',
      sample: true,
    };
  });
  await admissions.insertMany(sampleDocs);
  await beds.bulkWrite(sampleDocs.map((d) => ({ updateOne: { filter: { _id: d.bed }, update: { $set: { admission: d._id } } } })));

  // A week of hourly bed counts on the real clock, so the overview's trends have data.
  const current: SnapshotCounts = { totals: { total: 0, occupied: 0, free: 0, cleaning: 0, blocked: 0, held: 0 }, byType: {} };
  for (const b of layout.beds) {
    const type = wardByCode.get(b.wardCode)!.type as WardType;
    const t = (current.byType[type] ??= { total: 0, occupied: 0, free: 0, cleaning: 0, blocked: 0 });
    for (const c of [t, current.totals]) {
      c.total++;
      c[b.state]++;
    }
  }
  const realNow = new Date();
  const history = snapshotHistory(realNow, current);
  await snapshots.insertMany(history.map((p) => ({ ...p, at: new Date(p.hour.getTime() + 59 * 60_000) })));

  // Ten past requests, assigned to the newest sample admissions.
  const past = pastRequests(sample);
  await requests.insertMany(
    past.map((p) => {
      const a = p.admission;
      const link = admissionOf.get(a.label)!;
      const label = a.label;
      return {
        type: 'admission',
        patient: link.patient,
        patientName: a.name,
        patientUhid: a.uhid,
        patientAge: a.age,
        patientGender: a.gender,
        admission: link.id,
        stepDown: false,
        roomClass: a.roomClass,
        needs: a.needs,
        notes: a.notes,
        department: a.department,
        doctor: a.doctor,
        expectedStayDays: a.expectedStayDays,
        priority: p.priority,
        priorityRank: PRIORITY_RANK[p.priority],
        state: 'assigned',
        stateReason: `Assigned to ${label}.`,
        stateSince: p.assignedAt,
        open: false,
        attempts: 0,
        requestedBy: 'Seed',
        requestedByName: p.requestedByName,
        requestedAt: p.requestedAt,
        assignedBed: link.bedId,
        assignedBedLabel: label,
        assignedAt: p.assignedAt,
        decision: {
          suggestionId: new Types.ObjectId().toString(),
          by: p.by,
          bedId: link.bedId.toString(),
          bedLabel: label,
          wardName: a.wardName,
          reason: p.reason,
          appliedRules: [],
          addedNeeds: [],
          resolvedNeeds: [],
          candidates: [{ bedId: link.bedId.toString(), label, score: 90, reason: p.reason }],
          sample: p.by === 'ai',
        },
      };
    }),
  );

  const occupied = layout.beds.filter((b) => b.state === 'occupied').length;
  console.log(`✅ ${layout.wards.length} wards, ${layout.beds.length} beds (${occupied} occupied)`);
  console.log(`✅ ${sample.length} sample inpatients, ${history.length} snapshots, ${past.length} past requests`);
}
