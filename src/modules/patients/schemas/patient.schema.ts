import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PatientDocument = Patient & Document;

@Schema({ _id: false })
export class InsuranceInfo {
  @Prop({ default: 'Star Health Insurance' })
  provider: string;

  @Prop({ default: 'SH-POL-982341-2025' })
  policyNumber: string;

  @Prop({ default: '31 Dec 2026' })
  validity: string;

  @Prop({ default: 'Cashless (₹5,00,000)' })
  coverageType: string;

  @Prop({ default: 'Approved', enum: ['Not Claimed', 'In Progress', 'Approved', 'Settled'] })
  claimStatus: string;
}

@Schema({ _id: false })
export class PatientVitals {
  @Prop({ default: 'Today, 09:15 AM' })
  recordedAt: string;

  @Prop({ default: 138 })
  bpSystolic: number;

  @Prop({ default: 88 })
  bpDiastolic: number;

  @Prop({ default: 78 })
  heartRate: number;

  @Prop({ default: 98.4 })
  temperature: number;

  @Prop({ default: 98 })
  spo2: number;

  @Prop({ default: 74 })
  weightKg: number;

  @Prop({ default: 172 })
  heightCm: number;

  @Prop({ default: 25.0 })
  bmi: number;

  @Prop({ default: 'Overweight', enum: ['Normal', 'Overweight', 'Underweight', 'Obese'] })
  bmiStatus: string;
}

@Schema({ _id: false })
export class AiSummary {
  @Prop({ default: '45-year-old male with poorly controlled Type 2 Diabetes and newly detected Hypertension.' })
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

  @Prop({ default: 'B+' })
  bloodGroup: string;

  @Prop({ default: 'OPD', enum: ['OPD', 'IPD'] })
  visitType: string;

  @Prop({ default: 'Today', enum: ['Today', 'Admitted', 'Follow-up', 'Discharged'] })
  status: string;

  @Prop({ default: 'General Medicine' })
  department: string;

  @Prop({ default: 'Today, 09:30 AM' })
  lastVisit: string;

  @Prop({ default: 'Tomorrow 10:00 AM' })
  nextAppointment: string;

  @Prop({ default: 'Dr. Shajin' })
  doctor: string;

  @Prop({ type: [String], default: [] })
  conditions: string[];

  @Prop({ type: [String], default: [] })
  allergies: string[];

  @Prop({ type: InsuranceInfo, default: () => ({}) })
  insurance: InsuranceInfo;

  @Prop({ type: PatientVitals, default: () => ({}) })
  vitals: PatientVitals;

  @Prop({ type: AiSummary, default: () => ({}) })
  aiSummary: AiSummary;
}

export const PatientSchema = SchemaFactory.createForClass(Patient);
PatientSchema.index({ name: 'text', uhid: 'text', phone: 'text' });
