import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PatientDocument = Patient & Document;

// Clinical facts (vitals, blood group, insurance, AI summary) have no defaults:
// an unrecorded value must stay absent rather than look like a real reading.

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

  @Prop({ required: true })
  phone: string;

  @Prop({ default: '' })
  avatar: string;

  @Prop({ default: '' })
  bloodGroup: string;

  @Prop({ default: 'OPD', enum: ['OPD', 'IPD'] })
  visitType: string;

  @Prop({ default: 'Today', enum: ['Today', 'Admitted', 'Follow-up', 'Discharged'] })
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
}

export const PatientSchema = SchemaFactory.createForClass(Patient);
PatientSchema.index({ name: 'text', uhid: 'text', phone: 'text' });
