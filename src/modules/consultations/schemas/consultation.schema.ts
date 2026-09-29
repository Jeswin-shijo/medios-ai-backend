import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ConsultationDocument = Consultation & Document;

@Schema({ _id: false })
export class Icd10Diagnosis {
  @Prop({ required: true })
  code: string;

  @Prop({ required: true })
  description: string;

  @Prop({ default: 'Chronic', enum: ['Chronic', 'Acute'] })
  type: string;
}

@Schema({ timestamps: true })
export class Consultation {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ default: 'Arun Kumar' })
  patientName: string;

  @Prop({ default: '26 Sep 2026' })
  visitDate: string;

  @Prop({ default: '09:30 AM' })
  visitTime: string;

  @Prop({ default: 'OPD Regular' })
  visitType: string;

  @Prop({ default: 'Dr. Shajin' })
  doctor: string;

  @Prop({ default: 'General Medicine' })
  department: string;

  @Prop({ default: '' })
  subjective: string;

  @Prop({ default: '' })
  objective: string;

  @Prop({ default: '' })
  assessment: string;

  @Prop({ default: '' })
  plan: string;

  @Prop({ type: [Icd10Diagnosis], default: [] })
  icd10: Icd10Diagnosis[];

  @Prop({ default: false })
  isFinal: boolean;
}

export const ConsultationSchema = SchemaFactory.createForClass(Consultation);
