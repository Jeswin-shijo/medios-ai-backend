import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDate, displayTime } from '../../../common/utils/clinic-time';

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

  @Prop({ default: '' })
  patientName: string;

  @Prop({ default: () => displayDate() })
  visitDate: string;

  @Prop({ default: () => displayTime() })
  visitTime: string;

  @Prop({ default: '' })
  visitType: string;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ default: '' })
  department: string;

  /** Chief complaint, shown in the visit list. */
  @Prop({ default: '' })
  reason: string;

  @Prop({ default: '' })
  subjective: string;

  @Prop({ default: '' })
  objective: string;

  @Prop({ default: '' })
  assessment: string;

  @Prop({ default: '' })
  plan: string;

  /** Unstructured note written in the EMR's Free Text mode. */
  @Prop({ default: '' })
  freeText: string;

  @Prop({ type: [Icd10Diagnosis], default: [] })
  icd10: Icd10Diagnosis[];

  @Prop({ default: false })
  isFinal: boolean;
}

export const ConsultationSchema = SchemaFactory.createForClass(Consultation);
