import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PatientDocument = Patient & Document;

// Clinical facts (vitals, blood group, insurance, AI summary) have no defaults:
// an unrecorded value must stay absent rather than look like a real reading.

@Schema()
export class PatientContact {
  @Prop({ required: true, maxlength: 80 })
  name: string;

  @Prop({ required: true, maxlength: 40 })
  relation: string;

  @Prop({ required: true, maxlength: 20 })
  phone: string;
}
export const PatientContactSchema = SchemaFactory.createForClass(PatientContact);

@Schema({ _id: false })
export class PatientConsent {
  @Prop({ default: false })
  messages: boolean;

  @Prop({ default: false })
  calls: boolean;

  @Prop()
  recordedAt?: Date;

  @Prop()
  recordedBy?: string;

  @Prop()
  recordedByName?: string;

  @Prop({ type: String, enum: ['desk', 'ward', 'kiosk'] })
  via?: 'desk' | 'ward' | 'kiosk';
}
export const PatientConsentSchema = SchemaFactory.createForClass(PatientConsent);

@Schema({ _id: false })
export class InsuranceInfo {
  @Prop()
  provider: string;

  @Prop()
  policyNumber: string;

  @Prop()
  validity: string;

  @Prop()
  coverageType: string;

  @Prop({ default: 'Not Claimed', enum: ['Not Claimed', 'In Progress', 'Approved', 'Settled'] })
  claimStatus: string;
}

@Schema({ _id: false })
export class PatientVitals {
  @Prop()
  recordedAt: string;

  @Prop()
  bpSystolic: number;

  @Prop()
  bpDiastolic: number;

  @Prop()
  heartRate: number;

  @Prop()
  temperature: number;

  @Prop()
  spo2: number;

  @Prop()
  weightKg: number;

  @Prop()
  heightCm: number;

  @Prop()
  bmi: number;

  @Prop({ enum: ['Normal', 'Overweight', 'Underweight', 'Obese'] })
  bmiStatus: string;
}

@Schema({ _id: false })
export class AiSummary {
  @Prop()
  summary: string;

  @Prop({ type: [String], default: [] })
  keyPoints: string[];
}

@Schema({ timestamps: true })
export class Patient {
  @Prop({ required: true, unique: true, index: true })
  uhid: string;

  @Prop({ required: true, index: true })
  name: string;

  @Prop({ required: true })
  age: number;

  @Prop({ required: true, enum: ['Male', 'Female', 'Other'] })
  gender: string;

  /** Required unless the patient came in through the ER without any details yet. */
  @Prop({
    required: function (this: { detailsPending?: boolean }) {
      return !this.detailsPending;
    },
  })
  phone: string;

  /** An unidentified ER patient: name and phone are filled in later. */
  @Prop({ default: false })
  detailsPending?: boolean;

  /** "12 Mar 1991"; optional because older records only have an age. */
  @Prop()
  dob?: string;

  @Prop()
  address?: string;

  @Prop()
  email?: string;

  @Prop()
  emergencyContact?: string;

  @Prop({ default: '' })
  avatar: string;

  @Prop({ default: '' })
  bloodGroup: string;

  @Prop({ default: 'OPD', enum: ['OPD', 'IPD'] })
  visitType: string;

  @Prop({ default: 'Today', enum: ['Today', 'Admitted', 'Follow-up', 'Discharged', 'Deceased', 'Left without discharge'] })
  status: string;

  @Prop({ default: 'General Medicine' })
  department: string;

  @Prop({ default: '' })
  lastVisit: string;

  @Prop({ default: '' })
  nextAppointment: string;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ type: [String], default: [] })
  conditions: string[];

  @Prop({ type: [String], default: [] })
  allergies: string[];

  @Prop({ type: InsuranceInfo })
  insurance?: InsuranceInfo;

  @Prop({ type: PatientVitals })
  vitals?: PatientVitals;

  @Prop({ type: AiSummary })
  aiSummary?: AiSummary;

  // Set when the patient asks not to be called or the number is wrong; the AI call
  // agent never dials a patient with this flag. Staff clear it once fixed.
  @Prop({ default: false })
  doNotCall: boolean;

  @Prop({ default: '' })
  doNotCallReason: string;

  /** Set when the record was not made at the front desk, e.g. "Registered at kiosk Front kiosk". */
  @Prop()
  registeredVia?: string;

  /** Language for family texts and check-up calls. Written only by the Patient Support route. */
  @Prop({ type: String, enum: ['en', 'ta'], default: 'en' })
  preferredLanguage: 'en' | 'ta';

  /** Family contacts (at most 5). */
  @Prop({ type: [PatientContactSchema], default: [], validate: [(v: unknown[]) => v.length <= 5, 'At most 5 contacts.'] })
  contacts: PatientContact[];

  /** Who gets family updates: 'self' or a contact's _id. */
  @Prop({ type: String, default: 'self' })
  updatesTo: string;

  /** Consent to messages and calls, with who recorded it and where. */
  @Prop({ type: PatientConsentSchema, default: () => ({ messages: false, calls: false }) })
  consent: PatientConsent;
}

export const PatientSchema = SchemaFactory.createForClass(Patient);
PatientSchema.index({ name: 'text', uhid: 'text', phone: 'text' });
