import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PrescriptionDocument = Prescription & Document;

@Schema({ _id: false })
export class PrescriptionItem {
  @Prop({ required: true })
  medicine: string;

  @Prop({ default: '' })
  brand: string;

  @Prop({ required: true })
  dose: string;

  @Prop({ required: true, enum: ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS'] })
  frequency: string;

  @Prop({ required: true })
  duration: string;

  @Prop({ default: 'Oral' })
  route: string;

  @Prop({
    default: 'After food',
    enum: ['After food', 'Before food', 'At night', 'SOS (Fever)', 'With warm water'],
  })
  instructions: string;

  @Prop({ default: '' })
  indication: string;

  @Prop({ default: 'Active', enum: ['Active', 'Paused', 'Stopped', 'Completed'] })
  status: string;

  @Prop({ default: '26 Sep 2026' })
  startDate: string;
}

@Schema({ _id: false })
export class PrescriptionOptions {
  @Prop({ default: true })
  printAdvice: boolean;

  @Prop({ default: true })
  includeDiagnosis: boolean;

  @Prop({ default: true })
  includeVitals: boolean;

  @Prop({ default: true })
  includeNextVisit: boolean;

  @Prop({ default: false })
  includeLabSummary: boolean;
}

@Schema({ timestamps: true })
export class Prescription {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ default: '26 Sep 2026' })
  date: string;

  @Prop({ default: 'Dr. Shajin' })
  doctor: string;

  @Prop({ default: 'OPD Follow-up' })
  type: string;

  @Prop({ type: [PrescriptionItem], default: [] })
  items: PrescriptionItem[];

  @Prop({ default: 'Take with full glass of water. Avoid skipping doses. Report dizziness immediately.' })
  additionalInstructions: string;

  @Prop({ type: PrescriptionOptions, default: () => ({}) })
  options: PrescriptionOptions;
}

export const PrescriptionSchema = SchemaFactory.createForClass(Prescription);
